import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import ContentPolicyDecision from '@server/entity/ContentPolicyDecision';
import {
  describeMetadataFetchError,
  METADATA_FAILURE_PREWARM_RETRY_MS,
  shouldNotifyMetadataFailure,
  shouldReusePrewarmMetadataFailure,
} from '@server/lib/contentPolicy';
import { isRetirableMetadataFailureDecision } from '@server/lib/contentPolicy/retirement';

const failedDecision = (
  overrides: Partial<ContentPolicyDecision> = {}
): ContentPolicyDecision =>
  new ContentPolicyDecision({
    id: 1,
    mediaType: MediaType.TV,
    tmdbId: 329809,
    result: 'review',
    policyVersion: 'test',
    policyHash: 'policy-hash',
    metadataHash: 'metadata-hash',
    matchedRuleIds: ['metadata-fetch-failure'],
    categories: ['metadata-quality'],
    evidence: {},
    sourceMemberships: ['discover-search', 'hourly-prewarm'],
    reviewState: 'unreviewed',
    createdAt: new Date('2026-07-29T04:48:39Z'),
    updatedAt: new Date('2026-07-30T05:00:02Z'),
    ...overrides,
  });

describe('content-policy metadata failure lifecycle', () => {
  it('extracts a bounded HTTP status through wrapped error causes', () => {
    const axiosLikeError = Object.assign(new Error('request failed'), {
      name: 'AxiosError',
      response: { status: 404 },
    });
    const wrapped = new Error('TMDB lookup failed', { cause: axiosLikeError });

    assert.deepEqual(describeMetadataFetchError(wrapped), {
      errorName: 'AxiosError',
      statusCode: 404,
    });
  });

  it('reuses a recent failed decision only for the hourly prewarm', () => {
    const decision = failedDecision();
    const now =
      decision.updatedAt.getTime() + METADATA_FAILURE_PREWARM_RETRY_MS - 1;

    assert.equal(
      shouldReusePrewarmMetadataFailure(decision, {
        hasMetadata: false,
        policyHash: decision.policyHash,
        source: 'hourly-prewarm',
        now,
      }),
      true
    );
    assert.equal(
      shouldReusePrewarmMetadataFailure(decision, {
        hasMetadata: false,
        policyHash: decision.policyHash,
        source: 'discover-search',
        now,
      }),
      false
    );
    assert.equal(
      shouldReusePrewarmMetadataFailure(decision, {
        force: true,
        hasMetadata: false,
        policyHash: decision.policyHash,
        source: 'hourly-prewarm',
        now,
      }),
      false
    );
    assert.equal(
      shouldReusePrewarmMetadataFailure(decision, {
        hasMetadata: false,
        policyHash: decision.policyHash,
        source: 'hourly-prewarm',
        now: now + 1,
      }),
      false
    );
  });

  it('sends the first failure alert and suppresses its persisted duplicate', () => {
    const fingerprint = 'AxiosError:404';
    assert.equal(shouldNotifyMetadataFailure([], fingerprint), true);
    assert.equal(
      shouldNotifyMetadataFailure(
        [{ details: { fingerprint, notificationSent: true } }],
        fingerprint
      ),
      false
    );
    assert.equal(
      shouldNotifyMetadataFailure(
        [
          {
            details: {
              fingerprint: 'AxiosError:503',
              notificationSent: true,
            },
          },
        ],
        fingerprint
      ),
      true
    );
    assert.equal(shouldNotifyMetadataFailure([], fingerprint, false), false);
  });

  it('retires only discovery-isolated failed-metadata reviews', () => {
    assert.equal(isRetirableMetadataFailureDecision(failedDecision()), true);
    assert.equal(
      isRetirableMetadataFailureDecision(
        failedDecision({
          sourceMemberships: ['discover-search', 'sonarr:42'],
        })
      ),
      false
    );
    assert.equal(
      isRetirableMetadataFailureDecision(
        failedDecision({ matchedRuleIds: ['missing-genres'] })
      ),
      false
    );
    assert.equal(
      isRetirableMetadataFailureDecision(failedDecision({ result: 'allow' })),
      false
    );
  });
});
