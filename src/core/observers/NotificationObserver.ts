import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export interface NotificationConfig {
  webhookUrl?: string;
  notifyOnMerge?: boolean;
  notifyOnFailStreak?: number;
  notifyOnBudgetLow?: boolean;
}

export class NotificationObserver {
  private config: Required<NotificationConfig>;

  constructor(config: NotificationConfig = {}) {
    this.config = {
      webhookUrl: config.webhookUrl ?? '',
      notifyOnMerge: config.notifyOnMerge ?? true,
      notifyOnFailStreak: config.notifyOnFailStreak ?? 3,
      notifyOnBudgetLow: config.notifyOnBudgetLow ?? true,
    };
  }

  async handle(event: CycleEvent): Promise<void> {
    if (!this.config.webhookUrl) return;

    const message = this.formatMessage(event);
    if (!message) return;

    try {
      await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message, event: `${event.timing}:${event.phase}`, taskId: event.taskId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      log.warn('NotificationObserver: webhook failed', { error: err });
    }
  }

  formatMessage(event: CycleEvent): string | null {
    if (event.timing === 'after' && event.phase === 'merge' && event.data.merged && this.config.notifyOnMerge) {
      return `Task merged: ${event.taskId ?? 'unknown'}`;
    }
    if (event.timing === 'error') {
      return `Error in ${event.phase}: ${event.data.error ?? 'unknown'}`;
    }
    return null;
  }
}
