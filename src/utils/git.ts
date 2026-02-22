import { runProcess, type ProcessResult } from './process.js';
import { log } from './logger.js';

async function git(args: string[], cwd: string): Promise<ProcessResult> {
  return runProcess('git', args, { cwd });
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

export async function commitAll(message: string, cwd: string): Promise<void> {
  await git(['add', '-A'], cwd);
  const status = await git(['status', '--porcelain'], cwd);
  if (status.stdout.trim() === '') {
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

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(['rev-parse', '--git-dir'], cwd);
  return r.exitCode === 0;
}
