# apps/web

Next.js + React + TypeScript. Guidance here covers **working in this
directory**. The design this app must not violate (the zero-knowledge
boundary, the account key hierarchy, sealing, password reset, the
non-negotiable rules) lives in the root `CLAUDE.md` and applies here too.

Note the `nextjs-agent-rules` block at the end of this file is written and
re-added by `next dev`. It is not project guidance, it is committed only so
the tree stays clean, and it is the one place in the source tree that carries
an em-dash, because its text is not ours to edit. Everything between its
hidden BEGIN and END comment markers is replaced on every `next dev` start,
and the BEGIN marker sits above the block's visible heading. Add new sections
above that marker, never just before the heading, or they are silently
deleted the next time the dev server starts. Never write either marker out
literally anywhere else in this file: `next dev` matches the first one it
finds, and a copy quoted in prose becomes where the block is injected.

## Conventions

- **Animation is CSS transitions driven by `IntersectionObserver`** (`components/scroll-reveal.tsx` toggling `data-revealed`, with `.reveal-on-scroll` / `.reveal-stagger` in `globals.css`). Do **not** reach for `animation-timeline: view()`: it is Chrome/Edge only and degrades to no animation at all elsewhere, which looks identical to a broken feature. The hidden start state is gated on `@media (scripting: enabled)` so content is never stranded at `opacity: 0`, and stagger uses `transition-delay` (`animation-delay` is inert on a scroll-driven timeline). The one sanctioned script-driven exception is the FAQ's Safari fallback, below.
- **The `motion` library is installed, and its job is layout animation only.** Everything else stays CSS: a fade, a hover, a scroll reveal must not pull it in. It exists because CSS cannot animate a container between two content-driven heights (`interpolate-size` makes `0` to `auto` animatable, not `auto` to `auto` when the content swaps), which is what the Focus layout needs between steps. Note it now loads on the public form route, the one page anonymous respondents wait on.
- **Do not animate a bordered card with Motion's `layout` prop.** It morphs a box by scaling it, and scaling a tall card down to a short one visibly shears the border and corners. Measure the height with a `ResizeObserver` and animate the number, as `focus-form-renderer.tsx` does. That costs a layout pass per frame, which is the right trade for one element whose edges the user is looking at. `layout` is still fine for something without a visible border.
- **Easing tokens live in `@theme inline`** (`--ease-out`, `--ease-in-out`), so Tailwind's own `ease-out` utility already resolves to the strong curve. Do not add a parallel easing scale.
- **The FAQ disclosure** animates via `::details-content` + `interpolate-size`, needs `@starting-style` for the answer's fade (a transition cannot start from `content-visibility: hidden`), and is exclusive through the native `<details name>` attribute rather than controlled state. The height rules sit inside `@supports (interpolate-size: allow-keywords)`, because Safari supports `::details-content` but not `interpolate-size`. Where that is missing, `components/faq-accordion.tsx` animates the `<details>` height and the answer's fade with the Web Animations API instead, removes the `name` attributes and handles exclusivity itself (so the previously open item animates shut rather than snapping), and sets `data-closing` so `globals.css` turns the + back with the motion. It does nothing where the CSS path works or motion is reduced.
- **Icons come from `@hugeicons/react` + `@hugeicons/core-free-icons`.** Verify an export name exists in `node_modules/@hugeicons/core-free-icons/dist/types/index.d.ts` before importing it; a wrong name fails at build.
- **The `react-hooks` rules include React Compiler diagnostics, so `useMemo` can make lint worse.** Manual memoisation the compiler cannot preserve is a hard *error* (`Compilation Skipped: Existing memoization could not be preserved`), so reaching for `useMemo` to satisfy `exhaustive-deps` can trade two warnings for one error. The compiler is not enabled for builds either (no `reactCompiler` flag, no `babel-plugin-react-compiler`), so its automatic memoisation cannot be relied on to keep identities stable. Prefer deriving inside the effect from a stable primitive dependency, as `form-theme-surface.tsx` does with its joined font key.
- **Object identities in effect dependency arrays are a live hazard here**, for the same reason. `useSearchParams()` and `useRouter()` return values whose identity is not guaranteed stable across renders; an effect that lists one and also calls several `setState`s can re-run itself indefinitely. This has already produced a request storm on the form detail page. Depend on a primitive derived during render instead.
- **A comment inside a CSS selector list silently drops the whole rule.** The parser reports nothing, so the rule simply never appears. Put comments above a rule, never between selectors, and verify cursor/animation changes against the compiled stylesheet (`curl` the `/_next/static/**.css` the page links) rather than the source.
- **Claims on the landing page are load-bearing.** The copy states what the server does and does not receive, so check it against the code before editing. The password and the vault recovery code belong on the "Never received" list, and that is deliberate rather than an oversight to correct: login sends only `deriveAuthVerifier(...)` (`app/login/page.tsx`), so neither secret is transmitted. Do not remove them. But do not let the copy grow past what that buys: nothing on the page may contradict the two limits in `SECURITY.md` (offline cracking of a weak password from a dump, and an operator serving modified JavaScript). "Never received" is a claim about what crosses the wire, and only that.
- **`/privacy` and `/terms` are configuration, not shipped text.** They render
  only when `LEGAL_ENTITY` and `LEGAL_CONTACT_EMAIL` are set, and 404
  otherwise, because a policy is a promise by a named operator and the
  published image is run by people we have never met: shipping one operator's
  company and contact address to every self-hoster would hand them a document
  naming the wrong party, which is worse than no page because it reads as
  binding. `lib/legal.ts` is the only place that decides, the footer and the
  sitemap both ask it, and the three text pages share `components/prose-page.tsx`
  so the first edit to one does not leave the others behind. Everything either
  page asserts about what is stored, what is unreadable and how long it is kept
  has to stay true of the code, exactly as below, and here a stale sentence is a
  false statement made to a user about their own data rather than a doc bug.
- **`/security` answers to `SECURITY.md`, which answers to the code.** The page
  is a summary for someone deciding whether to trust an instance, so it may
  say less than `SECURITY.md` and must never say more. Changing a limit, a
  default or a header means changing the code, `SECURITY.md` and that page
  together, and the honest sections are the point of it: a reader who finds
  the limits listed plainly has a reason to believe the guarantee above them.

## Testing limits you will hit

- **`vitest` here has no DOM environment** (no `jsdom`/`happy-dom`, no `@testing-library/react` dependency): it's Node-only. Every component test renders with `renderToStaticMarkup` from `react-dom/server` and asserts on the resulting markup string; there is no way to `fireEvent`, trigger a state update, or assert a callback actually fired. This is a deliberate limit of the current setup, not a gap in any one test file: a component's interactive behavior (does clicking actually advance state, does a callback actually run) is only ever exercised by the Playwright e2e suite, never by `test:unit`. Keep this in mind before promising unit coverage for something that needs a live DOM.
- **`@/` path-alias imports are unresolvable under this repo's `vitest`.** Only `tsconfig.json` declares the alias, and Vite/Vitest never reads it, so any bare `@/...` import anywhere in a test's module graph fails at load time with `Cannot find package '@/...'`, regardless of how simple the target file's own content is. Every existing test routes around this with `vi.mock("@/path", () => ({ ...stub }))` when a dependency's own behavior is out of scope, or `vi.mock("@/path", async () => vi.importActual("<relative-path>"))` when the test needs that dependency's real behavior. Real npm/workspace packages (`@krypta/crypto`, `@hugeicons/*`) resolve fine and are unaffected; `import type` from `@/...` is erased at compile time and needs no mock either.
- **`motion/react` must be mocked in any test whose module graph reaches it.** This vitest is Node-only with no client React context, so Motion's hooks throw `Cannot read properties of null (reading 'useState')` before a single assertion runs. Adding Motion to one component broke seven tests across two files, `form-preview.test.tsx` included, because that file imports the real focus renderer rather than stubbing it. Copy the passthrough stub already in `focus-form-renderer.test.tsx`.
- Security-critical logic belongs in `lib/`, not in a page component, precisely because of the first limit. `lib/recovery.ts` exists so the "never transmits the recovery code" property can be asserted at all.
- The per-member notification toggle is another example of the first limit: its interactive behavior isn't unit-testable here, so the endpoint behind it is covered by `apps/api/tests/notifications_test.rs` instead.

## Writing e2e tests

Auth forms derive keys in JavaScript, so their submit handler only exists after
React hydrates. Clicking earlier performs the form's native GET, which reloads
the same route and silently drops the attempt; the tell in Playwright's log is a
navigation to something like `/unlock?`. Always go through `waitForInteractive`
or `unlock` from `e2e/fixtures.ts` instead of clicking straight after a
navigation, **including after a `page.goto` to a route you have already
visited**. This race is timing-sensitive enough that unrelated changes, adding
a few CSS rules included, will flip it, and a test that passes alone can fail in
a full run.

`waitForInteractive` waits for `networkidle`, so it cannot settle against a page
that never stops requesting. If it times out, suspect a render loop in the page
before suspecting the test.

Two failure modes look like broken product code but are not: an exhausted
registration cap (see the root `CLAUDE.md`) and this hydration race. Rule both
out before investigating the app.

## The app header has to fit a 375px phone

`e2e/form-appearance.spec.ts` asserts no horizontal overflow at 375px, and
the header is where that fails: a form page carries Share, Copy link, Export
CSV or Save, the theme toggle, Account, Admin and Log out. Below `sm` the
account items fold into one menu in `components/app-header.tsx` (which also
holds the language choice as radio items; from `sm` it is an icon-only globe
menu beside the theme toggle), the
secondary form actions drop their labels behind `hidden sm:inline` spans
while keeping an `aria-label` equal to the old text (so every existing
`getByRole` still resolves at desktop width), and Save and Publish shorten
their labels. An icon-only small button also needs `max-sm:w-7 max-sm:px-0!`:
the small size trims its left padding for a leading icon, which is right
with a label and lopsided without one. The Preview button is simply hidden
below `sm`. Adding a header action means fitting it into that budget, not
appending it.

## Adding a fetch to a settings panel breaks `e2e/admin.spec.ts`

This has now happened twice, once for `/auth/passkeys` and once for
`/billing/subscription`, and both times it escaped every per-task review and
surfaced only in the integration gate.

`e2e/admin.spec.ts` installs a strict request router and ends it with
`throw new Error("Unexpected acceptance-test request: " + path)`. It navigates
to `/dashboard/settings` and enrols TOTP there, so **any request that flow
makes, whether a component fetching on mount or an action like
`/auth/reauthenticate`, must have a stub arm in that router**, or the test
dies on a path it has never heard of. The existing `/auth/passkeys`,
`/billing/subscription` and `/auth/reauthenticate` arms are the pattern to
copy.

Do not loosen that final `throw` into a permissive catch-all. Its strictness is
the whole point: it is what proves the admin page requests only what it should.

`admin-boundary.spec.ts` has a router of the same kind (its own arms include
`/auth/reauthenticate`) and does not visit settings; if you make it visit
settings, it will need the settings page's arms too.

## `apiFetch` hides the HTTP status, and sometimes you need it

`apiFetch` calls `res.json()` unconditionally, so a response with an empty body
throws a `SyntaxError` rather than an `ApiClientError`, and a 404 is
indistinguishable downstream from a 500 or a network failure. That matters when
absence is a legitimate answer: the billing routes are simply not mounted on an
instance without Stripe, and the plan panel has to render nothing rather than an
error.

`apiFetchWithStatus` exists for exactly that case and returns the status
alongside the data. Reach for it when a specific status means something to the
caller, and leave `apiFetch` alone: it has many callers, and widening it would
touch all of them.

## Opening the dev app from a phone

Three separate things block this, and each fails in a way that looks like
something else.

**Next blocks its own dev assets from any origin but localhost.** The server
still returns the SSR HTML, so the page renders and then nothing hydrates:
dynamic imports never resolve, scroll reveals never fire, and the result reads
as a broken page rather than as blocked assets. The only signal is a warning in
the dev server's log. Pass the machine's address in `ALLOWED_DEV_ORIGINS`,
which `next.config.ts` reads.

**The API base has to point somewhere the phone can reach.** It defaults to
`http://localhost:8080`, and from a phone `localhost` is the phone. Set
`NEXT_PUBLIC_API_BASE` to the machine's address, and set
`CORS_ALLOWED_ORIGINS` on the API to match, or every request is rejected.
`connect-src` follows `NEXT_PUBLIC_API_BASE` automatically, so CSP needs no
separate change.

**Login cannot work over plain http, and no configuration fixes it.** The
session cookie is `__Host-session` with `Secure`, and browsers only store
`Secure` cookies over HTTPS, with `http://localhost` as the sole exception.
Over `http://<lan-ip>` the browser accepts the 200 from `/login` and silently
discards the cookie, so every later request is a 401. Landing page and public
forms work; the dashboard does not.

**The working setup is one HTTPS tunnel and the API proxied behind it.** A
tunnel to port 3000 gives HTTPS, but the cookie is also same-site only, so a
second tunnel for the API would never receive it. `DEV_API_PROXY_TARGET` in
`next.config.ts` makes this server forward `/api/v1` to the API, so the
tunnel origin serves both; set `NEXT_PUBLIC_API_BASE` to
`https://<tunnel>/api/v1` and list the tunnel host in `ALLOWED_DEV_ORIGINS`.
Two things bite here. Most tunnels answer the dev server's HMR websocket
with a 404, and the Turbopack dev runtime then never hydrates: the HTML,
scripts and nonce all arrive intact and nothing errors, the page just stays
inert. Serve a production build for tunnel testing (`bun run build && bun run
start`), which has no websocket. And `bun run start` spawns a `next-server`
process that `pkill -f "next start"` does not match; a rebuild while it still
holds port 3000 leaves the old process serving chunks that no longer exist.
Kill by port (`lsof -nP -iTCP:3000 -sTCP:LISTEN`) before starting again.

Pointing the API base at a LAN address also breaks localhost login, for that
same cookie reason, and it breaks the e2e suite with it. Put the variables back
before running Playwright, or the failures land on `waitForURL` at the login
step and read as product bugs.

## Tooling gotcha: shadcn MCP

`components.json` lives at `apps/web/`, not the repo root. The `shadcn mcp` server resolves it from its **process** working directory, and its own `--cwd` flag does not reach the tool handlers (4.19.0), so `.mcp.json` wraps the command as `sh -c "cd apps/web && exec bunx shadcn mcp"`. It runs the version the lockfile pins rather than `shadcn@latest`: `@latest` makes `bunx` resolve the package against the registry on every start, which can take longer than the 30-second MCP connect timeout, and the server then fails to connect. Symptom when this is wrong: `get_project_registries` returns empty and configured registries error with `NOT_CONFIGURED`. Note the CLI resolves some public registries without any config, so a working `shadcn search` does not prove the MCP is configured.

The MCP reads registries and aliases only. It cannot see local components in `apps/web/components/`.

The MCP's `view_items_in_registries` reports the **default** `@shadcn` registry's dependencies: it lists `radix-ui` for `dropdown-menu` and `lucide-react` for `chart`. This project's `components.json` sets `"style": "base-nova"` with `"iconLibrary": "hugeicons"`, so what the CLI actually installs is built on `@base-ui/react` and uses hugeicons instead: `bunx --bun shadcn@latest add dropdown-menu` landed a `components/ui/dropdown-menu.tsx` built on `@base-ui/react/menu` with `@hugeicons/react`/`@hugeicons/core-free-icons` icons, and no `package.json` change at all (`@base-ui/react` and `@hugeicons/*` were already dependencies). Trust `bunx --bun shadcn@latest add <name>` plus `git diff package.json` over the MCP's dependency listing.

## Commands

```bash
bun install          # first time only / after pulling new deps
bun run dev          # localhost:3000
bun run typecheck
bun run lint         # must be 0 errors and 0 warnings
bun run test:unit    # vitest
bun run test:e2e     # Playwright, requires the API and this dev server running
bun run build
```

Next 16 no longer prints the per-route First Load JS table; read
`.next/diagnostics/route-bundle-stats.json` after a build instead.

# Design notes for the web app

The sections below are the design of individual client features, moved here
from the root `CLAUDE.md`, which keeps the rules and the cross-cutting design
they rest on. Read the root first.

## A half-filled form is kept on the respondent's own device

`apps/web/lib/form-draft.ts` writes a respondent's in-progress answers to
`localStorage` under `krypta:draft:<formId>`, so closing a tab does not throw
the work away. It is the one place in the product that puts user content on
disk in the clear, and that is a deliberate trade rather than an oversight.

**It is not a hole in the zero-knowledge boundary, and encrypting it would not
be an improvement.** A response is sealed to the form public key before it
leaves the browser; a draft has not been submitted yet and there is nothing to
seal it to that the same browser does not already hold, since the schema key
sits in the URL fragment beside it and in the history of the same profile.
Encrypting a draft under that key would look like protection while providing
none. So the draft is stored plainly, the fill page says so under the seal, and
the respondent gets a control that removes it. Do not "fix" this by encrypting
with a key stored next to the ciphertext.

Six things a future edit would break by accident:

- **A restored draft is reconciled against the schema, and it has to be a
  second step.** The answers are read during the first render, from storage,
  while the questions are still being fetched and decrypted, so `loadDraft` has
  no schema to judge them by and validates shape alone. `reconcileDraft` in
  `lib/form-answers.ts` runs the moment the questions land and drops what the
  form can no longer hold. Without it a stale value survives every gate that
  should have caught it: turn a short text question into multiple choice and
  yesterday's sentence is still a string, so it restores, it is not empty, so
  the resume position skips the question and `required` counts it as answered,
  but no option matches it, so every radio renders unselected. The respondent
  sees a blank question nothing asks them to fill in and the sentence is sealed
  into their response. Three properties hold it in place. It is **subtractive
  only**, which is what keeps it clear of the sealing path, since the payload
  built at submit can then only shrink. It matches against **every** question
  rather than the visible ones, because an answer hidden behind a condition must
  survive a branch being toggled back and forth. And it returns the same object
  when it drops nothing, so an ordinary restore costs no render and no write and
  running it twice is a no-op. It deliberately does not judge the contents of a
  text-shaped answer: a wrong-looking string sits in a field the respondent can
  see and correct, while an unmatched option is neither visible nor fixable.
- **The notice reads the write, not the screen.** `saveDraft` returns whether
  anything is now on the device and the hook tracks that as `draftSaved`. It was
  once `Object.keys(answers).length > 0`, which is React state and lies in two
  ways: storage may be blocked or full, and the debounced write may not have
  landed yet. This is a promise made to someone who may be
  on a shared machine, so it must not be inferred from a proxy. The e2e depends
  on it for the same reason: waiting on the notice is now waiting on the write.
- **A finished draft must be discarded through `discardDraft`, never
  `clearDraft`.** Clearing storage while the answers are still in React state
  puts them straight back: the next keystroke rewrites them, and so does the
  flush below when the page is left. This shipped broken during development,
  where leaving the confirmation screen restored the draft of a response that
  had already been sent. `discardDraft` empties both, which is what makes every
  one of those paths write nothing.
- **The debounced write flushes on `pagehide` and on `visibilitychange`, not
  only on unmount.** Closing a tab does not unmount React, so an unmount-only
  flush would lose whatever was typed in the last debounce window, at exactly
  the moment a respondent is most likely to leave. `pagehide` covers a close, a
  reload, a navigation and the back/forward cache; `visibilitychange` covers a
  mobile browser being backgrounded, which on iOS may never fire `pagehide`.
- **The draft is restored in the `useState` initializer, not an effect.** An
  effect would paint an empty form for a frame, which reads as lost work, and
  the autosave would write that empty state over the draft it was about to
  read. It causes no hydration mismatch because the page renders a spinner
  until the form loads, on the server and on the client alike.
- **Where the respondent resumes is derived, never stored.**
  `firstUnansweredIndex` in `lib/form-answers.ts` gives both layouts their
  starting position on mount, so there is no second thing to keep in sync and
  no stored index that can point at a question the creator has since deleted.
  It matters most in Focus, where a respondent would otherwise click forward
  through every answer they had already given.

The draft expires on its own after 30 days, and the expiry is enforced for
the whole profile: `sweepExpiredDrafts` runs in the same `useState`
initializer before any form restores its draft, and removes every expired or
unreadable `krypta:draft:*` entry, so an abandoned answer on a shared machine
does not wait for its own link to be reopened. `DRAFT_MAX_AGE_MS` is coupled to
the API's `UNCLAIMED_ATTACHMENT_TTL_SECONDS`, which is one day longer so a
restored draft never names a reclaimed upload; change them together. The
one-response-per-person marker (`krypta:submitted:<formId>`) lives in the same
module, so one file owns that key prefix; it is not enforcement (see the last
bullet of "Response notifications and form limits" in `apps/api/CLAUDE.md`).

## Fonts never leave this origin

A form's typography used to be two third-party dependencies: a keyed Google
API for the picker's catalogue, and `fonts.googleapis.com` plus
`fonts.gstatic.com` in every respondent's browser for the files. The second
one handed Google the IP address of everyone who opened a form, which is the
same leak this project removed when it dropped the header image URL, and a
German court has ruled that exact embedding unlawful without consent.

Both are gone. `apps/web/fonts/families.json` names Fontsource packages (the
Google Fonts collection republished on npm, same files, open licenses), and
`apps/web/scripts/build-fonts.ts` turns the installed ones into
`lib/font-catalog.json`, one stylesheet per family under `public/fonts/`, and
the woff2 files behind it. It runs before `dev` and `build`; the catalogue is
committed and `scripts/ci.sh` fails if it drifts from the list. The CSP
therefore lists no font host at all, and `e2e/form-appearance.spec.ts` aborts
any request to Google so a regression fails loudly.

Three things a future edit would break by accident:

- **Variable packages name the face "Family Variable".** Themes store the
  plain family, so the script rewrites the name in the generated CSS. Copying
  Fontsource's CSS by hand skips that and the font silently never applies.
- **The catalogue is the authorisation, as before.** `getFontCssUrl` returns
  a URL only for a family the catalogue lists, and only under an id matching
  `^[a-z0-9-]{1,100}$` (`getFontCssUrl` in `apps/web/lib/form-theme.ts`), so a theme cannot name a path. Themes naming an unlisted
  family fall back to the role default exactly as they did when the list came
  from Google.
- **`app/opengraph-image.tsx` reads Outfit, Geist Mono and Schoolbell from the
  static `@fontsource/*` packages**, because the image renderer accepts WOFF
  but not woff2 and only the static packages ship WOFF. So **a family the card
  draws in keeps its static package even when the form catalogue resolves it
  through the variable one**, which is why `@fontsource/*` sits beside
  `@fontsource-variable/*` in `apps/web/package.json` rather than being a
  duplicate to tidy away; a static package the card stops using can go.
  Schoolbell carries the tagline alone, the one handwritten thing against the
  ciphertext, and must not spread to the wordmark, which has to read as a
  name. `next/font/google` in the root layout downloads its three faces once
  at build and serves them from this origin, so no Google Fonts request exists
  at runtime anywhere.

Scaling past the curated list is a data change, not a code change: the
Fontsource index at `api.fontsource.org/v1/fonts` lists every family with its
`variable` flag, so the list can be generated rather than written, and at
that size the files move out of the image to a volume or bucket served under
the same `/fonts/` path.

## A respondent's own answer to a choice question

`allowOther` on a `multiple_choice` or `checkboxes` question adds an "Other"
row with a text box. What the respondent writes is stored as a **marked option
value**, not as a new field on the answer: a response is `string | string[]`
and encrypted, so changing that shape later would mean migrating ciphertext the
server cannot read. `apps/web/lib/form-other.ts` is the only place that knows
the encoding.

The marker is a `U+0000` prefix, chosen because a respondent cannot type it and
a creator cannot paste it through the builder. An option the creator genuinely
named "Other" therefore stays an ordinary option, and where both exist the
summary relabels the written-in row so a chosen one is never counted with a
written one.

Two rules that are easy to lose. Written-in answers collapse into a single
summary row, because `summarizeChoice` buckets any unrecognised selection
separately and counting them as themselves would put a row on the chart per
distinct phrase. And selecting Other while writing nothing is not an answer:
`required` must reject it, or the requirement is met by ticking a box and
typing nothing, which is what the box exists to collect.

## Classic and Focus

Two navigational facts that are not obvious from the tree: both form layouts
(Classic and Focus) share `FormQuestionField`/`FormQuestionCard`, so every
question type is implemented once, and they share `apps/web/lib/form-steps.ts`,
which decides what is shown at once and when a respondent may move on.
`apps/web/lib/form-pagination.ts` is Classic's half of that answer, splitting
its questions into pages at each `pageBreakBefore` marker; Focus makes one step
per question.

**Classic and Focus are two deliberately different designs, and only the step
machine is shared.** `form-steps.ts` answers in neutral terms and each layout
words and draws the answer its own way: `stepBlockedBy` returns a reason rather
than a sentence precisely because Focus says "This question is required." about
the one question on screen while Classic says "Answer every required question
to continue." about a page of them. Focus keeps its nested enclosure, the
measured-height morph between steps and the letter shortcuts; Classic keeps its
page of cards, section titles and page counter. Nothing in `form-steps.ts`
should ever grow a class name, a label or a piece of copy, and a change that
makes the two layouts look more alike is a change to the product, not a
refactor. The position, the resume, the end-of-form test and both advance gates
used to be written twice, differently enough that a grep for one never found
the other, which is how their two upload gates drifted apart.
`apps/web/lib/form-visibility.ts` decides which questions a respondent
currently sees, and it runs **before** the split into steps. Filtering after it
would leave empty pages behind. That order is no longer a convention three
callers had to remember: `buildSteps` is private to `form-steps.ts` and
`buildVisibleSteps` is the only way in, so there is no call that can take them
in the wrong order. Visibility is derived, never stored, and like the
"required" toggle it is client-side only: the server cannot read a question,
an answer, or a condition.

## The web image carries no domain

**The web image is not tied to a domain, and keeping it that way is the point.**
`NEXT_PUBLIC_API_BASE` is inlined into the browser bundle at build time, so an
absolute value would send every user of a published image to whichever host
built it. Production is one hostname with the API under `/api`, so the base is
the relative `/api/v1`, which is the Dockerfile's default and needs no build
argument at all. `apiOrigin` in `lib/csp.ts` returns an empty string for a
relative base, because `connect-src 'self'` already covers a same-origin API
and `new URL()` throws on a path: the old fallback would have written
`http://localhost:8080` into a real deployment's policy. The local smoke stack
is the exception and passes the absolute form as a build argument, because it
has no proxy and runs the two on different ports.

`SITE_URL` is deliberately not `NEXT_PUBLIC_`. It is the absolute base for
social preview URLs, which crawlers reject when relative, and it is read only
on the server, so a runtime environment variable configures a running
container rather than a built image. `robots.ts` and `sitemap.ts` carry
`export const dynamic = "force-dynamic"` for the same reason: prerendered,
they would freeze the build machine's hostname into their output.

The web image cannot run with a read-only root filesystem as shipped: Next
writes its image cache under `.next` at runtime, which is why that tree is
chowned to UID 10001 in `apps/web/Dockerfile` rather than left root-owned.

## Two languages: the app's and the form's

krypta has two languages and they must not be merged. The **app language**
is the dashboard, builder and the screens around signing in, for whoever is
using them; it is English or Arabic, and the sign-in screens, the header, the
not-found page and the whole signed-in workspace (dashboard, New form and the
starter templates, account settings, a form's tabs, the builder, sharing and
invitations) and the admin screens are translated. The landing page, the legal
pages, `/security`, page titles and the server's emails are still English
(`UNTRANSLATED_ROUTES` in `lib/app-locale.ts` lists the routes whose text is
not translated, and the browser's language does not apply to them, so English
is never mirrored). The **form language** is the text respondents see around
the questions (buttons, hints, errors, the default thank-you), chosen by the
creator per form. The creator's own questions, options and confirmation
message are never translated.

The form language lives in the encrypted `FormTheme` as `language`, never in
a URL: a locale segment or query parameter would tell request logs what
language a form is in. `normalizeFormTheme` keeps it only when it is a
supported non-English value, so an English form serialises exactly as it did
before languages existed (the starter templates' padding budget depends on
that). `FormThemeSurface` sets `dir` and `lang`, provides
`FormLanguageContext`, and for Arabic loads the self-hosted Noto Sans Arabic
that `toFontStack` puts behind every chosen font.

The app language is resolved on the server by `getAppLanguage()` in
`lib/app-locale-server.ts`: the `krypta-locale` cookie, then `Accept-Language`
by q-value, then English, with nothing unrecognised ever reaching a page. No
locale is ever in a URL and there is no middleware, so `proxy.ts` and the CSP
are untouched. The cookie is written only when someone explicitly picks a
language (`language-switcher.tsx`), never by default, because `/privacy`
promises that the only cookies are the sign-in ones plus this one; adding any
other cookie means changing that page in the same commit. The root layout sets
`<html lang dir>`, provides `AppLanguageContext` and Base UI's
`DirectionProvider`, and for Arabic links the self-hosted Noto Sans Arabic
behind the app fonts (`globals.css`). Components read the language with
`useAppT()`; the server-safe translator lives in `lib/app-translator.ts`
because a Server Component (`not-found.tsx`) must not import the module that
holds the React context, and a test asserts that file never imports React.
**`app/f/layout.tsx` pins English and left to right for every public form
route**, so an Arabic browser opening an English form still gets one; the
form's own surface then applies the form's language. The API's English error
`message` is never shown: `describeApiError` (`lib/api-error-text.ts`) maps each
known code, and each of the five known `bad_request` texts, to a translated key
whose English value equals the server's string, and an unknown message shows
verbatim in English but never in Arabic. Email, password and code inputs use
`CredentialInput` (left to right, aligned to the reading edge in a
right-to-left page). Load failures are `{ key, retryable }` and are worded at
render by `failureText`, since they are created in async handlers where no
language is known.

Workspace conventions (the app's side). **Numbers, dates and sizes** go
through `appFormatters` (`lib/app-format.ts`, `useAppFormat()`), never
`toLocaleString`, `toFixed` or a bare `Intl`: Western digits and the Gregorian
calendar in both languages, with Arabic month names and units, so a count on
screen matches the same count in a CSV or a form. The translator is built with
the `-u-nu-latn` locale for the same reason. **Counts are ICU plurals**, and
the catalogue test (`lib/app-i18n.test.ts`) fails an Arabic plural that lacks
any of the six categories. User content (titles, questions, answers, emails)
is never translated and carries `dir="auto"` (or `dir="ltr"` for an email).
`FormThemeSurface` with `applyLanguage={false}` is app chrome and follows the
app language; with the default it follows the form's. **Starter templates**
carry Arabic text beside the English (`TEXT` in `lib/form-templates.ts`) and
make an Arabic-language form when picked in the Arabic app; Arabic runs two
bytes a letter, so every template in both languages must still fit the
1024-byte padding floor (a test enforces it), which is why the Arabic job
application leaves out its optional start date. `e2e/rtl-workspace.spec.ts`
walks the dashboard, account settings, the template gallery, the builder, a form's three tabs and the sharing dialog in an Arabic browser and fails on English left there, so a
new workspace string that skipped `t()` is caught there.

Strings live in `messages/<language>.json` under `form`. Components read them
with `useFormT()`; the two public pages, which compute text themselves, use
`formTranslator(language)` and keep message keys (not English text) in state.
The context defaults to English on purpose: a component rendered with no
surface, which is every unit test, renders exactly as it always did.
`lib/form-language.ts` holds the React-free helpers so the theme normaliser
never imports `createContext`.

Adding a language is a message file plus an entry in `FORM_LANGUAGES` and
`FORM_LANGUAGE_LABELS`, and `RIGHT_TO_LEFT` if it is written right to left.
The key-parity test in `lib/form-i18n.test.ts` is what stops a missing
translation from reaching a respondent as a raw key. Arabic Focus forms use
number shortcuts (Arabic keyboards do not type Latin letters); a new
right-to-left or non-Latin language needs the same check.

Three conventions keep Arabic content right even in an English form or
the English app. **User-written text sets its own direction:** elements that
show a question, option, section title, form title, custom confirmation or
answer carry `dir="auto"`, so an Arabic answer in an English dashboard reads
right to left with its punctuation at the correct end; Latin text is
unaffected. Respondent *inputs* take `dir="auto"` only once they hold text,
because HTML resolves an empty auto field to ltr rather than to its parent,
which would push an Arabic form's placeholder left; number and date inputs
never take it. **Respondent components use logical classes** (`ms-`, `ps-`,
`start-`, `text-start`), never `ml-`/`left-`/`text-left`, and
`components.json` sets `"rtl": true` so shadcn components arrive that way;
existing ones were converted with `shadcn migrate rtl`, except the tab
indicator, whose `--active-tab-left` is a physical offset by Base UI's design
and so stays `left-`. `FormThemeSurface` provides Base UI's
`DirectionProvider`, which sets positioning and keyboard direction for Base
UI components; a popup portalled to `<body>` would still need `dir` on its
portal, and no respondent page uses one yet. **Search folds Arabic spelling
variants** (`normalizeForSearch` in `lib/response-search.ts`: hamza and madda
marks, tatweel, dagger alef, harakat, taa marbuta, alef maqsura and the
Persian yeh and kaf), and the CSV export starts with a byte-order mark
because Excel otherwise opens UTF-8 Arabic as gibberish.

## Quiz mode is scored for members only

`lib/quiz.ts`, `lib/quiz-score.ts` and `lib/quiz-sealing.ts`. The answer key
and the manual grades are encrypted under a quiz key derived from the form
private key (`deriveQuizKey`), not under the form data key, because the form
data key is the key in the link and every respondent holds it.

That is also why a respondent never sees a score, and why adding one is not a
small change. Grading needs the answer key, and anything a respondent's
browser can grade with it can read in DevTools. Hashing the correct answers
does not help: a choice question has a handful of options. Do not move the key
under the link key, into the schema, or into `FormSettings` to "add instant
results".

Scores are never stored. `scoreResponse` recomputes them on every view from
the decrypted answers, the key and the manual marks, which is what makes
fixing a wrong answer key regrade every past response. Only manual marks are
saved, one blob per form (`hooks/use-quiz-grades.ts`), and unreadable grades
open as `null` rather than empty, so a click can never save an empty set over
them.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
