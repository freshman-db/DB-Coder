import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

interface DashboardStatus {
  currentTaskId?: string | null;
  currentTaskTitle?: string | null;
}

type CurrentTaskSubtitleFn = (status: DashboardStatus) => string;

async function loadCurrentTaskSubtitleFn(): Promise<CurrentTaskSubtitleFn> {
  const scriptPath = new URL('../web/app.js', import.meta.url);
  const script = await readFile(scriptPath, 'utf8');

  const context = {
    window: { addEventListener: () => {} },
    document: {
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    location: { hash: '' },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }),
    requestAnimationFrame: (cb: () => void) => cb(),
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
  };

  vm.runInNewContext(script, context, { filename: scriptPath.pathname });
  const subtitleFn = (context as { getCurrentTaskSubtitle?: CurrentTaskSubtitleFn }).getCurrentTaskSubtitle;
  assert.equal(typeof subtitleFn, 'function');
  if (!subtitleFn) {
    throw new Error('getCurrentTaskSubtitle is not available in app.js');
  }
  return subtitleFn;
}

test('dashboard current task subtitle uses task title first line', async () => {
  const getCurrentTaskSubtitle = await loadCurrentTaskSubtitleFn();
  const subtitle = getCurrentTaskSubtitle({
    currentTaskId: 'task-123',
    currentTaskTitle: 'Fix dashboard status conflict\n\nDetails',
  });

  assert.equal(subtitle, 'Fix dashboard status conflict');
});

test('dashboard current task subtitle falls back to task id when title missing', async () => {
  const getCurrentTaskSubtitle = await loadCurrentTaskSubtitleFn();
  const subtitle = getCurrentTaskSubtitle({
    currentTaskId: 'task-404',
    currentTaskTitle: null,
  });

  assert.equal(subtitle, '\u4efb\u52a1 #task-404');
});

test('dashboard current task subtitle returns idle text when no active task', async () => {
  const getCurrentTaskSubtitle = await loadCurrentTaskSubtitleFn();
  const subtitle = getCurrentTaskSubtitle({
    currentTaskId: null,
    currentTaskTitle: 'unused',
  });

  assert.equal(subtitle, '\u65e0\u8fdb\u884c\u4e2d\u4efb\u52a1');
});
