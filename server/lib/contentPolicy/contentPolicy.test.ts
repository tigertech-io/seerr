import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import ContentPolicyOverride from '@server/entity/ContentPolicyOverride';
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

  it('denies every native keyword and at least five fixtures per category', async () => {
    const policy = yaml.load(fs.readFileSync(policyPath, 'utf8')) as {
      deniedKeywords: {
        id: string;
        category: string;
        keywordIds: number[];
      }[];
    };
    const evaluator = new ContentPolicyEvaluator(policyPath);
    await evaluator.reload();
    let fixtureId = 600000;
    for (const group of policy.deniedKeywords) {
      assert.ok(
        group.keywordIds.length >= 5,
        `${group.category} must contain at least five acceptance fixtures`
      );
      for (const keywordId of group.keywordIds) {
        const result = await evaluator.evaluate(MediaType.MOVIE, fixtureId, {
          metadata: metadata({
            id: fixtureId++,
            keywords: [{ id: keywordId, name: group.id }],
          }),
          force: true,
        });
        assert.equal(result.result, 'deny', `keyword ${keywordId} escaped`);
        assert.ok(result.categories.includes(group.category));
      }
    }
  });

  it('meets the prohibited and family-safe acceptance dataset thresholds', async () => {
    const evaluator = new ContentPolicyEvaluator(policyPath);
    await evaluator.reload();
    const prohibited = [
      metadata({ id: 976912, keywords: [{ id: 207767 }] }),
      metadata({ id: 200066 }),
      metadata({ id: 700003, adult: true }),
      metadata({ id: 700004, genreIds: [27] }),
      metadata({ id: 700005, overview: 'A story about a demonic cult.' }),
    ];
    for (const item of prohibited) {
      const result = await evaluator.evaluate(item.mediaType, item.id, {
        metadata: item,
        force: true,
      });
      assert.notEqual(result.result, 'allow', `TMDB ${item.id} escaped`);
    }

    const controlResults = [];
    for (let index = 0; index < 50; index += 1) {
      const id = 710000 + index;
      controlResults.push(
        await evaluator.evaluate(MediaType.MOVIE, id, {
          metadata: metadata({
            id,
            title: `Family Adventure ${index + 1}`,
            originalTitle: `Family Adventure ${index + 1}`,
            overview: `Friends solve puzzle ${index + 1} during a summer holiday.`,
            keywords: [{ id: 800000 + index, name: 'family adventure' }],
          }),
          force: true,
        })
      );
    }
    assert.equal(
      controlResults.filter((result) => result.result === 'deny').length,
      0
    );
    assert.ok(
      controlResults.filter((result) => result.result === 'review').length <= 5
    );
  });

  it('uses whole-token matching for English and French phrases', async () => {
    const evaluator = new ContentPolicyEvaluator(policyPath);
    await evaluator.reload();
    const safe = await evaluator.evaluate(MediaType.MOVIE, 720001, {
      metadata: metadata({
        id: 720001,
        overview:
          'A family attends a Gorecki concerto after studying paranormality.',
      }),
      force: true,
    });
    assert.equal(safe.result, 'allow');

    const french = await evaluator.evaluate(MediaType.MOVIE, 720002, {
      metadata: metadata({
        id: 720002,
        originalLanguage: 'fr',
        overview: 'Une enquete sur un culte satanique.',
      }),
      force: true,
    });
    assert.equal(french.result, 'deny');
    assert.ok(french.categories.includes('occult'));
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
          "policyVersion: '2026-07-21.1'",
          "policyVersion: 'test-enforce'"
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

  it('validates break-glass reasons, rate limits, and hashed storage', async () => {
    const evaluator = new ContentPolicyEvaluator(policyPath);
    await evaluator.reload();
    await assert.rejects(
      () =>
        evaluator.issueOverride({
          administratorId: 31,
          mediaType: MediaType.MOVIE,
          tmdbId: 200066,
          action: 'create',
          reason: 'Too short',
        }),
      /at least 20 characters/
    );
    let plaintextToken = '';
    for (let index = 0; index < 5; index += 1) {
      const issued = await evaluator.issueOverride({
        administratorId: 31,
        mediaType: MediaType.MOVIE,
        tmdbId: 200066 + index,
        action: 'create',
        reason: `Approved emergency exception number ${index + 1}.`,
      });
      plaintextToken = issued.token;
      assert.notEqual(issued.override.tokenHash, issued.token);
      assert.equal(issued.override.tokenHash.length, 64);
    }
    const stored = await getRepository(ContentPolicyOverride).findOne({
      where: { administratorId: 31, tmdbId: 200070 },
    });
    assert.ok(stored);
    assert.notEqual(stored.tokenHash, plaintextToken);
    await assert.rejects(
      () =>
        evaluator.issueOverride({
          administratorId: 31,
          mediaType: MediaType.MOVIE,
          tmdbId: 200071,
          action: 'create',
          reason: 'A sixth emergency exception must be rate limited.',
        }),
      /rate limit/
    );
  });

  it('rejects wrong-owner, wrong-action, and expired break-glass tokens', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-policy-'));
    const tempPolicy = path.join(tempDir, 'policy.yml');
    fs.writeFileSync(
      tempPolicy,
      fs
        .readFileSync(policyPath, 'utf8')
        .replace(
          "policyVersion: '2026-07-21.1'",
          "policyVersion: 'test-enforce-binding'"
        )
        .replace('mode: audit', 'mode: enforce')
    );
    const evaluator = new ContentPolicyEvaluator(tempPolicy);
    await evaluator.reload();

    const wrongOwner = await evaluator.issueOverride({
      administratorId: 41,
      mediaType: MediaType.MOVIE,
      tmdbId: 200066,
      action: 'create',
      reason: 'Emergency owner-binding validation exception.',
    });
    await assert.rejects(() =>
      evaluator.assertAction(
        MediaType.MOVIE,
        200066,
        'create',
        42,
        wrongOwner.token,
        metadata({ id: 200066 })
      )
    );

    const wrongAction = await evaluator.issueOverride({
      administratorId: 41,
      mediaType: MediaType.MOVIE,
      tmdbId: 200066,
      action: 'create',
      reason: 'Emergency action-binding validation exception.',
    });
    await assert.rejects(() =>
      evaluator.assertAction(
        MediaType.MOVIE,
        200066,
        'approve',
        41,
        wrongAction.token,
        metadata({ id: 200066 })
      )
    );

    const expired = await evaluator.issueOverride({
      administratorId: 41,
      mediaType: MediaType.MOVIE,
      tmdbId: 200066,
      action: 'retry',
      reason: 'Emergency expiry validation exception for testing.',
    });
    await getRepository(ContentPolicyOverride).update(expired.override.id, {
      expiresAt: new Date(Date.now() - 1000),
    });
    await assert.rejects(() =>
      evaluator.assertAction(
        MediaType.MOVIE,
        200066,
        'retry',
        41,
        expired.token,
        metadata({ id: 200066 })
      )
    );
    assert.equal(await evaluator.markExpiredOverrides(), 1);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('atomically consumes a break-glass token under concurrent use', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-policy-'));
    const tempPolicy = path.join(tempDir, 'policy.yml');
    fs.writeFileSync(
      tempPolicy,
      fs
        .readFileSync(policyPath, 'utf8')
        .replace(
          "policyVersion: '2026-07-21.1'",
          "policyVersion: 'test-enforce-concurrency'"
        )
        .replace('mode: audit', 'mode: enforce')
    );
    const evaluator = new ContentPolicyEvaluator(tempPolicy);
    await evaluator.reload();
    const issued = await evaluator.issueOverride({
      administratorId: 51,
      mediaType: MediaType.MOVIE,
      tmdbId: 200066,
      action: 'create',
      reason: 'Emergency concurrent-consumption validation exception.',
    });
    const blockedMetadata = metadata({ id: 200066 });
    await evaluator.evaluate(MediaType.MOVIE, 200066, {
      metadata: blockedMetadata,
      force: true,
    });
    const attempts = await Promise.allSettled(
      [1, 2].map(() =>
        evaluator.assertAction(
          MediaType.MOVIE,
          200066,
          'create',
          51,
          issued.token,
          blockedMetadata
        )
      )
    );
    assert.equal(
      attempts.filter((attempt) => attempt.status === 'fulfilled').length,
      1
    );
    assert.equal(
      attempts.filter((attempt) => attempt.status === 'rejected').length,
      1
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
