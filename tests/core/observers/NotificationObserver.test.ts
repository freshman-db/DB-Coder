import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotificationObserver } from '../../../src/core/observers/NotificationObserver.js';

describe('NotificationObserver', () => {
  it('formats merge message', () => {
    const observer = new NotificationObserver({ webhookUrl: 'http://test' });
    const msg = observer.formatMessage({
      phase: 'merge', timing: 'after', taskId: 'abc',
      data: { merged: true }, timestamp: Date.now(),
    });
    assert.ok(msg?.includes('merged'));
    assert.ok(msg?.includes('abc'));
  });

  it('formats error message', () => {
    const observer = new NotificationObserver({ webhookUrl: 'http://test' });
    const msg = observer.formatMessage({
      phase: 'execute', timing: 'error',
      data: { error: 'timeout' }, timestamp: Date.now(),
    });
    assert.ok(msg?.includes('execute'));
    assert.ok(msg?.includes('timeout'));
  });

  it('returns null for non-notable events', () => {
    const observer = new NotificationObserver({ webhookUrl: 'http://test' });
    const msg = observer.formatMessage({
      phase: 'decide', timing: 'before', data: {}, timestamp: Date.now(),
    });
    assert.equal(msg, null);
  });

  it('does nothing without webhookUrl', async () => {
    const observer = new NotificationObserver();
    await observer.handle({
      phase: 'merge', timing: 'after', taskId: 'abc',
      data: { merged: true }, timestamp: Date.now(),
    });
  });
});
