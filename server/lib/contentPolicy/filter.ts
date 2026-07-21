import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import type { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getContentPolicyEvaluator } from '.';

type ListItem = Record<string, unknown> & {
  id?: number;
  tmdbId?: number;
  mediaType?: string;
  media_type?: string;
  adult?: boolean;
  knownFor?: ListItem[];
  known_for?: ListItem[];
};

const withTimeout = async <T>(
  promise: Promise<T>,
  milliseconds: number
): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error('content-policy-timeout')),
        milliseconds
      )
    ),
  ]);

export const filterContentPolicyPayload = async <T>(
  payload: T,
  user?: User
): Promise<T> => {
  if (!payload || typeof payload !== 'object') return payload;
  const container = payload as Record<string, unknown>;
  if (!Array.isArray(container.results)) return payload;
  const administrator = Boolean(user?.hasPermission(Permission.ADMIN));
  const evaluator = getContentPolicyEvaluator();
  const enforcing = (await evaluator.getMode()) === 'enforce';
  const tmdb = new TheMovieDb();
  const input = container.results as ListItem[];
  const output: (ListItem | undefined)[] = new Array(input.length);
  let cursor = 0;

  const evaluateMedia = async (item: ListItem) => {
    const mediaTypeValue = item.mediaType ?? item.media_type;
    const mediaType =
      mediaTypeValue === 'movie'
        ? MediaType.MOVIE
        : mediaTypeValue === 'tv'
          ? MediaType.TV
          : undefined;
    const tmdbId = Number(item.tmdbId ?? item.id);
    if (!mediaType || !Number.isInteger(tmdbId)) return undefined;
    try {
      return await withTimeout(
        evaluator.evaluate(mediaType, tmdbId, { source: 'discover-search' }),
        7500
      );
    } catch {
      await evaluator.recordEvent('discover_filter_failure', {
        mediaType,
        tmdbId,
        actorUserId: user?.id,
        details: { failClosed: true },
      });
      return {
        result: 'review' as const,
        policyVersion: 'unavailable',
        policyHash: 'unavailable',
        matchedRuleIds: ['filter-timeout-or-failure'],
        categories: ['metadata-quality'],
      };
    }
  };

  const workers = Array.from({ length: 8 }, async () => {
    while (cursor < input.length) {
      const index = cursor++;
      const item = input[index];
      const itemType = item.mediaType ?? item.media_type;
      if (itemType === 'person') {
        const knownFor = (item.knownFor ?? item.known_for ?? []) as ListItem[];
        const visible: ListItem[] = [];
        for (const known of knownFor) {
          const decision = await evaluateMedia(known);
          if (decision?.result === 'allow' || !enforcing || administrator) {
            visible.push(
              administrator ? { ...known, contentPolicy: decision } : known
            );
          }
        }
        if (administrator || !enforcing || (!item.adult && visible.length)) {
          output[index] = {
            ...item,
            ...(item.knownFor ? { knownFor: visible } : { known_for: visible }),
            ...(administrator && item.adult
              ? {
                  contentPolicy: {
                    result: 'deny',
                    matchedRuleIds: ['tmdb-adult'],
                  },
                }
              : {}),
          };
        }
        continue;
      }
      if (itemType === 'collection') {
        try {
          const collection = await withTimeout(
            tmdb.getCollection({ collectionId: Number(item.id) }),
            7500
          );
          const partDecisions = await Promise.all(
            collection.parts.map((part) =>
              withTimeout(
                evaluator.evaluate(MediaType.MOVIE, part.id, {
                  source: `collection:${item.id}`,
                }),
                7500
              )
            )
          );
          const result = partDecisions.every(
            (decision) => decision.result === 'allow'
          )
            ? 'allow'
            : partDecisions.some((decision) => decision.result === 'deny')
              ? 'deny'
              : 'review';
          if (result === 'allow' || !enforcing || administrator) {
            output[index] = administrator
              ? {
                  ...item,
                  contentPolicy: { result, partCount: partDecisions.length },
                }
              : item;
          }
        } catch {
          if (administrator) {
            output[index] = {
              ...item,
              contentPolicy: {
                result: 'review',
                matchedRuleIds: ['collection-evaluation-failure'],
              },
            };
          }
        }
        continue;
      }
      if (itemType !== 'movie' && itemType !== 'tv') {
        output[index] = item;
        continue;
      }
      const decision = await evaluateMedia(item);
      if (decision?.result === 'allow' || !enforcing || administrator) {
        output[index] = administrator
          ? { ...item, contentPolicy: decision }
          : item;
      }
    }
  });
  await Promise.all(workers);
  return { ...container, results: output.filter(Boolean) } as T;
};

export const contentPolicyResponseFilter: Middleware = (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    void filterContentPolicyPayload(body, req.user)
      .then((filtered) => originalJson(filtered))
      .catch(() =>
        originalJson(
          body &&
            typeof body === 'object' &&
            Array.isArray((body as Record<string, unknown>).results)
            ? { ...(body as Record<string, unknown>), results: [] }
            : body
        )
      );
    return res;
  }) as typeof res.json;
  next();
};

export const contentPolicyDetailGuard =
  (mediaType: MediaType): Middleware =>
  async (req, res, next) => {
    try {
      const evaluator = getContentPolicyEvaluator();
      const decision = await evaluator.evaluate(
        mediaType,
        Number(req.params.id),
        {
          source: 'direct-detail',
          actorUserId: req.user?.id,
        }
      );
      const administrator = Boolean(req.user?.hasPermission(Permission.ADMIN));
      if (
        (await evaluator.getMode()) === 'enforce' &&
        decision.result !== 'allow' &&
        !administrator
      ) {
        res.status(404).json({ status: 404, message: 'Media not found.' });
        return;
      }
      if (administrator) {
        const mode = await evaluator.getMode();
        const originalJson = res.json.bind(res);
        res.json = ((body: unknown) =>
          originalJson(
            body && typeof body === 'object'
              ? {
                  ...(body as Record<string, unknown>),
                  contentPolicy: { ...decision, mode },
                }
              : body
          )) as typeof res.json;
      }
      next();
    } catch {
      if (req.user?.hasPermission(Permission.ADMIN)) {
        res.status(503).json({
          status: 503,
          code: 'CONTENT_POLICY_UNAVAILABLE',
          message: 'Content policy is unavailable.',
        });
      } else {
        res.status(404).json({ status: 404, message: 'Media not found.' });
      }
    }
  };
