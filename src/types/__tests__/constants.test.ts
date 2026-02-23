import assert from 'node:assert/strict';
import test from 'node:test';

import { memoryCategories, promptNames } from '../constants.js';
import type { MemoryCategory, PromptName } from '../constants.js';

type AssertTrue<T extends true> = T;
type IsEqual<A, B> = (
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false
);

type _MemoryCategoryMatchesSource = AssertTrue<
  IsEqual<MemoryCategory, (typeof memoryCategories)[number]>
>;
type _PromptNameMatchesSource = AssertTrue<
  IsEqual<PromptName, (typeof promptNames)[number]>
>;

test('memory category types are derived from the source array', () => {
  assert.ok(memoryCategories.length > 0);
  for (const category of memoryCategories) {
    const value: MemoryCategory = category;
    assert.equal(typeof value, 'string');
  }
});

test('prompt name types are derived from the source array', () => {
  assert.ok(promptNames.length > 0);
  for (const promptName of promptNames) {
    const value: PromptName = promptName;
    assert.equal(typeof value, 'string');
  }
});
