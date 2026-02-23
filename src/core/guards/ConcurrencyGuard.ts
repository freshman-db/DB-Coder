import type { CycleEvent } from '../CycleEvents.js';
import { existsSync, readFileSync } from 'node:fs';
import { log } from '../../utils/logger.js';

export class ConcurrencyGuard {
  constructor(private lockFile: string) {}

  async handle(event: CycleEvent): Promise<void> {
    if (!existsSync(this.lockFile)) return;
    try {
      const pid = parseInt(readFileSync(this.lockFile, 'utf-8'), 10);
      if (pid !== process.pid) {
        process.kill(pid, 0);
        throw new Error(`Another db-coder process (pid ${pid}) holds the lock`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('holds the lock')) throw err;
    }
  }
}
