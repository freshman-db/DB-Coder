import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpConfig } from '../config/types.js';
import { log } from '../utils/logger.js';

export type Phase = 'scan' | 'plan' | 'execute' | 'review';

/** Matches Agent SDK's McpServerConfig union */
export type McpServerEntry =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> };

/** Default phase routing — which MCP servers are available in each phase */
const DEFAULT_PHASE_ROUTING: Record<string, Phase[]> = {
  serena:       ['scan', 'plan', 'execute', 'review'],
  context7:     ['plan', 'execute'],
  playwright:   ['execute', 'review'],
  github:       ['execute'],
  greptile:     ['review'],
  'mcp-search': ['scan', 'plan', 'execute', 'review'],
};

/** Plugins with dangerous side effects — never load into subprocesses */
const PLUGIN_BLACKLIST = new Set([
  'commit-commands',    // /commit-push-pr pushes code, creates PRs
  'code-review',        // /code-review executes gh pr comment
]);

export class McpDiscovery {
  private servers = new Map<string, McpServerEntry>();
  private phaseRouting = new Map<string, Phase[]>();
  private pluginPaths = new Map<string, string>();  // pluginId → installPath

  constructor(private mcpConfig?: McpConfig) {}

  /** Scan ~/.claude/plugins/ and discover all MCP servers */
  async discover(): Promise<void> {
    if (this.mcpConfig?.enabled === false) {
      log.info('MCP discovery disabled by config');
      return;
    }

    const home = homedir();
    const settingsPath = join(home, '.claude', 'settings.json');
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');

    if (!existsSync(settingsPath) || !existsSync(installedPath)) {
      log.warn('Claude plugins not found — skipping MCP discovery');
      return;
    }

    let settings: { enabledPlugins?: Record<string, boolean> };
    let installed: { plugins?: Record<string, Array<{ installPath: string }>> };

    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      installed = JSON.parse(readFileSync(installedPath, 'utf-8'));
    } catch (err) {
      log.warn('Failed to parse Claude plugin files', err);
      return;
    }

    const enabledPlugins = settings.enabledPlugins ?? {};
    const pluginEntries = installed.plugins ?? {};

    // Disabled servers from config
    const disabled = new Set(this.mcpConfig?.disabled ?? []);

    for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
      if (!enabled) continue;

      const pluginInfo = pluginEntries[pluginId];
      if (!pluginInfo?.[0]?.installPath) continue;

      const installPath = pluginInfo[0].installPath;

      // Record plugin path for plugin loading via SDK plugins option
      this.pluginPaths.set(pluginId, installPath);

      const mcpJsonPath = join(installPath, '.mcp.json');

      if (!existsSync(mcpJsonPath)) continue;

      try {
        const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
        const parsed = this.parseMcpJson(mcpJson, installPath);

        for (const [name, config] of Object.entries(parsed)) {
          if (disabled.has(name)) {
            log.debug?.(`MCP server '${name}' disabled by config`);
            continue;
          }
          this.servers.set(name, config);
        }
      } catch (err) {
        log.warn(`Failed to parse ${mcpJsonPath}`, err);
      }
    }

    // Add custom servers from config
    if (this.mcpConfig?.custom) {
      for (const [name, config] of Object.entries(this.mcpConfig.custom)) {
        if (disabled.has(name)) continue;
        this.servers.set(name, config as McpServerEntry);
      }
    }

    // Set up phase routing
    this.buildPhaseRouting();

    log.info(`Discovered ${this.servers.size} MCP servers: ${[...this.servers.keys()].join(', ')}`);
  }

  /** Get MCP server configs for a specific phase */
  getServersForPhase(phase: Phase): Record<string, McpServerEntry> {
    const result: Record<string, McpServerEntry> = {};
    for (const [name, config] of this.servers) {
      const phases = this.phaseRouting.get(name);
      if (phases?.includes(phase)) {
        result[name] = config;
      }
    }
    return result;
  }

  /** Get server names for a specific phase (for prompt generation) */
  getServerNames(phase: Phase): string[] {
    return Object.keys(this.getServersForPhase(phase));
  }

  /** Get all discovered server names */
  getAllServers(): string[] {
    return [...this.servers.keys()];
  }

  /** Get all loaded plugin IDs (for agent guidance generation) */
  getLoadedPluginIds(): string[] {
    const disabledPlugins = new Set(this.mcpConfig?.disabledPlugins ?? []);
    return [...this.pluginPaths.keys()]
      .filter(id => !isPluginBlacklisted(id) && !disabledPlugins.has(id));
  }

  /** Get plugin configs to load via SDK plugins option (all phases) */
  getPluginsForPhase(_phase: Phase): Array<{ type: 'local'; path: string }> {
    // All phases can load plugins — agents need plugin definitions to spawn subagents.
    // The PLUGIN_BLACKLIST still prevents dangerous plugins from loading.
    const disabledPlugins = new Set(this.mcpConfig?.disabledPlugins ?? []);

    return [...this.pluginPaths.entries()]
      .filter(([id]) => !isPluginBlacklisted(id) && !disabledPlugins.has(id))
      .map(([, path]) => ({ type: 'local' as const, path }));
  }

  /**
   * Parse .mcp.json — handles two formats:
   * 1. Official: `{ "serena": { "command": "uvx", ... } }` (top-level key = server name)
   * 2. Third-party: `{ "mcpServers": { "name": { ... } } }` (nested under mcpServers)
   */
  private parseMcpJson(json: Record<string, unknown>, installPath: string): Record<string, McpServerEntry> {
    const result: Record<string, McpServerEntry> = {};

    // Check for third-party format first
    if (json.mcpServers && typeof json.mcpServers === 'object') {
      const servers = json.mcpServers as Record<string, Record<string, unknown>>;
      for (const [name, config] of Object.entries(servers)) {
        const resolved = this.resolveConfig(config, installPath);
        if (resolved) result[name] = resolved;
      }
      return result;
    }

    // Official format: each top-level key is a server name
    for (const [name, config] of Object.entries(json)) {
      if (typeof config !== 'object' || config === null) continue;
      const resolved = this.resolveConfig(config as Record<string, unknown>, installPath);
      if (resolved) result[name] = resolved;
    }

    return result;
  }

  /** Resolve a single server config, expanding env vars */
  private resolveConfig(raw: Record<string, unknown>, installPath: string): McpServerEntry | null {
    // HTTP/SSE transport
    if (raw.type === 'http' || raw.type === 'sse') {
      const url = this.expandEnvVars(raw.url as string, installPath);
      if (!url) return null;
      const headers = raw.headers
        ? this.expandHeaders(raw.headers as Record<string, string>, installPath)
        : undefined;
      if (raw.headers && !headers) return null; // required env var missing
      return { type: raw.type, url, ...(headers && { headers }) };
    }

    // Stdio transport (default when command is present)
    if (raw.command) {
      const command = this.expandEnvVars(raw.command as string, installPath);
      if (!command) return null;
      const args = (raw.args as string[] | undefined)?.map(a => this.expandEnvVars(a, installPath)!);
      if (args?.some(a => a === null || a === undefined)) return null;
      const env = raw.env
        ? this.expandHeaders(raw.env as Record<string, string>, installPath)
        : undefined;
      return { command, ...(args && { args }), ...(env && { env }) };
    }

    return null;
  }

  /** Expand ${VAR} placeholders from process.env + special vars */
  private expandEnvVars(value: string, installPath?: string): string | null {
    let missing = false;
    const expanded = value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
      if (varName === 'CLAUDE_PLUGIN_ROOT' && installPath) {
        return installPath;
      }
      const envVal = process.env[varName];
      if (envVal === undefined) {
        log.debug?.(`MCP env var '${varName}' not set — skipping server`);
        missing = true;
        return '';
      }
      return envVal;
    });
    return missing ? null : expanded;
  }

  /** Expand env vars in all header/env values; return null if any required var is missing */
  private expandHeaders(headers: Record<string, string>, installPath?: string): Record<string, string> | null {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const expanded = this.expandEnvVars(value, installPath);
      if (expanded === null) return null;
      result[key] = expanded;
    }
    return result;
  }

  /** Build phase routing from defaults + config overrides */
  private buildPhaseRouting(): void {
    const overrides = this.mcpConfig?.serverPhases ?? {};

    for (const name of this.servers.keys()) {
      if (overrides[name]) {
        // Config override
        this.phaseRouting.set(name, overrides[name] as Phase[]);
      } else if (DEFAULT_PHASE_ROUTING[name]) {
        // Default routing
        this.phaseRouting.set(name, DEFAULT_PHASE_ROUTING[name]);
      } else {
        // Unknown server: available in execute only (safe default)
        this.phaseRouting.set(name, ['execute']);
      }
    }
  }
}

function isPluginBlacklisted(pluginId: string): boolean {
  // Match against short name: @org/plugin-name → plugin-name
  const shortName = pluginId.split('/').pop() ?? pluginId;
  return PLUGIN_BLACKLIST.has(shortName);
}
