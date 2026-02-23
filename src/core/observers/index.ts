import type { CycleEventBus } from '../CycleEventBus.js';
import { StructuredCycleLogger } from './StructuredCycleLogger.js';
import { CycleMetricsCollector } from './CycleMetricsCollector.js';
import { NotificationObserver, type NotificationConfig } from './NotificationObserver.js';
import { WebUIRealtimeObserver, type SSEBroadcastFn } from './WebUIRealtimeObserver.js';

export interface ObserverDeps {
  sseBroadcast?: SSEBroadcastFn;
  notificationConfig?: NotificationConfig;
}

export interface RegisteredObservers {
  logger: StructuredCycleLogger;
  metrics: CycleMetricsCollector;
}

export function registerObservers(bus: CycleEventBus, deps: ObserverDeps = {}): RegisteredObservers {
  const logger = new StructuredCycleLogger();
  const metrics = new CycleMetricsCollector();
  const notification = new NotificationObserver(deps.notificationConfig);

  bus.on('*', (e) => logger.handle(e));
  bus.on('*', (e) => metrics.handle(e));
  bus.on('after:merge', (e) => notification.handle(e));
  bus.on('error:*', (e) => notification.handle(e));

  if (deps.sseBroadcast) {
    const webui = new WebUIRealtimeObserver(deps.sseBroadcast);
    bus.on('*', (e) => webui.handle(e));
  }

  return { logger, metrics };
}

export { StructuredCycleLogger, CycleMetricsCollector, NotificationObserver, WebUIRealtimeObserver };
