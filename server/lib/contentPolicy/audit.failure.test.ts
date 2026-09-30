import { getRepository } from '@server/datasource';
import ContentPolicyEvent from '@server/entity/ContentPolicyEvent';
import { runContentPolicyLibraryAudit } from '@server/lib/contentPolicy/audit';
import { getSettings, type RadarrSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('read-only library audit failure', () => {
  setupTestDb();

  it('records a failed scheduled scan and never records completion', async () => {
    const settings = getSettings();
    settings.radarr = [
      {
        hostname: '127.0.0.1',
        port: 1,
        apiKey: 'test',
        useSsl: false,
        syncEnabled: true,
      } as RadarrSettings,
    ];
    settings.sonarr = [];

    await assert.rejects(runContentPolicyLibraryAudit());

    const events = await getRepository(ContentPolicyEvent).find();
    assert.equal(
      events.filter((event) => event.eventType === 'library_scan_failed')
        .length,
      1
    );
    assert.equal(
      events.filter((event) => event.eventType === 'library_scan_completed')
        .length,
      0
    );
    assert.deepEqual(
      Object.keys(
        events.find((event) => event.eventType === 'library_scan_failed')
          ?.details ?? {}
      ),
      ['errorName']
    );
  });
});
