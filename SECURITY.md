# Security

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** to
[security@iamroon.pk](mailto:security@iamroon.pk). Do not open a public GitHub issue for a security
problem.

Include what you can of: the affected component or endpoint, steps to reproduce, the impact you
believe it has, and whether it has been disclosed anywhere else. You will receive an acknowledgement
within **5 business days**. Confirmed issues are fixed and released as quickly as is responsible;
you will be told when a fix ships and, if you wish, credited in the release notes.

Please give the maintainer a reasonable opportunity to fix an issue before disclosing it publicly. In
return, good-faith research that stays within these terms will not be met with legal action from the
maintainer:

- Test only against your own Jira site and your own Forgejo instance, or a deployment you have been
  given permission to test.
- Do not access, modify or delete anyone else's data.
- Do not degrade the service for other users of the Atlassian platform.

This is an open-source project maintained by an individual. There is no bug bounty programme.

## Supported versions

Only the most recent release on the current major branch (`v1`) receives security fixes. Older
releases should be upgraded.

---

## Trust model

The app sits between two systems the customer controls: a Forgejo instance and a Jira Cloud site. It
holds credentials for the first and writes to the second. It runs entirely on Atlassian Forge; the
vendor operates no server in the data path and cannot read customer data.

Three things must hold for the app to be safe:

1. Only a Jira administrator can decide which Forgejo instance this site trusts, and which
   repositories on it feed the site.
2. Nobody but that instance, and only for those repositories, can submit development data into this
   site through the app.
3. Credentials never leave the backend.

Each is addressed below.

## Authentication of inbound deliveries

Both public receivers — the repository webhook and the Forgejo Actions reporter — are unauthenticated
URLs by construction, so every delivery is verified by one shared code path (`src/lib/delivery.js`):

- The URL carries a `?c=<connectionId>` parameter. It is a **selector, not a credential**: it chooses
  which stored signing secret to check against and grants nothing on its own. A value that is not
  shaped like a connection identifier is rejected before storage is consulted.
- The delivery must carry `X-Forgejo-Signature` (or Gitea's older `X-Gitea-Signature`), an
  HMAC-SHA256 over the request body using that connection's secret. The Forge platform strips line
  feeds from the delivered body, so the digest is checked against the body as received and against a
  reconstruction of Forgejo's original pretty-printed rendering; a delivery must match one of them
  under the same secret.
- Digests are compared with `crypto.timingSafeEqual`. A `===` comparison returns as soon as it finds
  a differing byte, which leaks enough timing information to recover a valid signature byte by byte.
- Missing connection id, malformed id, unknown connection, missing signature, invalid signature and a
  body that is not a JSON object are each rejected with a distinct status **before the body is
  interpreted**.
- **A valid signature is not enough.** The signing secret is shared by every repository on a
  connection, so it proves the delivery came from the instance, not that the administrator chose to
  connect that repository. The repository webhook receiver therefore also requires the repository
  named in the payload to be one that was connected through the admin page, and rejects everything
  else with `404`.

**Signing secrets are generated per connection**, 256 bits from `crypto.randomBytes`, and stored in
Forge secret storage. They are deliberately *not* Forge environment variables: those are set by the
app developer at deploy time and are identical across every installation, so one would be a signing
key shared by every customer of the app, unconfigurable by any of them.

Connection identifiers are 96 bits of `crypto.randomBytes`, so they are unguessable as well as
unique.

## Authorization of app operations

Forge decides who a page is *rendered* for. It does not stop anyone else from invoking a resolver
directly, and because storage calls run as the app, Forge performs no implicit permission check. So
every resolver asks Jira explicitly, as the calling user, against `/rest/api/3/mypermissions`:

- Admin resolvers require the Jira `ADMINISTER` global permission.
- Project resolvers, including the read-only status view, require `ADMINISTER_PROJECTS` on the
  project in context.

Resolver inputs are validated before use: connection identifiers must be well-formed and name an
existing connection, repository identifiers must be numeric, free-text fields are trimmed and capped.
When a repository is connected, its identity (id, name, URL, default branch) is read from Forgejo
rather than taken from the browser, and the authorizing account's admin permission on it is checked.

## OAuth

- **PKCE** with the `S256` method, so an intercepted authorization code cannot be redeemed without
  the verifier.
- **Single-use `state`**, deleted on read with a 10-minute expiry, defeating CSRF and replay of an
  intercepted callback URL.
- The callback trusts **nothing in its own URL except the state value**. The connection, PKCE
  verifier and redirect URI come from the pending-state record; the instance URL, client id and
  client secret come from the connection's own records. The client secret is stored in exactly one
  place.
- A token is only recorded after it has been used successfully against Forgejo's userinfo endpoint.
  Storing a token that turns out to be unusable is worse than storing none: the admin walks away
  believing setup finished.
- Refresh tokens are used automatically, proactively before expiry and reactively on a `401`. Forgejo
  rotates refresh tokens, so before spending one the stored record is re-read and a token refreshed by
  a concurrent invocation is adopted instead of racing it.

### Known limitation, disclosed at the point of approval

Forgejo has not implemented OAuth scopes. A token issued by a Forgejo OAuth application carries the
full permissions of the approving account and cannot be narrowed. The app cannot mitigate this; it
states it on the setup page, in the README and in the privacy policy, and advises approving with an
account whose access is already limited.

## Secret handling

- Client secrets, access tokens, refresh tokens, signing secrets and pending PKCE verifiers are
  stored with Forge secret storage (`kvs.setSecret`: encrypted at rest, not enumerable by the store's
  query API).
- No resolver returns a client secret or token. The admin page is told only whether they exist.
- The webhook signing secret is returned only by an explicit, admin-guarded `revealWebhookSecret`
  call, because a Forgejo Actions workflow needs it as a repository secret. It is not shipped to the
  browser on page load.
- Secrets, tokens, webhook payload contents and Forgejo usernames are not written to logs.

## Injection and output handling

- **Reflected XSS.** The OAuth callback returns HTML and echoes provider-supplied error strings from
  a public URL. Every interpolated value, including the heading, is HTML-escaped, and the response
  sets `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options:
  DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`.
- **Path injection.** Jira REST paths are built with Forge's `route` tagged template, which escapes
  interpolated values. Forgejo paths escape owner, repository and hook identifiers with
  `encodeURIComponent`.
- **Issue-key matching is field-scoped.** Keys are extracted from specific fields, never from a
  stringified payload, so an attacker cannot attach data to an arbitrary issue by planting an
  issue-key-shaped string in a repository name or clone URL. Explicit `issueKeys` in a CI report are
  validated against the issue-key shape.
- **Instance URLs** must be HTTPS (plain HTTP only for `localhost`), must not carry embedded
  credentials, and must not carry a query string or fragment.

## Egress

`external.fetch.backend` is `*`. Forgejo is self-hosted, so the instance host is entered at runtime
and cannot be known at deploy time, while Forge's egress allowlist is static. This is inherent to
integrating with self-hosted software and is declared rather than worked around; it makes the app
ineligible for the "Runs on Atlassian" badge.

Compensating controls: every outbound request targets the stored instance URL, that URL is validated
as above, and only a Jira administrator can create one.

## Availability and resource limits

- Devinfo submissions are split into batches under Jira's 400-entity limit rather than being rejected
  wholesale.
- Historical import processes one page per invocation and queues the next, so no single invocation
  can exhaust its time budget on a large repository. Restarting an import is refused while one is
  still making progress.
- Transient Forgejo failures return a retry request to the platform rather than failing silently or
  looping.
- Unsupported event types and events naming no issue are acknowledged without calling Jira.

## Dependencies

Direct runtime dependencies are Atlassian's own `@forge/*` packages plus Node's built-in `crypto`.
No third-party package is depended on directly; everything else in the tree arrives transitively
through `@forge/*`.

That transitive surface is reviewed automatically:

- **`npm audit`** runs in CI on every push and pull request, and weekly on a schedule, at
  `--audit-level=moderate`. The build fails on any known vulnerability.
- **Dependabot** opens a pull request for every advisory affecting the tree, transitive dependencies
  included, and keeps the tree current between advisories.
- **CodeQL** runs static analysis (`security-and-quality` queries) over the JavaScript source on the
  same triggers.

Vulnerabilities in dependencies are remediated under the timelines in Atlassian's Marketplace
security bug fix policy.

---

*Last reviewed: 13 September 2026.*
