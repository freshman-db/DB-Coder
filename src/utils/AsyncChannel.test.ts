import assert from 'node:assert/strict';
import test from 'node:test';

import { AsyncChannel } from './AsyncChannel.js';

test('push before pull returns immediately', async () => {
  const channel = new AsyncChannel<string>();
  channel.push('first');

  const iterator = channel[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: 'first', done: false });

  channel.close();
});

test('pull before push awaits until an item is pushed', async () => {
  const channel = new AsyncChannel<string>();
  const iterator = channel[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  let settled = false;
  void nextPromise.then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);

  channel.push('later');
  assert.deepEqual(await nextPromise, { value: 'later', done: false });

  channel.close();
});

test('close resolves pending pull and ends iteration', async () => {
  const channel = new AsyncChannel<string>();
  const iterator = channel[Symbol.asyncIterator]();
  const pending = iterator.next();

  channel.close();
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test('close causes for-await-of to exit after draining queued items', async () => {
  const channel = new AsyncChannel<number>();
  channel.push(1);
  channel.push(2);
  channel.close();

  const received: number[] = [];
  for await (const value of channel) {
    received.push(value);
  }

  assert.deepEqual(received, [1, 2]);
});

test('push after close throws', () => {
  const channel = new AsyncChannel<string>();
  channel.close();

  assert.throws(() => {
    channel.push('nope');
  }, /Channel closed/);
});

test('multiple queued items are consumed in FIFO order', async () => {
  const channel = new AsyncChannel<string>();
  const iterator = channel[Symbol.asyncIterator]();
  channel.push('a');
  channel.push('b');
  channel.push('c');

  assert.deepEqual(await iterator.next(), { value: 'a', done: false });
  assert.deepEqual(await iterator.next(), { value: 'b', done: false });
  assert.deepEqual(await iterator.next(), { value: 'c', done: false });

  channel.close();
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});

test('nullish payloads are delivered without being dropped', async () => {
  const channel = new AsyncChannel<string | null | undefined>();
  channel.push(undefined);
  channel.push(null);
  channel.close();

  const received: Array<string | null | undefined> = [];
  for await (const value of channel) {
    received.push(value);
  }

  assert.deepEqual(received, [undefined, null]);
});

test('multiple sequential consumers can read from the same channel', async () => {
  const channel = new AsyncChannel<number>();
  const firstConsumer = channel[Symbol.asyncIterator]();
  channel.push(10);

  assert.deepEqual(await firstConsumer.next(), { value: 10, done: false });
  if (firstConsumer.return) {
    await firstConsumer.return(undefined);
  }

  const secondConsumer = channel[Symbol.asyncIterator]();
  const pending = secondConsumer.next();
  channel.push(20);

  assert.deepEqual(await pending, { value: 20, done: false });

  channel.close();
  assert.deepEqual(await secondConsumer.next(), { value: undefined, done: true });
});
