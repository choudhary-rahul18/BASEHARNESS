import { chromium, Browser, BrowserContext, Page } from 'playwright';

// TypeScript equivalent of Python's: if __name__ == "__main__": asyncio.run(main())
// An async IIFE (Immediately Invoked Function Expression) — defines AND calls the function at once.
(async () => {
  // Declare outside the try block so finally block can reach them for cleanup.
  // TypeScript requires explicit types here because they're assigned inside try.
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    // ── Phase 1: Environment Setup ────────────────────────────────────────────

    // Launch the Chromium browser process. headless:false = visible window.
    // In Python/Playwright this would be: browser = await async_playwright().__aenter__()...
    browser = await chromium.launch({ headless: false });
    console.log('[1/3] Browser launched.');

    // Create a clean, isolated session sandbox — no cookies, no history.
    // This is the core concept: BrowserContext = one isolated "user session".
    context = await browser.newContext();
    console.log('[2/3] Context created (clean sandbox, no prior session data).');

    // Open a tab inside that context. Every page belongs to exactly one context.
    const page: Page = await context.newPage();
    console.log('[3/3] Page opened.');

    // ── Phase 2: Browser Interaction ──────────────────────────────────────────

    // Navigate to DuckDuckGo. goto() waits for the page's initial network events to settle.
    // Using DuckDuckGo instead of Google — Google blocks automated browsers via navigator.webdriver detection.
    await page.goto('https://duckduckgo.com');
    console.log('Navigated to DuckDuckGo.');

    // DuckDuckGo uses a plain <input name="q">, not a <textarea> like Google.
    // Same CSS selector pattern, different element type.
    const searchBox = page.locator('input[name="q"]');
    await searchBox.fill('Latest news on Indian Stock Market');
    console.log('Query filled.');

    // Submit the search by simulating the Enter key — no need to find the button.
    await searchBox.press('Enter');
    console.log('Search submitted. Waiting for results...');

    // Wait for results to load, then pause so you can see them on screen.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);
    console.log('Done. Tearing down...');

    // ── Phase 3: Teardown ─────────────────────────────────────────────────────
    // These also run in the finally block — see below.

  } finally {
    // finally always runs — even if an error was thrown above.
    // This prevents browser processes from leaking if something goes wrong mid-run.
    if (context) await context.close();  // Destroys session: cookies, localStorage, etc.
    if (browser) await browser.close();  // Releases the Chromium OS process.
    console.log('Browser closed. Goodbye.');
  }
})();
