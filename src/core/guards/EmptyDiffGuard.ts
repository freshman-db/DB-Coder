import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export type GetDiffStatsFn = (startCommit: string) => Promise<DiffStats>;

export class EmptyDiffGuard {
  constructor(private getDiffStats: GetDiffStatsFn) {}

  async handle(event: CycleEvent): Promise<void> {
    const startCommit = event.data.startCommit as string | undefined;
    if (!startCommit) return;

    const stats = await this.getDiffStats(startCommit);
    if (stats.filesChanged === 0) {
      log.warn('EmptyDiffGuard: worker produced no code changes', { startCommit });
      throw new Error('Worker produced no code changes');
    }
    log.info('EmptyDiffGuard: diff OK', { files: stats.filesChanged, ins: stats.insertions, del: stats.deletions });
  }
}
