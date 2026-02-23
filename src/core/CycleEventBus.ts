import { matchPattern, type CycleEvent, type EventPattern } from './CycleEvents.js';
import { log } from '../utils/logger.js';

export type EventHandler = (event: CycleEvent) => void | Promise<void>;

interface Registration {
  pattern: EventPattern;
  handler: EventHandler;
}

export class CycleEventBus {
  private registrations: Registration[] = [];

  on(pattern: EventPattern, handler: EventHandler): () => void {
    const reg: Registration = { pattern, handler };
    this.registrations.push(reg);
    return () => {
      const idx = this.registrations.indexOf(reg);
      if (idx >= 0) this.registrations.splice(idx, 1);
    };
  }

  emit(event: CycleEvent): void {
    for (const { pattern, handler } of this.registrations) {
      if (matchPattern(pattern, event.phase, event.timing)) {
        try {
          const result = handler(event);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(err =>
              log.warn(`EventBus handler error (${pattern})`, { error: err })
            );
          }
        } catch (err) {
          log.warn(`EventBus handler error (${pattern})`, { error: err });
        }
      }
    }
  }

  async emitAndWait(event: CycleEvent): Promise<Error[]> {
    const errors: Error[] = [];
    for (const { pattern, handler } of this.registrations) {
      if (matchPattern(pattern, event.phase, event.timing)) {
        try {
          await handler(event);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          errors.push(error);
          log.warn(`EventBus handler error (${pattern})`, { error });
        }
      }
    }
    return errors;
  }

  static noop(): CycleEventBus {
    return new NoopBus();
  }
}

class NoopBus extends CycleEventBus {
  override on(): () => void { return () => {}; }
  override emit(): void {}
  override async emitAndWait(): Promise<Error[]> { return []; }
}
