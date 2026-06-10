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

---

## Session 3 — 2026-06-11

### What We Built
Three additions on top of the Naked Agent:

1. **Deterministic Verifier** — after `done()`, the harness checks final page state in code (URL regex, title regex) and prints an explicit `PASSED / FAILED` verdict. No second LLM call — pure software engineering.
2. **Mid-loop Guards** — every step, before the LLM is consulted, the harness runs: auth wall detector, stuck loop detector, error page detector.
3. **LLM Adapter Layer** — a provider abstraction that lets the supervisor loop swap between Anthropic and Ollama by changing one env var (`LLM_PROVIDER`). The loop has zero knowledge of which provider is active.

---

### Files Created / Changed
| File | Purpose |
|---|---|
| `src/llmAdapter.ts` | NEW: Adapter pattern — `AnthropicAdapter` and `OllamaAdapter` behind a single `LLMAdapter` interface. `createAdapter(provider, systemPrompt)` factory. |
| `src/agent.ts` | Added verifiers (`isAuthWall`, `isErrorPage`, `isStuckLoop`, `verifyOutcome`). Replaced all Anthropic-specific LLM code with `adapter.getNextAction()`. |
| `.env` | Added `OLLAMA_API_KEY` and `LLM_PROVIDER` |

---

### Architecture: Updated with Adapter Layer
```
┌──────────────────────────────────────────────────┐
│  Supervisor Loop (agent.ts)                      │
│  while step < MAX_STEPS:                         │
│    1. Harness Checks (auth wall, stuck, error)   │
│    2. adapter.getNextAction() → tool call        │
│    3. Tool Registry → Playwright action          │
│  after done(): verifyOutcome() → PASSED/FAILED   │
└─────────────────┬────────────────────────────────┘
                  │
         ┌────────┴────────┐
         ▼                 ▼
  AnthropicAdapter    OllamaAdapter
  (Anthropic SDK,     (fetch to ollama.com/api/chat,
   tool_use blocks,    tool_calls array,
   tool_result IDs)    no ID pairing)
```

---

### Key Design Principle Established
**Verification must be code, not LLM.** Using a second LLM to verify the first LLM adds cost, latency, and another failure point. The harness verifies by checking observable, measurable state — URL patterns, page titles, DOM presence — the same way a traditional software test would.

---

### Concepts Learned

#### Adapter Pattern
- A thin abstraction that normalises different provider APIs into one interface.
- The loop calls `adapter.getNextAction({ url, title, tree })` and gets back `{ toolName, toolInput, reasoning }`.
- Each adapter owns its own message history, schema translation, and response parsing internally.
- Adding a new provider = one new class + one line in the factory. The loop never changes.

#### Transition-Based vs State-Based Checking
- State-based: "what URL am I on?" — can't distinguish blocked from passing through.
- Transition-based: "what action caused this URL?" — needs `(prev_action, current_url)` pair.
- The harness records every dispatched tool call, giving it ground truth for transition checks.

#### Why LLM Behaviour Cannot Be a Safety Mechanism
- Claude (Anthropic Haiku) gracefully reported failure at the auth wall — because its training told it to stop at authorization barriers without credentials.
- Ministral 3B hallucinated success at the same wall — claimed "Successfully upvoted" while sitting on `vote?id=...`.
- The harness produced `FAILED` for both. Swapping models changed the agent's behaviour; it did not change the harness verdict.

---

### Test Runs

#### Test 3 — HN Upvote, Anthropic Haiku, with verifier + "Make sure to complete the task" prompt
- Step 1: `click(10)` — upvote arrow clicked
- Step 2: Auth wall URL. Harness warned. Claude called `done("login required — task incomplete")`.
- Verifier: `FAILED — Blocked by authentication wall.`
- **Result:** Agent was honest; harness correctly confirmed failure. ✅ Verifier working.

#### Test 4 — HN Upvote, Ministral 3B (Ollama), with verifier
- Step 1: `click(10)` — upvote arrow clicked
- Step 2: Auth wall URL. Harness warned. Ministral called `done()` with hallucinated success AND malformed JSON (`"reason: The top story..."` as key instead of `"reason"`).
- Verifier: `FAILED — Blocked by authentication wall.` (regardless of malformed claim)
- **Key finding:** Small model (3B) hallucinated success + produced structurally broken tool call JSON. Harness caught it anyway.

---

### Failure Modes — Updated

| # | Failure Mode | Observed In | Harness Response |
|---|---|---|---|
| Wasted steps | Anthropic — clicked before typing | Warning log only (no guard yet) |
| Blind `done()` acceptance | Fixed — `verifyOutcome()` runs on every `done()` | PASSED/FAILED verdict |
| Auth wall undetected | Fixed — `isAuthWall()` runs every step | WARNING log + caught in verifier |
| Stuck loop | Fixed — `isStuckLoop()` runs every step | Stops loop after 3 identical URLs |
| Hallucinated success | Ministral 3B — claimed upvote succeeded | Verifier overruled it: FAILED |
| Malformed tool call JSON | Ministral 3B — key contained value text | `toolInput['reason']` was undefined; harness didn't crash |

---

## Session 4 — 2026-06-11

### What We Built
The **Harness Interception Gate** — a login middleware that handles authentication entirely in deterministic Playwright code. The LLM has no login tool, no knowledge of credentials, and never sees the auth wall URL in its message history.

---

### Files Created / Changed
| File | Purpose |
|---|---|
| `src/loginHandler.ts` | NEW: `LoginHandler` interface + `HackerNewsLoginHandler`. Reads credentials from `process.env` directly inside `.fill()` calls — never assigned to a named variable. |
| `src/agent.ts` | Added interception gate: when auth wall detected, harness logs in, replays upvote via authenticated DOM link, then resumes loop. Added `votedStoryId` tracking and DOM-state verifier. |

---

### Architecture: Updated with Interception Gate
```
┌──────────────────────────────────────────────────────────┐
│  Supervisor Loop (agent.ts)                              │
│  while step < MAX_STEPS:                                 │
│    1. Harness Checks:                                    │
│       • Auth wall detected?                              │
│           → loginHandler.login(page, START_URL)          │
│           → replay upvote via authenticated DOM link     │
│           → continue (LLM skips this step entirely)      │
│       • Stuck loop / error page → stop                   │
│    2. adapter.getNextAction() → tool call                │
│    3. Tool Registry → Playwright action                  │
│  after done(): verifyOutcome() → DOM-state check         │
└──────────────────────────────────────────────────────────┘
```

---

### Key Design Principle Established
**Smart harness + dumb LLM > dumb harness + smart LLM.**

Ministral 3B (a 3B-parameter model) completed the task correctly today. The same model hallucinated success in Session 3. The difference: the harness now handles every critical action deterministically. The LLM only had to identify the upvote arrow — the rest was code.

---

### Security Guarantees of the Interception Gate
1. Credentials read from `process.env` directly in `.fill()` — never stored in a named variable during LLM calls
2. No `login` tool in `toolSchemas` — prompt injection cannot cause credential leakage via a tool call argument
3. LLM message history skips the auth wall URL entirely — harness intercepts before `getNextAction()` is called
4. `tool_result` the LLM sees: `"Action executed successfully."` — no mention of login, credentials, or auth walls

---

### Concepts Learned

#### HN Vote URL Has a Session-Specific `auth=` Token
- Unauthenticated vote URL: `vote?id=48480978&how=up&goto=news`
- Authenticated vote URL: `vote?id=48480978&how=up&auth=a3f9bc...&goto=news`
- Replaying the unauthenticated URL after login silently fails — HN rejects it without error
- Fix: after login, read the live DOM for the authenticated link and click it via Playwright

#### HN Signals "Voted" via CSS Class, Not DOM Removal
- After voting, HN adds `class="nosee"` to the upvote `<a>` tag — doesn't remove the element
- Checking for the element's presence always returns true, voted or not
- Correct verifier: `a[href*="vote?id=...&how=up"]:not(.nosee)` — only counts visible, clickable links

#### Two Forms with Identical `name=` Attributes
- HN's login page has two forms (login + create account) both with `input[name="acct"]`
- Playwright's strict mode rejects locators that resolve to multiple elements
- Fix: `.first()` scopes to the login form, which is always first in the DOM

#### Transition from URL-Based to DOM-State Verification
- URL check (`isAuthWall`) detects failure categories
- DOM-state check (`nosee` class) confirms actual task completion
- These are different layers: URL tells you where you are; DOM tells you what happened

---

### Bugs Hit & Fixed (Session 4)

| Bug | Cause | Fix |
|---|---|---|
| `locator.fill: strict mode violation` | HN login page has two forms with `name="acct"` | `.first()` on all login locators |
| Vote never registered after login | Unauthenticated vote URL lacks `auth=` token | Read live DOM post-login; click authenticated link |
| Verifier false negative (`FAILED` on real success) | HN keeps upvote `<a>` with `nosee` class after voting | `:not(.nosee)` in verifier selector |

---

### Test Runs

#### Test 5 — HN Upvote, Ministral 3B (Ollama), with Interception Gate
- Step 1: `click(10)` — upvote arrow clicked (logged out)
- Step 2: Auth wall URL. **Harness intercepted.** Logged in → found authenticated vote link → clicked it → returned to front page. LLM was not called this step.
- Step 3: LLM saw logged-in HN page → called `done("Upvoted...")`
- Verifier: navigated to front page → `a[href*="vote?id=48480978&how=up"]:not(.nosee)` → count = 0 → `PASSED`
- **Confirmed in browser:** Upvote registered on the actual HN account. ✅
- **Key result:** Ministral 3B succeeded because the harness handled every critical action. The LLM only picked the right element.

---

### Failure Modes — Updated

| # | Failure Mode | Harness Response |
|---|---|---|
| Blind `done()` acceptance | Fixed — `verifyOutcome()` with DOM-state check | PASSED/FAILED via `:not(.nosee)` selector |
| Auth wall — login required | Fixed — Interception Gate logs in silently | Credentials never touch LLM |
| Auth wall — `auth=` token missing | Fixed — Harness reads authenticated link from live DOM | Upvote replayed correctly |
| Stuck loop | Fixed — `isStuckLoop()` runs every step | Stops after 3 identical URLs |
| Hallucinated success | Harness overrules LLM claim | DOM-state verifier is ground truth |
