# Security

## Reporting a vulnerability

Report suspected vulnerabilities privately to haroon.mahmood.4276@gmail.com. Please do not open a public
issue. Expect an acknowledgement within 5 business days.

---

## Trust model

The app sits between two systems the customer controls: a Forgejo instance and a Jira Cloud site. It
holds credentials for the first and writes to the second. It runs entirely on Atlassian Forge; the
vendor operates no server in the data path.

Three things must hold for the app to be safe:

1. Only a Jira administrator can decide which Forgejo instance this site trusts.
2. Nobody but that instance can submit development data into this site through the app.
3. Credentials never leave the backend.

Each is addressed below.

## Authentication of inbound deliveries

Both public receivers — the repository webhook and the Forgejo Actions reporter — are unauthenticated
URLs by construction, so every delivery is verified:

- The URL carries a `?c=<connectionId>` parameter. It is a **selector, not a credential**: it chooses
  which stored signing secret to check against and grants nothing on its own.
- The delivery must carry `X-Forgejo-Signature`, an HMAC-SHA256 over the **raw request body** using
  that connection's secret. Hashing re-serialised JSON would change key order and whitespace and
  reject every valid delivery, so the raw bytes are used, base64-decoded first when Forge hands them
  over encoded.
- Digests are compared with `crypto.timingSafeEqual`. A `===` comparison returns as soon as it finds
  a differing byte, which leaks enough timing information to recover a valid signature byte by byte.
- Missing connection ID, unknown connection, missing signature and invalid signature are each
  rejected before the body is parsed.

**Signing secrets are generated per connection**, 256 bits from `crypto.randomBytes`, and stored with
Forge secret storage. They are deliberately *not* Forge environment variables: those are set by the
app developer at deploy time and are identical across every installation, so one would be a signing
key shared by every customer of the app, unconfigurable by any of them.

Connection identifiers are 96 bits of `crypto.randomBytes`, so they are unguessable as well as
unique — knowing one is a prerequisite for aiming a delivery at an installation.

## Authorization of app operations

Forge decides who a page is *rendered* for. It does not stop anyone else from invoking a resolver
directly, and because storage calls run as the app, Forge performs no implicit permission check. So
every resolver asks Jira explicitly:

- Admin resolvers require the Jira `ADMINISTER` global permission.
- Project resolvers require `ADMINISTER_PROJECTS` on the project in context.

Both are checked with `.asUser()` against `/rest/api/3/mypermissions`, so Jira answers for the caller
rather than for the app.

## OAuth

- **PKCE** with the `S256` method, so an intercepted authorization code cannot be redeemed without
  the verifier.
- **Single-use `state`**, deleted on read with a 10-minute expiry, defeating CSRF and replay of an
  intercepted callback URL.
- The callback trusts **nothing in its own URL except the state value**; the connection, instance,
  client credentials, verifier and redirect URI all come from server-side storage.
- A token is only recorded as working after it is used successfully against Forgejo's userinfo
  endpoint. Storing a token that turns out to be unusable is worse than storing none — the admin
  walks away believing setup finished.
- Refresh tokens are used automatically, both proactively on expiry and reactively on a `401`, since
  a token can be revoked on the Forgejo side at any moment.

### Known limitation, disclosed at the point of approval

Forgejo has not implemented OAuth scopes. A token issued by a Forgejo OAuth application carries the
full permissions of the approving account and cannot be narrowed. The app cannot mitigate this; it
states it on the setup page, in the README and in the privacy policy, and advises approving with an
account whose access is already limited.

## Secret handling

- Client secrets, access tokens, refresh tokens, signing secrets and pending PKCE verifiers are
  stored with `kvs.setSecret` (encrypted at rest, not enumerable by the store's query API).
- No resolver returns a client secret or token. The admin page is told only whether they exist.
- The webhook signing secret is returned only by an explicit, admin-guarded `revealWebhookSecret`
  call, because Forgejo Actions needs it as a repository secret. It is not shipped to the browser on
  page load.
- Secrets are never written to logs.

## Injection and output handling

- **Reflected XSS.** The OAuth callback returns HTML and echoes provider-supplied error strings from
  a public URL. All interpolated values are HTML-escaped, and the response sets
  `Content-Security-Policy: default-src 'none'` and `X-Frame-Options: DENY`.
- **Path injection.** Jira REST paths are built with the `route` tagged template, which escapes
  interpolated values. Query strings are written literally so only values are substituted —
  interpolating a whole `a=b&c=d` string would escape the separators.
- **Forgejo paths.** Owner and repository names are `encodeURIComponent`-escaped before being placed
  in a path.
- **Issue-key matching is field-scoped.** Keys are extracted from specific fields, never from a
  stringified payload, so an attacker cannot attach data to an arbitrary issue by planting an
  issue-key-shaped string in a repository name or clone URL.

## Transport

Instance URLs must be HTTPS. Plain HTTP is accepted only for `localhost`/`127.0.0.1`, for local
development against a Forgejo running on the same machine.

## Egress

`external.fetch.backend` is `'*'`. Forgejo is self-hosted, so the instance host is entered at runtime
and cannot be known at deploy time, while Forge's egress allowlist is static. This is inherent to
integrating with self-hosted software and is declared rather than worked around; it makes the app
ineligible for the "Runs on Atlassian" badge.

Compensating controls: URLs must be HTTPS, every outbound request targets a URL derived from a
stored instance record, and only a Jira administrator can create one.

## Denial of service and resource limits

- Devinfo submissions are split into batches under Jira's 400-entity limit rather than being rejected
  wholesale.
- Historical import processes one page per invocation and queues the next, so no single invocation
  can exhaust its time budget on a large repository.
- Transient Forgejo failures return a retry request rather than either failing silently or looping.

## Dependencies

Runtime dependencies are Atlassian's own `@forge/*` packages plus Node's built-in `crypto`. There are
no third-party runtime dependencies.
