# BaseHarness — Progress Log

## Session 1 — 2026-06-10

### What We Built
A working TypeScript + Playwright browser automation agent from an empty directory.
The agent launches a browser, creates an isolated BrowserContext, searches DuckDuckGo for
"Latest news on Indian Stock Market", waits 5 seconds on the results page, then tears down cleanly.

---

### Files Created
| File | Purpose |
|---|---|
| `package.json` | Project manifest, dependencies, `npm start` script |
| `tsconfig.json` | TypeScript compiler config (strict, ESNext, ESM) |
| `src/agent.ts` | The browser agent — all logic lives here |
| `CLAUDE.md` | Project context for Claude Code sessions |

---

### Concepts Learned

#### BrowserContext — The Core Idea
- `browser.newContext()` creates an **isolated session sandbox** — no cookies, no history, no shared state.
- This is the foundational primitive for the Agentic Harness: one context = one isolated "user session".
- Never skip it and use `browser.newPage()` directly — that page shares a default context with all other direct pages.

#### The 3-Phase Agent Pattern
```
Phase 1 — Setup:     chromium.launch() → browser.newContext() → context.newPage()
Phase 2 — Interact:  page.goto() → page.locator() → .fill() → .press('Enter')
Phase 3 — Teardown:  context.close() → browser.close()
```

#### TypeScript Concepts
- **Async IIFE** `(async () => { ... })()` — equivalent to Python's `asyncio.run(main())`
- **`try/finally`** — teardown always runs even if an error is thrown mid-run (same as Python)
- **Explicit types** — variables declared before `try` must be typed explicitly: `let browser: Browser | null = null`
- **No venv needed** — `npm install` creates a local `node_modules/` folder; dependencies are local by default

#### Locator — Lazy DOM Pointer
- `page.locator('input[name="q"]')` does NOT search the DOM immediately
- The actual search happens only when an action is called (`.fill()`, `.press()`, etc.)
- Playwright re-queries the DOM on each action — resilient to dynamic page changes

---

### Issues Hit & Resolved

| Issue | Cause | Fix |
|---|---|---|
| Google reCAPTCHA | Playwright sets `navigator.webdriver = true`; Google detects this | Switched to DuckDuckGo |
| Tried `channel: 'chrome'` | Real Chrome still has `navigator.webdriver` set by Playwright | Reverted; not needed for DuckDuckGo |

**Key insight:** Google is uniquely aggressive about bot detection. For automation learning,
DuckDuckGo is the correct target — identical concepts, no CAPTCHA arms race.

---

---

## Session 2 — 2026-06-11

### What We Built
A dynamic AI agent — the "Naked Agent". All hard-coded selectors removed. The harness now:
1. Injects a DOM extractor into the live browser to produce a text tree of visible interactive elements
2. Sends that text tree + the current URL/title to Claude via the Anthropic API
3. Parses Claude's tool call and executes it via a Tool Registry
4. Loops until Claude calls `done()` or MAX_STEPS is hit

The system prompt carries the goal. The harness code is generic — swapping the prompt changes the task entirely.

---

### Files Created / Changed
| File | Purpose |
|---|---|
| `src/domExtractor.ts` | Injects JS into the browser via `page.evaluate()`, stamps elements with `data-index`, returns a clean text tree |
| `src/tools.ts` | Tool Registry: maps `navigate` / `click` / `type` / `done` to Playwright actions. Also exports tool schemas for the Claude API. |
| `src/agent.ts` | Full rewrite: Supervisor Loop with conversation history, tool dispatch, MAX_STEPS cap |
| `.env` | Stores `ANTHROPIC_API_KEY` — excluded from git via `.gitignore` |

---

### Architecture: The 3-Subsystem Pattern
```
┌─────────────────────────────────────────────┐
│  Supervisor Loop (agent.ts)                 │
│  while step < MAX_STEPS:                    │
│    1. DOM Extractor  → text tree            │
│    2. Claude API     → tool call            │
│    3. Tool Registry  → Playwright action    │
└─────────────────────────────────────────────┘
```

---

### Concepts Learned

#### `page.evaluate()` — The Bridge
- Your TypeScript runs in Node.js. The browser runs its own V8 engine. They cannot share memory.
- `page.evaluate(fn, arg?)` serialises `arg` as JSON → injects into browser → runs `fn` → serialises return value back.
- **Critical constraint:** only JSON-serialisable values can cross — no DOM nodes, no functions, no Playwright objects.
- The DOM Extractor returns a plain `string` — that's why it works.

#### Claude API — Multi-Turn Tool Use Protocol
- Every `tool_use` block in an assistant message **must** be followed by a `tool_result` block in the very next user message.
- Sending a plain observation without closing the tool pair causes a `400 BadRequestError`.
- Fix: combine `tool_result` + new observation into a single user message as a content array.

#### Parametric Knowledge vs. Live Observation
- The LLM brings "world knowledge" baked in from training. It recognised the HN login redirect from the URL pattern + blank page title — not from explicit DOM inspection.
- This makes the agent appear smart, but it also enables confident hallucination: the model can assert success based on prior knowledge rather than verifying actual page state.

#### Token Growth in Multi-Turn Loops
- Each API call sends the **full conversation history**.
- Call N carries N×2 messages. Cost and context window usage grow linearly with steps.
- Long tasks will eventually hit the model's context limit — future levels need history pruning or summarisation.

---

### Test Runs

#### Test 1 — DuckDuckGo Search (MAX_STEPS=5)
- Step 1: `click(1)` — focused search box (wasted step; `type()` didn't need it)
- Step 2: `type(1, "Latest news on Indian Stock Market")` — query submitted
- Step 3: `done(...)` — Claude saw results page, wrote summary, terminated correctly
- **Result:** Task completed in 3/5 steps. Agent called `done()` on its own. ✅

#### Test 2 — Hacker News Upvote (MAX_STEPS=10)
- Step 1: `click(10)` — clicked the upvote arrow
- Step 2: URL redirected to `vote?id=...&how=up&goto=news` (HN login wall). Claude navigated back.
- Step 3: `done(...)` — "upvote was attempted but login is required"
- **Result:** Task failed — no login session. The harness accepted `done()` without verifying anything. ❌

---

### Failure Modes Observed (Naked Agent)

| # | Failure Mode | What Happened | Why It's a Problem |
|---|---|---|---|
| 1 | **Wasted steps** | Agent clicked to focus a box before typing, when `type()` handles focus itself | Burns budget; in a 2-step run this caused task failure |
| 2 | **Blind acceptance of `done()`** | Harness closed the browser the moment Claude said done — no verification | Agent can hallucinate success and the harness will never know |
| 3 | **No session awareness** | Agent hit an auth wall, reported failure, but couldn't recover | Harness has no concept of login state or how to acquire it |
| 4 | **Step counter as only guard** | The only thing preventing an infinite loop is MAX_STEPS | No semantic understanding of "is the agent making progress?" |

---

### What Level 2 Needs to Fix (in code, not in the prompt)

The core principle: **the harness must verify outcomes in code. It cannot trust the LLM's self-report.**

| Problem | Level 2 Fix |
|---|---|
| Harness blindly accepts `done()` | After `done()`, harness checks page state in code to confirm goal was actually reached |
| No auth/session handling | Harness detects login redirects by URL pattern and either injects credentials or flags as unrecoverable |
| Wasted steps not detected | Harness tracks URL + DOM fingerprint across steps; if nothing changed, flag as a stuck loop |
| No progress signal | Harness scores each step: did the URL change? Did a key element appear/disappear? If N steps pass with no change → intervene |
