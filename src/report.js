// Turns the JSON report into a human-readable Markdown summary, ranked by
// instance count - mirrors the "Where to start" view used to plan
// remediation tracks from the Rocket Validator report.
'use strict';

const fs = require('fs');

function topAffectedPages(rule, n = 5) {
  const byUrl = new Map();
  for (const p of rule.affectedPages) {
    const key = p.url;
    if (!byUrl.has(key)) byUrl.set(key, { url: key, count: 0, viewports: new Set() });
    const entry = byUrl.get(key);
    entry.count += p.count;
    entry.viewports.add(p.viewport);
  }
  return Array.from(byUrl.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, n)
    .map((e) => `${e.url} (${e.count}, ${Array.from(e.viewports).join('+')})`);
}

function writeSummaryMarkdown(jsonReport, outPath) {
  const lines = [];
  lines.push('# axe-core scan summary');
  lines.push('');
  lines.push(`- Scanned at: ${jsonReport.scannedAt}`);
  lines.push(`- Pages scanned: ${jsonReport.pagesScanned}`);
  lines.push(`- Page loads completed: ${jsonReport.pageLoadsScanned} (viewports: ${jsonReport.viewportsScanned.join(', ')})`);
  if (jsonReport.pageLoadsFailed) lines.push(`- Page loads failed: ${jsonReport.pageLoadsFailed} (see JSON/console log for URLs)`);
  lines.push(`- WCAG tags: ${jsonReport.axeTags.join(', ')}`);
  lines.push('');
  lines.push(`## Rules found, ranked by instance count (${jsonReport.byRule.length} distinct rules)`);
  lines.push('');
  lines.push('| Rule | Impact | WCAG | Instances | Pages affected | Top pages |');
  lines.push('|---|---|---|---|---|---|');

  for (const rule of jsonReport.byRule) {
    const uniquePages = new Set(rule.affectedPages.map((p) => p.url)).size;
    const wcag = rule.wcagTags.filter((t) => t !== 'wcag2a' && t !== 'wcag2aa').join(', ') || rule.wcagTags.join(', ');
    const topPages = topAffectedPages(rule).join('<br>');
    lines.push(`| [${rule.ruleId}](${rule.helpUrl}) | ${rule.impact || '-'} | ${wcag} | ${rule.totalInstances} | ${uniquePages} | ${topPages} |`);
  }

  lines.push('');
  lines.push('## Rule details');
  lines.push('');
  for (const rule of jsonReport.byRule) {
    lines.push(`### ${rule.ruleId} (${rule.totalInstances} instances, impact: ${rule.impact || 'n/a'})`);
    lines.push('');
    lines.push(rule.description);
    lines.push('');
    lines.push(`WCAG: ${rule.wcagTags.join(', ')} — [axe-core docs](${rule.helpUrl})`);
    lines.push('');
    lines.push('| Page | Viewport | Count | Example selectors |');
    lines.push('|---|---|---|---|');
    const shown = rule.affectedPages.slice(0, 20);
    for (const p of shown) {
      const exampleSelectors = p.selectors.slice(0, 3).join('; ');
      lines.push(`| ${p.url} | ${p.viewport} | ${p.count} | \`${exampleSelectors}\` |`);
    }
    if (rule.affectedPages.length > shown.length) {
      lines.push(`| ... | | | ${rule.affectedPages.length - shown.length} more page/viewport rows in the JSON |`);
    }
    lines.push('');
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
}

module.exports = { writeSummaryMarkdown };
