// Main scanner: crawls the discovered URL list at two viewports, runs
// axe-core in a real headless Chromium via Playwright, and writes a
// structured JSON report (see README for schema notes).
//
// Checkpointing: every completed page+viewport result is appended as one
// line to scans/checkpoint.jsonl immediately, not just held in memory. If
// the process is killed (Ctrl+C, computer shutdown, crash), nothing beyond
// the in-flight page loads is lost - rerun with --resume to pick up where
// it left off instead of rescanning everything.
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
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
const CHECKPOINT_FLUSH_EVERY_MS = 0; // appendFileSync is synchronous per-line already, no batching needed

function parseArgs(argv) {
  const args = {
    concurrency: DEFAULT_CONCURRENCY,
    limit: null,
    nocache: false,
    resume: false,
    outDir: path.join(__dirname, '..', 'scans'),
  };
  for (const arg of argv) {
    if (arg.startsWith('--concurrency=')) args.concurrency = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--limit=')) args.limit = parseInt(arg.split('=')[1], 10);
    else if (arg === '--nocache') args.nocache = true;
    else if (arg === '--resume') args.resume = true;
    else if (arg.startsWith('--out-dir=')) args.outDir = arg.split('=')[1];
  }
  return args;
}

function checkpointPath(outDir) {
  return path.join(outDir, 'checkpoint.jsonl');
}

// Reads the existing checkpoint file (if any) into a map keyed by
// "url|||viewport" -> result. Malformed trailing lines (e.g. from a kill
// mid-write) are skipped rather than failing the whole load.
async function loadCheckpoint(outDir) {
  const file = checkpointPath(outDir);
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const result = JSON.parse(line);
      map.set(`${result.url}|||${result.viewport}`, result);
    } catch (e) {
      // partial/corrupt last line from an interrupted write - skip it, it'll be re-scanned
    }
  }
  return map;
}

function archiveStaleCheckpoint(outDir) {
  const file = checkpointPath(outDir);
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archived = path.join(outDir, `checkpoint-abandoned-${stamp}.jsonl`);
  fs.renameSync(file, archived);
  console.log(`Found an existing checkpoint from a previous run - archived it to ${archived}\n(pass --resume next time if you meant to continue that run instead of starting fresh)`);
}

function appendCheckpoint(outDir, result) {
  fs.appendFileSync(checkpointPath(outDir), JSON.stringify(result) + '\n', 'utf-8');
}

// Small dependency-free concurrency-limited task runner.
async function runPool(tasks, concurrency, onEach) {
  let idx = 0;
  let active = 0;
  const results = [];
  return new Promise((resolve) => {
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

  let checkpointed = new Map();
  if (args.resume) {
    checkpointed = await loadCheckpoint(args.outDir);
    console.log(`\n--resume: found ${checkpointed.size} already-completed page/viewport result(s) in the checkpoint file.`);
  } else {
    archiveStaleCheckpoint(args.outDir);
  }

  const totalPageLoads = targetUrls.length * VIEWPORTS.length;
  console.log(`\nScanning ${targetUrls.length} pages x ${VIEWPORTS.length} viewports = ${totalPageLoads} page loads, concurrency=${args.concurrency}${args.nocache ? ', cache-busting ON' : ''}`);
  if (checkpointed.size) console.log(`${checkpointed.size} already done, ${totalPageLoads - checkpointed.size} remaining.`);

  const browser = await chromium.launch({ headless: true });

  const pageResults = [];
  const tasks = [];
  for (const url of targetUrls) {
    for (const viewport of VIEWPORTS) {
      const key = `${url}|||${viewport.name}`;
      if (checkpointed.has(key)) {
        pageResults.push(checkpointed.get(key));
        continue; // already scanned in a previous run - don't re-launch a browser for it
      }
      tasks.push(() =>
        scanOnePage(browser, url, viewport, { nocache: args.nocache }).then((result) => {
          appendCheckpoint(args.outDir, result);
          return result;
        })
      );
    }
  }

  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    console.log(`\n\nInterrupted. Progress so far is safely saved in ${checkpointPath(args.outDir)}.`);
    console.log(`Resume later with: node src/scan.js --resume${args.nocache ? ' --nocache' : ''}`);
    process.exit(130);
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  const startedAt = Date.now();
  const newResults = await runPool(tasks, args.concurrency, (done, total, result) => {
    const elapsedS = Math.round((Date.now() - startedAt) / 1000);
    const label = result && result.error ? `ERROR: ${result.error}` : 'ok';
    process.stdout.write(`[${done}/${total} new] (${elapsedS}s) ${label}\n`);
  });
  pageResults.push(...newResults);

  await browser.close();
  if (interrupted) return; // onInterrupt already exited the process

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

  // Run completed in full - the checkpoint file has done its job and would
  // otherwise confuse a future plain (non---resume) run into thinking there's
  // nothing left to do.
  const cp = checkpointPath(args.outDir);
  if (fs.existsSync(cp)) fs.unlinkSync(cp);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scanOnePage, aggregateByRule, VIEWPORTS, AXE_TAGS };
