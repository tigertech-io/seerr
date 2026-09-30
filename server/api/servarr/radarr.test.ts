import RadarrAPI from '@server/api/servarr/radarr';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Radarr movie-list timeout', () => {
  it('uses a per-call timeout for the read-only library request', async () => {
    const api = new RadarrAPI({
      url: 'http://127.0.0.1/api/v3',
      apiKey: 'test',
    });
    let requestedPath: string | undefined;
    let requestedTimeout: number | undefined;
    const client = api as unknown as {
      axios: {
        get: (
          path: string,
          options: { timeout?: number }
        ) => Promise<{
          data: { id: number; tmdbId: number }[];
        }>;
      };
    };
    client.axios.get = async (path, options) => {
      requestedPath = path;
      requestedTimeout = options.timeout;
      return { data: [{ id: 1, tmdbId: 2 }] };
    };

    const movies = await api.getMovies({ timeout: 60_000 });

    assert.equal(requestedPath, '/movie');
    assert.equal(requestedTimeout, 60_000);
    assert.deepEqual(movies, [{ id: 1, tmdbId: 2 }]);
  });
});
