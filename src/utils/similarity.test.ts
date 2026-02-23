import assert from 'node:assert/strict';
import test from 'node:test';

import { wordJaccard } from './similarity.js';

test('wordJaccard returns 1 for identical strings', () => {
  assert.equal(wordJaccard('Fix login bug', 'Fix login bug'), 1);
});

test('wordJaccard returns 0 for completely different strings', () => {
  assert.equal(wordJaccard('Fix login bug', 'Refactor payment service'), 0);
});

test('wordJaccard computes expected ratio for partial overlap', () => {
  assert.equal(wordJaccard('fix login bug', 'fix payment bug'), 0.5);
});

test('wordJaccard returns 0 for empty string input', () => {
  assert.equal(wordJaccard('', 'fix login bug'), 0);
  assert.equal(wordJaccard('fix login bug', ''), 0);
});

test('wordJaccard is case insensitive', () => {
  assert.equal(wordJaccard('FIX Login Bug', 'fix login bug'), 1);
});

test('wordJaccard handles punctuation during tokenization', () => {
  assert.equal(wordJaccard('Fix, login! bug?', 'fix login bug'), 1);
});
