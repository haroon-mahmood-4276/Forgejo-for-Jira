# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Git tags carry the app's version; Forge assigns its own
version on every deploy, and the two are not expected to match.

## [1.1.0] — 2026-09-13

### Security

- Webhook deliveries are now accepted only for repositories that were connected through the admin
  page. A valid signature proves a delivery came from the Forgejo instance, not that the administrator
  chose that repository, so a correctly signed delivery for any other repository is refused with 404.
- Connection identifiers in trigger URLs and resolver payloads are validated for shape before storage
  is consulted.
- The project settings view now requires project-administrator permission, matching the resolver
  that Jira renders it for.
- The OAuth client secret is no longer copied into the pending-authorization record; the callback
  reads it from the connection's own secret record, so it exists in one place.
- The OAuth result page adds `X-Content-Type-Options`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store` and `frame-ancestors 'none'` to its existing CSP and frame headers, and
  escapes its heading.
- Forgejo instance URLs must not carry embedded credentials, a query string or a fragment.
- Forgejo usernames are no longer written to logs.
- Explicit `issueKeys` in a CI report are validated against the issue-key shape before being
  forwarded to Jira.
- CI runs with least-privilege token permissions and CodeQL's `security-and-quality` query suite.

### Fixed

- Two invocations refreshing the same expiring Forgejo token at once (a backfill page and a webhook,
  for example) could race. Forgejo rotates refresh tokens, so the loser's token was refused and the
  connection broke until re-authorized. A refresh now re-reads the stored token first and adopts one
  a sibling has already obtained.
- Reconnecting a repository whose earlier webhook was left behind on Forgejo no longer creates a
  second, identical webhook that delivers every event twice.
- Deleting a repository in Forgejo now removes the app's stored record as well as the Jira data.
- Re-importing a repository while an import was still running let stale queued pages add to the new
  progress counts. Restarting is now refused while an import is making progress and allowed once it
  has been idle for an hour, so a stalled import can be repaired from the admin page.
- A build or deployment report without a `url`, or with a non-numeric `buildNumber`, was forwarded
  to Jira and rejected there with a schema error relayed as 502. It is now refused with a 400 that
  names the field.
- A pull request payload with no number or URL could fail the whole devinfo batch; it is now skipped.
- Repository identity on connect (id, name, URL, default branch) is taken from Forgejo rather than
  from the browser, and the authorizing account's admin permission on the repository is checked.

### Changed

- Inbound delivery authentication for the repository webhook and the CI reporter is shared in
  `src/lib/delivery.js` rather than duplicated.
- Storage listing follows one prefix-scan helper.
- Removed unused code: the `updateConnection` resolver, project-link storage and its resolver, and
  overview fields the admin page never read.
- Documentation rewritten: README, SECURITY, PRIVACY; added NOTICE, CONTRIBUTING, CODE_OF_CONDUCT,
  SUPPORT and this changelog. Support and security contacts are now
  `support@iamroon.pk` and `security@iamroon.pk`.

## [1.0.0] — 2026-08-16

First release.

- Commits, branches and pull requests from Forgejo webhooks and a paged historical import.
- Builds from Forgejo Actions run webhooks; deployments and feature flags from a generated workflow
  step.
- Per-connection webhook signing secrets, PKCE OAuth, Jira-permission-guarded resolvers.

[Unreleased]: https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/compare/v1.1.0...v1
[1.1.0]: https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/releases/tag/v1.0.0
