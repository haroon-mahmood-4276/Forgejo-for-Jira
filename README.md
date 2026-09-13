# Forgejo for Jira

Connects a self-hosted [Forgejo](https://forgejo.org) instance to Jira Cloud, so commits, branches,
pull requests, builds and deployments appear in the **Development** panel on your issues — the same
place Atlassian's own GitHub and GitLab integrations put theirs.

Built on [Atlassian Forge](https://developer.atlassian.com/platform/forge/). The app runs entirely
inside Atlassian's infrastructure. The vendor operates no server in the data path and receives none of
your data.

> **Independent project.** Forgejo for Jira is not affiliated with, endorsed by or supported by
> Atlassian, Forgejo, Codeberg e.V. or the Gitea project. See [NOTICE.md](NOTICE.md) for trademark
> and third-party attributions, [LICENSE](LICENSE) for the licence and warranty disclaimer,
> [PRIVACY.md](PRIVACY.md) for data handling and [SECURITY.md](SECURITY.md) for the security model and
> how to report a vulnerability.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Setting up](#setting-up)
- [How work is matched to issues](#how-work-is-matched-to-issues)
- [Reporting from Forgejo Actions](#reporting-from-forgejo-actions)
- [Architecture](#architecture)
- [Security summary](#security-summary)
- [Scopes and egress](#scopes-and-egress)
- [Development](#development)
- [Known limitations](#known-limitations)
- [Support](#support)
- [Licence](#licence)

---

## What it does

| Entity | Source | How it links to an issue |
| --- | --- | --- |
| Commits | `push` webhook, REST import on connect | Issue key in the commit message |
| Branches | `create` / `delete` webhooks, REST import | Issue key in the branch name |
| Pull requests | `pull_request*` webhooks, REST import | Issue key in the title or source branch |
| Builds | `action_run_*` webhooks (Forgejo Actions) | Issue key in the run title or branch name |
| Deployments | A step in your own Forgejo Actions workflow | Issue key in the branch name or commit subject |
| Feature flags | A step in your own tooling | Issue keys named in the report |

**Historical import.** Connecting a repository imports its existing commits, branches and pull
requests, so issues that predate the integration are populated too. A webhook alone would only ever
show work done after setup.

**No manual webhook setup.** The app registers the repository webhook on Forgejo for you, signed with
a secret it generates per connection. Removing the repository removes the webhook again.

**Nothing moves an issue.** Every submission sets `preventTransitions`, so a commit message never
changes an issue's workflow status. Smart Commit parsing is deliberately out of scope.

---

## Requirements

- A **Jira Cloud** site. You need Jira administrator rights to install and configure the app.
- A **Forgejo** instance reachable over **HTTPS** from Atlassian's cloud. Recent Forgejo releases are
  supported; older Gitea-derived instances that still use the `gitea` webhook type are handled as a
  fallback.
- An account on that Forgejo instance with **admin permission on each repository** you want to
  connect, because creating a webhook requires it.

---

## Setting up

### 1. Install the app

Install from the Atlassian Marketplace listing, or with a developer-console install link if you are
running your own deployment. Then open **Settings → Apps → Forgejo for Jira**. The page has three tabs;
each one says what it needs before it can be used, and the page resumes where you left off.

### 2. Register an OAuth application in Forgejo

The first tab shows the exact **redirect URI** to use. It is unique to your installation.

1. In Forgejo, open **Site Administration → Applications** to cover every repository on the
   instance, or your own **Settings → Applications** to cover only repositories you can see.
2. Create an OAuth2 application. Name it anything. Leave **Confidential Client** enabled.
3. Paste the redirect URI from Jira into the **Redirect URI** field.
4. Copy the generated **Client ID** and **Client Secret** into the Jira page together with your
   instance URL, and save.

> **Permissions of the authorizing account.** Forgejo has not implemented OAuth scopes. The token
> issued in the next step carries the **full permissions of whoever approves it** and cannot be
> narrowed by this app. Approve with an account whose access is already limited to the repositories
> you intend to connect. The app uses the token only to list repositories, read commits, branches,
> pull requests and reviews, and manage the webhook it creates.

### 3. Authorize

Click **Authorize with Forgejo**. Approval opens in a new browser tab. The Jira page notices the
approval by itself; if it has stopped waiting, click **Check now**.

### 4. Choose repositories

On the **Repositories** tab, click **Load repositories** and connect the ones you want. For each
repository the app:

- verifies the repository with Forgejo and that the authorizing account can administer it;
- creates the webhook on Forgejo, or adopts one it created earlier that was left behind;
- queues a historical import of commits, branches and pull requests.

The import runs in the background one page at a time, and the page shows live progress. Large
repositories take a while; there is nothing to wait for.

**Re-import** restarts the import for a repository, for example after the app was unable to reach
Forgejo for a period. It is refused while an import is still making progress, and allowed again once an
import has been idle for an hour.

**Remove** deletes the webhook, forgets the repository and asks Jira to delete the development data
the repository contributed.

### 5. Builds and deployments

**Builds need no setup.** Forgejo emits a webhook when an Actions run reaches an outcome
(`action_run_success`, `action_run_failure`, `action_run_recover`), and the repository webhook the
app registered receives it. Runs appear on your issues as builds. There is no event for a run
*starting*, so a build appears once, already finished.

**A deploy workflow should not also be a build.** Every run becomes a build, including one that
reports your deployment, so an issue would show a deployment and an unrelated build for the same run.
List that workflow's file name under **Workflows not reported as builds** on the admin page and it is
skipped.

**Deployments and feature flags need a workflow step.** Neither has anything in Forgejo to read.
Click **Show workflow file** on the admin page: it generates a ready-to-paste
`.forgejo/workflows/jira.yml` with your reporting URL filled in and reveals the signing secret to
store as a repository secret named `JIRA_FORGEJO_SECRET`. See
[Reporting from Forgejo Actions](#reporting-from-forgejo-actions) for the payload.

---

## How work is matched to issues

Issue keys are found with the pattern `[A-Z][A-Z0-9]+-[0-9]+`, applied **only to specific fields**:
a commit message, a branch name, a pull request title, a workflow run title. The whole payload is never
scanned, because repository names, clone URLs and unrelated branch names can contain issue-key-shaped
text and would attach data to issues nobody referenced.

Anything with no issue key is dropped and never reaches Jira. Anything for a repository that is not
connected is rejected, even when it is correctly signed.

---

## Reporting from Forgejo Actions

The CI reporting endpoint accepts a JSON object, signed exactly like a Forgejo webhook: an
`X-Forgejo-Signature` header carrying the hex HMAC-SHA256 of the request body under the connection's
signing secret, posted to the URL shown on the admin page (which already carries `?c=<connection>`).

Common fields:

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | `build`, `deployment` or `featureFlag` |
| `issueKeys` | no | Explicit list. Entries that are not shaped like an issue key are ignored. |
| `ref`, `commitMessage`, `displayName` | no | Scanned for issue keys when `issueKeys` is absent. |
| `url` | build, deployment | Absolute `https` URL of the run. Required by Jira. |
| `state` | no | Jira's vocabulary: `pending`, `in_progress`, `successful`, `failed`, `cancelled`, `unknown`; deployments also accept `rolled_back`. Unknown values become `unknown`. |
| `lastUpdated` | no | ISO 8601 timestamp. Defaults to now. |

Build fields: `pipelineId`, `buildNumber` (numeric), `displayName`.

Deployment fields: `pipelineId`, `deploymentSequenceNumber` (numeric), `environment`
(`development`, `testing`, `staging`, `production`; anything else is reported as `unmapped`),
`environmentName`, `displayName`, `description`.

Feature flag fields: `key` (required), `id`, `displayName`, `enabled`, `defaultValue`,
`rolloutPercentage`, `environment`, `environmentName`.

Responses:

| Status | Meaning |
| --- | --- |
| `2xx` | Jira accepted the report. |
| `400` | The report itself is invalid; the body names the problem. |
| `401` | The signature did not verify. |
| `404` | The connection in `?c=` does not exist. |
| `502` | This app accepted the report but Jira rejected it; Jira's own message is in the body. |

---

## Architecture

```text
manifest.yml            Forge modules, functions, scopes, egress
src/
  webhook.js            Repository webhook receiver (commits, branches, PRs, workflow runs)
  ci-status.js          Build, deployment and feature flag reporter for Forgejo Actions
  oauth-callback.js     OAuth redirect target; renders a small HTML result page
  backfill.js           Async-queue worker for historical import, one page per invocation
  resolvers/
    admin.js            Site admin page backend (Jira admin only)
    project.js          Project settings page backend (project admin only)
  frontend/
    admin/              Site admin page (UI Kit): index.jsx + components/
    settings/           Project settings page (UI Kit): index.jsx + components/
  lib/
    delivery.js         Shared authentication of inbound deliveries
    verify-signature.js HMAC verification, header lookup, body reconstruction
    devinfo.js          Forgejo → Jira devinfo mapping, batching and submission
    builds.js           workflow_run → Jira build mapping and submission
    forgejo-client.js   Forgejo REST client: paging, token refresh, webhooks
    forgejo-oauth.js    OAuth protocol: URL validation, PKCE, state, token exchange
    issue-keys.js       Issue-key extraction and validation
    permissions.js      Jira-admin and project-admin guards
    storage.js          Connections, repositories, secrets, pending OAuth state
    resolver-class.js   Interop shim for @forge/resolver
test/
  local-test.mjs        The test suite (plain Node, no Forge installation needed)
  stubs.mjs             In-memory stand-ins for @forge/api, @forge/kvs, @forge/events
```

**Configuration is site-level.** Development information in Jira is site-wide and matched by issue
key: a repository connected once feeds issues in every project. The project settings page is
therefore informational.

**Each Forge function points at its own module** rather than a shared barrel file, so a top-level error
in one handler cannot take down the webhook receiver.

**Inbound deliveries share one authentication path** (`lib/delivery.js`) so the repository webhook and
the CI reporter cannot drift apart in what they check.

---

## Security summary

The full model is in [SECURITY.md](SECURITY.md). In brief:

- Every inbound delivery must name an existing connection and carry a valid HMAC-SHA256 signature
  under that connection's own randomly generated secret, compared in constant time.
- A valid signature proves the delivery came from the instance, not that the repository was chosen by
  the administrator, so deliveries for repositories that are not connected are rejected.
- Secrets and tokens are stored in Forge secret storage and never returned to the browser, except the
  webhook signing secret on an explicit, admin-only request.
- The OAuth flow uses PKCE (`S256`) and a single-use, expiring `state`. The callback trusts nothing in
  its own URL except that state.
- Every resolver checks the caller's Jira permission itself; Forge only decides who a page is rendered
  for.
- Instance URLs must be HTTPS and are validated before use.

---

## Scopes and egress

Every requested scope maps to a call in the source.

| Scope | Used by |
| --- | --- |
| `write:dev-info:jira` | `POST /rest/devinfo/0.10/bulk` — `src/lib/devinfo.js` |
| `delete:dev-info:jira` | `DELETE /rest/devinfo/0.10/repository/...` — `src/lib/devinfo.js` |
| `write:build-info:jira` | `POST /rest/builds/0.1/bulk` — `src/lib/builds.js`, `src/ci-status.js` |
| `write:deployment-info:jira` | `POST /rest/deployments/0.1/bulk` — `src/ci-status.js` |
| `write:feature-flag-info:jira` | `POST /rest/featureflags/0.1/bulk` — `src/ci-status.js` |
| `read:jira-work` | `GET /rest/api/3/mypermissions` — `src/lib/permissions.js` |
| `storage:app` | Connections, repositories and secrets — `src/lib/storage.js` |

The app requests no read access to issue content.

**Egress.** `external.fetch.backend` is `*`. Forgejo is self-hosted: the instance host is typed in by
an administrator at runtime, and Forge's egress allowlist is fixed at deploy time, so it cannot be
narrowed. This is inherent to integrating with self-hosted software. Consequences: the app is not
eligible for the "Runs on Atlassian" badge, and `forge lint` reports one warning. Compensating
controls: every outbound request targets the stored instance URL, that URL must be HTTPS with no
embedded credentials, and only a Jira administrator can set it.

---

## Development

```bash
npm install
npm test                       # 124 tests; needs no Forge installation, Jira site or Forgejo
npm run lint                   # forge lint; one expected warning for wildcard egress
npm run audit                  # npm audit at --audit-level=moderate
forge deploy -e development
forge install --site <your-site>.atlassian.net --product jira -e development
```

Node 22 or newer is required locally. The Forge runtime is Node 24.

### Testing

`npm test` runs the real source files against in-memory stubs of `@forge/api`, `@forge/kvs` and
`@forge/events`, installed through a module loader hook, so production code is exercised unmodified.
Covered: HMAC verification and its failure modes, connection- and repository-scoped delivery
routing, issue-key extraction, every devinfo mapper, batching against Jira's 400-entity limit, build,
deployment and feature flag reports, the OAuth callback, token refresh, and the backfill state
machine.

### Tunnelling

```bash
forge tunnel
```

Code changes hot reload. Changes to `manifest.yml` need `forge deploy` and a tunnel restart. Adding a
scope or egress entry needs `forge deploy` **and** `forge install --upgrade`. Without a tunnel, read
logs with `forge logs -e development --since 15m`.

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

The repository id in the body must be one that is connected, or the delivery is refused with `404`.
`202` means Jira accepted the batch. Use a real issue key from your site: the commit only becomes
visible on an issue that exists.

### Releasing

Releases are cut from the `v1` branch with an annotated tag, a GitHub release and a production
deploy; see `.claude/agents/release.md` for the checklist. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

---

## Known limitations

- **One Forgejo instance per Jira site.** The storage model supports several connections, but the
  admin page currently manages the first one only.
- **Wildcard egress**, as described above. Not eligible for Runs on Atlassian.
- **Pull request approval state during import.** Reading each reviewer's verdict needs one API call
  per pull request, which is too expensive during a bulk import. Imported pull requests show
  reviewers as unapproved until the next webhook for that pull request corrects them.
- **Commit file counts during import.** The REST import does not request per-commit file lists, so
  imported commits report a file count of 0. Live pushes carry real counts.
- **Import reads the default branch's history.** Commits that exist only on unmerged branches are
  represented by their branch entity and by live pushes, not by the commit import.
- **One authorizing account per instance.** Import and webhook registration act as whoever approved
  the OAuth request; repositories that account cannot see are not offered.
- **Stalled imports.** If Forge exhausts its retry budget for a page, the import stays in the
  running state with the last error shown. It can be restarted from the admin page after an hour.

---

## Support

- **Questions and bug reports:** open an issue on
  [GitHub](https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/issues) or email
  [support@iamroon.pk](mailto:support@iamroon.pk). See [SUPPORT.md](SUPPORT.md).
- **Security vulnerabilities:** email [security@iamroon.pk](mailto:security@iamroon.pk). Please do
  not open a public issue. See [SECURITY.md](SECURITY.md).
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md).

This is free, open-source software maintained by an individual. Support is provided on a best-effort
basis with no guaranteed response time or service level.

## Licence

MIT — see [LICENSE](LICENSE). The software is provided "as is", without warranty of any kind. Third-party
notices and trademark attributions are in [NOTICE.md](NOTICE.md).
