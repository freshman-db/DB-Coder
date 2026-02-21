import type { Phase } from '../mcp/McpDiscovery.js';

/** Known agent capabilities — maps agent name to its plugin, description, and applicable phases */
const KNOWN_AGENTS: Record<string, { plugin: string; description: string; phases: Phase[] }> = {
  'code-explorer':         { plugin: 'feature-dev',       description: 'Trace architecture, map code structure, document dependencies', phases: ['scan', 'plan', 'execute'] },
  'code-architect':        { plugin: 'feature-dev',       description: 'Design feature architectures, provide implementation blueprints', phases: ['plan', 'execute'] },
  'code-reviewer':         { plugin: 'feature-dev',       description: 'Review code for bugs, logic errors, security vulnerabilities', phases: ['review'] },
  'silent-failure-hunter': { plugin: 'pr-review-toolkit', description: 'Audit error handling, find silent failures and swallowed errors', phases: ['review'] },
  'pr-test-analyzer':      { plugin: 'pr-review-toolkit', description: 'Analyze test coverage quality and completeness', phases: ['review'] },
  'code-simplifier':       { plugin: 'pr-review-toolkit', description: 'Simplify code for clarity while preserving functionality', phases: ['scan', 'review'] },
  'comment-analyzer':      { plugin: 'pr-review-toolkit', description: 'Verify documentation accuracy and long-term maintainability', phases: ['review'] },
  'type-design-analyzer':  { plugin: 'pr-review-toolkit', description: 'Analyze type design quality, encapsulation, invariants', phases: ['scan', 'review'] },
};

/**
 * Build agent guidance text for a given phase based on loaded plugins.
 * Returns a markdown section listing available agents for the prompt to reference.
 */
export function buildAgentGuidance(phase: Phase, loadedPluginIds: string[]): string {
  // Normalize plugin IDs: @anthropic-ai/feature-dev → feature-dev
  const normalizedIds = new Set(loadedPluginIds.map(id => {
    const short = id.split('/').pop() ?? id;
    return short;
  }));

  const available: Array<{ name: string; description: string }> = [];

  for (const [agentName, info] of Object.entries(KNOWN_AGENTS)) {
    if (!info.phases.includes(phase)) continue;
    if (!normalizedIds.has(info.plugin)) continue;
    available.push({ name: agentName, description: info.description });
  }

  if (available.length === 0) return '';

  const lines = available.map(a => `- **${a.name}**: ${a.description}`);
  return `\n## Available Specialized Agents (via Task tool)\nYou can spawn these agents using the Task tool for parallel analysis:\n${lines.join('\n')}\n\nLaunch agents in parallel when possible for efficiency. Synthesize their reports into your analysis.\n`;
}
