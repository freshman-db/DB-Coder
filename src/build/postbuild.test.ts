import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

interface PackageJsonShape {
  scripts?: Record<string, string>;
}

function getPostbuildScript(): string {
  const packageJsonPath = join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJsonShape;
  const postbuild = packageJson.scripts?.postbuild;
  if (typeof postbuild !== 'string') {
    throw new Error('package.json is missing scripts.postbuild');
  }
  return postbuild;
}

test('postbuild script replaces dist/web contents without nesting', () => {
  const root = mkdtempSync(join(tmpdir(), 'db-coder-postbuild-test-'));
  const srcWeb = join(root, 'src', 'web');
  const distWeb = join(root, 'dist', 'web');
  const postbuild = getPostbuildScript();

  mkdirSync(srcWeb, { recursive: true });
  mkdirSync(join(distWeb, 'web'), { recursive: true });

  writeFileSync(join(srcWeb, 'app.js'), 'console.log("fresh");\n', 'utf-8');
  writeFileSync(join(srcWeb, 'index.html'), '<html>fresh</html>\n', 'utf-8');
  writeFileSync(join(srcWeb, 'style.css'), 'body { color: black; }\n', 'utf-8');

  writeFileSync(join(distWeb, 'app.js'), 'console.log("stale");\n', 'utf-8');
  writeFileSync(join(distWeb, 'stale.txt'), 'stale asset\n', 'utf-8');
  writeFileSync(join(distWeb, 'web', 'nested.txt'), 'nested from old build\n', 'utf-8');

  try {
    const result = spawnSync('bash', ['-lc', postbuild], {
      cwd: root,
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(distWeb, 'web')), false);
    assert.equal(existsSync(join(distWeb, 'stale.txt')), false);
    assert.equal(readFileSync(join(distWeb, 'app.js'), 'utf-8'), 'console.log("fresh");\n');
    assert.equal(readFileSync(join(distWeb, 'index.html'), 'utf-8'), '<html>fresh</html>\n');
    assert.equal(readFileSync(join(distWeb, 'style.css'), 'utf-8'), 'body { color: black; }\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
