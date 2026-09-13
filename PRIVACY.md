# Privacy Policy — Forgejo for Jira

**Vendor:** Haroon Mahmood, trading as IamRoon (the "vendor", "we")
**Contact:** [support@iamroon.pk](mailto:support@iamroon.pk)
**Security contact:** [security@iamroon.pk](mailto:security@iamroon.pk)
**Effective date:** 13 September 2026

This policy describes, accurately and in full, what the Forgejo for Jira app (the "app") does with
data. It is written in plain language. It has not been reviewed by a lawyer and does not constitute
legal advice; if your organisation needs a formal data-processing agreement, contact us.

---

## 1. Summary

The app moves development activity from a Forgejo instance you control into a Jira Cloud site you
control. It runs entirely on Atlassian Forge.

- **No data is sent to the vendor.** We operate no server that handles your data and cannot access
  the data the app stores in your Atlassian site.
- **No analytics, telemetry, advertising, profiling, tracking or third-party data sharing** of any
  kind.
- The only external system the app contacts is the Forgejo instance a Jira administrator entered.

## 2. Roles

For the purposes of data-protection law such as the GDPR and the UK GDPR:

- **You** (the organisation operating the Jira site and the Forgejo instance) are the **controller**
  of the data the app handles.
- **Atlassian** hosts the app and its storage under your agreement with Atlassian and processes data
  on your behalf. See Atlassian's [Trust Center](https://www.atlassian.com/trust) and
  [Forge documentation](https://developer.atlassian.com/platform/forge/).
- **The vendor** writes and publishes the software but **does not process your data** and is not in a
  position to act as a processor: we have no access to your Atlassian site, the app's storage, or its
  logs unless you explicitly grant it.

## 3. Where the app runs and where data is stored

All code executes inside Atlassian's infrastructure. All persisted data is held in Forge hosted
storage, which lives within your Atlassian Cloud site and follows Atlassian's data residency,
encryption and retention arrangements.

## 4. What the app stores

| Data | Storage | Purpose |
| --- | --- | --- |
| Forgejo instance URL, display name, OAuth client ID | Forge storage | To reach your instance and show which one is connected |
| OAuth client secret | Forge **secret** storage (encrypted) | To exchange and refresh access tokens |
| OAuth access and refresh token | Forge **secret** storage (encrypted) | To read repositories and register webhooks as the approving Forgejo account |
| Forgejo username of the account that authorized the connection | Forge storage | To show an administrator which account the connection acts as |
| Generated webhook signing secret | Forge **secret** storage (encrypted) | To verify that incoming deliveries came from your instance |
| Connected repository records: Forgejo repository ID, `owner/name`, URL, default branch, webhook ID, import progress and last import error | Forge storage | To track what is connected and how far an import has got |
| Workflow file names excluded from build reporting | Forge storage | Administrator preference |
| Pending OAuth authorization state (PKCE verifier, connection ID, redirect URI) | Forge **secret** storage | To complete an authorization; deleted on use, expires after 10 minutes |

The app stores no Jira user data and no Jira issue content. It requests no read access to issue
content.

**Personal data.** The Forgejo username above, and the OAuth token issued to that account, identify a
person. The app is therefore declared to Atlassian as storing personal data. Both are held for as long
as the connection exists and are deleted with it. Nothing else the app stores identifies anyone.

## 5. What the app transmits, and to whom

**From Forgejo to Jira.** Development data is read from your Forgejo instance and written to your own
Jira site through Atlassian's development information, builds, deployments and feature flag APIs.
This includes: commit SHAs, commit messages, commit author names and email addresses as recorded in
git, branch names, pull request titles, states, comment counts, reviewer names and approval states,
Forgejo Actions run results, and any deployment or feature flag report your own workflow posts.

Only records that reference a Jira issue key are transmitted. Anything with no issue key in the
relevant field is discarded and never reaches Jira. Deliveries for repositories you did not connect
are rejected.

**From Jira to Forgejo.** The app reads repositories, commits, branches, pull requests and reviews
from Forgejo, and creates or deletes the repository webhook it manages. It writes nothing else to
Forgejo.

**Nowhere else.** The app makes outbound network requests only to the Forgejo instance URL a Jira
administrator entered. It does not call the vendor, an analytics provider or any other third party.

## 6. Author email addresses

Git commits carry the author's name and email address. The app passes these to Jira so Jira can match
a commit to a Jira user account, which is what makes the development panel useful. This is the same
handling as Atlassian's own GitHub and GitLab integrations. If your organisation does not want commit
author emails in Jira, do not connect the repository.

## 7. Logging

The app writes operational logs, readable through the Forge developer console by whoever
administers the app deployment. If you install the Marketplace listing, that is the vendor; if you
deploy the source yourself, it is you.

Logs record event types, entity counts, repository names, connection identifiers, HTTP status codes
and error messages. Webhook payload **contents** are not logged. Secrets, tokens and Forgejo
usernames are not logged. Atlassian retains Forge logs under its own schedule.

## 8. Retention and deletion

- Removing a repository from the admin page deletes its stored record, removes the webhook from
  Forgejo, and asks Jira to delete the corresponding development data.
- Deleting a repository in Forgejo has the same effect on the stored record and the Jira data.
- Removing a connection deletes its credentials, tokens and repository records, and asks Jira to
  delete the development data for every repository it fed.
- Revoking authorization deletes the stored token but keeps the connection and repository selection.
- Uninstalling the app removes all data it stored, under Forge's storage lifecycle.

Development data already written to Jira is Jira data, held under your Atlassian agreement.

## 9. Permissions the app requests

Every scope maps to a call in the source code; the mapping is documented in
[README.md](README.md#scopes-and-egress).

## 10. Access to your Forgejo instance

Forgejo has not implemented OAuth scopes. A token issued by a Forgejo OAuth application therefore
carries the **full permissions of the account that approves it**, and cannot be narrowed by this app.
The app uses it only to list repositories, read commits, branches, pull requests and reviews, and
manage the webhook it created. This limitation is Forgejo's, not the app's, and is stated at the point
of approval as well as here. Approve with an account whose access is limited to the repositories you
intend to connect.

## 11. Your rights

Because the vendor holds none of your data, requests to access, correct, export or erase personal
data handled by the app are fulfilled by you as controller, using the deletion controls in section 8
and Jira's own tools. If you believe the app itself handles data in a way this policy does not
describe, contact [support@iamroon.pk](mailto:support@iamroon.pk).

## 12. Children

The app is a business tool intended for use by organisations and is not directed at children.

## 13. Changes

Material changes to this policy are published at
<https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/blob/v1/PRIVACY.md> with an updated
effective date, and noted in [CHANGELOG.md](CHANGELOG.md).

## 14. Contact

[support@iamroon.pk](mailto:support@iamroon.pk)
