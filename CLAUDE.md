## Agent Development Workflow

This project uses a permanent 3-agent improvement loop focused on **prompt engineering excellence**.

### Agents
- **@product-owner** — Analyzes prompt failures, writes precise specs with exact prompt changes needed (model: opus)
- **@developer** — Implements prompt changes, builds tests, verifies TypeScript compiles (model: sonnet)
- **@qa-tester** — Runs real browser + real AI tests, monitors action tag quality, feeds observations back to PO (model: sonnet)

### The Loop
```
PO writes spec → Developer implements → QA tests with real AI → PO analyzes QA report → repeat forever
```

The loop never stops. QA PASS = start next improvement cycle, not "done."

### Primary Focus: Prompt Engineering
All 3 agents center on `src/background/prompt-engine.ts` — the 4-band prompt system:
- **Band 1:** Action framework (identity, selector strategy, action types)
- **Band 2:** Page understanding (domain persona, intent-specific guidance, page context)
- **Band 3:** Output formatting (cloud models only)
- **Band 4:** Extended context (memory, user skills, sitemap)

### AI Models for Testing
Configured in `.env` (gitignored):
- **`gemini-2.5-flash-lite`** — default cloud model, fast + cheap (GEMINI_API_KEY in .env)
- **LM Studio `http://127.0.0.1:1234`** — local models (Gemma, etc.), zero cost, offline
- **Mock AI** — E2E regression tests, no API key needed

```bash
# Real AI — Gemini 2.5 Flash Lite
source .env && USE_REAL_AI=true npm test

# Real AI — LM Studio local (check running: curl http://127.0.0.1:1234/v1/models)
source .env && USE_REAL_AI=true PROVIDER=local npm test

# Mock AI regression tests
npm test

# Unit tests only
npm run test:unit

# Watch tests run live
npm run test:ui
```

### Monitoring Progress
```bash
# Queue status (what each item is at)
cat enhancements/_queue.json | python3 -m json.tool

# List all reports
ls -lt enhancements/done/

# Open last Playwright HTML report
open playwright-report/index.html

# Watch queue update in real time (second terminal)
watch -n 3 'cat enhancements/_queue.json'
```

### Submitting a Request
```
New [feature/bug/improvement]: <description>. Use @product-owner to spec it.
```

### Resume the Loop
```
@product-owner — review latest QA report and spec the next improvement
@qa-tester — test '<slug>' and feed back to PO
```

### Queue
Tracked in `enhancements/_queue.json`

### Quick Commands
- Start fresh: `"New request: <description>. @product-owner spec it, then @developer implement, then @qa-tester verify."`
- Check queue: `"Show me enhancements/_queue.json"`
- Next priority: `"What's the highest priority unfinished item in the queue?"`
- Full pipeline: `"Run the full agent pipeline on '<slug>'"`
- add more develper agents to acceelareate the development