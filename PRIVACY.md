# Privacy Policy — Forgejo for Jira

> This describes what the app does with data, accurately and in full. It has not been reviewed by a
> lawyer and is not legal advice; if you are relying on it commercially, have someone qualified read
> it.

**Vendor:** Haroon Mahmood, trading as IamRoon
**Contact:** haroon.mahmood.4276@gmail.com
**Last updated:** 16 August 2026

---

## Summary

Forgejo for Jira moves development activity from a Forgejo instance you control into a Jira Cloud
site you control. It runs entirely on Atlassian Forge. **No data is sent to the vendor, and the
vendor operates no server that handles your data.** There is no analytics, telemetry, advertising,
profiling or third-party data sharing of any kind.

## Where the app runs and where data is stored

The app runs as an Atlassian Forge app. All code executes inside Atlassian's infrastructure, and all
persisted data is held in Forge's hosted storage, which lives within your Atlassian Cloud
installation and follows Atlassian's own data residency and retention arrangements. See Atlassian's
[Forge platform documentation](https://developer.atlassian.com/platform/forge/) and
[Trust Center](https://www.atlassian.com/trust).

## What the app stores

| Data | Encrypted at rest | Why |
| --- | --- | --- |
| Forgejo instance URL, display name, OAuth client ID | Standard Forge storage | To reach your instance and show which one is connected |
| OAuth client secret | Yes (Forge secret storage) | To exchange and refresh access tokens |
| OAuth access and refresh token | Yes (Forge secret storage) | To read repositories and register webhooks as the approving Forgejo account |
| Forgejo username of the account that authorized the connection | Standard Forge storage | To show an administrator which account the connection acts as |
| Generated webhook signing secret | Yes (Forge secret storage) | To verify that incoming deliveries came from your instance |
| Connected repository records: Forgejo repository ID, `owner/name`, URL, webhook ID, import progress | Standard Forge storage | To track what is connected and how far an import has got |
| Pending OAuth authorization state (PKCE verifier, connection ID) | Yes (Forge secret storage) | To complete an authorization; deleted on use, expires after 10 minutes |

The app stores no Jira user data, and no Jira issue content.

**Personal data.** The Forgejo username above, and the OAuth token issued to that account, identify a
person, so the app is declared to Atlassian as storing personal data. Both are held for as long as
the connection exists and are deleted with it. Nothing else the app stores identifies anyone, and
none of it leaves your Atlassian site.

## What the app transmits, and to whom

**From Forgejo to Jira.** Development data is read from your Forgejo instance and written to your own
Jira site through Atlassian's development information APIs. This includes commit SHAs, commit
messages, commit author names and email addresses as recorded in git, branch names, pull request
titles, states, comment counts and reviewer names, and build and deployment results your workflow
reports.

Only records that reference a Jira issue key are transmitted. Anything with no issue key in the
relevant field is discarded and never leaves the app.

**Nowhere else.** The app makes outbound network requests only to the Forgejo instance URL a Jira
administrator entered. It does not call the vendor, an analytics provider, or any third party.

## Author email addresses

Git commits carry the author's name and email address. The app passes these to Jira so Jira can match
a commit to a Jira user account, which is what makes the development panel useful. This is the same
handling as Atlassian's own GitHub and GitLab integrations. If your organisation does not want commit
author emails in Jira, do not connect the repository.

## Logging

The app writes operational logs, readable through the Forge developer console by whoever administers
the app. Logs record event types, entity counts, repository names, connection identifiers and error
messages. Webhook payload *contents* are not logged, and neither are secrets or tokens.

## Retention and deletion

- Removing a repository from the admin page deletes its stored record and asks Jira to delete the
  corresponding development data.
- Removing a connection deletes its credentials, tokens and repository records, and asks Jira to
  delete the development data for every repository it fed.
- Uninstalling the app removes all data it stored, under Forge's own storage lifecycle.

## Permissions the app requests

Every scope maps to a call in the source code; the mapping is documented in
[README.md](README.md#scopes). The app requests no read access to Jira issue content.

## Access to your Forgejo instance

Forgejo has not implemented OAuth scopes. A token issued by a Forgejo OAuth application therefore
carries the **full permissions of the account that approves it**, and cannot be narrowed. The app uses
it only to list repositories, read commits, branches and pull requests, and manage the webhook it
created. This limitation is Forgejo's, not the app's, and is stated at the point of approval as well
as here. Approve with an account whose access is limited to the repositories you intend to connect.

## Changes

Material changes to this policy will be published at
https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/blob/main/PRIVACY.md with an updated date.

## Contact

haroon.mahmood.4276@gmail.com
