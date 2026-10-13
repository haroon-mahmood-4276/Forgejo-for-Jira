# Marketplace listing: Forgejo for Jira

Copy for every field of the Atlassian Marketplace listing, in the order the listing's **Overview**
tab shows it. Each value is in its own block so it can be pasted as is. The number after each
heading is `characters used / limit`; limits are from Atlassian's
[Build your presence on Marketplace](https://developer.atlassian.com/platform/marketplace/building-your-presence-on-marketplace/)
and [listing principles](https://developer.atlassian.com/platform/marketplace/marketplace-app-listing-principles/).

Images are in [`images/`](images/). See [README.md](README.md) for where each one goes and how to
regenerate them.

---

## Header

**App name** [16/60]

```text
Forgejo for Jira
```

**Tagline** [104/130]

```text
Show Forgejo commits, branches, pull requests, builds and deployments on the Jira issues they belong to.
```

**Summary** (shown in search results) [190/250]

```text
Connect a self-hosted Forgejo instance to Jira Cloud. Work that names an issue key appears in the issue's Development panel, with no webhook setup and no server to run. Free and open source.
```

**Logo** `images/logo-144x144.png` · **Banner** `images/banner-1120x548.png`

---

## Key highlights

Atlassian requires exactly three. Each has a title, a summary, a full image (1840 x 900) and a cropped
image (580 x 330).

### Highlight 1

**Title** [44/50]

```text
Connect Forgejo once, then pick repositories
```

**Summary** [174/220]

```text
Register one OAuth app, authorize it, and choose your repositories. The app creates and signs each webhook for you, then imports existing history so older issues fill in too.
```

**Caption** [132/220]

```text
Setup in Jira: paste the redirect URI into Forgejo, authorize, and the app registers a signed webhook on each repository you choose.
```

- Full image: `images/highlight-1-connect-1840x900.png`
- Cropped image: `images/highlight-1-connect-cropped-580x330.png`
- Alt text: Two browser windows side by side. On the left, the Forgejo for Jira admin page in Jira with fields for the Forgejo URL, client ID and client secret. On the right, Forgejo's authorize screen and a webhook the app created. Arrows between them are labelled OAuth 2.0 with PKCE and Signed webhooks.

### Highlight 2

**Title** [39/50]

```text
Development context on every Jira issue
```

**Summary** [189/220]

```text
Commits, branches and pull requests appear in the Development panel of any issue whose key is in a commit message, branch name or pull request title. The same place your team already looks.
```

**Caption** [122/220]

```text
The Development panel on a Jira issue listing a branch, a pull request, two commits and a passing build, all from Forgejo.
```

- Full image: `images/highlight-2-development-panel-1840x900.png`
- Cropped image: `images/highlight-2-development-panel-cropped-580x330.png`
- Alt text: A Jira issue titled Fix redirect loop after login. Its Development panel lists a branch, an open pull request, two commits and a successful build, each labelled as coming from Forgejo.

### Highlight 3

**Title** [42/50]

```text
Builds and deployments, right on the issue
```

**Summary** [178/220]

```text
Forgejo Actions runs appear as builds automatically. Add one generated workflow file to report deployments and feature flags, then see what is running where without leaving Jira.
```

**Caption** [155/220]

```text
A deployment workflow reports to Jira, and the issue shows the build, each environment from development to production, and a feature flag with its rollout.
```

- Full image: `images/highlight-3-builds-deployments-1840x900.png`
- Cropped image: `images/highlight-3-builds-deployments-cropped-580x330.png`
- Alt text: On the left, a Forgejo Actions workflow file with two highlighted steps that tell Jira a deployment started and ended. On the right, a Jira issue showing a passing build, four deployment environments with production in progress, and a feature flag at 25 percent rollout.

---

## Additional screenshots

Up to five per highlight. These four go under highlight 1 (setup) and highlight 3 (delivery) as
indicated. Each caption is at most 220 characters.

### Gallery 1: Repositories tab (highlight 1) [129/220]

```text
Connect repositories from Forgejo and watch their history import in the background. Re-import or remove a repository at any time.
```

- Image: `images/gallery-1-repositories-1840x900.png`
- Alt text: The Repositories tab of the admin page. Available repositories have Connect buttons. Connected repositories show webhook status, import status with a progress bar, and Re-import and Remove buttons.

### Gallery 2: Builds & deployments tab (highlight 3) [154/220]

```text
Builds need no setup. Exclude deploy workflows so they are not also shown as builds, and generate a ready-to-paste workflow file that reports deployments.
```

- Image: `images/gallery-2-builds-tab-1840x900.png`
- Alt text: The Builds and deployments tab with a note that builds need no setup, a field listing workflows not reported as builds, and a dialog titled Report deployments to Jira showing the generated workflow file.

### Gallery 3: Project settings (highlight 2) [159/220]

```text
A read-only project page shows project admins how to name branches and commits, which Forgejo instance is connected, and how each repository's import is going.
```

- Image: `images/gallery-3-project-settings-1840x900.png`
- Alt text: A Jira project settings page named Forgejo. It explains how work reaches the project using branch names, commit messages and pull request titles, then lists the connected instance as Authorized and the repositories as Complete.

### Gallery 4: Issue key matching (highlight 2) [189/220]

```text
Keys are read from specific fields only: commit messages, branch names, pull request titles and workflow run titles. Work with no key is dropped, and commits never change an issue's status.
```

- Image: `images/gallery-4-issue-key-matching-1840x900.png`
- Alt text: A commit message, a branch name and a pull request title each containing the key ABC-12 highlighted in orange. Arrows lead from them to the ABC-12 issue, which shows two commits, one branch, one pull request and one passing build.

---

## More details [915/1000]

Plain text with bullets and line breaks. Apply the editor's bullet list to the lines that start with a
bullet.

```text
Connect with ease
• Link a self-hosted Forgejo instance over HTTPS with OAuth 2.0 and PKCE
• Choose the repositories you administer; the app creates a signed webhook for each one
• Existing commits, branches and pull requests are imported, so older issues fill in too

Stay in context
• Commits, branches, pull requests, builds, deployments and feature flags in the Development panel
• Matched by the issue key in a commit message, branch name, pull request title or workflow run title
• Builds from Forgejo Actions need no setup; a generated workflow file reports deployments and feature flags

Stay in control
• Nothing moves an issue: commits never change workflow status
• A read-only project page shows project admins how to name work
• No read access to Jira issue content is requested

Private by design
• Runs on Atlassian Forge. The vendor operates no server in the data path and receives none of your data
```

---

## Resources

| Card | Link |
| --- | --- |
| App documentation | https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/blob/v1/README.md |
| Setup guide | https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/blob/v1/README.md#setting-up |
| Reporting from Forgejo Actions | https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/blob/v1/README.md#reporting-from-forgejo-actions |
| Source code | https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/tree/v1 |
| Issue tracker | https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/issues |

---

## Privacy and security

Answers for the **Privacy & Security** tab. They restate [PRIVACY.md](../PRIVACY.md) and
[SECURITY.md](../SECURITY.md); if those change, change these.

**Privacy policy**
https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/blob/v1/PRIVACY.md

**Security policy and vulnerability reports**
https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/blob/v1/SECURITY.md · security@iamroon.pk

**Where data is stored.** In Forge hosted storage inside the customer's Atlassian site, following
Atlassian's data residency. Secrets (OAuth client secret, access and refresh tokens, webhook signing
secrets) are in Forge secret storage, encrypted.

**Personal data.** The Forgejo username of the account that authorized the connection, and its OAuth
token. Both are deleted with the connection. The app stores no Jira user data and no issue content.

**Data sent to the vendor.** None. The vendor runs no server in the data path. No analytics,
telemetry, advertising or third-party sharing.

**External requests.** Only to the Forgejo instance an administrator entered, over HTTPS. Forge fixes
the egress list at deploy time and the host is chosen at runtime, so the manifest declares a
wildcard (`*`). Every request targets the stored instance URL, which only a Jira administrator can
set. This is why the app is not eligible for **Runs on Atlassian**.

**Authentication.** Inbound webhooks and CI reports must carry a valid HMAC-SHA256 signature under a
per-connection secret, compared in constant time. Deliveries for repositories that were not
connected are refused. OAuth uses PKCE and single-use, expiring state.

**Authorization.** Every resolver checks the caller's Jira permission itself. Site setup needs Jira
administrator rights; the project page needs project administrator rights.

**Known limitation.** Forgejo has no OAuth scopes, so the access token carries the full permissions
of the account that approves it. The app tells the administrator this before they authorize, and
advises using an account limited to the repositories to be connected.

Not claimed: Cloud Fortified, Runs on Atlassian, a bug bounty programme or any Atlassian
partnership. The app is independent software ([NOTICE.md](../NOTICE.md)).

---

## Version information

| Field | Value |
| --- | --- |
| Version | 1.1.0, for Jira Cloud |
| Release date | 2026-09-13 |
| Payment model | Free |
| License type | Open source (MIT) |
| Vendor | Haroon Mahmood, trading as IamRoon |
| Support | Best effort, no service level. support@iamroon.pk · GitHub issues |

**Release summary** [78/80]

```text
Stricter webhook checks, plus fixes for token refresh and history import races
```

**Release notes** [604/1000]

```text
Security
• Webhook deliveries are accepted only for repositories connected on the admin page.
• Connection IDs, instance URLs and CI report issue keys are validated before use.
• The OAuth result page sends stricter security headers.

Fixes
• Two simultaneous token refreshes no longer break the connection.
• Reconnecting a repository no longer creates a duplicate webhook.
• Re-importing while an import is running no longer corrupts progress.
• Invalid build or deployment reports now return a 400 that names the field instead of a 502.

Docs
• Rewritten setup, troubleshooting and uninstall guidance.
```

**Scopes** (shown in the sidebar)

| Scope | Why |
| --- | --- |
| `write:dev-info:jira` | Submit commits, branches and pull requests |
| `delete:dev-info:jira` | Remove a repository's data when it is disconnected |
| `write:build-info:jira` | Submit builds |
| `write:deployment-info:jira` | Submit deployments |
| `write:feature-flag-info:jira` | Submit feature flags |
| `read:jira-work` | Check the caller's Jira permissions |
| `storage:app` | Store connections, repositories and secrets |

---

## What was deliberately not copied from the GitHub for Atlassian listing

The layout is the same: header, tagline, three highlights, a gallery of captioned screenshots, a
short "More details" list, resources, and a privacy and security block. The following parts of that
listing describe things this app does not have or are earned or generated by Marketplace, so they
are not reproduced:

- **Badges** (Cloud Fortified, Partner Supported) and **ratings, review count and install count**.
  These are granted or measured by Atlassian.
- **Teamwork Graph, Rovo, Smart Commits, Jira Automation and creating branches from Jira.** This app
  has none of them. Smart Commits is deliberately out of scope: nothing a commit says can move an
  issue.
- **GitHub Cloud, GitHub Enterprise and manually created GitHub apps.** Replaced by self-hosted
  Forgejo over OAuth.
