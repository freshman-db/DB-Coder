#!/usr/bin/env node

import { resolve } from "node:path";
import { Command } from "commander";
import { Config } from "./config/Config.js";
import { Client } from "./client/Client.js";
import { GlobalMemory } from "./memory/GlobalMemory.js";
import { TaskStore } from "./memory/TaskStore.js";
import { CodexBridge } from "./bridges/CodexBridge.js";
import { TaskQueue } from "./core/TaskQueue.js";
import { MainLoop } from "./core/MainLoop.js";
import { CycleEventBus } from "./core/CycleEventBus.js";
import { registerGuards } from "./core/guards/index.js";
import { registerObservers } from "./core/observers/index.js";
import { registerStrategies } from "./core/strategies/index.js";
import { CostTracker } from "./utils/cost.js";
import { Server } from "./server/Server.js";
import { emitSseEvent } from "./server/routes.js";
import { PatrolManager } from "./core/ModeManager.js";
import { PlanChatManager } from "./core/PlanChatManager.js";
import { log, type LogEntry } from "./utils/logger.js";
import { truncate } from "./utils/parse.js";
import { validateConfigForStartup } from "./startup/configValidation.js";
import { wireGracefulShutdown } from "./startup/gracefulShutdown.js";
import { checkAndRecoverErrors } from "./startup/errorRecovery.js";
import { TASK_DESC_MAX_LENGTH } from "./types/constants.js";
import { discoverPlugins } from "./bridges/pluginDiscovery.js";
import { buildHooks } from "./bridges/hooks.js";
import type { SdkExtras } from "./bridges/buildSdkOptions.js";
import { createSystemDataMcpServer } from "./mcp/SystemDataMcp.js";

const program = new Command()
  .name("db-coder")
  .description("Autonomous AI coding agent")
  .version("0.1.0");

// --- serve ---
program
  .command("serve")
  .description("Start the db-coder service")
  .option("-p, --project <path>", "Project path", process.cwd())
  .action(async (opts) => {
    const projectPath = resolve(opts.project);
    log.info(`Starting db-coder for project: ${projectPath}`);

    const config = new Config(projectPath);
    if (!validateConfigForStartup(config.values, config.projectPath)) {
      process.exitCode = 1;
      return;
    }

    const { memory, codex: codexConfig, budget } = config.values;

    // Initialize components
    const globalMemory = new GlobalMemory(memory.pgConnectionString);
    const taskStore = new TaskStore(memory.pgConnectionString);

    await globalMemory.init();
    await taskStore.init();

    // Check for error files from previous failed builds
    const recoveredErrors = await checkAndRecoverErrors(taskStore, projectPath);
    if (recoveredErrors > 0) {
      log.warn(
        `Created ${recoveredErrors} P0 recovery task(s) from previous errors`,
      );
    }

    const codexBridge = new CodexBridge(codexConfig);
    const taskQueue = new TaskQueue(taskStore);
    const costTracker = new CostTracker(taskStore, budget);

    const eventBus = new CycleEventBus();

    registerGuards(eventBus, {
      getDiffStats: async (startCommit: string) => {
        const { getDiffStats } = await import("./utils/git.js");
        const stats = await getDiffStats(startCommit, "HEAD", projectPath);
        return {
          filesChanged: stats.files_changed,
          insertions: stats.insertions,
          deletions: stats.deletions,
        };
      },
      getBudgetInfo: async () => {
        const dailyCost = await taskStore.getDailyCost();
        return {
          remainingUsd:
            config.values.budget.maxPerDay - dailyCost.total_cost_usd,
          avgTaskCostUsd: 2,
        };
      },
      lockFile: `${process.env.HOME}/.db-coder/patrol.lock`,
    });

    const observers = registerObservers(eventBus, {
      sseBroadcast: emitSseEvent,
    });

    registerStrategies(eventBus, {
      getProjectHealth: async () => ({
        tscErrors: 0, // Will be populated by actual tsc check in later iteration
        recentSuccessRate: 0.8,
        blockedTaskCount: 0,
      }),
    });

    // Discover plugins and build hooks for SDK sessions
    const plugins = discoverPlugins();
    const hooks = buildHooks({
      onToolResult: (name, _input, _response) => {
        log.debug(`Tool used: ${name}`);
      },
    });
    const systemDataMcp = createSystemDataMcpServer({ projectPath, taskStore });
    const sdkExtras: SdkExtras = {
      plugins,
      hooks,
      mcpServers: { "db-coder-system-data": systemDataMcp },
    };

    const mainLoop = new MainLoop(
      config,
      taskQueue,
      codexBridge,
      taskStore,
      costTracker,
      eventBus,
      sdkExtras,
    );
    const patrolManager = new PatrolManager(mainLoop, taskStore, projectPath);
    const planChat = new PlanChatManager(taskStore, config);

    const server = new Server(
      config,
      mainLoop,
      taskStore,
      globalMemory,
      costTracker,
      observers,
      patrolManager,
      planChat,
    );

    // Global error handlers
    process.on("unhandledRejection", (err) => {
      log.error("Unhandled rejection", err);
    });
    process.on("uncaughtException", (err) => {
      log.error("Uncaught exception", err);
    });

    wireGracefulShutdown({
      mainLoop,
      server,
      taskStore,
      globalMemory,
    });

    // Register restart handler for self-build scenarios
    const RESTART_EXIT_CODE = 75;
    mainLoop.onRestart(() => {
      log.info(`Self-build restart: exiting with code ${RESTART_EXIT_CODE}`);
      server.stop().catch(() => {});
      globalMemory.close().catch(() => {});
      taskStore.close().catch(() => {});
      process.exit(RESTART_EXIT_CODE);
    });

    await server.start();

    // Resume patrol if it was active before shutdown/restart
    try {
      if (await patrolManager.shouldResumePatrol()) {
        log.info("Resuming patrol from previous session");
        await patrolManager.startPatrol();
      } else {
        log.info("db-coder ready. Awaiting mode selection via Web UI or API.");
      }
    } catch (err) {
      log.warn(`Failed to resume patrol: ${err}`);
      log.info("db-coder ready. Awaiting mode selection via Web UI or API.");
    }
  });

// --- Client commands ---
function getClient(): Client {
  return new Client();
}

function isLogEntry(entry: unknown): entry is LogEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const c = entry as {
    timestamp?: unknown;
    level?: unknown;
    message?: unknown;
  };
  return (
    typeof c.timestamp === "string" &&
    (c.level === "debug" ||
      c.level === "info" ||
      c.level === "warn" ||
      c.level === "error") &&
    typeof c.message === "string"
  );
}

program
  .command("status")
  .description("Show service status")
  .action(async () => {
    try {
      const status = await getClient().status();
      console.log(JSON.stringify(status, null, 2));
    } catch {
      console.error("Service not running. Start with: db-coder serve");
    }
  });

program
  .command("add <description>")
  .description("Add a task")
  .option("-p, --priority <n>", "Priority (0=urgent, 3=optional)", "2")
  .action(async (description, opts) => {
    const task = await getClient().addTask(
      description,
      parseInt(opts.priority),
    );
    console.log("Task added:", JSON.stringify(task, null, 2));
  });

program
  .command("queue")
  .description("Show task queue")
  .action(async () => {
    const { tasks } = await getClient().listTasks();
    if (tasks.length === 0) {
      console.log("No tasks.");
      return;
    }
    for (const t of tasks) {
      const statusIcon: string =
        {
          queued: "⏳",
          active: "🔄",
          done: "✅",
          failed: "❌",
          blocked: "🚫",
          skipped: "⏭️",
          pending_review: "👀",
        }[t.status] ?? "?";
      console.log(
        `${statusIcon} [P${t.priority}] ${truncate(t.task_description, TASK_DESC_MAX_LENGTH)}  (${t.id.slice(0, 8)})`,
      );
    }
  });

program
  .command("logs")
  .description("Show real-time logs")
  .option("-f, --follow", "Follow log stream")
  .action(async (opts) => {
    if (opts.follow) {
      console.log("Following logs (Ctrl+C to stop)...");
      await getClient().followLogs((entry) => {
        if (!isLogEntry(entry)) return;
        const { timestamp, level, message } = entry;
        console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
      });
    } else {
      const status = await getClient().status();
      console.log(JSON.stringify(status, null, 2));
    }
  });

program
  .command("pause")
  .description("Pause the main loop")
  .action(async () => {
    await getClient().pause();
    console.log("Paused.");
  });

program
  .command("resume")
  .description("Resume the main loop")
  .action(async () => {
    await getClient().resume();
    console.log("Resumed.");
  });

program
  .command("scan")
  .description("Trigger a project scan")
  .option("--deep", "Deep scan")
  .action(async (opts) => {
    const depth = opts.deep ? "deep" : "normal";
    await getClient().triggerScan(depth);
    console.log(`Scan triggered (${depth}).`);
  });

program
  .command("cost")
  .description("Show cost details")
  .action(async () => {
    const cost = await getClient().getCost();
    console.log(JSON.stringify(cost, null, 2));
  });

program
  .command("blocked")
  .description("Show blocked tasks")
  .action(async () => {
    const { tasks } = await getClient().listTasks();
    const blocked = tasks.filter((t) => t.status === "blocked");
    if (blocked.length === 0) {
      console.log("No blocked tasks.");
      return;
    }
    for (const t of blocked) {
      console.log(
        `🚫 [P${t.priority}] ${truncate(t.task_description, TASK_DESC_MAX_LENGTH)}  (${t.id.slice(0, 8)})`,
      );
    }
  });

program.parse();
