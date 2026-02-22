import type { Brain } from './Brain.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { CodexBridge } from '../bridges/CodexBridge.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { TaskQueue } from './TaskQueue.js';
import type { Config } from '../config/Config.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { PlanRequest } from '../prompts/brain.js';
import type { PlanDraft } from '../memory/types.js';
import { log } from '../utils/logger.js';

export type { PlanRequest };

export class PlanWorkflow {
  constructor(
    private brain: Brain,
    private claude: ClaudeBridge,
    private codex: CodexBridge,
    private taskStore: TaskStore,
    private taskQueue: TaskQueue,
    private config: Config,
    private globalMemory: GlobalMemory,
  ) {}

  /**
   * Submit a plan request: research → generate plan draft.
   * Returns the draft ID. The draft starts in 'draft' status awaiting approval.
   */
  async submitRequest(projectPath: string, request: PlanRequest): Promise<number> {
    log.info(`Plan request submitted: ${request.description.slice(0, 80)}`);
    let totalCost = 0;

    // Phase 1: Deep research
    const { report: researchReport, cost: researchCost } = await this.brain.research(projectPath, request);
    totalCost += researchCost;

    // Phase 2: Generate plan
    const { plan, markdown, reasoning, cost: planCost } = await this.brain.createPlanWithMarkdown(
      projectPath, researchReport, request,
    );
    totalCost += planCost;

    // Track daily cost (no task ID for plan workflow)
    await this.taskStore.addDailyCost(totalCost);

    // Save draft
    const draft = await this.taskStore.savePlanDraft({
      project_path: projectPath,
      plan,
      analysis_summary: researchReport.slice(0, 10000),
      reasoning,
      markdown,
      cost_usd: totalCost,
    });

    log.info(`Plan draft created: #${draft.id} with ${plan.tasks.length} tasks`);
    return draft.id;
  }

  /**
   * Execute an approved plan: enqueue tasks via TaskQueue.
   */
  async executeApprovedPlan(draftId: number): Promise<void> {
    const draft = await this.taskStore.getPlanDraft(draftId);
    if (!draft) throw new Error(`Plan draft #${draftId} not found`);
    if (draft.status !== 'approved') throw new Error(`Plan draft #${draftId} is not approved (status: ${draft.status})`);

    const projectPath = draft.project_path;
    const plan = draft.plan as import('./types.js').TaskPlan;

    log.info(`Executing approved plan #${draftId}: ${plan.tasks?.length ?? 0} tasks`);

    const taskIds = await this.taskQueue.enqueue(projectPath, plan);
    log.info(`Plan #${draftId} execution started: ${taskIds.length} tasks enqueued`);
  }

  /**
   * Revise a plan based on annotations: regenerate with feedback.
   * Returns the new draft ID.
   */
  async revisePlan(draftId: number): Promise<number> {
    const draft = await this.taskStore.getPlanDraft(draftId);
    if (!draft) throw new Error(`Plan draft #${draftId} not found`);

    const annotations = draft.annotations;
    const feedback = annotations
      .map(a => `Task #${a.task_index}: ${a.action}${a.comment ? ` — ${a.comment}` : ''}${a.modified_description ? ` → "${a.modified_description}"` : ''}`)
      .join('\n');

    // Re-submit with feedback as additional constraint
    const originalPlan = draft.plan as { reasoning?: string };
    const request: PlanRequest = {
      description: `Revise the previous plan based on reviewer feedback.\n\nOriginal reasoning: ${originalPlan.reasoning ?? draft.reasoning}\n\nFeedback:\n${feedback}`,
      constraints: [`Address all reviewer feedback from plan #${draftId}`],
    };

    const newDraftId = await this.submitRequest(draft.project_path, request);

    // Mark old draft as expired
    await this.taskStore.updatePlanDraftStatus(draftId, 'expired');

    return newDraftId;
  }
}
