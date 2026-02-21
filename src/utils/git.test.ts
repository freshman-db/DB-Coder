import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { commitAll, getModifiedAndAddedFiles } from './git.js';
import type { LogEntry } from './logger.js';
import { log } from './logger.js';
import { runProcess } from './process.js';

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess('git', args, { cwd });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function createRepo(prefix: string): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  return repo;
}

async function getHeadChangedFiles(cwd: string): Promise<string[]> {
  const output = await git(cwd, ['show', '--name-only', '--pretty=format:', 'HEAD']);
  return output.split('\n').map(line => line.trim()).filter(Boolean);
}

test('getModifiedAndAddedFiles returns only modified and added paths', async () => {
  const repo = await createRepo('db-coder-git-status-');
  try {
    writeFileSync(join(repo, 'keep.txt'), 'keep-v1\n', 'utf-8');
    writeFileSync(join(repo, 'remove.txt'), 'remove-v1\n', 'utf-8');
    await git(repo, ['add', 'keep.txt', 'remove.txt']);
    await git(repo, ['commit', '-m', 'initial']);

    writeFileSync(join(repo, 'keep.txt'), 'keep-v2\n', 'utf-8');
    rmSync(join(repo, 'remove.txt'));
    writeFileSync(join(repo, 'new.txt'), 'new\n', 'utf-8');

    const changedFiles = await getModifiedAndAddedFiles(repo);
    assert.deepEqual(changedFiles.sort(), ['keep.txt', 'new.txt']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('commitAll stages only provided files', async () => {
  const repo = await createRepo('db-coder-git-commit-');
  try {
    writeFileSync(join(repo, 'safe.txt'), 'safe-v1\n', 'utf-8');
    writeFileSync(join(repo, 'other.txt'), 'other-v1\n', 'utf-8');
    await git(repo, ['add', 'safe.txt', 'other.txt']);
    await git(repo, ['commit', '-m', 'initial']);

    writeFileSync(join(repo, 'safe.txt'), 'safe-v2\n', 'utf-8');
    writeFileSync(join(repo, 'other.txt'), 'other-v2\n', 'utf-8');

    await commitAll('commit safe only', repo, ['safe.txt']);

    assert.deepEqual(await getHeadChangedFiles(repo), ['safe.txt']);

    const status = await git(repo, ['status', '--porcelain']);
    assert.match(status, /other\.txt$/m);
    assert.doesNotMatch(status, /safe\.txt$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('commitAll skips sensitive patterns and logs warnings', async () => {
  const repo = await createRepo('db-coder-git-sensitive-');
  try {
    mkdirSync(join(repo, 'keys'), { recursive: true });
    mkdirSync(join(repo, 'notes'), { recursive: true });
    writeFileSync(join(repo, 'safe.txt'), 'safe-v1\n', 'utf-8');
    writeFileSync(join(repo, '.env'), 'TOKEN=before\n', 'utf-8');
    writeFileSync(join(repo, 'keys', 'server.pem'), 'pem-before\n', 'utf-8');
    writeFileSync(join(repo, 'credentials.txt'), 'credentials-before\n', 'utf-8');
    writeFileSync(join(repo, 'notes', 'secret-plan.md'), 'secret-before\n', 'utf-8');
    await git(repo, ['add', 'safe.txt', '.env', 'keys/server.pem', 'credentials.txt', 'notes/secret-plan.md']);
    await git(repo, ['commit', '-m', 'initial']);

    writeFileSync(join(repo, 'safe.txt'), 'safe-v2\n', 'utf-8');
    writeFileSync(join(repo, '.env'), 'TOKEN=after\n', 'utf-8');
    writeFileSync(join(repo, 'keys', 'server.pem'), 'pem-after\n', 'utf-8');
    writeFileSync(join(repo, 'credentials.txt'), 'credentials-after\n', 'utf-8');
    writeFileSync(join(repo, 'notes', 'secret-plan.md'), 'secret-after\n', 'utf-8');

    const logs: LogEntry[] = [];
    const removeListener = log.addListener((entry) => logs.push(entry));
    try {
      await commitAll('commit non-sensitive changes', repo, [
        'safe.txt',
        '.env',
        'keys/server.pem',
        'credentials.txt',
        'notes/secret-plan.md',
      ]);
    } finally {
      removeListener();
    }

    assert.deepEqual(await getHeadChangedFiles(repo), ['safe.txt']);

    const warningMessages = logs.filter(entry => entry.level === 'warn').map(entry => entry.message);
    assert.equal(warningMessages.length, 4);
    assert.ok(warningMessages.some(message => message.includes('.env')));
    assert.ok(warningMessages.some(message => message.includes('keys/server.pem')));
    assert.ok(warningMessages.some(message => message.includes('credentials.txt')));
    assert.ok(warningMessages.some(message => message.includes('notes/secret-plan.md')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('commitAll no-ops when no eligible files remain after filtering', async () => {
  const repo = await createRepo('db-coder-git-noop-');
  try {
    writeFileSync(join(repo, '.env'), 'TOKEN=before\n', 'utf-8');
    await git(repo, ['add', '.env']);
    await git(repo, ['commit', '-m', 'initial']);

    writeFileSync(join(repo, '.env'), 'TOKEN=after\n', 'utf-8');
    const beforeCommit = await git(repo, ['rev-parse', 'HEAD']);

    await commitAll('should skip commit', repo, ['.env']);

    const afterCommit = await git(repo, ['rev-parse', 'HEAD']);
    assert.equal(afterCommit, beforeCommit);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
