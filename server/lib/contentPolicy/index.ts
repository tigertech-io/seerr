import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import ContentPolicyDecision, {
  type ContentPolicyResult,
} from '@server/entity/ContentPolicyDecision';
import ContentPolicyEvent from '@server/entity/ContentPolicyEvent';
import ContentPolicyOverride, {
  type ContentPolicyAction,
} from '@server/entity/ContentPolicyOverride';
import { Notification } from '@server/lib/notifications';
import logger from '@server/logger';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import yaml from 'js-yaml';
import { In, IsNull, LessThan, Like, MoreThan } from 'typeorm';
import { sendContentPolicyNotification } from './notifications';
import type {
  ContentPolicy,
  ContentPolicyEvaluation,
  ContentPolicyMetadata,
  PolicyRuleGroup,
} from './types';

const DEFAULT_POLICY_PATH = '/app/config/content-policy/policy.yml';
export const METADATA_FAILURE_NOTIFICATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const METADATA_FAILURE_PREWARM_RETRY_MS = 24 * 60 * 60 * 1000;

type MetadataFetchErrorDetails = {
  errorName: string;
  statusCode?: number;
};

export const describeMetadataFetchError = (
  error: unknown
): MetadataFetchErrorDetails => {
  let current: unknown = error;
  let errorName = error instanceof Error ? error.name : 'unknown';

  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) errorName = current.name;
    if (typeof current !== 'object') break;

    const candidate = current as {
      cause?: unknown;
      response?: { status?: unknown };
    };
    if (typeof candidate.response?.status === 'number') {
      return { errorName, statusCode: candidate.response.status };
    }
    current = candidate.cause;
  }

  return { errorName };
};

export const shouldNotifyMetadataFailure = (
  recentFailures: Pick<ContentPolicyEvent, 'details'>[],
  fingerprint: string,
  notificationRequested = true
): boolean =>
  notificationRequested &&
  !recentFailures.some(
    (event) =>
      event.details.fingerprint === fingerprint &&
      event.details.notificationSent === true
  );

export const shouldReusePrewarmMetadataFailure = (
  decision: ContentPolicyDecision | null,
  input: {
    force?: boolean;
    hasMetadata: boolean;
    policyHash?: string;
    source?: string;
    now?: number;
  }
): boolean =>
  Boolean(
    decision &&
    !input.force &&
    !input.hasMetadata &&
    input.source === 'hourly-prewarm' &&
    decision.policyHash === input.policyHash &&
    decision.matchedRuleIds.includes('metadata-fetch-failure') &&
    (input.now ?? Date.now()) - decision.updatedAt.getTime() <
      METADATA_FAILURE_PREWARM_RETRY_MS
  );

export class ContentPolicyError extends Error {
  public constructor(
    public status: 403 | 503,
    public code:
      | 'CONTENT_POLICY_DENIED'
      | 'CONTENT_POLICY_REVIEW_REQUIRED'
      | 'CONTENT_POLICY_UNAVAILABLE',
    message: string
  ) {
    super(message);
  }
}

const normalizeText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const asNumberArray = (value: unknown, field: string): number[] => {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item))) {
    throw new Error(`${field} must be an array of integer IDs`);
  }
  return [...new Set(value as number[])];
};

const validateRuleGroups = (
  value: unknown,
  field: string
): PolicyRuleGroup[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`${field}[${index}] must be an object`);
    }
    const item = raw as Record<string, unknown>;
    if (
      typeof item.id !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]+$/i.test(item.id)
    ) {
      throw new Error(`${field}[${index}].id is invalid`);
    }
    if (ids.has(item.id)) {
      throw new Error(`${field} contains duplicate rule ID ${item.id}`);
    }
    ids.add(item.id);
    if (typeof item.category !== 'string' || !item.category.trim()) {
      throw new Error(`${field}[${index}].category is required`);
    }
    const phrases = item.phrases;
    if (
      phrases !== undefined &&
      (!Array.isArray(phrases) ||
        phrases.some((phrase) => typeof phrase !== 'string'))
    ) {
      throw new Error(`${field}[${index}].phrases must contain only strings`);
    }
    return {
      id: item.id,
      category: item.category,
      keywordIds:
        item.keywordIds === undefined
          ? undefined
          : asNumberArray(item.keywordIds, `${field}[${index}].keywordIds`),
      phrases: (phrases as string[] | undefined)?.map(normalizeText),
    };
  });
};

const validatePolicy = (input: unknown): ContentPolicy => {
  if (!input || typeof input !== 'object') {
    throw new Error('policy root must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.policyVersion !== 'string' || !raw.policyVersion.trim()) {
    throw new Error('policyVersion is required');
  }
  if (raw.mode !== 'audit' && raw.mode !== 'enforce') {
    throw new Error('mode must be audit or enforce');
  }
  const manual = raw.manualDeny as Record<string, unknown> | undefined;
  if (!manual) throw new Error('manualDeny is required');
  const supportedLanguages = raw.supportedLanguages;
  if (
    !Array.isArray(supportedLanguages) ||
    supportedLanguages.some((item) => typeof item !== 'string')
  ) {
    throw new Error('supportedLanguages must be a string array');
  }
  const policy: ContentPolicy = {
    policyVersion: raw.policyVersion,
    mode: raw.mode,
    deniedGenreIds: asNumberArray(raw.deniedGenreIds, 'deniedGenreIds'),
    manualDeny: {
      movie: asNumberArray(manual.movie, 'manualDeny.movie'),
      tv: asNumberArray(manual.tv, 'manualDeny.tv'),
    },
    deniedKeywords: validateRuleGroups(raw.deniedKeywords, 'deniedKeywords'),
    explicitText: validateRuleGroups(raw.explicitText, 'explicitText'),
    reviewText: validateRuleGroups(raw.reviewText, 'reviewText'),
    supportedLanguages: supportedLanguages as string[],
    cacheHours: Number(raw.cacheHours ?? 6),
    hydrationConcurrency: Number(raw.hydrationConcurrency ?? 8),
    overrideMinutes: Number(raw.overrideMinutes ?? 15),
  };
  if (!Number.isFinite(policy.cacheHours) || policy.cacheHours <= 0) {
    throw new Error('cacheHours must be greater than zero');
  }
  if (
    !Number.isInteger(policy.hydrationConcurrency) ||
    policy.hydrationConcurrency < 1
  ) {
    throw new Error('hydrationConcurrency must be a positive integer');
  }
  if (policy.overrideMinutes !== 15) {
    throw new Error('overrideMinutes must remain 15 in policy v1');
  }
  return policy;
};

export class ContentPolicyEvaluator {
  private policy?: ContentPolicy;
  private policyHash?: string;
  private loadError?: string;
  private loadedAt?: Date;

  public constructor(private readonly configuredPath?: string) {}

  public get configPath(): string {
    return (
      this.configuredPath ??
      process.env.CONTENT_POLICY_CONFIG ??
      DEFAULT_POLICY_PATH
    );
  }

  public async reload(actorUserId?: number): Promise<void> {
    try {
      const source = fs.readFileSync(this.configPath, 'utf8');
      const candidate = validatePolicy(yaml.load(source));
      const candidateHash = sha256(source);
      if (
        this.policy &&
        this.policy.policyVersion === candidate.policyVersion &&
        this.policyHash !== candidateHash
      ) {
        throw new Error('semantic policy changes require a new policyVersion');
      }
      this.policy = candidate;
      this.policyHash = candidateHash;
      this.loadError = undefined;
      this.loadedAt = new Date();
      await this.recordEvent('policy_reload', {
        actorUserId,
        details: { mode: candidate.mode },
      });
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      await this.recordEvent('policy_reload_failed', {
        actorUserId,
        details: { error: this.loadError },
      }).catch(() => undefined);
      logger.error('Content policy reload rejected', {
        label: 'Content Policy',
        errorMessage: this.loadError,
      });
      sendContentPolicyNotification(
        Notification.CONTENT_POLICY_FAILURE,
        'Policy reload rejected',
        this.loadError
      );
      throw error;
    }
  }

  private async ensureLoaded(): Promise<ContentPolicy> {
    if (!this.policy) {
      try {
        await this.reload();
      } catch {
        throw new ContentPolicyError(
          503,
          'CONTENT_POLICY_UNAVAILABLE',
          'Content policy is unavailable.'
        );
      }
    }
    if (!this.policy || !this.policyHash) {
      throw new ContentPolicyError(
        503,
        'CONTENT_POLICY_UNAVAILABLE',
        'Content policy is unavailable.'
      );
    }
    return this.policy;
  }

  public async status() {
    const policy = await this.ensureLoaded();
    const decisionRepository = getRepository(ContentPolicyDecision);
    const eventRepository = getRepository(ContentPolicyEvent);
    const overrideRepository = getRepository(ContentPolicyOverride);
    const [
      allow,
      deny,
      review,
      activeOverrides,
      findingDecisions,
      failures,
      breakGlassEvents,
    ] = await Promise.all([
      decisionRepository.count({ where: { result: 'allow' } }),
      decisionRepository.count({ where: { result: 'deny' } }),
      decisionRepository.count({ where: { result: 'review' } }),
      overrideRepository.count({
        where: { consumedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      }),
      decisionRepository.find({
        where: { result: In(['deny', 'review']) },
        select: { sourceMemberships: true },
      }),
      eventRepository.count({
        where: {
          eventType: In([
            'policy_reload_failed',
            'metadata_fetch_failure',
            'discover_filter_failure',
            'library_scan_failed',
            'library_scan_resolution_failure',
            'dispatch_blocked',
          ]),
        },
      }),
      eventRepository.count({ where: { eventType: Like('break_glass_%') } }),
    ]);
    const libraryFindings = findingDecisions.filter((decision) =>
      decision.sourceMemberships.some((source) =>
        /^(seerr|radarr|sonarr):/.test(source)
      )
    ).length;
    return {
      mode: policy.mode,
      policyVersion: policy.policyVersion,
      policyHash: this.policyHash,
      loadedAt: this.loadedAt,
      healthy: !this.loadError,
      loadError: this.loadError,
      counts: {
        allow,
        deny,
        review,
        failures,
        libraryFindings,
        breakGlassEvents,
        activeOverrides,
      },
    };
  }

  public async getMode(): Promise<'audit' | 'enforce'> {
    return (await this.ensureLoaded()).mode;
  }

  public async fetchMetadata(
    mediaType: MediaType,
    tmdbId: number,
    options: {
      notifyFailure?: boolean;
      source?: string;
    } = {}
  ): Promise<ContentPolicyMetadata> {
    const tmdb = new TheMovieDb();
    try {
      const raw =
        mediaType === MediaType.MOVIE
          ? await tmdb.getMovie({ movieId: tmdbId })
          : await tmdb.getTvShow({ tvId: tmdbId });
      const item = raw as unknown as Record<string, unknown>;
      const keywordContainer = item.keywords as
        | {
            keywords?: { id: number; name?: string }[];
            results?: { id: number; name?: string }[];
          }
        | undefined;
      return {
        id: Number(item.id),
        mediaType,
        adult: item.adult === true,
        title: String(item.title ?? item.name ?? ''),
        originalTitle: String(item.original_title ?? item.original_name ?? ''),
        tagline: String(item.tagline ?? ''),
        overview: String(item.overview ?? ''),
        originalLanguage: String(item.original_language ?? ''),
        genreIds: Array.isArray(item.genres)
          ? (item.genres as { id: number }[]).map((genre) => genre.id)
          : [],
        keywords: keywordContainer?.keywords ?? keywordContainer?.results ?? [],
      };
    } catch (error) {
      const errorDetails = describeMetadataFetchError(error);
      const fingerprint = `${errorDetails.errorName}:${
        errorDetails.statusCode ?? 'unknown'
      }`;
      const notificationRequested = options.notifyFailure !== false;
      const eventRepository = getRepository(ContentPolicyEvent);
      const recentFailures = notificationRequested
        ? await eventRepository.find({
            where: {
              eventType: 'metadata_fetch_failure',
              mediaType,
              tmdbId,
              createdAt: MoreThan(
                new Date(Date.now() - METADATA_FAILURE_NOTIFICATION_COOLDOWN_MS)
              ),
            },
            order: { createdAt: 'DESC' },
            take: 25,
          })
        : [];
      const notificationSent = shouldNotifyMetadataFailure(
        recentFailures,
        fingerprint,
        notificationRequested
      );
      await this.recordEvent('metadata_fetch_failure', {
        mediaType,
        tmdbId,
        details: {
          ...errorDetails,
          fingerprint,
          source: options.source,
          notificationSent,
          notificationReason: notificationSent
            ? 'sent'
            : notificationRequested
              ? 'duplicate-suppressed'
              : 'source-suppressed',
        },
      });
      if (notificationSent) {
        sendContentPolicyNotification(
          Notification.CONTENT_POLICY_FAILURE,
          'Metadata evaluation failed closed',
          `${mediaType}:${tmdbId}`
        );
      }
      return {
        id: tmdbId,
        mediaType,
        genreIds: [],
        keywords: [],
        fetchFailed: true,
        fetchFailureStatus: errorDetails.statusCode,
      };
    }
  }

  public async evaluate(
    mediaType: MediaType,
    tmdbId: number,
    options: {
      metadata?: ContentPolicyMetadata;
      source?: string;
      actorUserId?: number;
      force?: boolean;
      notifyMetadataFailure?: boolean;
    } = {}
  ): Promise<ContentPolicyEvaluation> {
    const policy = await this.ensureLoaded();
    const decisionRepository = getRepository(ContentPolicyDecision);
    const current = await decisionRepository.findOne({
      where: { mediaType, tmdbId },
    });
    if (
      shouldReusePrewarmMetadataFailure(current, {
        force: options.force,
        hasMetadata: Boolean(options.metadata),
        policyHash: this.policyHash,
        source: options.source,
      })
    ) {
      if (
        options.source &&
        current &&
        !current.sourceMemberships.includes(options.source)
      ) {
        current.sourceMemberships = [
          ...current.sourceMemberships,
          options.source,
        ];
        await decisionRepository.save(current);
      }
      return this.toEvaluation(current as ContentPolicyDecision, true);
    }
    const metadata =
      options.metadata ??
      (await this.fetchMetadata(mediaType, tmdbId, {
        notifyFailure: options.notifyMetadataFailure,
        source: options.source,
      }));
    const compactMetadata = {
      id: metadata.id,
      mediaType,
      adult: metadata.adult ?? null,
      title: normalizeText(metadata.title ?? ''),
      originalTitle: normalizeText(metadata.originalTitle ?? ''),
      tagline: normalizeText(metadata.tagline ?? ''),
      overview: normalizeText(metadata.overview ?? ''),
      originalLanguage: metadata.originalLanguage ?? '',
      genreIds: [...metadata.genreIds].sort((a, b) => a - b),
      keywordIds: metadata.keywords.map(({ id }) => id).sort((a, b) => a - b),
      fetchFailed: metadata.fetchFailed ?? false,
      fetchFailureStatus: metadata.fetchFailureStatus ?? null,
    };
    const metadataHash = sha256(stableJson(compactMetadata));
    const cacheMs = policy.cacheHours * 60 * 60 * 1000;
    if (
      !options.force &&
      current &&
      current.policyHash === this.policyHash &&
      current.metadataHash === metadataHash &&
      Date.now() - current.updatedAt.getTime() < cacheMs
    ) {
      if (
        options.source &&
        !current.sourceMemberships.includes(options.source)
      ) {
        current.sourceMemberships = [
          ...current.sourceMemberships,
          options.source,
        ];
        await decisionRepository.save(current);
      }
      return this.toEvaluation(current, true);
    }

    const matchedRuleIds: string[] = [];
    const categories: string[] = [];
    const evidence: Record<string, unknown> = {};
    let result: ContentPolicyResult = 'allow';
    const addMatch = (ruleId: string, category: string) => {
      matchedRuleIds.push(ruleId);
      categories.push(category);
    };
    const manualIds =
      policy.manualDeny[mediaType === MediaType.MOVIE ? 'movie' : 'tv'];
    if (manualIds.includes(tmdbId)) addMatch('manual-deny', 'manual');
    if (metadata.adult === true)
      addMatch('tmdb-adult', 'pornography-exploitation');
    const deniedGenres = metadata.genreIds.filter((id) =>
      policy.deniedGenreIds.includes(id)
    );
    if (deniedGenres.length) {
      addMatch('genre-deny', 'horror');
      evidence.genreIds = deniedGenres;
    }
    const keywordIds = new Set(metadata.keywords.map(({ id }) => id));
    const matchedKeywords: number[] = [];
    for (const group of policy.deniedKeywords) {
      const ids = (group.keywordIds ?? []).filter((id) => keywordIds.has(id));
      if (ids.length) {
        addMatch(group.id, group.category);
        matchedKeywords.push(...ids);
      }
    }
    if (matchedKeywords.length)
      evidence.keywordIds = [...new Set(matchedKeywords)];
    const searchable = ` ${normalizeText(
      [
        metadata.title,
        metadata.originalTitle,
        metadata.tagline,
        metadata.overview,
      ]
        .filter(Boolean)
        .join(' ')
    )} `;
    for (const group of policy.explicitText) {
      const phrases = (group.phrases ?? []).filter((phrase) =>
        searchable.includes(` ${phrase} `)
      );
      if (phrases.length) addMatch(group.id, group.category);
    }
    if (matchedRuleIds.length) {
      result = 'deny';
    } else {
      if (metadata.fetchFailed) {
        addMatch('metadata-fetch-failure', 'metadata-quality');
      }
      for (const group of policy.reviewText) {
        if (
          (group.phrases ?? []).some((phrase) =>
            searchable.includes(` ${phrase} `)
          )
        ) {
          addMatch(group.id, group.category);
        }
      }
      if (!metadata.genreIds.length)
        addMatch('missing-genres', 'metadata-quality');
      if (!metadata.overview?.trim() && metadata.keywords.length === 0) {
        addMatch('missing-overview-and-keywords', 'metadata-quality');
      }
      if (
        metadata.originalLanguage &&
        !policy.supportedLanguages.includes(metadata.originalLanguage) &&
        !metadata.overview?.trim()
      ) {
        addMatch('unsupported-language-no-fallback', 'metadata-quality');
      }
      if (matchedRuleIds.length) result = 'review';
    }

    const decision =
      current ?? new ContentPolicyDecision({ mediaType, tmdbId });
    decision.result = result;
    decision.policyVersion = policy.policyVersion;
    decision.policyHash = this.policyHash as string;
    decision.metadataHash = metadataHash;
    decision.matchedRuleIds = [...new Set(matchedRuleIds)];
    decision.categories = [...new Set(categories)];
    decision.evidence = evidence;
    decision.sourceMemberships = [
      ...new Set(
        [...(decision.sourceMemberships ?? []), options.source].filter(
          Boolean
        ) as string[]
      ),
    ];
    const saved = await decisionRepository.save(decision);
    await this.recordEvent('evaluation', {
      mediaType,
      tmdbId,
      actorUserId: options.actorUserId,
      decisionId: saved.id,
      details: {
        result,
        matchedRuleIds: saved.matchedRuleIds,
        categories: saved.categories,
      },
    });
    return this.toEvaluation(saved, false);
  }

  public async assertAction(
    mediaType: MediaType,
    tmdbId: number,
    action: ContentPolicyAction,
    actorUserId: number,
    token?: string,
    metadata?: ContentPolicyMetadata
  ): Promise<{
    decision: ContentPolicyDecision;
    override?: ContentPolicyOverride;
  }> {
    const evaluation = await this.evaluate(mediaType, tmdbId, {
      metadata,
      actorUserId,
      source: `action:${action}`,
    });
    const decision = await getRepository(ContentPolicyDecision).findOneOrFail({
      where: { id: evaluation.decisionId },
    });
    if ((await this.getMode()) === 'audit' || evaluation.result === 'allow') {
      return { decision };
    }
    const override = token
      ? await this.consumeOverride(
          token,
          actorUserId,
          mediaType,
          tmdbId,
          action
        )
      : undefined;
    if (override) return { decision, override };
    await this.recordEvent('action_blocked', {
      mediaType,
      tmdbId,
      actorUserId,
      decisionId: decision.id,
      details: { action, result: evaluation.result },
    });
    if (evaluation.matchedRuleIds.includes('metadata-fetch-failure')) {
      throw new ContentPolicyError(
        503,
        'CONTENT_POLICY_UNAVAILABLE',
        'Content policy metadata is unavailable.'
      );
    }
    throw new ContentPolicyError(
      403,
      evaluation.result === 'deny'
        ? 'CONTENT_POLICY_DENIED'
        : 'CONTENT_POLICY_REVIEW_REQUIRED',
      evaluation.result === 'deny'
        ? 'This title is unavailable.'
        : 'This title requires administrator review.'
    );
  }

  public async issueOverride(input: {
    administratorId: number;
    mediaType: MediaType;
    tmdbId: number;
    action: ContentPolicyAction;
    reason: string;
  }): Promise<{ token: string; override: ContentPolicyOverride }> {
    if (![MediaType.MOVIE, MediaType.TV].includes(input.mediaType)) {
      throw new Error('Break-glass mediaType must be movie or tv.');
    }
    if (!['create', 'approve', 'retry'].includes(input.action)) {
      throw new Error('Break-glass action must be create, approve, or retry.');
    }
    if (!Number.isInteger(input.tmdbId) || input.tmdbId <= 0) {
      throw new Error('Break-glass TMDB ID is invalid.');
    }
    if (input.reason.trim().length < 20) {
      throw new Error('Break-glass reason must be at least 20 characters.');
    }
    const repository = getRepository(ContentPolicyOverride);
    const issuedLastHour = await repository.count({
      where: {
        administratorId: input.administratorId,
        createdAt: MoreThan(new Date(Date.now() - 60 * 60 * 1000)),
      },
    });
    if (issuedLastHour >= 5)
      throw new Error('Break-glass rate limit exceeded.');
    const token = randomBytes(32).toString('base64url');
    const override = await repository.save(
      new ContentPolicyOverride({
        tokenHash: sha256(token),
        administratorId: input.administratorId,
        mediaType: input.mediaType,
        tmdbId: input.tmdbId,
        action: input.action,
        reason: input.reason.trim(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      })
    );
    await this.recordEvent('break_glass_issued', {
      mediaType: input.mediaType,
      tmdbId: input.tmdbId,
      actorUserId: input.administratorId,
      details: {
        overrideId: override.id,
        action: input.action,
        expiresAt: override.expiresAt,
      },
    });
    sendContentPolicyNotification(
      Notification.CONTENT_POLICY_BREAK_GLASS,
      'Break-glass override issued',
      `${input.mediaType}:${input.tmdbId} action=${input.action} expires=${override.expiresAt.toISOString()}`
    );
    return { token, override };
  }

  private async consumeOverride(
    token: string,
    administratorId: number,
    mediaType: MediaType,
    tmdbId: number,
    action: ContentPolicyAction
  ): Promise<ContentPolicyOverride | undefined> {
    const repository = getRepository(ContentPolicyOverride);
    const item = await repository.findOne({
      where: { tokenHash: sha256(token) },
    });
    const valid =
      item &&
      item.administratorId === administratorId &&
      item.mediaType === mediaType &&
      item.tmdbId === tmdbId &&
      item.action === action &&
      !item.consumedAt &&
      item.expiresAt > new Date();
    if (!valid) {
      await this.recordEvent('break_glass_rejected', {
        mediaType,
        tmdbId,
        actorUserId: administratorId,
        details: { action },
      });
      sendContentPolicyNotification(
        Notification.CONTENT_POLICY_BREAK_GLASS,
        'Break-glass override rejected',
        `${mediaType}:${tmdbId} action=${action}`
      );
      return undefined;
    }
    const consumedAt = new Date();
    const result = await repository
      .createQueryBuilder()
      .update(ContentPolicyOverride)
      .set({ consumedAt })
      .where('id = :id', { id: item.id })
      .andWhere('consumedAt IS NULL')
      .andWhere('expiresAt > :now', { now: consumedAt })
      .execute();
    if (result.affected !== 1) return undefined;
    item.consumedAt = consumedAt;
    await this.recordEvent('break_glass_used', {
      mediaType,
      tmdbId,
      actorUserId: administratorId,
      details: { overrideId: item.id, action },
    });
    sendContentPolicyNotification(
      Notification.CONTENT_POLICY_BREAK_GLASS,
      'Break-glass override used',
      `${mediaType}:${tmdbId} action=${action}`
    );
    return item;
  }

  public async markExpiredOverrides(): Promise<number> {
    const repository = getRepository(ContentPolicyOverride);
    const expired = await repository.find({
      where: {
        consumedAt: IsNull(),
        expiredNotificationAt: IsNull(),
        expiresAt: LessThan(new Date()),
      },
    });
    for (const item of expired) {
      item.expiredNotificationAt = new Date();
      await repository.save(item);
      await this.recordEvent('break_glass_expired_unused', {
        mediaType: item.mediaType,
        tmdbId: item.tmdbId,
        actorUserId: item.administratorId,
        details: { overrideId: item.id, action: item.action },
      });
      sendContentPolicyNotification(
        Notification.CONTENT_POLICY_BREAK_GLASS,
        'Break-glass override expired unused',
        `${item.mediaType}:${item.tmdbId} action=${item.action}`
      );
    }
    return expired.length;
  }

  public async defensiveDispatchCheck(request: {
    id: number;
    type: MediaType;
    media: { tmdbId: number };
    policyDecisionId?: number | null;
    policyOverrideId?: number | null;
  }): Promise<boolean> {
    if ((await this.getMode()) === 'audit') return true;
    if (request.policyOverrideId) {
      const override = await getRepository(ContentPolicyOverride).findOne({
        where: { id: request.policyOverrideId },
      });
      if (
        override?.consumedAt &&
        override.tmdbId === request.media.tmdbId &&
        override.mediaType === request.type
      )
        return true;
    }
    if (!request.policyDecisionId) return false;
    const evaluation = await this.evaluate(request.type, request.media.tmdbId, {
      source: 'arr-dispatch',
    });
    return Boolean(
      evaluation.decisionId === request.policyDecisionId &&
      evaluation.result === 'allow'
    );
  }

  public async recordEvent(
    eventType: string,
    input: {
      mediaType?: MediaType;
      tmdbId?: number;
      actorUserId?: number;
      decisionId?: number;
      details?: Record<string, unknown>;
    } = {}
  ): Promise<ContentPolicyEvent> {
    return getRepository(ContentPolicyEvent).save(
      new ContentPolicyEvent({
        eventType,
        mediaType: input.mediaType,
        tmdbId: input.tmdbId,
        actorUserId: input.actorUserId,
        decisionId: input.decisionId,
        policyVersion: this.policy?.policyVersion,
        policyHash: this.policyHash,
        details: input.details ?? {},
      })
    );
  }

  private toEvaluation(
    decision: ContentPolicyDecision,
    cached: boolean
  ): ContentPolicyEvaluation {
    return {
      decisionId: decision.id,
      mediaType: decision.mediaType,
      tmdbId: decision.tmdbId,
      result: decision.result,
      policyVersion: decision.policyVersion,
      policyHash: decision.policyHash,
      metadataHash: decision.metadataHash,
      matchedRuleIds: decision.matchedRuleIds,
      categories: decision.categories,
      evidence: decision.evidence,
      cached,
    };
  }
}

let evaluator: ContentPolicyEvaluator | undefined;
export const getContentPolicyEvaluator = (): ContentPolicyEvaluator => {
  evaluator ??= new ContentPolicyEvaluator();
  return evaluator;
};

export type { ContentPolicyEvaluation, ContentPolicyMetadata } from './types';
export { normalizeText, validatePolicy };
