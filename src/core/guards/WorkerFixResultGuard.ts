import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export class WorkerFixResultGuard {
  async handle(event: CycleEvent): Promise<void> {
    const verification = event.data.verification as { passed: boolean; reason?: string } | undefined;
    if (!verification) return;
    if (!verification.passed) {
      log.warn('WorkerFixResultGuard: workerFix did not resolve verification failure', {
        reason: verification.reason,
      });
    }
  }
}
