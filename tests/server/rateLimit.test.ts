import assert from 'node:assert/strict';
import test from 'node:test';

import { createRateLimiter } from '../../src/server/rateLimit.js';

function mockDateNow(initialNow: number): { setNow: (nextNow: number) => void; restore: () => void } {
  const originalDateNow = Date.now;
  let now = initialNow;
  Date.now = (): number => now;
  return {
    setNow: (nextNow: number): void => {
      now = nextNow;
    },
    restore: (): void => {
      Date.now = originalDateNow;
    },
  };
}

test('createRateLimiter allows requests under the configured limit', () => {
  const mockTime = mockDateNow(1_000);
  try {
    const limiter = createRateLimiter(60_000, 3);

    assert.equal(limiter('127.0.0.1'), true);
    assert.equal(limiter('127.0.0.1'), true);
    assert.equal(limiter('127.0.0.1'), true);
  } finally {
    mockTime.restore();
  }
});

test('createRateLimiter blocks requests once the limit is reached', () => {
  const mockTime = mockDateNow(1_000);
  try {
    const limiter = createRateLimiter(60_000, 2);

    assert.equal(limiter('127.0.0.1'), true);
    assert.equal(limiter('127.0.0.1'), true);
    assert.equal(limiter('127.0.0.1'), false);
  } finally {
    mockTime.restore();
  }
});

test('createRateLimiter resets counters after the window expires', () => {
  const mockTime = mockDateNow(5_000);
  try {
    const limiter = createRateLimiter(1_000, 2);

    assert.equal(limiter('127.0.0.1'), true);
    assert.equal(limiter('127.0.0.1'), true);
    assert.equal(limiter('127.0.0.1'), false);

    mockTime.setNow(6_001);
    assert.equal(limiter('127.0.0.1'), true);
    assert.equal(limiter('127.0.0.1'), true);
    assert.equal(limiter('127.0.0.1'), false);
  } finally {
    mockTime.restore();
  }
});
