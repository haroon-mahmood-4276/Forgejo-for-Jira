# Forgejo for Jira

Connects a self-hosted [Forgejo](https://forgejo.org) instance to Jira Cloud, so commits, branches,
pull requests, builds and deployments appear in the **Development** panel on your issues — the same
place GitHub for Jira and GitLab for Jira put theirs.

Built on Atlassian Forge. Runs entirely inside Atlassian's infrastructure; no server of ours sits
between your Forgejo instance and your Jira site.

---

## What it does

| Entity | Source | How it links |
| --- | --- | --- |
| Commits | `push` webhook + REST backfill | Issue key in the commit message |
| Branches | `create` / `delete` webhooks + REST backfill | Issue key in the branch name |
| Pull requests | `pull_request*` webhooks + REST backfill | Issue key in the title or source branch |
| Builds | `action_run_*` webhooks | Issue key in the run title or branch name |
| Deployments | Forgejo Actions workflow step | Issue key in the branch name or commit subject |

**Historical import.** Connecting a repository imports its existing commits, branches and pull
requests, so issues that predate the integration are populated too. A webhook alone would only ever
show work done after setup.

**No manual webhook setup.** The app registers the repository webhook on Forgejo for you, with a
signing secret it generates per connection.

---

## Installing

### 1. Install the app

From the Atlassian Marketplace listing, or with a developer-console install link. Installation
requires Jira site-admin rights.

Then open **Settings → Apps → Forgejo for Jira**. The page walks through the four steps below and
resumes where you left off if you close it.

### 2. Register an OAuth application in Forgejo

The admin page shows you the exact redirect URI to use — it is unique to your installation.

1. In Forgejo, open **Site Administration → Applications** (covers every repository on the
   instance) or your own **Settings → Applications** (covers only yours).
2. Create an OAuth2 application. Leave **Confidential Client** enabled.
3. Paste the redirect URI shown in Jira into the **Redirect URI** field.
4. Copy the generated **Client ID** and **Client Secret** back into the Jira page, along with your
   instance URL, and save.

> **Note on permissions.** Forgejo has not implemented OAuth scopes. The token issued in the next
> step carries the full permissions of whoever approves it. Approve with an account that has access
> to only the repositories you intend to link.

### 3. Authorize

Click **Authorize with Forgejo**. Approval opens in a new browser tab. When it reports success,
return to Jira and click **Refresh**.

### 4. Choose repositories

Pick the repositories to connect. For each one the app:

- creates the webhook on Forgejo, pointing at your installation and signed with your connection's
  secret;
- queues a historical import of its commits, branches and pull requests.

The import runs in the background, one page per invocation, and the page shows live progress. Large
repositories take a while; there is nothing to wait for.

Connecting a repository needs **admin permission on that repository** in Forgejo, because creating a
webhook does. Repositories you cannot administer are shown but not connectable.

### 5. Builds and deployments

**Builds need no setup.** Forgejo emits a webhook when an Actions run reaches an outcome —
`action_run_success`, `action_run_failure`, `action_run_recover` — and the repository webhook this
app already registered receives it. Runs appear on your issues as builds with nothing to paste into
the repository.

There is no event for a run *starting*, so a build appears once, already finished. If you want a
build to show as in progress while it runs, report it yourself from a workflow step — but then use
a different `pipelineId` than the webhook's, or one will overwrite the other.

**A deploy workflow should not also be a build.** Every run becomes a build, including the one that
reports your deployment — so the issue would show a deployment and an unrelated build for the same
run. Name that workflow file under **Workflows not reported as builds** on the admin page and it is
skipped. A test workflow needs nothing: it is already a build.

**Deployments and feature flags do need a workflow step.** Neither has anything in Forgejo to read:
a deployment is whatever your pipeline decides it is, and Forgejo has no feature flags at all. So
these are reported by your own workflow.

Click **Show workflow file** on the admin page. It generates a ready-to-paste
`.forgejo/workflows/jira.yml` with your URL already filled in, and reveals the signing secret to
store as a repository secret named `JIRA_FORGEJO_SECRET`. It reports the deployment as
`in_progress` when the job starts and the real outcome when it ends, so a failed deploy shows as
failed rather than never appearing.

That file deliberately reports **only** deployments. Reporting builds from it too would put two
build entities on every issue — one from the webhook, one from the workflow — because they land
under different pipeline identifiers. The CI trigger still accepts `type: "build"` for anyone
already doing so.

---

## How work is matched to issues

Issue keys are found with the pattern `/[A-Z][A-Z0-9]+-\d+/g`, applied **to specific fields** — a
commit message, a branch name, a pull request title — never to the whole payload. Scanning a
stringified payload would match issue-key-shaped text in repository names, clone URLs and unrelated
branch names, attaching data to issues nobody referenced.

Anything with no issue key is dropped and never reaches Jira.

`preventTransitions` is set on every submission: commits never move an issue through your workflow
on their own. Smart Commit parsing is deliberately out of scope.

---

## Architecture

```text
src/
  webhook.js            Repository webhook receiver
  ci-status.js          Deployment and feature flag receiver (Forgejo Actions)
  oauth-callback.js     OAuth redirect target
  backfill.js           Async-queue worker for historical import
  resolvers/
    admin.js            Site admin page backend
    project.js          Project settings page backend
  frontend/
    admin.jsx           Guided setup (UI Kit)
    settings.jsx        Project-level status view (UI Kit)
  lib/
    devinfo.js          Forgejo → Jira devinfo mapping and submission
    forgejo-client.js   Forgejo REST API: paging, token refresh, webhooks
    forgejo-oauth.js    OAuth protocol: PKCE, state, token exchange, refresh
    issue-keys.js       Issue-key extraction
    builds.js           workflow_run mapping and Jira build submission
    permissions.js      Jira-admin and project-admin guards
    storage.js          Connections, repositories, secrets, pending OAuth state
    verify-signature.js HMAC verification shared by both receivers
    resolver-class.js   Interop shim for @forge/resolver
```

**Configuration is site-level.** Development information in Jira is site-wide and matched by issue
key: a repository connected "in" one project already feeds issues in every other. Per-project
configuration would mean duplicate connections, duplicate webhooks and duplicate imports of the same
repository. The project settings page is therefore informational.

**Each function points at its own module** rather than a shared barrel file. A barrel makes every
handler share one bundle, so a top-level error in any one of them takes down the webhook receiver
too.

---

## Security

- **Per-installation signing secrets.** Each connection generates its own 256-bit webhook secret,
  stored encrypted. It is not a Forge environment variable: those are set by the app developer at
  deploy time and are identical across every installation, which would mean every customer shared
  one signing key and no customer could set their own.
- **Signature verification is mandatory and fails closed.** Every delivery must carry a valid
  `X-Forgejo-Signature`. The HMAC-SHA256 is computed over the **raw request body**, because
  re-serialising parsed JSON changes key order and whitespace and would reject every valid delivery.
  A request naming no connection, or an unknown one, is rejected before anything is parsed.
- **Constant-time comparison.** Digests are compared with `crypto.timingSafeEqual`, not `===`. A
  short-circuiting comparison leaks timing information that lets an attacker recover a valid
  signature byte by byte.
- **Secrets never reach the browser.** Client secrets and access tokens are stored with
  `kvs.setSecret` and are never returned by any resolver. The webhook signing secret is returned only
  from an explicit, admin-guarded `revealWebhookSecret` call, because Forgejo Actions needs it.
- **CSRF and code interception.** The OAuth flow uses a single-use `state` value (deleted on read,
  10-minute expiry) and PKCE with the `S256` method. The callback trusts nothing in its own URL
  except that state value.
- **Reflected XSS.** The OAuth callback renders HTML and echoes provider error strings, so it
  escapes them and serves a restrictive `Content-Security-Policy` and `X-Frame-Options: DENY`.
- **Authorization on every resolver.** Admin resolvers require the Jira `ADMINISTER` global
  permission; project resolvers require `ADMINISTER_PROJECTS`. Forge only decides who a page is
  *rendered* for — resolvers are reachable by any authenticated user of the site.
- **HTTPS only.** Instance URLs must be HTTPS; plain HTTP is accepted for `localhost` only, for
  local development.

No secret is committed to this repository.

---

## Scopes

Every requested scope maps to a call that exists in the code.

| Scope | Used by |
| --- | --- |
| `write:dev-info:jira` | `POST /rest/devinfo/0.10/bulk` — `src/lib/devinfo.js` |
| `delete:dev-info:jira` | `DELETE /rest/devinfo/0.10/repository/...` — `src/lib/devinfo.js` |
| `write:build-info:jira` | `POST /rest/builds/0.1/bulk` — `src/lib/builds.js`, `src/ci-status.js` |
| `write:deployment-info:jira` | `POST /rest/deployments/0.1/bulk` — `src/ci-status.js` |
| `write:feature-flag-info:jira` | `POST /rest/featureflags/0.1/bulk` — `src/ci-status.js` |
| `read:jira-work` | `/rest/api/3/mypermissions` — `src/lib/permissions.js` |
| `storage:app` | Connections, repositories and secrets — `src/lib/storage.js` |

The granular scopes are the ones Forge enforces here. The classic
`write:build:jira-software` family was declared alongside them until a probe
established that the bulk APIs accept writes without it — and that the classic
scope alone is *not* enough, which is what a deployment refused with
`{"code":401,"message":"Unauthorized; scope does not match"}` was telling us.

### Egress

`external.fetch.backend` is `'*'`. Forgejo is self-hosted: the customer types their instance URL at
runtime, and Forge's egress allowlist is static, so the host cannot be known at deploy time. This is
inherent to integrating with self-hosted software.

Consequences, accepted deliberately:

- the app is **not eligible for the "Runs on Atlassian" badge**;
- `forge lint` emits a warning about the wildcard.

Mitigations in code: instance URLs must be HTTPS, every outbound request targets a URL derived from
a stored instance a Jira administrator entered, and only Jira administrators can add one.

---

## Development

```bash
npm install
npm test                       # 97 tests, no Forge/Jira/Forgejo needed
forge lint
forge deploy -e development
forge install --site <your-site>.atlassian.net --product jira -e development
```

### Testing

`npm test` runs the real source files against in-memory stubs of `@forge/api`, `@forge/kvs` and
`@forge/events`, installed with a module loader hook — so the production code is exercised
unmodified. It covers HMAC verification and its failure modes, connection-scoped webhook routing,
issue-key extraction, every devinfo mapper, batching against Jira's 400-entity limit, build and
deployment submission, and the backfill state machine.

### Tunnelling

```bash
forge tunnel
```

- Changes to **code** are hot reloaded.
- Changes to **`manifest.yml`** require `forge deploy` and a tunnel restart.
- Adding scopes or egress entries requires `forge deploy` **and** `forge install --upgrade`.

Without a tunnel: `forge logs -e development --since 15m`.

### Simulating a delivery

```bash
URL="<webhook URL from the admin page, including ?c=...>"
SECRET="<revealed on the admin page>"
BODY='{"ref":"refs/heads/main","repository":{"id":1,"full_name":"acme/test","html_url":"https://forgejo.example.com/acme/test"},"commits":[{"id":"0000000000000000000000000000000000000001","message":"ABC-1 test devinfo","url":"https://forgejo.example.com/acme/test/commit/0000001","author":{"name":"Test","email":"test@example.com"},"timestamp":"2026-08-09T10:00:00Z","added":[],"removed":[],"modified":["a.txt"]}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

curl -sS -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "X-Forgejo-Event: push" \
  -H "X-Forgejo-Signature: $SIG" \
  --data-raw "$BODY"
```

`202` means Jira accepted the batch. Use a real issue key from your site — the commit only becomes
visible on an issue that exists, and the Development panel only appears once an issue has devinfo
data.

---

## Known limitations

- **Wildcard egress**, as described above. Not eligible for Runs on Atlassian.
- **Pull request approval state during backfill.** Whether each reviewer has approved needs a
  separate API call per pull request, which is too expensive during a bulk import, so imported pull
  requests show reviewers as unapproved until the next webhook corrects them.
- **Commit file counts during backfill.** The REST import does not request per-commit file lists, so
  imported commits report a file count of 0. Live pushes carry real counts.
- **Backfill reads the default branch's commit history.** Commits that exist only on unmerged
  branches are picked up from their branch entity and from live pushes, not from the commit import.
- **One authorizing account per instance.** The import and webhook registration act as whoever
  approved the OAuth request; repositories that account cannot see are not offered.

## Licence

MIT — see [LICENSE](LICENSE).
