// Site-specific page prep, run inside the Playwright page context before
// axe.run(). Each function is defensive (checks existence before acting) so
// a quirk that isn't present on a given page never throws the whole scan.
'use strict';

/**
 * Dismiss the Complianz cookie consent banner using its own exposed public
 * function (window.cmplz_set_banner_status) rather than trying to click a
 * button by selector - this is the same approach already verified working
 * elsewhere in this project's remediation work (its own official API,
 * survives Complianz's own re-renders).
 */
async function dismissCookieBanner(page) {
  await page.evaluate(() => {
    try {
      if (typeof window.cmplz_set_banner_status === 'function') {
        window.cmplz_set_banner_status('dismissed');
      }
    } catch (e) { /* no-op if it throws - banner may not exist on this page */ }
    // Belt-and-suspenders: force-hide it directly too, in case the function
    // call didn't fully remove it in time for this render.
    document.querySelectorAll('.cmplz-cookiebanner').forEach((el) => {
      el.style.setProperty('display', 'none', 'important');
    });
  });
}

/**
 * Hide the chat widget ("ANIbot" per the project brief - no such string
 * actually appears in the page's own source, so this targets it by its one
 * stable, literal id: #chat-bubble. Its wrapper div is a direct child of
 * <body> with a randomly-generated id per page load, so instead of
 * hardcoding that id, this walks up from #chat-bubble to whichever ancestor
 * is body's direct child and hides that whole subtree.
 */
async function hideChatWidget(page) {
  await page.evaluate(() => {
    const bubble = document.getElementById('chat-bubble');
    if (!bubble) return;
    let node = bubble;
    while (node.parentElement && node.parentElement !== document.body) {
      node = node.parentElement;
    }
    node.style.setProperty('display', 'none', 'important');
  });
}

/**
 * Trigger the site's lazy-loaded images (img.lazy / img[data-src], swapped
 * in by W3 Total Cache's lazyload.min.js via IntersectionObserver) by
 * scrolling the full page height in steps, then returning to the top.
 * Without this, axe either misses real alt-text issues on images that
 * never loaded, or flags the 1x1 SVG placeholder instead of the real image.
 */
async function triggerLazyLoad(page) {
  await page.evaluate(async () => {
    const step = Math.max(window.innerHeight, 400);
    const scrollHeight = () => document.body.scrollHeight;
    let y = 0;
    // Cap iterations defensively in case scrollHeight keeps growing (e.g. infinite scroll)
    for (let i = 0; i < 200 && y < scrollHeight(); i++) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
      y += step;
    }
    window.scrollTo(0, scrollHeight());
    await new Promise((r) => setTimeout(r, 300));
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 200));
  });
}

/**
 * Runs all page-prep quirks in the right order: cookie banner first (it
 * can block scroll/interaction), then lazy-load triggering (needs to
 * happen before axe evaluates image alt text), then hide the chat widget
 * last (cheap, order doesn't matter for this one).
 */
async function preparePage(page) {
  await dismissCookieBanner(page);
  await page.waitForTimeout(150);
  await triggerLazyLoad(page);
  await hideChatWidget(page);
}

module.exports = { dismissCookieBanner, hideChatWidget, triggerLazyLoad, preparePage };
