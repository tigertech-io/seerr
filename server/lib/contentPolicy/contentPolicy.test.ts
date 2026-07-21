import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import {
  ContentPolicyEvaluator,
  normalizeText,
} from '@server/lib/contentPolicy';
import { setupTestDb } from '@server/test/db';
import yaml from 'js-yaml';

setupTestDb();

const policyPath = path.resolve('content-policy/policy.yml');
const metadata = (
  overrides: Partial<{
    id: number;
    mediaType: MediaType;
    adult: boolean;
    title: string;
    originalTitle: string;
    tagline: string;
    overview: string;
    originalLanguage: string;
    genreIds: number[];
    keywords: { id: number; name?: string }[];
  }> = {}
) => ({
  id: 123,
  mediaType: MediaType.MOVIE,
  adult: false,
  title: 'A Safe Family Adventure',
  originalTitle: 'A Safe Family Adventure',
  tagline: 'Friends solve a puzzle',
  overview: 'A family works together during a summer holiday.',
  originalLanguage: 'en',
  genreIds: [12, 10751],
  keywords: [{ id: 111, name: 'family' }],
  ...overrides,
});

describe('ContentPolicyEvaluator', () => {
  it('normalizes Unicode, punctuation, whitespace, and diacritics', () => {
    assert.equal(normalizeText('  Horreur—ÉROTIQUE!!  '), 'horreur erotique');
  });

  it('contains the exact 71 native keyword IDs without duplicates', () => {
    const policy = yaml.load(fs.readFileSync(policyPath, 'utf8')) as {
      deniedKeywords: { keywordIds: number[] }[];
    };
    const ids = policy.deniedKeywords.flatMap((group) => group.keywordIds);
    assert.equal(ids.length, 71);
    assert.equal(new Set(ids).size, 71);
    assert.ok(ids.includes(207767));
    assert.ok(ids.includes(345799));
    assert.ok(ids.includes(287884));
  });

  it('denies manual IDs, adult content, Horror, keywords, and explicit phrases', async () => {
    const evaluator = new ContentPolicyEvaluator(policyPath);
    await evaluator.reload();
    const cases = [
      metadata({ id: 200066 }),
      metadata({ adult: true }),
      metadata({ genreIds: [27] }),
      metadata({ keywords: [{ id: 207767, name: 'erotic thriller' }] }),
      metadata({ overview: 'A documentary about a demonic cult.' }),
    ];
    for (const item of cases) {
      const result = await evaluator.evaluate(item.mediaType, item.id, {
        metadata: item,
        force: true,
      });
      assert.equal(result.result, 'deny');
    }
  });

  it('reviews ambiguous, unsupported, and incomplete metadata', async () => {
    const evaluator = new ContentPolicyEvaluator(policyPath);
    await evaluator.reload();
    const cases = [
      metadata({ overview: 'A tale involving the paranormal.' }),
      metadata({ overview: '', originalLanguage: 'ja', keywords: [] }),
      metadata({ overview: '', keywords: [] }),
      metadata({ genreIds: [] }),
    ];
    for (const item of cases) {
      const result = await evaluator.evaluate(item.mediaType, item.id, {
        metadata: item,
        force: true,
      });
      assert.equal(result.result, 'review');
    }
  });

  it('allows a complete family-safe control', async () => {
    const evaluator = new ContentPolicyEvaluator(policyPath);
    await evaluator.reload();
    const result = await evaluator.evaluate(MediaType.MOVIE, 123, {
      metadata: metadata(),
      force: true,
    });
    assert.equal(result.result, 'allow');
  });

  it('rejects a changed policy hash without a new semantic version atomically', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-policy-'));
    const tempPolicy = path.join(tempDir, 'policy.yml');
    const source = fs.readFileSync(policyPath, 'utf8');
    fs.writeFileSync(tempPolicy, source);
    const evaluator = new ContentPolicyEvaluator(tempPolicy);
    await evaluator.reload();
    const before = await evaluator.status();
    fs.writeFileSync(
      tempPolicy,
      source.replace('cacheHours: 6', 'cacheHours: 7')
    );
    await assert.rejects(() => evaluator.reload(), /new policyVersion/);
    const after = await evaluator.status();
    assert.equal(after.policyHash, before.policyHash);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('binds break-glass to one administrator, media, action, and successful use', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-policy-'));
    const tempPolicy = path.join(tempDir, 'policy.yml');
    fs.writeFileSync(
      tempPolicy,
      fs
        .readFileSync(policyPath, 'utf8')
        .replace(
          'policyVersion: "2026-07-21.1"',
          'policyVersion: "test-enforce"'
        )
        .replace('mode: audit', 'mode: enforce')
    );
    const evaluator = new ContentPolicyEvaluator(tempPolicy);
    await evaluator.reload();
    const issued = await evaluator.issueOverride({
      administratorId: 1,
      mediaType: MediaType.MOVIE,
      tmdbId: 200066,
      action: 'create',
      reason: 'Emergency operator-approved exception for testing.',
    });
    const first = await evaluator.assertAction(
      MediaType.MOVIE,
      200066,
      'create',
      1,
      issued.token,
      metadata({ id: 200066 })
    );
    assert.equal(first.override?.id, issued.override.id);
    await assert.rejects(() =>
      evaluator.assertAction(
        MediaType.MOVIE,
        200066,
        'create',
        1,
        issued.token,
        metadata({ id: 200066 })
      )
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
