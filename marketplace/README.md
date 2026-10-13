# Marketplace assets

Everything needed to fill in the **Overview** tab of the Atlassian Marketplace listing. Nothing in
this folder is part of the app: it is excluded from the Forge upload by `.forgeignore`.

| Path | What it is |
| --- | --- |
| [`listing.md`](listing.md) | Copy for every field, with character limits, alt text and privacy answers |
| [`preview.html`](preview.html) | Mock-up of the finished Overview tab. Open it in a browser; no server needed. Its copy mirrors `listing.md`, so edit both |
| `images/` | The PNGs to upload, each at the exact size Marketplace asks for |
| `svg/` | The vector source of each PNG |
| `scenes.mjs` | One function per image. Edit this to change an illustration |
| `draw.mjs` | Shared palette, icons and UI pieces |
| `build.mjs` | Renders `svg/` and `images/` |
| `assets/forgejo-logo.svg` | The Forgejo logo, unmodified. See [NOTICE.md](../NOTICE.md) |

## Where each image goes

| File | Size | Marketplace field |
| --- | --- | --- |
| `logo-144x144.png` | 144 x 144 | App logo |
| `banner-1120x548.png` | 1120 x 548 | App banner |
| `highlight-N-…-1840x900.png` | 1840 x 900 | Highlight N, full screenshot |
| `highlight-N-…-cropped-580x330.png` | 580 x 330 | Highlight N, cropped screenshot |
| `gallery-N-…-1840x900.png` | 1840 x 900 | Additional screenshot (see `listing.md` for which highlight) |

## Regenerating

```bash
node marketplace/build.mjs            # every image
node marketplace/build.mjs gallery    # only images whose name contains "gallery"
```

Needs Node 22 and Google Chrome (or set `CHROME_PATH` to a Chrome or Chromium binary). The script
checks that every PNG is exactly the size in its file name and fails if one is not.

## These are illustrations, not screenshots

Atlassian's listing principles ask for screenshots that show the app inside the Atlassian UI rather
than standalone marketing graphics. The images here are drawn: they use the real labels from the
app's admin and project pages and the workflow file it generates, but the Jira issue view and
Forgejo screens are stylised, and names, numbers and URLs (Acme, `ABC-12`, `code.acme.dev`) are
invented. Before submitting, consider replacing or adding real screenshots from a development
install, at the same sizes. The illustrations do not use the Jira or Atlassian logos.
