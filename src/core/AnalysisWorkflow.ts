import type { Brain } from './Brain.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { Config } from '../config/Config.js';
import type { AnalysisReport } from '../memory/types.js';
import { log } from '../utils/logger.js';

export class AnalysisWorkflow {
  constructor(
    private brain: Brain,
    private claude: ClaudeBridge,
    private taskStore: TaskStore,
    private config: Config,
  ) {}

  /**
   * Analyze a specific module and save the report.
   */
  async analyzeModule(projectPath: string, modulePath: string): Promise<AnalysisReport> {
    log.info(`Starting analysis: ${modulePath || '(project-level)'}`);

    const { report, cost } = await this.brain.analyzeModule(projectPath, modulePath);

    // Save to database
    const saved = await this.taskStore.saveAnalysisReport({
      project_path: projectPath,
      module_path: report.module_path,
      title: report.title,
      markdown: report.markdown,
      summary: report.summary,
      modules: report.modules,
      cost_usd: cost,
    });

    log.info(`Analysis saved: #${saved.id} "${saved.title}"`);
    return saved;
  }

  /**
   * Analyze the entire project (shorthand for modulePath = '.').
   */
  async analyzeProject(projectPath: string): Promise<AnalysisReport> {
    return this.analyzeModule(projectPath, '.');
  }
}
