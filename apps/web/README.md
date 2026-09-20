# krypta web

The Next.js client for krypta's end-to-end encrypted forms. Every question,
answer, uploaded file and appearance setting is encrypted here, in the
browser, before it is sent to the API. This app holds the only keys that can
open any of it.

Start here: the repository root `README.md` explains what krypta is and walks
through setting the whole thing up, including the object store bootstrap this
page assumes is done. What follows covers the client on its own.

## Local development

From the repository root, start the local backing services:

```bash
docker compose -f infra/docker/docker-compose.dev.yml up -d
```

In another terminal, start the API from `apps/api` after copying its
`.env.example` to `.env`:

```bash
cargo run
```

Then start the web app from this directory:

```bash
bun run dev
```

The web app runs on `http://localhost:3000` and expects the API on
`http://localhost:8080`.

## Fonts

Every font a form can use is served from this origin. `fonts/families.json`
lists the Fontsource packages to bundle, and `scripts/build-fonts.ts` (run
automatically before `dev` and `build`, or by hand with `bun run fonts:build`)
turns them into `lib/font-catalog.json`, one stylesheet per family under
`public/fonts/`, and the woff2 files behind it. Nothing is fetched from Google
at any point, so a respondent's browser contacts no third party to render a
form. To add a family, add its Fontsource id to the list and the matching
package to `package.json`, then rebuild.

## Form dark mode

Creators can enable dark mode per form in Appearance. Enabled public forms
follow the respondent's system color preference and show an in-form Light,
System and Dark switch for the current page session. This local choice is never
stored in the encrypted form schema or sent to the API.

## Checks

Run the web checks from this directory:

```bash
bun run test:unit
bun run lint
bun run typecheck
bun run build
bun run test:e2e
```

The end-to-end suite drives a real browser, so install one the first time with
`bunx playwright install`. It also needs the API and the dev services running,
since it registers accounts and submits real responses.

Two limits of the unit suite that surprise people: vitest runs in Node with no
DOM, so component tests render to static markup rather than mounting, and the
Playwright specs under `e2e/` are excluded from it on purpose. They fail with a
confusing error if you run vitest over them by hand.

Keep secrets in local environment files or your deployment's secret manager.
Never commit `.env.local` or API credentials.
