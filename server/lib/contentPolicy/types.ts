import type { MediaType } from '@server/constants/media';
import type { ContentPolicyResult } from '@server/entity/ContentPolicyDecision';

export type PolicyRuleGroup = {
  id: string;
  category: string;
  keywordIds?: number[];
  phrases?: string[];
};

export type ContentPolicy = {
  policyVersion: string;
  mode: 'audit' | 'enforce';
  deniedGenreIds: number[];
  manualDeny: { movie: number[]; tv: number[] };
  deniedKeywords: PolicyRuleGroup[];
  explicitText: PolicyRuleGroup[];
  reviewText: PolicyRuleGroup[];
  supportedLanguages: string[];
  cacheHours: number;
  hydrationConcurrency: number;
  overrideMinutes: number;
};

export type ContentPolicyMetadata = {
  id: number;
  mediaType: MediaType;
  adult?: boolean;
  title?: string;
  originalTitle?: string;
  tagline?: string;
  overview?: string;
  originalLanguage?: string;
  genreIds: number[];
  keywords: { id: number; name?: string }[];
  fetchFailed?: boolean;
};

export type ContentPolicyEvaluation = {
  decisionId: number;
  mediaType: MediaType;
  tmdbId: number;
  result: ContentPolicyResult;
  policyVersion: string;
  policyHash: string;
  metadataHash: string;
  matchedRuleIds: string[];
  categories: string[];
  evidence: Record<string, unknown>;
  cached: boolean;
};
