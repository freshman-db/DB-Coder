#!/usr/bin/env node

import { Command } from 'commander';
import { Config } from './config/Config.js';
import { Client } from './client/Client.js';
import { GlobalMemory } from './memory/GlobalMemory.js';
import { ProjectMemory } from './memory/ProjectMemory.js';
import { TaskStore } from './memory/TaskStore.js';
import { ClaudeBridge } from './bridges/ClaudeBridge.js';
import { CodexBridge } from './bridges/CodexBridge.js';
import { Brain } from './core/Brain.js';
import { TaskQueue } from './core/TaskQueue.js';
import { MainLoop } from './core/MainLoop.js';
import { CostTracker } from './utils/cost.js';
import { Server } from './server/Server.js';
import { McpDiscovery } from './mcp/McpDiscovery.js';
import { log } from './utils/logger.js';

const program = new Command()
  .name('db-coder')
  .description('Autonomous AI coding agent')
  .version('0.1.0');

// --- serve ---
program
  .command('serve')
  .description('Start the db-coder service')
  .option('-p, --project <path>', 'Project path', process.cwd())
  .action(async (opts) => {
    const projectPath = opts.project;
    log.info(`Starting db-coder for project: ${projectPath}`);

    const config = new Config(projectPath);
    const { memory, claude: claudeConfig, codex: codexConfig, budget, mcp: mcpConfig } = config.values;

    // Initialize components
    const globalMemory = new GlobalMemory(memory.pgConnectionString);
    const projectMemory = new ProjectMemory(memory.claudeMemUrl);
    const taskStore = new TaskStore(memory.pgConnectionString);

    await globalMemory.init();
    await taskStore.init();

    // Discover MCP servers from Claude plugins
    const mcpDiscovery = new McpDiscovery(mcpConfig);
    await mcpDiscovery.discover();

    const claudeBridge = new ClaudeBridge(claudeConfig, mcpDiscovery);
    const codexBridge = new CodexBridge(codexConfig);
    const brain = new Brain(claudeBridge, globalMemory, projectMemory, taskStore);
    claudeBridge.setQuestionHandler(brain);
    const taskQueue = new TaskQueue(taskStore);
    const costTracker = new CostTracker(taskStore, budget);
    const mainLoop = new MainLoop(config, brain, taskQueue, claudeBridge, codexBridge, taskStore, globalMemory, costTracker);
    const server = new Server(config, mainLoop, taskStore, globalMemory, costTracker);

    // Global error handlers
    process.on('unhandledRejection', (err) => { log.error('Unhandled rejection', err); });
    process.on('uncaughtException', (err) => { log.error('Uncaught exception', err); });

    // Graceful shutdown
    const shutdown = async () => {
      log.info('Shutting down...');
      await mainLoop.stop();
      await server.stop();
      await globalMemory.close();
      await taskStore.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Start server and main loop
    await server.start();
    mainLoop.start().catch(err => log.error('MainLoop error', err));
  });

// --- Client commands ---
function getClient(): Client {
  return new Client();
}

program
  .command('status')
  .description('Show service status')
  .action(async () => {
    try {
      const status = await getClient().status();
      console.log(JSON.stringify(status, null, 2));
    } catch {
      console.error('Service not running. Start with: db-coder serve');
    }
  });

program
  .command('add <description>')
  .description('Add a task')
  .option('-p, --priority <n>', 'Priority (0=urgent, 3=optional)', '2')
  .action(async (description, opts) => {
    const task = await getClient().addTask(description, parseInt(opts.priority));
    console.log('Task added:', JSON.stringify(task, null, 2));
  });

program
  .command('queue')
  .description('Show task queue')
  .action(async () => {
    const tasks = await getClient().listTasks() as Array<{ id: string; priority: number; status: string; task_description: string }>;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      console.log('No tasks.');
      return;
    }
    for (const t of tasks) {
      const statusIcon = { queued: '⏳', active: '🔄', done: '✅', failed: '❌', blocked: '🚫', skipped: '⏭️' }[t.status] ?? '?';
      console.log(`${statusIcon} [P${t.priority}] ${t.task_description.slice(0, 60)}  (${t.id.slice(0, 8)})`);
    }
  });

program
  .command('logs')
  .description('Show real-time logs')
  .option('-f, --follow', 'Follow log stream')
  .action(async (opts) => {
    if (opts.follow) {
      console.log('Following logs (Ctrl+C to stop)...');
      await getClient().followLogs((entry: any) => {
        const { timestamp, level, message } = entry;
        console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
      });
    } else {
      const status = await getClient().status();
      console.log(JSON.stringify(status, null, 2));
    }
  });

program
  .command('pause')
  .description('Pause the main loop')
  .action(async () => {
    await getClient().pause();
    console.log('Paused.');
  });

program
  .command('resume')
  .description('Resume the main loop')
  .action(async () => {
    await getClient().resume();
    console.log('Resumed.');
  });

program
  .command('scan')
  .description('Trigger a project scan')
  .option('--deep', 'Deep scan')
  .action(async (opts) => {
    const depth = opts.deep ? 'deep' : 'normal';
    await getClient().triggerScan(depth);
    console.log(`Scan triggered (${depth}).`);
  });

program
  .command('memory <action>')
  .description('Memory management (search|add)')
  .argument('[query...]', 'Search query or memory content')
  .option('-c, --category <cat>', 'Memory category', 'experience')
  .option('-t, --title <title>', 'Memory title')
  .action(async (action, query, opts) => {
    const client = getClient();
    if (action === 'search') {
      const q = query.join(' ');
      const results = await client.searchMemory(q);
      console.log(JSON.stringify(results, null, 2));
    } else if (action === 'add') {
      const content = query.join(' ');
      const title = opts.title ?? content.slice(0, 50);
      await client.addMemory(opts.category, title, content);
      console.log('Memory added.');
    } else {
      console.error('Unknown action. Use: search or add');
    }
  });

program
  .command('cost')
  .description('Show cost details')
  .action(async () => {
    const cost = await getClient().getCost();
    console.log(JSON.stringify(cost, null, 2));
  });

program
  .command('blocked')
  .description('Show blocked tasks')
  .action(async () => {
    const tasks = await getClient().listTasks() as Array<{ id: string; priority: number; status: string; task_description: string }>;
    const blocked = (Array.isArray(tasks) ? tasks : []).filter(t => t.status === 'blocked');
    if (blocked.length === 0) {
      console.log('No blocked tasks.');
      return;
    }
    for (const t of blocked) {
      console.log(`🚫 [P${t.priority}] ${t.task_description.slice(0, 60)}  (${t.id.slice(0, 8)})`);
    }
  });

program.parse();
