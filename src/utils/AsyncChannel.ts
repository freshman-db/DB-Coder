/**
 * Push-to-pull adapter: external code pushes items, internally consumed as AsyncIterable.
 * Used to feed user messages into Agent SDK's query() which accepts AsyncIterable<SDKUserMessage>.
 */
export class AsyncChannel<T> {
  private queue: T[] = [];
  private waiter: { resolve: () => void } | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) throw new Error('Channel closed');
    this.queue.push(item);
    this.waiter?.resolve();
    this.waiter = null;
  }

  close(): void {
    this.closed = true;
    this.waiter?.resolve();
    this.waiter = null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>(r => { this.waiter = { resolve: r }; });
    }
  }
}
