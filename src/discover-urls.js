// Discovers the URL list to scan from the Yoast sitemaps that actually
// represent "core institutional pages" for this project - see README for
// the scoping decision (post-sitemap*.xml are excluded: confirmed via a
// direct fetch that they contain ~2,053 individual news articles, not
// institutional pages, despite being named similarly).
'use strict';

const SITEMAP_URLS = [
  'https://ani.pt/page-sitemap.xml',
  'https://ani.pt/category-sitemap.xml',
  'https://ani.pt/categorias-de-pagina-sitemap.xml',
];

const USER_AGENT = 'Mozilla/5.0 (compatible; ANI-a11y-axe-scanner/1.0)';

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Fetch failed for ${url}: HTTP ${res.status}`);
  }
  return res.text();
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
