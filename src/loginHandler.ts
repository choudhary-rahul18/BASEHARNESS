import { Page } from 'playwright';

// ── LoginHandler interface ────────────────────────────────────────────────────
// The harness calls canHandle() to find the right handler for the current site,
// then calls login() to perform the full auth flow in Playwright code.
// The LLM has no knowledge of this interface or the login flow — it is invisible
// to the message history sent to the API.
export interface LoginHandler {
  canHandle(url: string): boolean;
  login(page: Page, returnUrl: string): Promise<boolean>;
}

// ── HackerNewsLoginHandler ────────────────────────────────────────────────────
// Handles authentication for news.ycombinator.com.
//
// Security contract:
//   - Credentials are read from process.env directly inside .fill() calls.
//   - They are never assigned to a named variable in this module's scope.
//   - They are never passed as arguments to any function the LLM can invoke.
//   - Nothing in this file is ever added to the LLM's messages array.
export class HackerNewsLoginHandler implements LoginHandler {

  canHandle(url: string): boolean {
    return url.includes('news.ycombinator.com');
  }

  async login(page: Page, returnUrl: string): Promise<boolean> {
    // Guard: refuse to proceed if credentials are missing — fail loudly, not silently.
    if (!process.env.HN_USERNAME || !process.env.HN_PASSWORD) {
      console.log('[LOGIN] Missing HN_USERNAME or HN_PASSWORD in env. Cannot log in.');
      console.log('[LOGIN] Add both to your .env file and restart.');
      return false;
    }

    console.log('[LOGIN] Navigating to HN login page...');
    await page.goto('https://news.ycombinator.com/login');
    await page.waitForLoadState('networkidle');

    // Fill credentials directly from process.env — no intermediate variable.
    // This ensures the credential strings never exist as named values anywhere
    // in scope during LLM calls.
    // HN's login page has two forms (login + create account) with identical field names.
    // .first() scopes to the login form, which is always the first one in the DOM.
    await page.locator('input[name="acct"]').first().fill(process.env.HN_USERNAME);
    await page.locator('input[name="pw"]').first().fill(process.env.HN_PASSWORD);
    await page.locator('input[type="submit"]').first().click();
    await page.waitForLoadState('networkidle');

    // Verify: if still on the login page, credentials were wrong.
    if (page.url().includes('/login')) {
      console.log('[LOGIN] FAILED — Still on login page. Check HN_USERNAME / HN_PASSWORD.');
      return false;
    }

    console.log('[LOGIN] SUCCESS — Logged in to HN. Returning to task URL.');
    await page.goto(returnUrl);
    await page.waitForLoadState('networkidle');
    return true;
  }
}
