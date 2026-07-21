import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('content policy CSRF contract', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'server/routes/contentPolicy.ts'),
    'utf8'
  );

  it('reuses Seerr global CSRF secret cookie instead of a session secret', () => {
    assert.match(source, /key: '_csrf'/);
    assert.match(source, /path: '\/'/);
    assert.doesNotMatch(source, /routes\.use\(csurf\(\)\);/);
  });

  it('keeps the browser-readable token cookie aligned with the secret cookie', () => {
    assert.match(source, /res\.cookie\('XSRF-TOKEN', req\.csrfToken\(\)/);
    assert.match(source, /secure: secureCsrfCookie/);
  });
});
