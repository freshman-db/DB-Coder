import type { MainLoop } from './MainLoop.js';
import type { TaskStore } from '../memory/TaskStore.js';
import { log } from '../utils/logger.js';

const PATROL_STATE_KEY = 'patrol_active';

export class PatrolManager {
  constructor(
    private mainLoop: MainLoop,
    private taskStore: TaskStore,
    private projectPath: string,
  ) {}

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
    await this.taskStore.setServiceState(this.projectPath, PATROL_STATE_KEY, 'true');
    this.mainLoop.start().catch(err => {
      log.error('MainLoop error', err);
    });
  }

  async stopPatrol(): Promise<void> {
    if (!this.mainLoop.isRunning()) {
      throw new Error('Patrol is not running');
    }
    log.info('Stopping patrol...');
    await this.taskStore.setServiceState(this.projectPath, PATROL_STATE_KEY, 'false');
    await this.mainLoop.stop();
    await this.mainLoop.waitForStopped();
    log.info('Patrol stopped');
  }

  async shouldResumePatrol(): Promise<boolean> {
    const state = await this.taskStore.getServiceState(this.projectPath, PATROL_STATE_KEY);
    return state === 'true';
  }
}
