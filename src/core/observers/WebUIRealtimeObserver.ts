import type { CycleEvent } from '../CycleEvents.js';

export type SSEBroadcastFn = (eventType: string, data: unknown) => void;

export class WebUIRealtimeObserver {
  constructor(private broadcast: SSEBroadcastFn) {}

  handle(event: CycleEvent): void {
    this.broadcast('cycle-event', {
      phase: event.phase,
      timing: event.timing,
      taskId: event.taskId,
      timestamp: event.timestamp,
      data: event.data,
    });
  }
}
