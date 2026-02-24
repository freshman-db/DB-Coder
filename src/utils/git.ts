import { runProcess, type ProcessResult } from './process.js';
import { log } from './logger.js';
import { basename } from 'node:path';

export const SENSITIVE_PATTERNS = ['.env*', '*.pem', 'credentials*', '*secret*'] as const;

/** Porcelain statuses indicating a file change — includes D for rename/deletion support. */
const CHANGED_STATUSES = new Set(['M', 'A', 'R', 'C', 'T', '?', 'D']);
const SENSITIVE_FILE_REGEXES = SENSITIVE_PATTERNS.map(patternToRegex);

/** Max files per git-add invocation to stay within OS ARG_MAX limits. */
const GIT_ADD_BATCH_SIZE = 100;

async function git(args: string[], cwd: string): Promise<ProcessResult> {
  return runProcess('git', args, { cwd });
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function isSensitiveFile(filePath: string): boolean {
  const fileName = basename(filePath);
  return SENSITIVE_FILE_REGEXES.some(regex => regex.test(fileName));
}

function parseStatusPath(path: string): string {
  const renameSeparator = ' -> ';
  const renameIndex = path.indexOf(renameSeparator);
  if (renameIndex === -1) return path;
  return path.slice(renameIndex + renameSeparator.length);
}

function isChangedStatus(status: string): boolean {
  return CHANGED_STATUSES.has(status);
}

export async function getModifiedAndAddedFiles(cwd: string): Promise<string[]> {
  const r = await git(['status', '--porcelain', '--untracked-files=all'], cwd);
  const files = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    if (line.length < 4) continue;
    const indexStatus = line[0] ?? ' ';
    const worktreeStatus = line[1] ?? ' ';
    if (!isChangedStatus(indexStatus) && !isChangedStatus(worktreeStatus)) continue;
    const path = parseStatusPath(line.slice(3).trim());
    if (!path) continue;
    files.add(path);
  }
  return [...files];
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return r.stdout.trim();
}

export async function getHeadCommit(cwd: string): Promise<string> {
  const r = await git(['rev-parse', 'HEAD'], cwd);
  return r.stdout.trim();
}

export async function isWorkingClean(cwd: string): Promise<boolean> {
  const r = await git(['status', '--porcelain'], cwd);
  return r.stdout.trim() === '';
}

export async function createBranch(name: string, cwd: string): Promise<void> {
  await git(['checkout', '-b', name], cwd);
  log.info(`Created branch: ${name}`);
}

export async function switchBranch(name: string, cwd: string): Promise<void> {
  await git(['checkout', name], cwd);
}

export async function commitAll(message: string, cwd: string, files: string[]): Promise<void> {
  const eligibleFiles: string[] = [];
  for (const file of new Set(files.filter(Boolean))) {
    if (isSensitiveFile(file)) {
      log.warn(`Skipping sensitive file during staging: ${file}`);
      continue;
    }
    eligibleFiles.push(file);
  }

  if (eligibleFiles.length === 0) {
    log.info('Nothing to commit');
    return;
  }

  // Stage eligible files in batches to stay within OS ARG_MAX limits
  for (let i = 0; i < eligibleFiles.length; i += GIT_ADD_BATCH_SIZE) {
    const batch = eligibleFiles.slice(i, i + GIT_ADD_BATCH_SIZE);
    await git(['add', '--', ...batch], cwd);
  }

  // Defense-in-depth: unstage any sensitive files that may have been
  // pre-staged by operations outside commitAll()
  const stagedResult = await git(['diff', '--cached', '--name-only'], cwd);
  const allStaged = stagedResult.stdout.trim().split('\n').filter(Boolean);
  const sensitiveStaged = allStaged.filter(f => isSensitiveFile(f));
  if (sensitiveStaged.length > 0) {
    await git(['restore', '--staged', '--', ...sensitiveStaged], cwd);
    log.warn(`Unstaged ${sensitiveStaged.length} pre-staged sensitive file(s)`);
  }

  // Re-check staging area after filtering
  const finalStaged = await git(['diff', '--cached', '--name-only'], cwd);
  if (finalStaged.stdout.trim() === '') {
    log.info('Nothing to commit');
    return;
  }

  await git(['commit', '-m', message], cwd);
  log.info(`Committed: ${message}`);
}

export async function getDiff(cwd: string, staged = false): Promise<string> {
  const args = staged ? ['diff', '--cached'] : ['diff'];
  const r = await git(args, cwd);
  return r.stdout;
}

export async function getChangedFilesSince(commit: string, cwd: string): Promise<string[]> {
  const r = await git(['diff', '--name-only', commit, 'HEAD'], cwd);
  return r.stdout.trim().split('\n').filter(Boolean);
}

export async function resetToCommit(commit: string, cwd: string): Promise<void> {
  await git(['reset', '--hard', commit], cwd);
  log.warn(`Reset to commit: ${commit}`);
}

export async function branchExists(name: string, cwd: string): Promise<boolean> {
  const r = await git(['branch', '--list', name], cwd);
  return r.stdout.trim() !== '';
}

export async function getRecentLog(cwd: string, n = 20): Promise<string> {
  const r = await git(['log', '--oneline', `-${n}`], cwd);
  return r.stdout;
}

export async function mergeBranch(branch: string, cwd: string): Promise<void> {
  await git(['merge', '--no-ff', branch, '-m', `Merge branch '${branch}'`], cwd);
  log.info(`Merged branch: ${branch}`);
}

export async function deleteBranch(branch: string, cwd: string): Promise<void> {
  await git(['branch', '-d', branch], cwd);
}

export async function listBranches(prefix: string, cwd: string): Promise<string[]> {
  const r = await git(['branch', '--list', `${prefix}*`], cwd);
  return r.stdout
    .split('\n')
    .map(line => line.replace(/^\*?\s+/, '').trim())
    .filter(Boolean);
}

export async function forceDeleteBranch(branch: string, cwd: string): Promise<void> {
  await git(['branch', '-D', branch], cwd);
  log.info(`Force-deleted branch: ${branch}`);
}

export async function getDiffStats(
  fromCommit: string,
  toCommit: string,
  cwd: string,
): Promise<{ files_changed: number; insertions: number; deletions: number }> {
  const r = await git(['diff', '--shortstat', fromCommit, toCommit], cwd);
  const text = r.stdout.trim();
  if (!text) return { files_changed: 0, insertions: 0, deletions: 0 };

  const filesMatch = text.match(/(\d+) files? changed/);
  const insertMatch = text.match(/(\d+) insertions?/);
  const deleteMatch = text.match(/(\d+) deletions?/);

  return {
    files_changed: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
    deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
  };
}

export async function getDiffSince(fromCommit: string, cwd: string): Promise<string> {
  const r = await git(['diff', fromCommit, 'HEAD'], cwd);
  return r.stdout;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(['rev-parse', '--git-dir'], cwd);
  return r.exitCode === 0;
}
