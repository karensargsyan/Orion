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
Configured in `.env` (copy from `.env.example`):
- **`gemini-2.0-flash-exp`** — Google AI Studio cloud model, fast + cheap (GEMINI_API_KEY in .env)
- **LM Studio `http://127.0.0.1:1234`** — local models (Gemma, Llama, etc.), zero cost, offline
- **Mock AI** — E2E regression tests, no API key needed

#### Setup Real AI Testing

1. **Copy environment template:**
   ```bash
   cp .env.example .env
   ```

2. **Get API keys:**
   - Gemini: https://aistudio.google.com/app/apikey
   - OpenAI (future): https://platform.openai.com/api-keys

3. **Fill in `.env`:**
   ```bash
   GEMINI_API_KEY=your_actual_key_here
   ```

#### Running Tests

```bash
# Mock AI regression tests (default, no .env needed)
npm test

# Real AI — Gemini (cloud)
source .env && USE_REAL_AI=true npm test
source .env && USE_REAL_AI=true PROVIDER=gemini npm test

# Real AI — LM Studio (local, requires LM Studio running)
# 1. Start LM Studio: lmstudio server start
# 2. Load a model (gemma-2-9b-it recommended)
# 3. Run tests:
source .env && USE_REAL_AI=true PROVIDER=local npm test

# Real AI — Specific test file
source .env && USE_REAL_AI=true npm test -- e2e/tests/06-form-filling.spec.ts

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