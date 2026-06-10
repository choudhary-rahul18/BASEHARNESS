# BaseHarness

A long-term "Agentic Harness" project. Each level adds a new layer of reliability to a browser automation agent powered by an LLM.

## Current Level: 1 — Naked Agent + Deterministic Verifiers + Harness Interception Gate

---

## Project Goal
Build a progressively hardened agentic harness where the LLM decides actions and the harness verifies outcomes in code — not by prompting, not by spawning a second LLM, but through deterministic software engineering techniques.

---

## Stack
- **TypeScript 5.x** with strict mode
- **Playwright 1.49+** for browser automation
- **ts-node** (ESM mode) as the TypeScript runner
- **@anthropic-ai/sdk** — Anthropic provider
- **dotenv** — env var loading
- **Node.js** — no build step needed, `npm start` runs directly

---

## Run
```bash
npm install
npx playwright install chromium   # first time only
npm start
```

---

## Project Structure
```
src/
  agent.ts          ← Supervisor Loop + deterministic verifiers + interception gate
  domExtractor.ts   ← Injects JS into browser via page.evaluate(), returns text tree
  tools.ts          ← Tool Registry: navigate / click / type / done
  llmAdapter.ts     ← Provider abstraction: AnthropicAdapter + OllamaAdapter
  loginHandler.ts   ← Harness Interception Gate: LoginHandler interface + HackerNewsLoginHandler
```

---

## Configuration (.env)
```
ANTHROPIC_API_KEY=...
OLLAMA_API_KEY=...
LLM_PROVIDER=anthropic        # or: ollama
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
OLLAMA_MODEL=ministral-3:3b
HN_USERNAME=...               # Hacker News login — used by loginHandler only, never passed to LLM
HN_PASSWORD=...
```
Swap `LLM_PROVIDER` to change the model backend. No code changes needed.

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

## Key Decisions

- **Verification is code, not LLM** — after `done()`, the harness checks DOM state (CSS classes, element presence) with Playwright. No second LLM call. Deterministic, free, fast.
- **Harness Interception Gate** — when an auth wall is hit, the harness pauses the loop, logs in via Playwright, replays the original action using the authenticated DOM link (`auth=` token), and resumes. Credentials never touch the LLM message history. No login tool in `toolSchemas`.
- **Adapter pattern for providers** — `LLMAdapter` interface hides all protocol differences. The supervisor loop is provider-agnostic.
- **System prompt carries the goal** — the harness is task-agnostic. Swap the prompt, not the code.
- **Harness guards run before LLM** — auth wall, stuck loop, and error page checks run every step before the LLM is consulted. The harness can stop the loop independently of the LLM's reasoning.
- **`page.evaluate()` bridge** — DOM extraction runs inside the browser's V8 engine. Only JSON-serialisable values (plain string) cross back to Node.js.
- **tool_use / tool_result pairing** — Anthropic's API requires a `tool_result` block immediately after every `tool_use`. Handled inside `AnthropicAdapter`, invisible to the loop.
- **DuckDuckGo over Google** — Google blocks Playwright via `navigator.webdriver`. DuckDuckGo does not.

---

## User Context
- User is experienced in Python, new to TypeScript — explain TypeScript concepts using Python analogues.
- Improvements to agent reliability go into harness code, not the system prompt.
- Do not add complexity beyond what is asked. Keep it minimal.
