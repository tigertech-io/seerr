import { resolveSonarrTmdbId } from '@server/lib/contentPolicy/audit';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Sonarr TVDB to TMDB audit resolution', () => {
  it('returns the first resolved TMDB television ID', async () => {
    const tmdb = {
      getByExternalId: async () => ({ tv_results: [{ id: 12345 }] }),
    };
    assert.deepEqual(await resolveSonarrTmdbId(tmdb as never, 6789), {
      tmdbId: 12345,
    });
  });

  it('reports an explicit not-found result instead of silently skipping', async () => {
    const tmdb = { getByExternalId: async () => ({ tv_results: [] }) };
    assert.deepEqual(await resolveSonarrTmdbId(tmdb as never, 6789), {
      failure: 'not_found',
    });
  });

  it('reports lookup failures without exposing the exception message', async () => {
    const tmdb = {
      getByExternalId: async () => {
        throw new TypeError('secret-bearing upstream response');
      },
    };
    assert.deepEqual(await resolveSonarrTmdbId(tmdb as never, 6789), {
      failure: 'lookup_failed',
      errorName: 'TypeError',
    });
  });
});
