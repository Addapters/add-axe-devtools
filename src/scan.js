// Main scanner: crawls the discovered URL list at two viewports, runs
// axe-core in a real headless Chromium via Playwright, and writes a
// structured JSON report (see README for schema notes).
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const { discoverUrls } = require('./discover-urls');
const { preparePage } = require('./quirks');

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
];

const NAV_TIMEOUT_MS = 30000;
const DEFAULT_CONCURRENCY = 4;

function parseArgs(argv) {
  const args = { concurrency: DEFAULT_CONCURRENCY, limit: null, nocache: false, outDir: path.join(__dirname, '..', 'scans') };
  for (const arg of argv) {
    if (arg.startsWith('--concurrency=')) args.concurrency = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--limit=')) args.limit = parseInt(arg.split('=')[1], 10);
    else if (arg === '--nocache') args.nocache = true;
    else if (arg.startsWith('--out-dir=')) args.outDir = arg.split('=')[1];
  }
  return args;
}

// Small dependency-free concurrency-limited task runner.
async function runPool(tasks, concurrency, onEach) {
  let idx = 0;
  let active = 0;
  const results = [];
  return new Promise((resolve, reject) => {
    let finished = 0;
    function launchNext() {
      if (idx >= tasks.length) {
        if (active === 0 && finished === tasks.length) resolve(results);
        return;
      }
      const myIdx = idx++;
      active++;
      Promise.resolve(tasks[myIdx]())
        .then((r) => {
          results[myIdx] = r;
          active--;
          finished++;
          if (onEach) onEach(finished, tasks.length, r);
          launchNext();
        })
        .catch((err) => {
          active--;
          finished++;
          results[myIdx] = { error: String(err && err.message ? err.message : err) };
          if (onEach) onEach(finished, tasks.length, results[myIdx]);
          launchNext();
        });
    }
    const startCount = Math.min(concurrency, tasks.length);
    if (startCount === 0) resolve(results);
    for (let i = 0; i < startCount; i++) launchNext();
  });
}

async function scanOnePage(browser, url, viewport, { nocache }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    userAgent: 'Mozilla/5.0 (compatible; ANI-a11y-axe-scanner/1.0)',
  });
  const page = await context.newPage();
  try {
    const targetUrl = nocache ? `${url}${url.includes('?') ? '&' : '?'}nocache=${Date.now()}` : url;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {
      /* some pages (video embeds, long-poll widgets) never truly go idle - proceed anyway */
    });
    await preparePage(page);

    const axeResults = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();

    return {
      url,
      viewport: viewport.name,
      violations: axeResults.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        tags: v.tags.filter((t) => AXE_TAGS.includes(t)),
        nodes: v.nodes.map((n) => ({
          target: n.target,
          html: n.html,
          failureSummary: n.failureSummary,
        })),
      })),
    };
  } finally {
    await context.close();
  }
}

function aggregateByRule(pageResults) {
  const ruleMap = new Map();

  for (const result of pageResults) {
    if (!result || result.error || !result.violations) continue;
    for (const violation of result.violations) {
      if (!ruleMap.has(violation.id)) {
        ruleMap.set(violation.id, {
          ruleId: violation.id,
          impact: violation.impact,
          wcagTags: violation.tags,
          description: violation.description,
          help: violation.help,
          helpUrl: violation.helpUrl,
          totalInstances: 0,
          affectedPages: [],
        });
      }
      const rule = ruleMap.get(violation.id);
      rule.totalInstances += violation.nodes.length;
      rule.affectedPages.push({
        url: result.url,
        viewport: result.viewport,
        count: violation.nodes.length,
        selectors: violation.nodes.map((n) => n.target.join(' ')),
      });
    }
  }

  return Array.from(ruleMap.values()).sort((a, b) => b.totalInstances - a.totalInstances);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });

  console.log('Discovering URLs from sitemaps...');
  const { urls, perSitemap } = await discoverUrls();
  perSitemap.forEach((s) => console.log(`  ${s.sitemapUrl}: ${s.kept}/${s.total} kept (PT only)`));

  let targetUrls = urls;
  if (args.limit) targetUrls = targetUrls.slice(0, args.limit);
  console.log(`\nScanning ${targetUrls.length} pages x ${VIEWPORTS.length} viewports = ${targetUrls.length * VIEWPORTS.length} page loads, concurrency=${args.concurrency}${args.nocache ? ', cache-busting ON' : ''}`);

  const browser = await chromium.launch({ headless: true });

  const tasks = [];
  for (const url of targetUrls) {
    for (const viewport of VIEWPORTS) {
      tasks.push(() => scanOnePage(browser, url, viewport, { nocache: args.nocache }));
    }
  }

  const startedAt = Date.now();
  const pageResults = await runPool(tasks, args.concurrency, (done, total, result) => {
    const elapsedS = Math.round((Date.now() - startedAt) / 1000);
    const label = result && result.error ? `ERROR: ${result.error}` : 'ok';
    process.stdout.write(`[${done}/${total}] (${elapsedS}s) ${label}\n`);
  });

  await browser.close();

  const errors = pageResults.filter((r) => r && r.error);
  if (errors.length) {
    console.log(`\n${errors.length} page load(s) failed and were excluded from results:`);
    errors.forEach((e) => console.log(`  ${e.error}`));
  }

  const byRule = aggregateByRule(pageResults);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const jsonReport = {
    scannedAt: new Date().toISOString(),
    pagesScanned: targetUrls.length,
    pageLoadsScanned: pageResults.filter((r) => r && !r.error).length,
    pageLoadsFailed: errors.length,
    viewportsScanned: VIEWPORTS.map((v) => v.name),
    axeTags: AXE_TAGS,
    byRule,
  };

  const jsonPath = path.join(args.outDir, `axe-results-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf-8');
  console.log(`\nWrote ${jsonPath}`);

  const { writeSummaryMarkdown } = require('./report');
  const mdPath = path.join(args.outDir, `axe-summary-${timestamp}.md`);
  writeSummaryMarkdown(jsonReport, mdPath);
  console.log(`Wrote ${mdPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scanOnePage, aggregateByRule, VIEWPORTS, AXE_TAGS };
