import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PluginRelevance } from '../config/types.js';
import { log } from '../utils/logger.js';
import { runProcess } from '../utils/process.js';

export interface PluginInfo {
  name: string;
  description: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  installedVersion?: string;
  hasUpdate: boolean;
  relevance: PluginRelevance;
}

export interface PluginCheckResult {
  installed: PluginInfo[];
  available: PluginInfo[];
  newPlugins: PluginInfo[];
  updatable: PluginInfo[];
  checkedAt: Date;
}

/** Category keywords for relevance classification */
const ESSENTIAL_KEYWORDS = ['code-review', 'pr-review', 'feature-dev'];
const RECOMMENDED_KEYWORDS = ['test', 'security', 'lint', 'type', 'simplif'];
const IRRELEVANT_KEYWORDS = ['learning', 'tutorial', 'demo'];

export class PluginMonitor {
  private relevanceOverrides: Record<string, PluginRelevance>;

  constructor(relevanceOverrides?: Record<string, PluginRelevance>) {
    this.relevanceOverrides = relevanceOverrides ?? {};
  }

  /** Check installed plugins and their status */
  async checkForUpdates(): Promise<PluginCheckResult> {
    const home = homedir();
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');

    const installed: PluginInfo[] = [];
    const available: PluginInfo[] = [];
    const newPlugins: PluginInfo[] = [];
    const updatable: PluginInfo[] = [];

    // Parse installed plugins
    if (existsSync(installedPath) && existsSync(settingsPath)) {
      try {
        const installedData = JSON.parse(readFileSync(installedPath, 'utf-8'));
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const enabledPlugins = settings.enabledPlugins ?? {};
        const pluginEntries = installedData.plugins ?? {};

        for (const [pluginId, versions] of Object.entries(pluginEntries)) {
          const versionArr = versions as Array<{ installPath: string; version?: string }>;
          if (!versionArr?.[0]) continue;

          const info: PluginInfo = {
            name: pluginId,
            description: this.getPluginDescription(versionArr[0].installPath),
            version: versionArr[0].version ?? 'unknown',
            installed: true,
            enabled: enabledPlugins[pluginId] === true,
            installedVersion: versionArr[0].version,
            hasUpdate: false,
            relevance: this.classifyRelevance(pluginId, ''),
          };

          installed.push(info);
        }
      } catch (err) {
        log.warn('PluginMonitor: failed to parse plugin files', err);
      }
    }

    // Try to get marketplace info via claude CLI
    try {
      const result = await runProcess('claude', ['plugin', 'list', '--json'], { timeout: 15000 });
      if (result.exitCode === 0 && result.stdout) {
        const marketplacePlugins = JSON.parse(result.stdout);
        if (Array.isArray(marketplacePlugins)) {
          for (const mp of marketplacePlugins) {
            const name = mp.name ?? mp.id ?? '';
            const isInstalled = installed.some(i => i.name === name);

            if (!isInstalled) {
              const info: PluginInfo = {
                name,
                description: mp.description ?? '',
                version: mp.version ?? 'unknown',
                installed: false,
                enabled: false,
                hasUpdate: false,
                relevance: this.classifyRelevance(name, mp.description ?? ''),
              };
              available.push(info);
              newPlugins.push(info);
            } else {
              // Check for version updates
              const installedPlugin = installed.find(i => i.name === name);
              if (installedPlugin && mp.version && installedPlugin.version !== mp.version) {
                installedPlugin.hasUpdate = true;
                updatable.push(installedPlugin);
              }
            }
          }
        }
      }
    } catch {
      // CLI may not support --json yet, that's OK
      log.debug?.('PluginMonitor: claude plugin list not available');
    }

    const result: PluginCheckResult = {
      installed,
      available,
      newPlugins,
      updatable,
      checkedAt: new Date(),
    };

    if (newPlugins.length > 0 || updatable.length > 0) {
      log.info(`Plugin check: ${installed.length} installed, ${newPlugins.length} new available, ${updatable.length} updatable`);
    }

    return result;
  }

  /** Install a plugin by name */
  async installPlugin(name: string): Promise<boolean> {
    try {
      const result = await runProcess('claude', ['plugin', 'install', name], { timeout: 30000 });
      return result.exitCode === 0;
    } catch (err) {
      log.warn(`Failed to install plugin ${name}`, err);
      return false;
    }
  }

  /** Update a plugin by name */
  async updatePlugin(name: string): Promise<boolean> {
    try {
      const result = await runProcess('claude', ['plugin', 'update', name], { timeout: 30000 });
      return result.exitCode === 0;
    } catch (err) {
      log.warn(`Failed to update plugin ${name}`, err);
      return false;
    }
  }

  /** Enable a plugin by name */
  async enablePlugin(name: string): Promise<boolean> {
    try {
      const result = await runProcess('claude', ['plugin', 'enable', name], { timeout: 15000 });
      return result.exitCode === 0;
    } catch (err) {
      log.warn(`Failed to enable plugin ${name}`, err);
      return false;
    }
  }

  /** Disable a plugin by name */
  async disablePlugin(name: string): Promise<boolean> {
    try {
      const result = await runProcess('claude', ['plugin', 'disable', name], { timeout: 15000 });
      return result.exitCode === 0;
    } catch (err) {
      log.warn(`Failed to disable plugin ${name}`, err);
      return false;
    }
  }

  /** Classify plugin relevance based on name and description */
  private classifyRelevance(name: string, description: string): PluginRelevance {
    // User overrides take priority
    const shortName = name.split('/').pop() ?? name;
    if (this.relevanceOverrides[shortName]) return this.relevanceOverrides[shortName];
    if (this.relevanceOverrides[name]) return this.relevanceOverrides[name];

    const text = `${shortName} ${description}`.toLowerCase();

    if (ESSENTIAL_KEYWORDS.some(k => text.includes(k))) return 'essential';
    if (RECOMMENDED_KEYWORDS.some(k => text.includes(k))) return 'recommended';
    if (IRRELEVANT_KEYWORDS.some(k => text.includes(k))) return 'irrelevant';

    return 'optional';
  }

  /** Read plugin description from its package.json */
  private getPluginDescription(installPath: string): string {
    try {
      const pkgPath = join(installPath, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        return pkg.description ?? '';
      }
    } catch { /* ignore */ }
    return '';
  }
}
