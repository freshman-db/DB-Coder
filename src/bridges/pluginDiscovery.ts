import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../utils/logger.js';

/** Semver-aware version comparison. Returns negative if a < b, positive if a > b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Discover installed Claude Code plugins from the standard cache directory.
 * Returns plugin configs suitable for passing to SDK Options.plugins.
 */
export function discoverPlugins(pluginsDir?: string): SdkPluginConfig[] {
  const dir = pluginsDir ?? join(homedir(), '.claude', 'plugins', 'cache');
  if (!existsSync(dir)) return [];

  const plugins: SdkPluginConfig[] = [];

  try {
    for (const org of readdirSync(dir)) {
      const orgDir = join(dir, org);
      if (!statSync(orgDir).isDirectory()) continue;

      for (const plugin of readdirSync(orgDir)) {
        const pluginDir = join(orgDir, plugin);
        if (!statSync(pluginDir).isDirectory()) continue;

        // Find latest version directory (semver-aware sort)
        const versions = readdirSync(pluginDir)
          .filter(v => statSync(join(pluginDir, v)).isDirectory())
          .sort(compareSemver)
          .reverse();

        if (versions.length > 0) {
          plugins.push({ type: 'local', path: join(pluginDir, versions[0]) });
        }
      }
    }
  } catch (err) {
    log.warn('Plugin discovery failed', { dir, error: String(err) });
  }

  log.info(`Discovered ${plugins.length} plugin(s)`);
  return plugins;
}
