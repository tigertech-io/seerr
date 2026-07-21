import logger from '@server/logger';
import path from 'node:path';
import { after, before } from 'node:test';

process.env.CONTENT_POLICY_CONFIG ??= path.resolve(
  process.cwd(),
  'content-policy/policy.yml'
);

before(() => {
  if (process.env.VERBOSE != 'true') logger.silent = true;
});

after(() => {
  if (process.env.VERBOSE != 'true') logger.silent = false;
});
