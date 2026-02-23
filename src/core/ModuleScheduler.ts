import type { TaskStore } from '../memory/TaskStore.js';
import type { ScanModule } from '../memory/types.js';
import { getChangedFilesSince } from '../utils/git.js';
import { log } from '../utils/logger.js';

const STATE_KEY = 'module_scan_rotation_index';

export class ModuleScheduler {
  constructor(
    private taskStore: TaskStore,
    private rotationInterval: number,
  ) {}

  /**
   * Select the next module to scan:
   * 1. Modules whose involved files have changed since last scan → priority
   * 2. Otherwise, rotate to the module least recently scanned
   */
  async getNextModule(projectPath: string): Promise<{ module: ScanModule; hasChanges: boolean } | null> {
    const modules = await this.taskStore.getModules(projectPath);
    if (modules.length === 0) return null;

    // Check which modules have file changes
    for (const mod of modules) {
      if (await this.hasModuleChanges(projectPath, mod)) {
        return { module: mod, hasChanges: true };
      }
    }

    // No changes — rotate by picking least-recently-scanned module
    const rotationIndex = await this.getRotationIndex(projectPath);
    const cyclesSinceLastScan = await this.getCyclesSinceLastModuleScan(projectPath);

    // Only rotate if enough cycles have passed
    if (cyclesSinceLastScan < this.rotationInterval) {
      log.info(`Module rotation: ${cyclesSinceLastScan}/${this.rotationInterval} cycles since last module scan, skipping`);
      return null;
    }

    // Find the module at the current rotation index
    const idx = rotationIndex % modules.length;
    const nextModule = modules[idx];

    // Advance rotation index for next time
    await this.setRotationIndex(projectPath, (idx + 1) % modules.length);

    return { module: nextModule, hasChanges: false };
  }

  /** Check if any of the module's involved files have changed since its last scan */
  async hasModuleChanges(projectPath: string, module: ScanModule): Promise<boolean> {
    const lastModuleScan = await this.taskStore.getLastModuleScan(projectPath, module.name);
    if (!lastModuleScan) return true; // Never scanned → treat as changed

    try {
      const changedFiles = await getChangedFilesSince(lastModuleScan.commit_hash, projectPath);
      // Check if any changed file overlaps with module's involved files
      return changedFiles.some(f => module.involved_files.some(mf => f.endsWith(mf) || mf.endsWith(f)));
    } catch {
      return true; // On error, assume changes
    }
  }

  private async getRotationIndex(projectPath: string): Promise<number> {
    const value = await this.taskStore.getServiceState(projectPath, STATE_KEY);
    return value ? parseInt(value, 10) || 0 : 0;
  }

  private async setRotationIndex(projectPath: string, index: number): Promise<void> {
    await this.taskStore.setServiceState(projectPath, STATE_KEY, String(index));
  }

  private async getCyclesSinceLastModuleScan(projectPath: string): Promise<number> {
    const value = await this.taskStore.getServiceState(projectPath, 'cycles_since_module_scan');
    return value ? parseInt(value, 10) || 0 : this.rotationInterval; // Default: allow immediate scan
  }

  async incrementCycleCounter(projectPath: string): Promise<void> {
    const current = await this.getCyclesSinceLastModuleScan(projectPath);
    await this.taskStore.setServiceState(projectPath, 'cycles_since_module_scan', String(current + 1));
  }

  async resetCycleCounter(projectPath: string): Promise<void> {
    await this.taskStore.setServiceState(projectPath, 'cycles_since_module_scan', '0');
  }
}
