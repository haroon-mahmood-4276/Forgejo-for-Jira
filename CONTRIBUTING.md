# Contributing

Thank you for considering a contribution. This project is small and maintained by one person, so
clear, focused changes are the ones that land quickly.

## Before you start

- **Bugs and ideas:** open a
  [GitHub issue](https://github.com/haroon-mahmood-4276/Forgejo-for-Jira/issues). Include the Forgejo
  version, what you expected, what happened, and any log lines from the Forge developer console
  (with secrets and personal data removed).
- **Security problems:** do **not** open an issue. Email
  [security@iamroon.pk](mailto:security@iamroon.pk); see [SECURITY.md](SECURITY.md).
- **Larger changes:** open an issue first so the approach can be agreed before you spend time on it.

## Development setup

```bash
git clone https://github.com/haroon-mahmood-4276/Forgejo-for-Jira.git
cd Forgejo-for-Jira
npm install
npm test
```

The test suite needs nothing but Node 22 or newer. Deploying to a development environment needs the
[Forge CLI](https://developer.atlassian.com/platform/forge/getting-started/) and your own Jira Cloud
developer site; see the Development section of [README.md](README.md).

## Ground rules for changes

- **Tests.** Every behaviour change comes with a test in `test/local-test.mjs`, written against the
  stubs in `test/stubs.mjs`. `npm test` must pass.
- **Lint.** `npm run lint` must report no errors. The single wildcard-egress warning is expected.
- **Security invariants** in [SECURITY.md](SECURITY.md) are not negotiable: inbound deliveries stay
  authenticated through `src/lib/delivery.js`, resolvers keep their permission checks, secrets stay
  in secret storage and out of resolver responses and logs.
- **Scopes.** Do not add a Forge scope or egress entry without an issue explaining why; each one
  appears on every customer's consent screen and is a major release.
- **Frontend.** UI Kit components from `@forge/react` only. Nothing from `react-dom` or third-party
  component libraries will render in Forge.
- **Style.** Match the surrounding code: ES modules, four-space indentation in backend code, comments
  that explain *why* rather than *what*. No new runtime dependencies without discussion.
- **Documentation.** If a change alters what the app stores, transmits or requests, update
  [PRIVACY.md](PRIVACY.md) and [README.md](README.md) in the same pull request. Add a line to
  [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.

## Pull requests

- Branch from `v1` and target `v1`.
- Keep a pull request to one logical change.
- Write the description for a reviewer who has not read the code: what changed, why, and how it was
  tested.
- CI runs `npm audit`, the test suite and CodeQL. All must pass.

## Licence

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE), the
same licence as the rest of the project, and that you have the right to license it that way.
