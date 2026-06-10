import 'dotenv/config';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { extractDOM } from './domExtractor.js';
import { toolRegistry } from './tools.js';
import { createAdapter, Provider } from './llmAdapter.js';
import { HackerNewsLoginHandler } from './loginHandler.js';

// ── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a browser automation agent.
Your task is to upvote a story on Hacker News.
Go to https://news.ycombinator.com, find the top story, and click its upvote arrow.
Make sure to complete the task.`;

const START_URL = 'https://news.ycombinator.com';
const MAX_STEPS = 10;
const PROVIDER = (process.env.LLM_PROVIDER ?? 'anthropic') as Provider;

// ── Deterministic Harness Verifiers ──────────────────────────────────────────
// Pure functions — no LLM, no network. Check observable page state in code.

function isAuthWall(url: string): boolean {
  return /\/login|\/signin|\/auth|\/vote\?id=/.test(url);
}

function isErrorPage(title: string): boolean {
  return /\b(404|403|error|not found|forbidden|unauthorized)\b/i.test(title);
}

// Returns true if the last N URLs are all identical — agent is looping.
function isStuckLoop(urlHistory: string[], window = 3): boolean {
  if (urlHistory.length < window) return false;
  const tail = urlHistory.slice(-window);
  return tail.every(u => u === tail[0]);
}

// Called after done(). Checks final page state and prints PASSED / FAILED.
async function verifyOutcome(page: Page, agentReason: string, votedStoryId: string | null): Promise<void> {
  const url   = page.url();
  const title = await page.title();

  console.log('\n' + '═'.repeat(55));
  console.log('[VERIFY] Final page state:');
  console.log(`         URL:   ${url}`);
  console.log(`         Title: ${title || '(empty)'}`);
  console.log(`[VERIFY] Agent claimed: "${agentReason}"`);
  console.log('─'.repeat(55));

  if (isAuthWall(url)) {
    console.log('[VERIFY] FAILED — Blocked by authentication wall.');
    console.log('         The claimed action was never completed.');
  } else if (isErrorPage(title)) {
    console.log('[VERIFY] FAILED — Agent ended on an error page.');
  } else if (votedStoryId) {
    // DOM-state verification: HN removes the active upvote anchor once a vote is cast.
    // Navigate to the front page so the story is in the DOM, then check the link.
    await page.goto('https://news.ycombinator.com');
    await page.waitForLoadState('networkidle');
    // After voting, HN keeps the upvote <a> in the DOM but adds class="nosee"
    // (visually grayed out, no longer clickable). Only count links that are still
    // active — i.e. NOT carrying the nosee class.
    const activeVoteLinks = await page.locator(`a[href*="vote?id=${votedStoryId}&how=up"]:not(.nosee)`).count();
    if (activeVoteLinks > 0) {
      console.log(`[VERIFY] FAILED — Active upvote link still present for story ${votedStoryId}. Vote did not register.`);
    } else {
      console.log(`[VERIFY] PASSED — Upvote confirmed: vote link is nosee (voted) for story ${votedStoryId}.`);
    }
  } else {
    console.log('[VERIFY] PASSED — No known failure patterns detected.');
  }

  console.log('═'.repeat(55));
}

// ── Supervisor Loop ───────────────────────────────────────────────────────────
(async () => {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext();
    const page: Page = await context.newPage();
    console.log('[HARNESS] Browser ready.');

    // Adapter owns all LLM protocol details — message history, schema
    // translation, response parsing. The loop below is now provider-agnostic.
    const adapter = createAdapter(PROVIDER, SYSTEM_PROMPT);
    console.log(`[HARNESS] Provider: ${PROVIDER}\n`);

    await page.goto(START_URL);
    await page.waitForLoadState('networkidle');

    const urlHistory: string[] = [];

    // Interception gate — handles auth walls in harness code, invisible to the LLM.
    const loginHandler = new HackerNewsLoginHandler();
    let loginAttempted = false;
    let votedStoryId: string | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      console.log(`\n━━━ Step ${step + 1} / ${MAX_STEPS} ${'━'.repeat(40)}`);

      // ── 1. Observe ────────────────────────────────────────────────────────
      const url   = page.url();
      const title = await page.title();
      const tree  = await extractDOM(page);

      console.log(`[DOM] URL: ${url} | Title: ${title}`);

      // ── 2. Harness checks — run every step, before the LLM is consulted ──
      urlHistory.push(url);

      if (isAuthWall(url)) {
        // Extract story ID from vote URL for later DOM-state verification.
        const idMatch = url.match(/vote\?id=(\d+)/);
        if (idMatch) votedStoryId = idMatch[1];

        if (!loginAttempted && loginHandler.canHandle(url)) {
          loginAttempted = true;
          console.log('[HARNESS] Auth wall detected — attempting harness-driven login...');
          // Return to START_URL after login — the front page has authenticated vote
          // links (with auth= tokens). The unauthenticated URL we intercepted lacks
          // those tokens, so replaying it directly silently fails.
          const success = await loginHandler.login(page, START_URL);
          if (!success) {
            console.log('[HARNESS] Login failed. Cannot recover. Stopping.');
            break;
          }
          // If the auth wall was a vote redirect, click the authenticated upvote
          // link now that we're on the logged-in front page. The harness does this
          // in Playwright code — the LLM is not involved.
          if (votedStoryId) {
            console.log(`[HARNESS] Replaying upvote for story ${votedStoryId} via authenticated link...`);
            const voteLocator = page.locator(`a[href*="vote?id=${votedStoryId}&how=up"]`);
            if (await voteLocator.count() > 0) {
              await voteLocator.first().click();
              await page.waitForLoadState('networkidle');
              console.log('[HARNESS] Upvote replayed. Returning to front page.');
              await page.goto(START_URL);
              await page.waitForLoadState('networkidle');
            } else {
              console.log('[HARNESS] Upvote link not found — story may already be voted or off front page.');
            }
          }
          console.log('[HARNESS] Resuming task.');
          continue;  // skip LLM call; next iteration observes the logged-in page
        }
        console.log('[HARNESS] WARNING — Auth wall detected. No handler available or login already attempted.');
      }
      if (isStuckLoop(urlHistory)) {
        console.log('[HARNESS] STUCK — URL unchanged for 3 consecutive steps. Stopping.');
        break;
      }
      if (isErrorPage(title)) {
        console.log(`[HARNESS] ERROR PAGE — "${title}". Stopping.`);
        break;
      }

      // ── 3. Ask the LLM for the next action ───────────────────────────────
      // One call — adapter handles all provider-specific protocol internally.
      console.log(`[LLM] Asking ${PROVIDER} for next action...`);
      const { toolName, toolInput, reasoning } = await adapter.getNextAction({ url, title, tree });

      if (reasoning) console.log(`[LLM] Reasoning: ${reasoning}`);

      // ── 4. Handle the result ──────────────────────────────────────────────
      if (!toolName) {
        console.log('[HARNESS] FAILED — No tool call returned. Agent may be confused.');
        break;
      }

      console.log(`[LLM] Chose tool: ${toolName}(${JSON.stringify(toolInput)})`);

      if (toolName === 'done') {
        await verifyOutcome(page, String(toolInput['reason'] ?? ''), votedStoryId);
        break;
      }

      // ── 5. Execute via Tool Registry ──────────────────────────────────────
      const executor = toolRegistry[toolName];
      if (!executor) {
        console.log(`[HARNESS] FAILED — Unknown tool "${toolName}". Agent hallucinated a tool name.`);
        break;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await executor(page, toolInput as any);
      await page.waitForTimeout(1000);
    }

    if (urlHistory.length === MAX_STEPS) {
      console.log(`\n[HARNESS] FAILED — MAX_STEPS (${MAX_STEPS}) reached. Task incomplete.`);
    }

  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    console.log('\n[HARNESS] Browser closed.');
  }
})();
