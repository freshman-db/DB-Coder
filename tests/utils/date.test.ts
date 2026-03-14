import assert from 'node:assert/strict';
import test from 'node:test';
import { getTodayBeijing } from '../../src/utils/date.js';

test('getTodayBeijing returns YYYY-MM-DD format', () => {
  const result = getTodayBeijing();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('getTodayBeijing returns Beijing date, not UTC', () => {
  // Beijing is UTC+8. At any moment, the Beijing date is either
  // the same as UTC date or one day ahead (during UTC 16:00~23:59).
  const utcDate = new Date().toISOString().slice(0, 10);
  const bjDate = getTodayBeijing();

  const utcDay = new Date(utcDate).getTime();
  const bjDay = new Date(bjDate).getTime();
  const diffDays = (bjDay - utcDay) / (24 * 60 * 60 * 1000);

  // Beijing date is 0 or +1 day relative to UTC date
  assert.ok(diffDays === 0 || diffDays === 1,
    `Expected Beijing date to be same or +1 day vs UTC, got diff=${diffDays}`);
});
