import 'dotenv/config';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { extractDOM } from './domExtractor.js';
import { toolRegistry } from './tools.js';
import { createAdapter, Provider } from './llmAdapter.js';

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
async function verifyOutcome(page: Page, agentReason: string): Promise<void> {
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
        console.log('[HARNESS] WARNING — Auth wall detected. Letting agent continue...');
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
        await verifyOutcome(page, String(toolInput['reason'] ?? ''));
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
