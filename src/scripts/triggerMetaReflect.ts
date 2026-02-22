#!/usr/bin/env node
/**
 * Manual trigger for meta-reflect: analyzes recent task data and proposes prompt patches.
 * Usage: node dist/scripts/triggerMetaReflect.js [--project <path>]
 */

import { Config } from '../config/Config.js';
import { TaskStore } from '../memory/TaskStore.js';
import { GlobalMemory } from '../memory/GlobalMemory.js';
import { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import { McpDiscovery } from '../mcp/McpDiscovery.js';
import { TrendAnalyzer } from '../evolution/TrendAnalyzer.js';
import { EvolutionEngine } from '../evolution/EvolutionEngine.js';
import { PromptRegistry } from '../prompts/PromptRegistry.js';
import { log } from '../utils/logger.js';

async function main() {
  const projectPath = process.argv.includes('--project')
    ? process.argv[process.argv.indexOf('--project') + 1]
    : process.cwd();

  log.info(`Meta-reflect trigger for project: ${projectPath}`);

  const config = new Config(projectPath);
  const { memory, claude: claudeConfig, mcp: mcpConfig } = config.values;

  const globalMemory = new GlobalMemory(memory.pgConnectionString);
  const taskStore = new TaskStore(memory.pgConnectionString);
  await globalMemory.init();
  await taskStore.init();

  // Show current data counts
  const recentReviews = await taskStore.getRecentReviewEvents(projectPath, 20);
  const doneTasks = await taskStore.listTasks(projectPath, 'done');
  const activeVersions = await taskStore.getActivePromptVersions(projectPath);
  const candidates = await taskStore.getCandidatePromptVersions(projectPath);

  log.info(`Data: ${recentReviews.length} reviews, ${doneTasks.length} done tasks, ${activeVersions.length} active patches, ${candidates.length} candidate patches`);

  // Initialize Claude bridge
  const mcpDiscovery = new McpDiscovery(mcpConfig);
  await mcpDiscovery.discover();
  const claudeBridge = new ClaudeBridge(claudeConfig, mcpDiscovery);

  // Create evolution engine
  const trendAnalyzer = new TrendAnalyzer(taskStore);
  const evolutionEngine = new EvolutionEngine(taskStore, globalMemory, config, trendAnalyzer);

  // Run meta-reflect
  log.info('Starting meta-reflect...');
  const start = Date.now();
  await evolutionEngine.metaReflect(projectPath, claudeBridge);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log.info(`Meta-reflect completed in ${elapsed}s`);

  // Show results
  const newActiveVersions = await taskStore.getActivePromptVersions(projectPath);
  const newCandidates = await taskStore.getCandidatePromptVersions(projectPath);

  log.info(`Results: ${newActiveVersions.length} active patches, ${newCandidates.length} candidate patches`);

  for (const v of newCandidates) {
    log.info(`  Candidate: ${v.prompt_name} v${v.version} — confidence=${v.confidence}, rationale="${v.rationale.slice(0, 120)}"`);
    for (const p of v.patches) {
      log.info(`    [${p.op}] ${p.section ?? '(global)'}: ${p.reason.slice(0, 100)}`);
    }
  }

  for (const v of newActiveVersions) {
    log.info(`  Active: ${v.prompt_name} v${v.version} — effectiveness=${v.effectiveness}, tasks_evaluated=${v.tasks_evaluated}`);
  }

  // Refresh prompt registry to show resolved state
  const registry = new PromptRegistry(taskStore, projectPath);
  await registry.refresh();

  // Cleanup
  await globalMemory.close();
  await taskStore.close();
  await log.shutdown();
}

main().catch(err => {
  console.error('Meta-reflect failed:', err);
  process.exit(1);
});
