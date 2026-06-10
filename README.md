# BaseHarness

A progressively hardened agentic browser automation harness. Each level adds a new layer of reliability — not by improving the prompt, but through deterministic software engineering in the harness itself.

The core principle: **the LLM decides actions; the harness verifies outcomes in code.**

---

## What It Does

The harness launches a browser, gives an LLM a live view of the DOM at each step, executes whatever tool the LLM calls, and independently verifies the result. The LLM can hallucinate — the harness cannot be fooled by a hallucination.

Current task: upvote the top story on Hacker News.

---

## Stack

- **TypeScript 5.x** — strict mode
- **Playwright 1.49+** — browser automation
- **ts-node** (ESM) — runs TypeScript directly, no build step
- **@anthropic-ai/sdk** — Anthropic provider
- **dotenv** — env var loading

---

## Setup

```bash
npm install
npx playwright install chromium   # first time only
```

Create a `.env` file:

```
ANTHROPIC_API_KEY=...
OLLAMA_API_KEY=...
LLM_PROVIDER=anthropic        # or: ollama
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
OLLAMA_MODEL=ministral-3:3b
HN_USERNAME=your_hn_username
HN_PASSWORD=your_hn_password
```

```bash
npm start
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Supervisor Loop (agent.ts)                             │
│  while step < MAX_STEPS:                                │
│    1. Harness Checks (runs before LLM):                 │
│       • Auth wall? → Interception Gate (login + replay) │
│       • Stuck loop? → stop                              │
│       • Error page? → stop                              │
│    2. adapter.getNextAction() → tool call               │
│    3. Tool Registry → Playwright action                 │
│  after done(): verifyOutcome() → DOM-state check        │
└──────────────────────┬──────────────────────────────────┘
                       │
              ┌────────┴────────┐
              ▼                 ▼
       AnthropicAdapter    OllamaAdapter
```

---

## Project Structure

```
src/
  agent.ts          — Supervisor Loop, harness guards, verifier
  domExtractor.ts   — Injects JS into browser, returns text tree of interactive elements
  tools.ts          — Tool Registry: navigate / click / type / done
  llmAdapter.ts     — Provider abstraction: AnthropicAdapter + OllamaAdapter
  loginHandler.ts   — Harness Interception Gate: handles auth silently, invisible to LLM
```

---

## Levels

### Level 0 — BrowserContext Agent
Basic Playwright agent: `browser → context → page`. Hard-coded selectors.

### Level 1 — Naked Agent + Deterministic Verifiers
- All hard-coded selectors removed. LLM drives actions via a live DOM tree.
- `verifyOutcome()` — checks final page state in code after `done()`. PASSED/FAILED verdict.
- Mid-loop guards — `isAuthWall`, `isStuckLoop`, `isErrorPage` run before every LLM call.
- LLM Adapter Layer — swap between Anthropic and Ollama via `LLM_PROVIDER` env var.
- **Harness Interception Gate** — when auth wall detected, harness logs in silently, replays the original action via authenticated DOM link, resumes loop. Credentials never touch the LLM.

---

## Key Design Decisions

**Verification is code, not LLM.** After `done()`, the harness checks observable DOM state (CSS classes, element presence) with Playwright. No second LLM call. Deterministic, free, instantaneous.

**Harness Interception Gate for auth.** No login tool is exposed to the LLM. When an auth wall is hit, the harness pauses the loop, logs in via Playwright, replays the blocked action using the authenticated DOM link (which carries a session `auth=` token), and resumes. The LLM's message history skips the entire auth episode.

**Adapter pattern for providers.** `LLMAdapter` interface hides all protocol differences. Swap `LLM_PROVIDER=ollama` to switch models. The supervisor loop never changes.

**DOM tree as the LLM's eyes.** `domExtractor.ts` injects JS into the browser via `page.evaluate()`, stamps each interactive element with `data-index`, and returns a plain text tree. The LLM references elements by index; the Tool Registry finds them by `[data-index="N"]`.

**Harness guards run before LLM.** Every step, the harness checks page state before consulting the LLM. The harness can stop or redirect the loop independently of the LLM's reasoning.

---

## Security Properties

- Credentials (`HN_USERNAME`, `HN_PASSWORD`) exist only in `process.env` — never in the LLM's message array
- No login tool in `toolSchemas` — prompt injection cannot extract credentials via a tool call argument
- Auth wall URL is never sent to the LLM as an observation — harness intercepts between steps
