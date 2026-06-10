# BaseHarness

Level 0 of a long-term "Agentic Harness" application. Teaches Playwright's BrowserContext API using TypeScript.

## Project Goal
A browser automation agent that searches DuckDuckGo for "Latest news on Indian Stock Market" using an isolated BrowserContext session.

## Stack
- **TypeScript 5.x** with strict mode
- **Playwright 1.49+** for browser automation
- **ts-node** (ESM mode) as the TypeScript runner
- **Node.js** — no build step needed, `npm start` runs directly

## Run
```bash
npm install
npx playwright install chromium   # first time only
npm start
```

## Project Structure
```
src/agent.ts    ← the only source file; all agent logic lives here
package.json
tsconfig.json
```

## Key Decisions
- **DuckDuckGo over Google** — Google blocks Playwright via `navigator.webdriver` detection. DuckDuckGo does not.
- **`browser.newContext()` explicitly** — never use `browser.newPage()` directly; the context is the session isolation boundary.
- **`try/finally` for teardown** — ensures `context.close()` and `browser.close()` always run, even on errors.
- **Top-level async IIFE** — TypeScript's equivalent of Python's `asyncio.run(main())`.

## User Context
- User is experienced in Python, new to TypeScript — explain TypeScript concepts using Python analogues.
- This project is intentionally minimal. Do not add complexity beyond what is asked.
