import { runProcess, type ProcessResult } from './process.js';
import { log } from './logger.js';
import { basename } from 'node:path';

export const SENSITIVE_PATTERNS = ['.env', '*.pem', 'credentials*', '*secret*'] as const;

const MODIFIED_OR_ADDED_STATUSES = new Set(['M', 'A', 'R', 'C', 'T', '?']);
const SENSITIVE_FILE_REGEXES = SENSITIVE_PATTERNS.map(patternToRegex);

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
  return SENSITIVE_FILE_REGEXES.some(regex => regex.test(filePath) || regex.test(fileName));
}

function parseStatusPath(path: string): string {
  const renameSeparator = ' -> ';
  const renameIndex = path.indexOf(renameSeparator);
  if (renameIndex === -1) return path;
  return path.slice(renameIndex + renameSeparator.length);
}

function isModifiedOrAddedStatus(status: string): boolean {
  return MODIFIED_OR_ADDED_STATUSES.has(status);
}

export async function getModifiedAndAddedFiles(cwd: string): Promise<string[]> {
  const r = await git(['status', '--porcelain', '--untracked-files=all'], cwd);
  const files = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    if (line.length < 4) continue;
    const indexStatus = line[0] ?? ' ';
    const worktreeStatus = line[1] ?? ' ';
    if (!isModifiedOrAddedStatus(indexStatus) && !isModifiedOrAddedStatus(worktreeStatus)) continue;
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

  await git(['add', '--', ...eligibleFiles], cwd);
  const staged = await git(['diff', '--cached', '--name-only', '--', ...eligibleFiles], cwd);
  if (staged.stdout.trim() === '') {
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

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(['rev-parse', '--git-dir'], cwd);
  return r.exitCode === 0;
}
