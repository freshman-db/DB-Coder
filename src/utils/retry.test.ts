import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateRetryDelay } from './retry.js';

test('calculateRetryDelay uses exponential backoff with jitter', () => {
  const delay = calculateRetryDelay({
    attempt: 2,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    random: () => 0.5,
  });

  assert.equal(delay, 450);
});

test('calculateRetryDelay caps delay at maxDelayMs', () => {
  const delay = calculateRetryDelay({
    attempt: 6,
    baseDelayMs: 100,
    maxDelayMs: 500,
    random: () => 1,
  });

  assert.equal(delay, 500);
});
