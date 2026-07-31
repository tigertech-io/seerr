import type ContentPolicyDecision from '@server/entity/ContentPolicyDecision';

const RETIRABLE_METADATA_FAILURE_SOURCES = new Set([
  'discover-search',
  'hourly-prewarm',
]);

export const isRetirableMetadataFailureDecision = (
  decision: ContentPolicyDecision
): boolean =>
  decision.result === 'review' &&
  decision.matchedRuleIds.includes('metadata-fetch-failure') &&
  decision.sourceMemberships.length > 0 &&
  decision.sourceMemberships.every((source) =>
    RETIRABLE_METADATA_FAILURE_SOURCES.has(source)
  );
