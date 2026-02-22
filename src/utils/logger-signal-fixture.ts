/**
 * Test fixture: simulates an application with both logger-registered and
 * app-level SIGINT handlers. Used by logger.test.ts to verify that the
 * logger's signal handler does NOT race with or pre-empt the application's
 * graceful shutdown.
 *
 * Usage: node logger-signal-fixture.js <logDir> <markerFile>
 *
 * 1. Creates a Logger (which registers its own SIGINT/SIGTERM handlers).
 * 2. Registers an app-level SIGINT handler that performs async cleanup,
 *    writes a marker file, then calls logger.shutdown() and exits.
 * 3. Sends 'ready' via IPC so the parent test can deliver SIGINT.
 */
import { Logger } from './logger.js';
import { writeFileSync } from 'node:fs';

const logDir = process.argv[2];
const markerFile = process.argv[3];

if (!logDir || !markerFile) {
  process.stderr.write('Usage: logger-signal-fixture <logDir> <markerFile>\n');
  process.exit(1);
}

const logger = new Logger({ logDir, registerExitHandlers: true });

// App-level signal handler — registered AFTER the logger's handler.
// If the logger called process.exit(), this handler would never complete.
process.on('SIGINT', async () => {
  // The app should still be able to log during its shutdown sequence.
  logger.info('app-shutdown-started');

  // Simulate async cleanup work (DB close, server stop, etc.)
  await new Promise(resolve => setTimeout(resolve, 50));

  logger.info('app-shutdown-complete');

  // Prove the handler ran to completion
  writeFileSync(markerFile, 'cleanup-done');

  await logger.shutdown();
  process.exit(0);
});

logger.info('ready');
process.send?.('ready');

// Keep process alive until signalled
setInterval(() => {}, 10_000);
