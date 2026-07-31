import logger from '@server/logger';
import { existsSync } from 'fs';
import path from 'path';
import semver from 'semver';

const COMMIT_TAG_PATH = path.join(__dirname, '../../committag.json');
let commitTag = 'local';

if (existsSync(COMMIT_TAG_PATH)) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  commitTag = require(COMMIT_TAG_PATH).commitTag;
  logger.info(`Commit Tag: ${commitTag}`);
}

export const getCommitTag = (): string => {
  return commitTag;
};

export const getAppVersion = (): string => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { version } = require('../../package.json');

  let finalVersion = version;

  if (version === '0.1.0') {
    finalVersion = `develop-${getCommitTag()}`;
  }

  return finalVersion;
};

// Maintained builds append a policy revision (for example
// `3.3.0-policy.6`) while remaining based on an exact upstream release.
// Compare the numeric upstream versions so the custom suffix does not make a
// current maintained build appear older than the release it tracks.
export const isNewerUpstreamRelease = (
  currentVersion: string,
  releaseVersion: string
): boolean => {
  const current = semver.coerce(currentVersion);
  const release = semver.coerce(releaseVersion);

  if (!current || !release) {
    return !releaseVersion.includes(currentVersion);
  }

  return semver.gt(release, current);
};
