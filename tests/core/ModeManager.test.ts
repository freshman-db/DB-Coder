import assert from 'node:assert/strict';
import test from 'node:test';
import type { MainLoop } from '../../src/core/MainLoop.js';
import type { TaskStore } from '../../src/memory/TaskStore.js';
import { PatrolManager } from '../../src/core/ModeManager.js';

interface ServiceStateWrite {
  projectPath: string;
  key: string;
  value: string;
}

interface PatrolFixture {
  manager: PatrolManager;
  stateWrites: ServiceStateWrite[];
  getRunning(): boolean;
  getLoopState(): string;
}

function createPatrolFixture(initialRunning = false): PatrolFixture {
  let running = initialRunning;
  let loopState = initialRunning ? 'running' : 'idle';
  const serviceState = new Map<string, string>();
  const stateWrites: ServiceStateWrite[] = [];

  const mainLoop = {
    isRunning: () => running,
    getState: () => loopState,
    start: async () => {
      running = true;
      loopState = 'running';
    },
    stop: async () => {
      running = false;
      loopState = 'stopping';
    },
    waitForStopped: async () => {
      loopState = 'idle';
    },
  } as unknown as MainLoop;

  const taskStore = {
    setServiceState: async (projectPath: string, key: string, value: string) => {
      serviceState.set(`${projectPath}:${key}`, value);
      stateWrites.push({ projectPath, key, value });
    },
    getServiceState: async (projectPath: string, key: string) => {
      return serviceState.get(`${projectPath}:${key}`) ?? null;
    },
  } as unknown as TaskStore;

  const manager = new PatrolManager(mainLoop, taskStore, '/repo/project');
  return {
    manager,
    stateWrites,
    getRunning: () => running,
    getLoopState: () => loopState,
  };
}

test('PatrolManager start/stop updates status and persisted patrol state', async () => {
  const fixture = createPatrolFixture();

  assert.deepEqual(fixture.manager.getStatus(), { patrolling: false, loopState: 'idle' });
  assert.equal(fixture.manager.isPatrolling(), false);

  await fixture.manager.startPatrol();

  assert.equal(fixture.getRunning(), true);
  assert.equal(fixture.manager.isPatrolling(), true);
  assert.deepEqual(fixture.manager.getStatus(), { patrolling: true, loopState: 'running' });
  assert.deepEqual(fixture.stateWrites.map(write => write.value), ['true']);
  assert.equal(await fixture.manager.shouldResumePatrol(), true);

  await fixture.manager.stopPatrol();

  assert.equal(fixture.getRunning(), false);
  assert.deepEqual(fixture.manager.getStatus(), { patrolling: false, loopState: 'idle' });
  assert.deepEqual(fixture.stateWrites.map(write => write.value), ['true', 'false']);
  assert.equal(fixture.getLoopState(), 'idle');
  assert.equal(await fixture.manager.shouldResumePatrol(), false);
});

test('PatrolManager rejects double-start attempts', async () => {
  const fixture = createPatrolFixture();

  await fixture.manager.startPatrol();
  await assert.rejects(fixture.manager.startPatrol(), /already running/i);

  assert.deepEqual(fixture.stateWrites.map(write => write.value), ['true']);
});

test('PatrolManager stopPatrol throws when patrol is not running', async () => {
  const fixture = createPatrolFixture();

  await assert.rejects(fixture.manager.stopPatrol(), /not running/i);
  assert.equal(fixture.stateWrites.length, 0);
});
