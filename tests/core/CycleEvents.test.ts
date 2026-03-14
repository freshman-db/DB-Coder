import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchPattern } from '../../src/core/CycleEvents.js';

describe('matchPattern', () => {
  it('matches wildcard *', () => {
    assert.equal(matchPattern('*', 'execute', 'after'), true);
    assert.equal(matchPattern('*', 'decide', 'before'), true);
  });

  it('matches exact pattern', () => {
    assert.equal(matchPattern('after:execute', 'execute', 'after'), true);
    assert.equal(matchPattern('after:execute', 'execute', 'before'), false);
    assert.equal(matchPattern('after:execute', 'verify', 'after'), false);
  });

  it('matches timing wildcard', () => {
    assert.equal(matchPattern('*:execute', 'execute', 'after'), true);
    assert.equal(matchPattern('*:execute', 'execute', 'before'), true);
    assert.equal(matchPattern('*:execute', 'verify', 'after'), false);
  });

  it('matches phase wildcard', () => {
    assert.equal(matchPattern('after:*', 'execute', 'after'), true);
    assert.equal(matchPattern('after:*', 'verify', 'after'), true);
    assert.equal(matchPattern('after:*', 'execute', 'before'), false);
  });

  it('rejects malformed patterns', () => {
    assert.equal(matchPattern('execute', 'execute', 'after'), false);
    assert.equal(matchPattern('', 'execute', 'after'), false);
  });
});
