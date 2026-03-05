import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  commitAll,
  getModifiedAndAddedFiles,
  mergeBranch,
  resetToCommit,
  switchBranch,
} from "./git.js";
import type { LogEntry } from "./logger.js";
import { log } from "./logger.js";
import { runProcess } from "./process.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd });
  assert.equal(
    result.exitCode,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

async function createRepo(prefix: string): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  return repo;
}

async function getHeadChangedFiles(cwd: string): Promise<string[]> {
  const output = await git(cwd, [
    "show",
    "--name-only",
    "--pretty=format:",
    "HEAD",
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("getModifiedAndAddedFiles returns only modified and added paths", async () => {
  const repo = await createRepo("db-coder-git-status-");
  try {
    writeFileSync(join(repo, "keep.txt"), "keep-v1\n", "utf-8");
    writeFileSync(join(repo, "remove.txt"), "remove-v1\n", "utf-8");
    await git(repo, ["add", "keep.txt", "remove.txt"]);
    await git(repo, ["commit", "-m", "initial"]);

    writeFileSync(join(repo, "keep.txt"), "keep-v2\n", "utf-8");
    rmSync(join(repo, "remove.txt"));
    writeFileSync(join(repo, "new.txt"), "new\n", "utf-8");

    const changedFiles = await getModifiedAndAddedFiles(repo);
    assert.deepEqual(changedFiles.sort(), [
      "keep.txt",
      "new.txt",
      "remove.txt",
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commitAll stages only provided files", async () => {
  const repo = await createRepo("db-coder-git-commit-");
  try {
    writeFileSync(join(repo, "safe.txt"), "safe-v1\n", "utf-8");
    writeFileSync(join(repo, "other.txt"), "other-v1\n", "utf-8");
    await git(repo, ["add", "safe.txt", "other.txt"]);
    await git(repo, ["commit", "-m", "initial"]);

    writeFileSync(join(repo, "safe.txt"), "safe-v2\n", "utf-8");
    writeFileSync(join(repo, "other.txt"), "other-v2\n", "utf-8");

    await commitAll("commit safe only", repo, ["safe.txt"]);

    assert.deepEqual(await getHeadChangedFiles(repo), ["safe.txt"]);

    const status = await git(repo, ["status", "--porcelain"]);
    assert.match(status, /other\.txt$/m);
    assert.doesNotMatch(status, /safe\.txt$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commitAll skips sensitive patterns and logs warnings", async () => {
  const repo = await createRepo("db-coder-git-sensitive-");
  try {
    mkdirSync(join(repo, "keys"), { recursive: true });
    mkdirSync(join(repo, "notes"), { recursive: true });
    writeFileSync(join(repo, "safe.txt"), "safe-v1\n", "utf-8");
    writeFileSync(join(repo, ".env"), "TOKEN=before\n", "utf-8");
    writeFileSync(join(repo, ".env.local"), "LOCAL=before\n", "utf-8");
    writeFileSync(join(repo, "keys", "server.pem"), "pem-before\n", "utf-8");
    writeFileSync(
      join(repo, "credentials.txt"),
      "credentials-before\n",
      "utf-8",
    );
    writeFileSync(
      join(repo, "notes", "secret-plan.md"),
      "secret-before\n",
      "utf-8",
    );
    await git(repo, [
      "add",
      "safe.txt",
      ".env",
      ".env.local",
      "keys/server.pem",
      "credentials.txt",
      "notes/secret-plan.md",
    ]);
    await git(repo, ["commit", "-m", "initial"]);

    writeFileSync(join(repo, "safe.txt"), "safe-v2\n", "utf-8");
    writeFileSync(join(repo, ".env"), "TOKEN=after\n", "utf-8");
    writeFileSync(join(repo, ".env.local"), "LOCAL=after\n", "utf-8");
    writeFileSync(join(repo, "keys", "server.pem"), "pem-after\n", "utf-8");
    writeFileSync(
      join(repo, "credentials.txt"),
      "credentials-after\n",
      "utf-8",
    );
    writeFileSync(
      join(repo, "notes", "secret-plan.md"),
      "secret-after\n",
      "utf-8",
    );

    const logs: LogEntry[] = [];
    const removeListener = log.addListener((entry) => logs.push(entry));
    try {
      await commitAll("commit non-sensitive changes", repo, [
        "safe.txt",
        ".env",
        ".env.local",
        "keys/server.pem",
        "credentials.txt",
        "notes/secret-plan.md",
      ]);
    } finally {
      removeListener();
    }

    assert.deepEqual(await getHeadChangedFiles(repo), ["safe.txt"]);

    const warningMessages = logs
      .filter((entry) => entry.level === "warn")
      .map((entry) => entry.message);
    assert.equal(warningMessages.length, 5);
    assert.ok(warningMessages.some((message) => message.includes(".env")));
    assert.ok(
      warningMessages.some((message) => message.includes(".env.local")),
    );
    assert.ok(
      warningMessages.some((message) => message.includes("keys/server.pem")),
    );
    assert.ok(
      warningMessages.some((message) => message.includes("credentials.txt")),
    );
    assert.ok(
      warningMessages.some((message) =>
        message.includes("notes/secret-plan.md"),
      ),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commitAll no-ops when no eligible files remain after filtering", async () => {
  const repo = await createRepo("db-coder-git-noop-");
  try {
    writeFileSync(join(repo, ".env"), "TOKEN=before\n", "utf-8");
    await git(repo, ["add", ".env"]);
    await git(repo, ["commit", "-m", "initial"]);

    writeFileSync(join(repo, ".env"), "TOKEN=after\n", "utf-8");
    const beforeCommit = await git(repo, ["rev-parse", "HEAD"]);

    await commitAll("should skip commit", repo, [".env"]);

    const afterCommit = await git(repo, ["rev-parse", "HEAD"]);
    assert.equal(afterCommit, beforeCommit);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("getModifiedAndAddedFiles returns new path for git-mv renames", async () => {
  const repo = await createRepo("db-coder-git-rename-");
  try {
    writeFileSync(join(repo, "old.txt"), "content\n", "utf-8");
    await git(repo, ["add", "old.txt"]);
    await git(repo, ["commit", "-m", "initial"]);

    await git(repo, ["mv", "old.txt", "new.txt"]);

    const changedFiles = await getModifiedAndAddedFiles(repo);
    assert.ok(
      changedFiles.includes("new.txt"),
      "Should include renamed file new.txt",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commitAll excludes pre-staged sensitive files from commit", async () => {
  const repo = await createRepo("db-coder-git-prestaged-");
  try {
    writeFileSync(join(repo, "safe.txt"), "v1\n", "utf-8");
    writeFileSync(join(repo, ".env"), "SECRET=old\n", "utf-8");
    await git(repo, ["add", "safe.txt", ".env"]);
    await git(repo, ["commit", "-m", "initial"]);

    // Modify both files
    writeFileSync(join(repo, "safe.txt"), "v2\n", "utf-8");
    writeFileSync(join(repo, ".env"), "SECRET=new\n", "utf-8");

    // Pre-stage .env BEFORE commitAll is called (simulates external operation)
    await git(repo, ["add", ".env"]);

    const logs: LogEntry[] = [];
    const removeListener = log.addListener((entry) => logs.push(entry));
    try {
      await commitAll("should not include .env", repo, ["safe.txt"]);
    } finally {
      removeListener();
    }

    // Only safe.txt should be in the commit
    assert.deepEqual(await getHeadChangedFiles(repo), ["safe.txt"]);

    // .env should still be modified (unstaged by defense-in-depth)
    const status = await git(repo, ["status", "--porcelain"]);
    assert.match(status, /\.env/m, ".env should still show in status");

    // Should have logged the unstaging
    const warnMessages = logs
      .filter((e) => e.level === "warn")
      .map((e) => e.message);
    assert.ok(
      warnMessages.some((m) => m.includes("pre-staged")),
      "Should warn about unstaging",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commitAll handles manual rename leaving no unstaged deletions", async () => {
  const repo = await createRepo("db-coder-git-rename-commit-");
  try {
    writeFileSync(join(repo, "old.txt"), "content\n", "utf-8");
    await git(repo, ["add", "old.txt"]);
    await git(repo, ["commit", "-m", "initial"]);

    // Manual rename (not git mv) — git reports as D + ??
    renameSync(join(repo, "old.txt"), join(repo, "new.txt"));

    const files = await getModifiedAndAddedFiles(repo);
    assert.ok(files.includes("new.txt"), "Should include new file");
    assert.ok(files.includes("old.txt"), "Should include deleted old file");

    await commitAll("rename file", repo, files);

    // Working tree should be clean — no lingering D status
    const status = await git(repo, ["status", "--porcelain"]);
    assert.equal(
      status,
      "",
      "Working tree should be clean after rename commit",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("mergeBranch throws when git exits with code 1 (non-existent branch)", async () => {
  const repo = await createRepo("db-coder-git-merge-fail-");
  try {
    writeFileSync(join(repo, "file.txt"), "content\n", "utf-8");
    await git(repo, ["add", "file.txt"]);
    await git(repo, ["commit", "-m", "initial"]);

    await assert.rejects(
      () => mergeBranch("non-existent-branch", repo),
      (err: Error) => {
        assert.ok(err instanceof Error, "Should throw an Error");
        assert.match(
          err.message,
          /failed \(exit \d+\)/,
          "Error message should include exit code",
        );
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("switchBranch throws when git exits with code 1 (non-existent branch)", async () => {
  const repo = await createRepo("db-coder-git-switch-fail-");
  try {
    writeFileSync(join(repo, "file.txt"), "content\n", "utf-8");
    await git(repo, ["add", "file.txt"]);
    await git(repo, ["commit", "-m", "initial"]);

    await assert.rejects(
      () => switchBranch("non-existent-branch", repo),
      (err: Error) => {
        assert.ok(err instanceof Error, "Should throw an Error");
        assert.match(
          err.message,
          /failed \(exit \d+\)/,
          "Error message should include exit code",
        );
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resetToCommit throws when git exits with non-zero code (invalid commit)", async () => {
  const repo = await createRepo("db-coder-git-reset-fail-");
  try {
    writeFileSync(join(repo, "file.txt"), "content\n", "utf-8");
    await git(repo, ["add", "file.txt"]);
    await git(repo, ["commit", "-m", "initial"]);

    await assert.rejects(
      () => resetToCommit("deadbeefdeadbeef", repo),
      (err: Error) => {
        assert.ok(err instanceof Error, "Should throw an Error");
        assert.match(
          err.message,
          /failed \(exit \d+\)/,
          "Error message should include exit code",
        );
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
