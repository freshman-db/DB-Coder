import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { DbCoderConfig } from '../config/types.js';
import { isRecord } from './parse.js';

type ConfigRecord = Record<string, unknown>;

const SANDBOX_VALUES = new Set(['workspace-write', 'workspace-read', 'full-auto']);
const AUTONOMY_LEVELS = new Set(['full', 'supervised']);
const MCP_PHASES = new Set(['scan', 'plan', 'execute', 'review']);
const PLUGIN_RELEVANCE_VALUES = new Set(['essential', 'recommended', 'optional', 'irrelevant']);
const GOAL_STATUSES = new Set(['active', 'paused', 'done']);

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super([
      'Invalid db-coder configuration:',
      ...issues.map(issue => `  - ${issue}`),
      'Fix ~/.db-coder/config.json or <project>/.db-coder.json, then restart db-coder.',
    ].join('\n'));
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/**
 * Validates config values without mutating or normalizing the original object.
 */
export function validateConfig(config: DbCoderConfig, projectPath: string): void {
  const issues: string[] = [];
  validateProjectPath(projectPath, issues);

  if (!isRecord(config)) {
    throw new ConfigValidationError(['config must be an object']);
  }

  validateNonEmptyString(config.apiToken, 'apiToken', issues);

  const brain = requireRecord(config.brain, 'brain', issues);
  if (brain) {
    validateNonEmptyString(brain.model, 'brain.model', issues);
    validateNumber(brain.scanInterval, 'brain.scanInterval', issues, { integer: true, min: 1 });
    validateNumber(brain.maxScanBudget, 'brain.maxScanBudget', issues, { min: 0 });
  }

  const claude = requireRecord(config.claude, 'claude', issues);
  if (claude) {
    validateNonEmptyString(claude.model, 'claude.model', issues);
    validateNumber(claude.maxTaskBudget, 'claude.maxTaskBudget', issues, { min: 0 });
    validateNumber(claude.maxTurns, 'claude.maxTurns', issues, { integer: true, min: 1 });
  }

  const codex = requireRecord(config.codex, 'codex', issues);
  if (codex) {
    validateNonEmptyString(codex.model, 'codex.model', issues);
    validateEnum(codex.sandbox, 'codex.sandbox', SANDBOX_VALUES, issues);

    if (codex.tokenPricing !== undefined) {
      const tokenPricing = requireRecord(codex.tokenPricing, 'codex.tokenPricing', issues);
      if (tokenPricing) {
        validateNumber(tokenPricing.inputPerMillion, 'codex.tokenPricing.inputPerMillion', issues, { min: 0 });
        validateNumber(tokenPricing.cachedInputPerMillion, 'codex.tokenPricing.cachedInputPerMillion', issues, { min: 0 });
        validateNumber(tokenPricing.outputPerMillion, 'codex.tokenPricing.outputPerMillion', issues, { min: 0 });
      }
    }
  }

  const autonomy = requireRecord(config.autonomy, 'autonomy', issues);
  if (autonomy) {
    validateEnum(autonomy.level, 'autonomy.level', AUTONOMY_LEVELS, issues);
    validateNumber(autonomy.maxRetries, 'autonomy.maxRetries', issues, { integer: true, min: 0 });
    validateNumber(autonomy.subtaskTimeout, 'autonomy.subtaskTimeout', issues, { integer: true, min: 1 });
  }

  const routing = requireRecord(config.routing, 'routing', issues);
  if (routing) {
    validateExactValue(routing.scan, 'routing.scan', 'brain', issues);
    validateExactValue(routing.plan, 'routing.plan', 'brain', issues);
    validateExactValue(routing.execute_frontend, 'routing.execute_frontend', 'claude', issues);
    validateExactValue(routing.execute_backend, 'routing.execute_backend', 'codex', issues);
    validateExactValue(routing.reflect, 'routing.reflect', 'brain', issues);
  }

  const budget = requireRecord(config.budget, 'budget', issues);
  if (budget) {
    validateNumber(budget.maxPerTask, 'budget.maxPerTask', issues, { min: 0 });
    validateNumber(budget.maxPerDay, 'budget.maxPerDay', issues, { min: 0 });
    validateNumber(budget.warningThreshold, 'budget.warningThreshold', issues, { min: 0, max: 1 });
  }

  const memory = requireRecord(config.memory, 'memory', issues);
  if (memory) {
    const claudeMemUrl = validateNonEmptyString(memory.claudeMemUrl, 'memory.claudeMemUrl', issues);
    if (claudeMemUrl) {
      validateUrl(claudeMemUrl, 'memory.claudeMemUrl', issues, ['http:', 'https:']);
    }

    const pgConnectionString = validateNonEmptyString(memory.pgConnectionString, 'memory.pgConnectionString', issues);
    if (pgConnectionString) {
      validateUrl(pgConnectionString, 'memory.pgConnectionString', issues, ['postgres:', 'postgresql:']);
    }
  }

  const git = requireRecord(config.git, 'git', issues);
  if (git) {
    validateNonEmptyString(git.branchPrefix, 'git.branchPrefix', issues);
    validateStringArray(git.protectedBranches, 'git.protectedBranches', issues, { minLength: 1 });
  }

  const server = requireRecord(config.server, 'server', issues);
  if (server) {
    validateNonEmptyString(server.host, 'server.host', issues);
    validateNumber(server.port, 'server.port', issues, { integer: true, min: 1, max: 65535 });
  }

  const mcp = requireRecord(config.mcp, 'mcp', issues);
  if (mcp) {
    validateBoolean(mcp.enabled, 'mcp.enabled', issues);

    if (mcp.serverPhases !== undefined) {
      const serverPhases = requireRecord(mcp.serverPhases, 'mcp.serverPhases', issues);
      if (serverPhases) {
        for (const [serverName, phases] of Object.entries(serverPhases)) {
          if (serverName.trim().length === 0) {
            issues.push('mcp.serverPhases contains an empty server name');
          }
          const phaseList = validateStringArray(phases, `mcp.serverPhases.${serverName}`, issues);
          if (!phaseList) continue;
          for (let i = 0; i < phaseList.length; i += 1) {
            validateEnum(phaseList[i], `mcp.serverPhases.${serverName}[${i}]`, MCP_PHASES, issues);
          }
        }
      }
    }

    if (mcp.disabled !== undefined) {
      validateStringArray(mcp.disabled, 'mcp.disabled', issues);
    }
    if (mcp.disabledPlugins !== undefined) {
      validateStringArray(mcp.disabledPlugins, 'mcp.disabledPlugins', issues);
    }

    if (mcp.custom !== undefined) {
      const custom = requireRecord(mcp.custom, 'mcp.custom', issues);
      if (custom) {
        for (const [name, rawServerConfig] of Object.entries(custom)) {
          if (name.trim().length === 0) {
            issues.push('mcp.custom contains an empty server name');
            continue;
          }
          validateMcpCustomServer(rawServerConfig, `mcp.custom.${name}`, projectPath, issues);
        }
      }
    }
  }

  const plugins = requireRecord(config.plugins, 'plugins', issues);
  if (plugins) {
    if (plugins.autoUpdate !== undefined) {
      validateBoolean(plugins.autoUpdate, 'plugins.autoUpdate', issues);
    }
    if (plugins.autoInstallRecommended !== undefined) {
      validateBoolean(plugins.autoInstallRecommended, 'plugins.autoInstallRecommended', issues);
    }
    if (plugins.checkInterval !== undefined) {
      validateNumber(plugins.checkInterval, 'plugins.checkInterval', issues, { integer: true, min: 1 });
    }
    if (plugins.relevanceOverrides !== undefined) {
      const overrides = requireRecord(plugins.relevanceOverrides, 'plugins.relevanceOverrides', issues);
      if (overrides) {
        for (const [pluginName, relevance] of Object.entries(overrides)) {
          if (pluginName.trim().length === 0) {
            issues.push('plugins.relevanceOverrides contains an empty plugin name');
          }
          validateEnum(relevance, `plugins.relevanceOverrides.${pluginName}`, PLUGIN_RELEVANCE_VALUES, issues);
        }
      }
    }
  }

  const evolution = requireRecord(config.evolution, 'evolution', issues);
  if (evolution) {
    const goals = evolution.goals;
    if (!Array.isArray(goals)) {
      issues.push('evolution.goals must be an array');
    } else {
      for (let i = 0; i < goals.length; i += 1) {
        const goal = requireRecord(goals[i], `evolution.goals[${i}]`, issues);
        if (!goal) continue;

        validateNonEmptyString(goal.description, `evolution.goals[${i}].description`, issues);
        validateNumber(goal.priority, `evolution.goals[${i}].priority`, issues, { integer: true, min: 0, max: 3 });

        if (goal.status !== undefined) {
          validateEnum(goal.status, `evolution.goals[${i}].status`, GOAL_STATUSES, issues);
        }
        if (goal.progress !== undefined) {
          validateNumber(goal.progress, `evolution.goals[${i}].progress`, issues, { min: 0, max: 100 });
        }
        if (goal.completedAt !== undefined) {
          const completedAt = validateNonEmptyString(goal.completedAt, `evolution.goals[${i}].completedAt`, issues);
          if (completedAt && Number.isNaN(Date.parse(completedAt))) {
            issues.push(`evolution.goals[${i}].completedAt must be an ISO date string`);
          }
        }
      }
    }

  }

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
}

function validateProjectPath(projectPath: string, issues: string[]): void {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    issues.push('projectPath must be a non-empty path');
    return;
  }

  const resolved = resolve(projectPath);
  if (!existsSync(resolved)) {
    issues.push(`projectPath does not exist: ${resolved}`);
    return;
  }

  try {
    if (!statSync(resolved).isDirectory()) {
      issues.push(`projectPath must be a directory: ${resolved}`);
    }
  } catch (err) {
    issues.push(`projectPath is not accessible: ${resolved} (${String(err)})`);
  }
}

function validateMcpCustomServer(raw: unknown, field: string, projectPath: string, issues: string[]): void {
  const config = requireRecord(raw, field, issues);
  if (!config) return;

  const type = config.type;
  if (type !== undefined) {
    validateEnum(type, `${field}.type`, new Set(['stdio', 'http', 'sse']), issues);
  }

  if (config.command !== undefined) {
    const command = validateNonEmptyString(config.command, `${field}.command`, issues);
    if (command) {
      validatePathValue(command, `${field}.command`, projectPath, issues);
    }
  }

  if (config.args !== undefined) {
    validateStringArray(config.args, `${field}.args`, issues);
  }

  if (config.url !== undefined) {
    const url = validateNonEmptyString(config.url, `${field}.url`, issues);
    if (url) {
      validateUrl(url, `${field}.url`, issues, ['http:', 'https:']);
    }
  }

  if (config.headers !== undefined) {
    const headers = requireRecord(config.headers, `${field}.headers`, issues);
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        if (name.trim().length === 0) {
          issues.push(`${field}.headers contains an empty header name`);
        }
        validateNonEmptyString(value, `${field}.headers.${name}`, issues);
      }
    }
  }

  const hasCommand = typeof config.command === 'string' && config.command.trim().length > 0;
  const hasUrl = typeof config.url === 'string' && config.url.trim().length > 0;
  if (!hasCommand && !hasUrl) {
    issues.push(`${field} must define either a non-empty command or url`);
  }
}

function validatePathValue(value: string, field: string, projectPath: string, issues: string[]): void {
  if (value.includes('\u0000')) {
    issues.push(`${field} contains an invalid null byte`);
    return;
  }
  if (value.includes('${')) return;
  if (!looksLikePath(value)) return;

  const resolved = resolvePath(value, projectPath);
  if (!existsSync(resolved)) {
    issues.push(`${field} points to a missing path: ${resolved}`);
  }
}

function looksLikePath(value: string): boolean {
  return value.startsWith('.')
    || value.startsWith('/')
    || value.startsWith('~')
    || value.includes('/')
    || value.includes('\\');
}

function resolvePath(value: string, projectPath: string): string {
  if (value.startsWith('~/')) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(projectPath, value);
}

function validateUrl(value: string, field: string, issues: string[], protocols: string[]): void {
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) {
      issues.push(`${field} must use ${protocols.join(' or ')} protocol`);
    }
  } catch {
    issues.push(`${field} must be a valid URL`);
  }
}

function validateBoolean(value: unknown, field: string, issues: string[]): void {
  if (typeof value !== 'boolean') {
    issues.push(`${field} must be a boolean`);
  }
}

function validateExactValue(value: unknown, field: string, expected: string, issues: string[]): void {
  if (value !== expected) {
    issues.push(`${field} must be "${expected}"`);
  }
}

function validateEnum(value: unknown, field: string, allowed: Set<string>, issues: string[]): void {
  if (typeof value !== 'string' || !allowed.has(value)) {
    issues.push(`${field} must be one of: ${[...allowed].join(', ')}`);
  }
}

function validateNumber(
  value: unknown,
  field: string,
  issues: string[],
  opts: { integer?: boolean; min?: number; max?: number } = {},
): void {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    issues.push(`${field} must be a finite number`);
    return;
  }

  if (opts.integer && !Number.isInteger(value)) {
    issues.push(`${field} must be an integer`);
  }
  if (opts.min !== undefined && value < opts.min) {
    issues.push(`${field} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    issues.push(`${field} must be <= ${opts.max}`);
  }
}

function validateNonEmptyString(value: unknown, field: string, issues: string[]): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${field} must be a non-empty string`);
    return null;
  }
  return value.trim();
}

function validateStringArray(
  value: unknown,
  field: string,
  issues: string[],
  opts: { minLength?: number } = {},
): string[] | null {
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array`);
    return null;
  }

  if (opts.minLength !== undefined && value.length < opts.minLength) {
    issues.push(`${field} must contain at least ${opts.minLength} item(s)`);
  }

  const result: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      issues.push(`${field}[${i}] must be a non-empty string`);
      continue;
    }
    result.push(item.trim());
  }
  return result;
}

function requireRecord(value: unknown, field: string, issues: string[]): ConfigRecord | null {
  if (!isRecord(value)) {
    issues.push(`${field} must be an object`);
    return null;
  }
  return value;
}
