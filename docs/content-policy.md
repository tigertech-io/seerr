# Content-policy extension

This branch tracks upstream Seerr `v3.3.0` (`703faf95f454ffecae99a5e86ea761b3b524c6df`) and adds the TigerTech content-policy extension. The extension is intentionally integrated at the Seerr transaction boundary; it is not a proxy or a sidecar.

## Runtime configuration

Mount the canonical policy read-only at `/app/config/content-policy/policy.yml`, or set `CONTENT_POLICY_CONFIG` to another absolute path. The engine validates a candidate policy before swapping it into memory. A changed hash with an unchanged `policyVersion` is rejected.

`audit` mode evaluates and records every decision without hiding media or blocking acquisition. `enforce` mode enables list/detail filtering and all request, approval, retry, and defensive Arr-dispatch guards. A mode change is a semantic policy change and requires a new `policyVersion`.

The sample [policy](../content-policy/policy.yml) contains the exact 71 TMDB keyword IDs configured in the native Seerr blocklist, Horror genre ID 27, adult-flag denial, manual movie deny 200066, and normalized English/French text rules.

## Persistence and secrets

Policy decisions, events, and hashed overrides are stored in Seerr's existing database. SQLite and PostgreSQL migrations are supplied. Override plaintext is returned only once, is never logged or stored, expires after 15 minutes, and is atomically consumed for one administrator/media/action tuple.

Events store IDs, categories, rule IDs, source memberships, and hashes. They do not store posters, media paths, Arr API keys, raw metadata responses, or override tokens.

## Operator surfaces

The administrator-only `/settings/content-policy` page and `/api/v1/content-policy/*` APIs expose status, decisions, evidence, events, reload, on-demand evaluation, read-only scans, acknowledgements, and break glass. Mutation endpoints require both an interactive administrator session and a route-specific CSRF token; the global API key cannot issue overrides.

Metadata failures remain fail-closed review decisions. Identical failure notifications are persisted and deduplicated for 24 hours, and the hourly discovery prewarm reuses a recent failed decision instead of retrying it until 24 hours have elapsed. Prewarm retries never send failure notifications. An interactive administrator can retire a failed decision only when every source is `discover-search` or `hourly-prewarm`; decisions associated with a library, request, action, or Arr dispatch are not eligible. Retirement does not change policy rules or library state, and a future discovery result is evaluated again.

## Image and upgrades

The `Policy image` workflow runs typecheck, lint, tests, production build, a linux/amd64 image build, SBOM generation, and a high/critical vulnerability scan before publishing `ghcr.io/tigertech-io/seerr:3.3.0-policy.6`. Deploy by resolved digest only.

For every upstream upgrade, rebase a new policy branch on the exact upstream tag, rerun acquisition-boundary and filter tests, publish a new immutable policy tag, and complete an audit-mode observation window before enforcement is approved.
