# Support

Forgejo for Jira is free, open-source software maintained by an individual. Support is provided on a
best-effort basis. There is no service-level agreement and no guaranteed response time.

## Where to ask

| Need | Where |
| --- | --- |
| A bug, or a question about setup or behaviour | [GitHub issues](https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/issues) |
| Something you would rather not post publicly | [support@iamroon.pk](mailto:support@iamroon.pk) |
| A security vulnerability | [security@iamroon.pk](mailto:security@iamroon.pk) — see [SECURITY.md](SECURITY.md). Never a public issue. |

## What to include

- Your Forgejo version and whether the instance is reachable from the public internet over HTTPS.
- Which step of setup, or which event (push, pull request, workflow run, deployment report), is
  affected.
- What you expected and what happened.
- Relevant lines from the Forge developer console (`forge logs`) if you deploy the app yourself.

Before sharing logs or screenshots, remove signing secrets, client secrets, tokens, and anything
personal that is not needed to reproduce the problem.

## Before you write

- **Nothing shows on the issue.** Check that the commit message, branch name or pull request title
  contains an issue key in the form `ABC-123`, that the issue exists, and that the repository is
  listed as connected on the admin page.
- **Builds missing.** The workflow's file name must not be listed under *Workflows not reported as
  builds*, and the run's title or branch must name an issue.
- **Deployment step fails with 401.** The `JIRA_FORGEJO_SECRET` repository secret must match the
  secret revealed on the admin page for the connection in the URL.
- **Deployment step fails with 502.** Jira rejected the report; the response body contains Jira's
  own message.
- **Import stuck.** An import that has not progressed for an hour can be restarted with *Re-import*.

## Self-hosting the app

You may deploy the source to your own Forge developer account instead of installing the Marketplace
listing. In that case you administer the deployment, its logs and its Forge storage yourself. The
Development section of [README.md](README.md) covers deploying and tunnelling.
