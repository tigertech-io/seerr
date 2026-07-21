import { isNewerUpstreamRelease } from '@server/utils/appVersion';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('isNewerUpstreamRelease', () => {
  it('treats a maintained policy build as current with its upstream base', () => {
    assert.equal(isNewerUpstreamRelease('3.3.0-policy.5', 'v3.3.0'), false);
  });

  it('still reports a newer upstream release', () => {
    assert.equal(isNewerUpstreamRelease('3.3.0-policy.5', 'v3.3.1'), true);
    assert.equal(isNewerUpstreamRelease('3.3.0-policy.5', 'v4.0.0'), true);
  });

  it('does not report an older upstream release', () => {
    assert.equal(isNewerUpstreamRelease('3.3.0-policy.5', 'v3.2.0'), false);
  });
});
