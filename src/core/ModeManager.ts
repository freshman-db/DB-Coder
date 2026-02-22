import type { MainLoop } from './MainLoop.js';
import { log } from '../utils/logger.js';

export class PatrolManager {
  constructor(private mainLoop: MainLoop) {}

  getStatus(): { patrolling: boolean; loopState: string } {
    return {
      patrolling: this.mainLoop.isRunning(),
      loopState: this.mainLoop.getState(),
    };
  }

  isPatrolling(): boolean {
    return this.mainLoop.isRunning();
  }

  async startPatrol(): Promise<void> {
    if (this.mainLoop.isRunning()) {
      throw new Error('Patrol is already running');
    }
    log.info('Patrol starting');
    this.mainLoop.start().catch(err => {
      log.error('MainLoop error', err);
    });
  }

  async stopPatrol(): Promise<void> {
    if (!this.mainLoop.isRunning()) {
      throw new Error('Patrol is not running');
    }
    log.info('Stopping patrol...');
    await this.mainLoop.stop();
    await this.mainLoop.waitForStopped();
    log.info('Patrol stopped');
  }
}
