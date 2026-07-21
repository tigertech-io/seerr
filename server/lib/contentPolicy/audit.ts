import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import { getContentPolicyEvaluator } from '.';

export const runContentPolicyLibraryAudit = async (
  actorUserId?: number
): Promise<{ evaluated: number; readOnly: true }> => {
  const evaluator = getContentPolicyEvaluator();
  const settings = getSettings();
  const sources = new Map<
    string,
    { mediaType: MediaType; tmdbId: number; sources: string[] }
  >();
  const add = (mediaType: MediaType, tmdbId: number, source: string) => {
    const key = `${mediaType}:${tmdbId}`;
    const current = sources.get(key) ?? { mediaType, tmdbId, sources: [] };
    current.sources = [...new Set([...current.sources, source])];
    sources.set(key, current);
  };

  const localMedia = await getRepository(Media).find();
  for (const media of localMedia) {
    if (
      [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE].includes(
        media.status
      ) ||
      [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE].includes(
        media.status4k
      )
    ) {
      add(media.mediaType, media.tmdbId, `seerr:${media.id}`);
    }
  }

  for (const server of settings.radarr.filter((item) => item.syncEnabled)) {
    const api = new RadarrAPI({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    });
    for (const movie of await api.getMovies()) {
      add(MediaType.MOVIE, movie.tmdbId, `radarr:${movie.id}`);
    }
  }

  const tmdb = new TheMovieDb();
  for (const server of settings.sonarr.filter((item) => item.syncEnabled)) {
    const api = new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });
    for (const series of await api.getSeries()) {
      const match = await tmdb.getByExternalId({
        externalId: series.tvdbId,
        type: 'tvdb',
      });
      const tmdbId = match.tv_results?.[0]?.id;
      if (tmdbId) add(MediaType.TV, tmdbId, `sonarr:${series.id}`);
    }
  }

  const items = [...sources.values()];
  let cursor = 0;
  const workers = Array.from({ length: 8 }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      const metadata = await evaluator.fetchMetadata(
        item.mediaType,
        item.tmdbId
      );
      for (const source of item.sources) {
        await evaluator.evaluate(item.mediaType, item.tmdbId, {
          metadata,
          source,
          actorUserId,
          force: true,
        });
      }
    }
  });
  await Promise.all(workers);
  await evaluator.recordEvent('library_scan_completed', {
    actorUserId,
    details: { evaluated: items.length, readOnly: true },
  });
  return { evaluated: items.length, readOnly: true };
};

export const prewarmContentPolicy = async (): Promise<number> => {
  const decisions = await getRepository(
    (await import('@server/entity/ContentPolicyDecision')).default
  ).find({ order: { updatedAt: 'DESC' }, take: 200 });
  const evaluator = getContentPolicyEvaluator();
  let completed = 0;
  let cursor = 0;
  const workers = Array.from({ length: 8 }, async () => {
    while (cursor < decisions.length) {
      const item = decisions[cursor++];
      await evaluator.evaluate(item.mediaType, item.tmdbId, {
        source: 'hourly-prewarm',
      });
      completed += 1;
    }
  });
  await Promise.all(workers);
  return completed;
};
