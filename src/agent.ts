import 'dotenv/config';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import { extractDOM } from './domExtractor.js';
import { toolRegistry, toolSchemas } from './tools.js';

// ── System Prompt ─────────────────────────────────────────────────────────────
// This is the only place that describes the task.
// The harness code below is intentionally generic — it knows nothing about
// DuckDuckGo or stock markets. Swap this prompt to run a completely different task.
const SYSTEM_PROMPT = `You are a browser automation agent.
Your task is to upvote a story on Hacker News.
Go to https://news.ycombinator.com, find the top story, and click its upvote arrow.`;

const START_URL = 'https://news.ycombinator.com';
const MAX_STEPS = 10; // Safety cap — this is a naked agent with no other guardrails.

// ── Anthropic client ──────────────────────────────────────────────────────────
// Reads ANTHROPIC_API_KEY from the environment automatically.
const client = new Anthropic();

// ── Supervisor Loop ───────────────────────────────────────────────────────────
(async () => {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    // ── Phase 1: Browser Setup ────────────────────────────────────────────────
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext();
    const page: Page = await context.newPage();
    console.log('[HARNESS] Browser ready.\n');

    await page.goto(START_URL);
    await page.waitForLoadState('networkidle');

    // ── Phase 2: Supervisor Loop ──────────────────────────────────────────────
    // messages accumulates every user + assistant turn.
    // We send the full history on every API call so Claude remembers prior actions.
    // Python analogy: a growing list of dicts passed to the API each iteration.
    const messages: Anthropic.MessageParam[] = [];

    // Claude's API rule: after every tool_use block in an assistant message,
    // the very next user message MUST contain a matching tool_result block.
    // We track the last tool call's ID so we can prepend that result.
    let lastToolCallId: string | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      console.log(`\n━━━ Step ${step + 1} / ${MAX_STEPS} ${'━'.repeat(40)}`);

      // ── 1. Observe: extract the current page state ────────────────────────
      const url   = page.url();
      const title = await page.title();
      const tree  = await extractDOM(page);

      console.log(`[DOM] URL: ${url} | Title: ${title}`);

      // ── 2. Build the user turn ────────────────────────────────────────────
      // The observation text describes what the harness currently sees.
      const observationText =
        `Current URL: ${url}\n` +
        `Page title: ${title}\n\n` +
        `Interactive elements on the page:\n${tree}`;

      if (lastToolCallId) {
        // From step 2 onward: combine tool_result + new observation in ONE user message.
        // Claude requires tool_result to immediately follow tool_use — they cannot be
        // in separate messages. Anthropic.MessageParam content can be an array of blocks.
        messages.push({
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: lastToolCallId, content: 'Action executed successfully.' },
            { type: 'text', text: observationText },
          ],
        });
      } else {
        // Step 1: no prior tool call, plain text observation is fine.
        messages.push({ role: 'user', content: observationText });
      }

      // ── 3. Call the LLM ───────────────────────────────────────────────────
      console.log('[LLM] Sending page state to Claude...');
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
        tools: toolSchemas,
      });

      // ── 4. Parse the response ─────────────────────────────────────────────
      // response.content is an array of blocks — either 'text' (reasoning) or
      // 'tool_use' (the action Claude decided to take).
      let toolCallBlock: Anthropic.ToolUseBlock | null = null;

      for (const block of response.content) {
        if (block.type === 'text') {
          console.log(`[LLM] Reasoning: ${block.text}`);
        } else if (block.type === 'tool_use') {
          toolCallBlock = block;
        }
      }

      // Save Claude's response into history so the next turn has full context.
      messages.push({ role: 'assistant', content: response.content });

      // ── 5. Handle the tool call ───────────────────────────────────────────
      if (!toolCallBlock) {
        // No tool call returned — naked-agent failure mode #1.
        console.log('[HARNESS] No tool call in response. Stopping.');
        break;
      }

      const toolName  = toolCallBlock.name;
      const toolInput = toolCallBlock.input as Record<string, unknown>;
      console.log(`[LLM] Chose tool: ${toolName}(${JSON.stringify(toolInput)})`);

      // 'done' is a termination signal, not a Playwright action.
      if (toolName === 'done') {
        console.log(`\n[HARNESS] Agent finished. Reason: "${toolInput['reason']}"`);
        break;
      }

      // ── 6. Execute via Tool Registry ──────────────────────────────────────
      const executor = toolRegistry[toolName];
      if (!executor) {
        // Hallucinated a tool that doesn't exist — naked-agent failure mode #2.
        console.log(`[HARNESS] Unknown tool "${toolName}". Stopping.`);
        break;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await executor(page, toolInput as any);

      // Remember this tool call's ID — next iteration must return tool_result for it.
      lastToolCallId = toolCallBlock.id;

      // Let the page settle before the next observation.
      await page.waitForTimeout(1000);
    }

  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    console.log('\n[HARNESS] Browser closed.');
  }
})();
