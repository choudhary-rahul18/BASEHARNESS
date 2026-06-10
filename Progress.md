# BaseHarness — Progress Log

## Session 1 — 2026-06-11

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

### What's Next (Level 1 Ideas)
- Extract and print actual search result titles/URLs from the results page (scraping)
- Run multiple BrowserContexts in parallel — simulate multiple isolated users
- Persist a session (save/load cookies to a context)
- Add error handling with meaningful messages
