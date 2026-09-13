# Notices

Forgejo for Jira
Copyright (c) 2026 Haroon Mahmood

Licensed under the MIT License; see [LICENSE](LICENSE).

## No affiliation

This is an independent, community-maintained project. It is **not** affiliated with, endorsed by,
sponsored by or supported by:

- **Atlassian Pty Ltd** or any Atlassian company. "Atlassian", "Jira", "Forge" and "Atlassian
  Marketplace" are trademarks of Atlassian Pty Ltd.
- **Forgejo** or **Codeberg e.V.** "Forgejo" and the Forgejo logo are trademarks of Codeberg e.V.
- The **Gitea** project.

These names are used only to describe what the software works with (nominative use). Nothing in
this repository claims any rights in them.

## Third-party materials

### Forgejo logo

The app icon (`logo.png`) and the provider logo referenced from `manifest.yml`
(`https://forgejo.org/favicon.svg`) are the Forgejo logo, designed by Caesar Schinas for the Forgejo
project and published under the
[Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/)
licence. It is used here, unmodified, to indicate that the app integrates with Forgejo, in line
with the [Forgejo branding guidelines](https://codeberg.org/forgejo/governance/src/branch/main/TRADEMARK.md).
The CC BY-SA 4.0 licence applies to the logo only; it does not extend to the rest of this repository.

If the Forgejo project asks for the logo to be replaced, it will be.

### Runtime dependencies

The app's only direct runtime dependencies are Atlassian's `@forge/*` packages, published by
Atlassian under their respective licences and used under the
[Atlassian Developer Terms](https://developer.atlassian.com/platform/marketplace/atlassian-developer-terms/).
Their transitive dependencies are listed in `package-lock.json` with licence information available
through `npm ls` and `npm view <package> license`.

## Disclaimer

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. Use of the
software with Jira Cloud is subject to your agreement with Atlassian; use with a Forgejo instance is
subject to that instance's terms. You are responsible for reviewing the permissions the app requests,
the data it transmits (see [PRIVACY.md](PRIVACY.md)) and its security model (see
[SECURITY.md](SECURITY.md)) before installing it.
