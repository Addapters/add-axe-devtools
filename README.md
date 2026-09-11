# add-axe-devtools

A repeatable axe-core accessibility scanner for ani.pt, built so we control
the tool and aren't dependent on Rocket Validator's paid tiers for Axe
results. Discovers core institutional pages from the site's own sitemaps,
runs axe-core in a real headless Chromium (via Playwright) at two
viewports, and outputs a structured report grouped by rule.

## Scope

Pages come from three Yoast sitemaps only, PT (default language) pages only
- the WPML English mirror is filtered out by path (`/en/...`):

- `page-sitemap.xml`
- `category-sitemap.xml`
- `categorias-de-pagina-sitemap.xml`

**`post-sitemap.xml`, `post-sitemap2.xml`, and `post-sitemap3.xml` are
deliberately excluded**, despite an earlier draft of this project's spec
listing them as in-scope. A direct fetch showed they contain ~2,053
individual news/blog articles (not institutional pages) - including them
would have taken this from ~142 pages to ~2,543 and changed what the report
is even measuring. Confirmed with the project owner before building the
scanner around the narrower scope. If that decision changes, add the
sitemap URLs back to `SITEMAP_URLS` in `src/discover-urls.js`.

Current scope, from the three sitemaps above (as of the date this was
written - re-run `node src/discover-urls.js` any time to get current
counts): **282 pages**.

## Usage

```bash
npm install
npx playwright install chromium   # one-time, downloads the browser binary

node src/discover-urls.js               # just lists URLs + counts, no scan
node src/scan.js                        # full scan, default concurrency 4
node src/scan.js --limit=5               # scan only the first 5 URLs (smoke test)
node src/scan.js --concurrency=8         # more parallel page loads
node src/scan.js --nocache                # append ?nocache=<timestamp> to every URL
```

Output goes to `scans/axe-results-<timestamp>.json` (structured, for
tooling/track-planning) and `scans/axe-summary-<timestamp>.md`
(human-readable, ranked by instance count).

## Axe configuration

Tags: `wcag2a, wcag2aa, wcag21aa, wcag22aa` - matches WCAG 2.1 AA (the
compliance target) plus WCAG 2.2 AA's `target-size` criterion, which the
original Rocket Validator report flagged as high-volume.

## Site-specific handling (`src/quirks.js`)

- **Complianz cookie banner**: dismissed via its own exposed
  `window.cmplz_set_banner_status('dismissed')` function (same approach
  already used elsewhere in this project's remediation work), with a
  force-hide fallback.
- **Chat widget**: the project brief calls it "ANIbot," but no such string
  actually appears anywhere in the page's source - it's targeted by its one
  stable literal id, `#chat-bubble`. Its wrapper is a direct child of
  `<body>` with a *randomly-generated id per page load* (confirmed live -
  it changes across reloads), so the code walks up from `#chat-bubble` to
  whichever ancestor is body's direct child and hides that whole subtree,
  rather than hardcoding an id that wouldn't survive the next page load.
  Not yet scanned in its own right - the brief notes this as a candidate
  for a separate, targeted pass later.
- **Lazy-loaded images** (`img.lazy` / `data-src`, swapped in by W3 Total
  Cache's `lazyload.min.js`): triggered by scrolling the full page height
  in steps before running axe, then returning to the top.
- **Divi cache**: pass `--nocache` to append `?nocache=<timestamp>` to
  every URL if results look inconsistent with a manual check - off by
  default since it defeats caching for every one of ~560 requests.
- **Viewports**: mobile (390x844) and desktop (1440x900), both scanned for
  every page - there's no separate desktop nav on this site (same
  hamburger-slide menu at all sizes), but touch-target sizing can still
  differ by viewport.
- **WPML**: PT pages only for this pass (see Scope above). The EN mirror
  is a smaller, separate page set - a good candidate for a follow-up scan
  if PT results come back clean.

## Output schema notes

Each rule's `affectedPages` entries include a `viewport` field (`"mobile"`
or `"desktop"`) that wasn't in the original schema sketch - added because
`target-size` findings are viewport-dependent, and losing that distinction
would make the report harder to act on.
