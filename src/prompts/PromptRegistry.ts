import type { TaskStore } from '../memory/TaskStore.js';
import type { PromptName, PromptVersion } from '../evolution/types.js';
import { applyPatches, validatePatchedPrompt } from './patchUtils.js';
import { log } from '../utils/logger.js';

const CACHE_TTL_MS = 60_000; // 60 seconds

interface CacheEntry {
  versions: PromptVersion[];
  loadedAt: number;
}

export class PromptRegistry {
  private cache: CacheEntry | null = null;
  private projectPath: string;

  constructor(
    private taskStore: TaskStore,
    projectPath: string,
  ) {
    this.projectPath = projectPath;
  }

  /**
   * Resolve a prompt: look up the active patch for this promptName,
   * apply it to the base prompt, and validate the result.
   * Returns the patched prompt or the base if patching fails.
   */
  async resolve(promptName: PromptName, basePrompt: string): Promise<string> {
    const versions = await this.getActiveVersions();
    const version = versions.find(v => v.prompt_name === promptName);
    if (!version || version.patches.length === 0) {
      return basePrompt;
    }

    const patched = applyPatches(basePrompt, version.patches);
    if (patched === basePrompt) {
      // applyPatches returned base due to error
      log.warn(`Prompt patch failed for "${promptName}" v${version.version}, using base template`);
      return basePrompt;
    }

    if (!validatePatchedPrompt(patched, promptName)) {
      log.warn(`Prompt patch for "${promptName}" v${version.version} broke JSON format, using base template`);
      return basePrompt;
    }

    return patched;
  }

  /**
   * Get the active version ID for a prompt name (used for effectiveness tracking).
   */
  async getActiveVersionId(promptName: PromptName): Promise<number | null> {
    const versions = await this.getActiveVersions();
    const version = versions.find(v => v.prompt_name === promptName);
    return version?.id ?? null;
  }

  /**
   * Force refresh the cache from DB.
   */
  async refresh(): Promise<void> {
    const versions = await this.taskStore.getActivePromptVersions(this.projectPath);
    this.cache = { versions, loadedAt: Date.now() };
    log.info(`PromptRegistry refreshed: ${versions.length} active version(s)`);
  }

  private async getActiveVersions(): Promise<PromptVersion[]> {
    if (this.cache && Date.now() - this.cache.loadedAt < CACHE_TTL_MS) {
      return this.cache.versions;
    }
    await this.refresh();
    return this.cache!.versions;
  }
}
