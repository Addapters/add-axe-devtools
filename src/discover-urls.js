// Discovers the URL list to scan from the Yoast sitemaps that actually
// represent "core institutional pages" for this project - see README for
// the scoping decision (post-sitemap*.xml are excluded: confirmed via a
// direct fetch that they contain ~2,053 individual news articles, not
// institutional pages, despite being named similarly).
'use strict';

const { request } = require('playwright');

const SITEMAP_URLS = [
  'https://ani.pt/page-sitemap.xml',
  'https://ani.pt/category-sitemap.xml',
  'https://ani.pt/categorias-de-pagina-sitemap.xml',
];

const USER_AGENT = 'Mozilla/5.0 (compatible; ANI-a11y-axe-scanner/1.0)';
const FETCH_TIMEOUT_MS = 15000;
const FETCH_RETRIES = 3;
const RETRY_BACKOFF_MS = 5000;

// Confirmed live (2026-09-11): page-sitemap.xml (391 URLs, ~516KB) reliably
// hung/timed out via Node's built-in fetch() AND via curl from this same
// environment, while the two smaller sitemaps and the homepage fetched
// fine via the exact same tools. Checked directly via a real browser
// (Claude in Chrome) and confirmed the site itself is fine - the page
// loads instantly there. Root-caused by testing Playwright's own request
// client against the same URL: it succeeded immediately with the correct
// content, where plain fetch()/curl consistently failed - so this is a
// network/TLS-fingerprint quirk specific to how a bare HTTP client
// connects from this environment, not a site outage. Using Playwright's
// bundled request client here instead resolves it, and keeps the
// discovery step consistent with the rest of the scanner, which already
// uses Playwright for everything else.
let sharedRequestContext = null;
async function getRequestContext() {
  if (!sharedRequestContext) sharedRequestContext = await request.newContext();
  return sharedRequestContext;
}

async function fetchText(url, { timeoutMs = FETCH_TIMEOUT_MS, retries = FETCH_RETRIES } = {}) {
  const ctx = await getRequestContext();
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await ctx.get(url, { timeout: timeoutMs, headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' } });
      if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      console.log(`  ${url}: attempt ${attempt}/${retries} failed (${err.message})${attempt < retries ? ` - retrying in ${RETRY_BACKOFF_MS / 1000}s...` : ''}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }
  throw new Error(`Fetch failed for ${url} after ${retries} attempts: ${lastErr.message}`);
}

async function closeRequestContext() {
  if (sharedRequestContext) {
    await sharedRequestContext.dispose();
    sharedRequestContext = null;
  }
}

function extractLocs(xml) {
  const matches = xml.match(/<loc>([^<]*)<\/loc>/g) || [];
  return matches.map((m) => m.replace(/<\/?loc>/g, '').trim());
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/.test(xml);
}

function isEnglishMirror(url) {
  // WPML puts the English mirror under an /en/ path segment on this site -
  // confirmed by sampling all three in-scope sitemaps directly.
  const path = new URL(url).pathname;
  return path === '/en' || path.startsWith('/en/');
}

async function discoverUrls({ includeEnglish = false } = {}) {
  const perSitemap = [];
  const allUrls = new Set();

  try {
    for (const sitemapUrl of SITEMAP_URLS) {
      const xml = await fetchText(sitemapUrl);
      if (isSitemapIndex(xml)) {
        throw new Error(
          `${sitemapUrl} returned a <sitemapindex>, not a <urlset> - this sitemap ` +
          `URL is serving the index instead of its own page list. Re-check the URL.`
        );
      }
      const locs = extractLocs(xml);
      if (locs.length === 0) {
        throw new Error(`${sitemapUrl} returned zero <loc> entries - check manually before trusting this run.`);
      }
      const ptLocs = includeEnglish ? locs : locs.filter((u) => !isEnglishMirror(u));
      perSitemap.push({ sitemapUrl, total: locs.length, kept: ptLocs.length });
      ptLocs.forEach((u) => allUrls.add(u));
    }
  } finally {
    await closeRequestContext();
  }

  return {
    urls: Array.from(allUrls).sort(),
    perSitemap,
  };
}

module.exports = { discoverUrls, SITEMAP_URLS };

// Allow running standalone: `node src/discover-urls.js` just prints the list + counts.
if (require.main === module) {
  discoverUrls()
    .then(({ urls, perSitemap }) => {
      console.log('Per-sitemap counts (PT-only, after English-mirror filter):');
      perSitemap.forEach((s) => console.log(`  ${s.sitemapUrl}: ${s.kept}/${s.total} kept`));
      console.log(`\nTotal unique PT URLs: ${urls.length}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
