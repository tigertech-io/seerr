import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

type OpenApiDocument = {
  paths?: Record<string, Record<string, unknown>>;
};

const contentPolicyOperations: [string, string][] = [
  ['/content-policy/status', 'get'],
  ['/content-policy/decisions', 'get'],
  ['/content-policy/decisions/{mediaType}/{tmdbId}', 'get'],
  ['/content-policy/events', 'get'],
  ['/content-policy/evaluate', 'post'],
  ['/content-policy/reload', 'post'],
  ['/content-policy/decisions/{id}/acknowledge', 'post'],
  ['/content-policy/decisions/{id}/retire-metadata-failure', 'post'],
  ['/content-policy/break-glass', 'post'],
  ['/content-policy/scans', 'post'],
];

describe('content-policy OpenAPI contract', () => {
  it('registers every content-policy route before request validation', () => {
    const document = yaml.load(
      fs.readFileSync(path.resolve('seerr-api.yml'), 'utf8')
    ) as OpenApiDocument;

    for (const [route, method] of contentPolicyOperations) {
      assert.ok(document.paths?.[route], `Missing OpenAPI path: ${route}`);
      assert.ok(
        document.paths[route][method],
        `Missing OpenAPI operation: ${method.toUpperCase()} ${route}`
      );
    }
  });

  it('restricts break-glass and evaluation request values', () => {
    const document = yaml.load(
      fs.readFileSync(path.resolve('seerr-api.yml'), 'utf8')
    ) as OpenApiDocument;
    const serialized = JSON.stringify({
      evaluate: document.paths?.['/content-policy/evaluate']?.post,
      breakGlass: document.paths?.['/content-policy/break-glass']?.post,
    });

    assert.match(serialized, /"enum":\["movie","tv"\]/);
    assert.match(serialized, /"enum":\["create","approve","retry"\]/);
    assert.match(serialized, /"minLength":20/);
  });
});
