import { Notification } from '@server/lib/notifications';
import { buildContentPolicyEmailSubject } from '@server/lib/notifications/agents/email';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('content-policy notifications', () => {
  it('keeps immediate failure and break-glass alerts without a digest type', () => {
    assert.equal(Notification.CONTENT_POLICY_FAILURE, 8192);
    assert.equal(Notification.CONTENT_POLICY_BREAK_GLASS, 16384);
    assert.equal('CONTENT_POLICY_DIGEST' in Notification, false);
  });

  it('uses an actionable subject for content-policy email', () => {
    assert.equal(
      buildContentPolicyEmailSubject(
        'Content Policy Failure',
        'Cynnix Requests'
      ),
      'Content Policy Failure [Cynnix Requests]'
    );
  });
});
