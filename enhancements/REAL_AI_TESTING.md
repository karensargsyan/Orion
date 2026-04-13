# Real AI Testing Guide

**For @qa-tester and developers running real LLM validation**

## Quick Start

1. **Copy environment template:**
   ```bash
   cp .env.example .env
   ```

2. **Add your API key to `.env`:**
   ```bash
   GEMINI_API_KEY=AIzaSyD2yYBh1AOmwUJa3307shLUgh9l4re0efM
   ```

3. **Run tests with real AI:**
   ```bash
   source .env && USE_REAL_AI=true npm test
   ```

## Provider Options

### Gemini 2.0 Flash Exp (Recommended for QA)

**Pros:**
- ✅ Fast (2-5 seconds per response)
- ✅ Cheap ($0.00015 per 1K tokens)
- ✅ Good prompt adherence
- ✅ No local setup required

**Usage:**
```bash
source .env && USE_REAL_AI=true PROVIDER=gemini npm test
```

### LM Studio (Local Model)

**Pros:**
- ✅ Zero cost
- ✅ Offline testing
- ✅ Privacy (no data leaves your machine)

**Cons:**
- ⚠️ **SLOW** - responses may take 10-60 seconds depending on model/hardware
- ⚠️ **Requires powerful GPU** (Apple Silicon M1/M2/M3 recommended)
- ⚠️ Setup required

**Setup:**
1. Download LM Studio: https://lmstudio.ai/
2. Install a model (recommended: `gemma-2-9b-it` or `llama-3.2-3b-instruct`)
3. Start local server: LM Studio → Local Server tab → Start Server
4. Verify running: `curl http://127.0.0.1:1234/v1/models`

**Usage:**
```bash
source .env && USE_REAL_AI=true PROVIDER=local npm test
```

## Test Timeouts for Real AI

⚠️ **IMPORTANT:** Real AI tests take longer than mock tests.

### Default Timeouts
- **Mock AI:** ~2 minutes for all 27 tests
- **Gemini:** ~5-7 minutes for all tests (2-5 sec per LLM call)
- **LM Studio:** ~15-30 minutes (10-60 sec per LLM call, depends on model/hardware)

### Timeout Configuration

Tests have built-in timeouts in `playwright.config.ts`:
```typescript
timeout: 60_000,  // 60 seconds per test
expect: { timeout: 15_000 },  // 15 seconds for assertions
```

**For local models, you may need to increase timeouts:**

Edit `playwright.config.ts`:
```typescript
export default defineConfig({
  timeout: 120_000,  // 2 minutes (for slow local models)
  expect: { timeout: 30_000 },  // 30 seconds
  // ...
})
```

Or run with custom timeout:
```bash
source .env && USE_REAL_AI=true PROVIDER=local npx playwright test --timeout=120000
```

## Running Specific Tests

Test individual features:
```bash
# Form filling tests (uses selector strategy, form wizard awareness)
source .env && USE_REAL_AI=true npm test -- e2e/tests/06-form-filling.spec.ts

# Chat tests (uses smart interaction improvements, natural language)
source .env && USE_REAL_AI=true npm test -- e2e/tests/03-chat-basic.spec.ts

# Navigation tests (tests action loop, multi-step tasks)
source .env && USE_REAL_AI=true npm test -- e2e/tests/04-navigation.spec.ts
```

## Expected Real AI Behavior

### What to Validate

Real AI tests should verify the **3 implemented prompt engineering features:**

1. **Smart Interaction Improvements** (P0)
   - Casual language: "fill this fields" → AI detects form, fills without clarification
   - Grammar check: Right-click text → "Fix grammar & spelling" → AI corrects
   - Text improvement: "make this better" → AI rewrites professionally

2. **Selector Strategy Unified** (P1)
   - Visible text priority: AI uses `selector="Search flights"` not `selector="button.search"`
   - Fallback sequence: Step 1 (visible text) → Step 2 (placeholder) → Step 3 (aria-label) → Step 4 (CSS)
   - No retries: If selector fails, AI moves to next step

3. **Multi-Step Form Wizard Awareness** (P1)
   - Wizard detection: AI detects "Step 2 of 3" indicators
   - Field names in plan: Task plan shows "Fill: Name, Email, Phone" not "Fill 3 fields"
   - Cross-page continuity: After clicking Next, AI gets warning about stale selectors

### QA Checklist

Run tests with real AI and verify:

- [ ] Form filling test passes (validates selector strategy + wizard awareness)
- [ ] Chat tests pass (validates smart interaction patterns)
- [ ] Navigation tests pass (validates cross-page continuity)
- [ ] Check Playwright HTML report for failures
- [ ] Check actual LLM responses (look for action tags `[ACTION:CLICK selector="..."]`)
- [ ] Verify no regressions (all 27 tests should pass)

## Troubleshooting

### "GEMINI_API_KEY is required"
- Ensure `.env` file exists with `GEMINI_API_KEY=your_key`
- Run `source .env && echo $GEMINI_API_KEY` to verify variable is loaded
- Use `source .env &&` prefix before `npm test`

### "LM Studio error: connect ECONNREFUSED"
- Check LM Studio is running: Local Server tab → Status should be "Running"
- Verify URL: `curl http://127.0.0.1:1234/v1/models`
- Check port: default is 1234, change in `.env` if different

### Tests timeout with local model
- Increase timeout in `playwright.config.ts` (see "Timeout Configuration" above)
- Use smaller model (gemma-2-2b-it instead of gemma-2-9b-it)
- Reduce max_tokens in prompt (edit prompt-engine.ts if needed)

### Real AI gives different results than mock
**This is expected!** Real AI:
- May interpret prompts differently
- May choose different selectors
- May skip steps or add clarifications
- **This is what we're testing** — prompt engineering effectiveness

If real AI fails a test that mock passes:
1. Check if failure is due to prompt not being followed
2. Document the failure in QA report
3. Feed back to @product-owner for prompt refinement

## Cost Tracking (Gemini)

**Gemini 2.0 Flash Exp pricing:**
- Input: $0.00015 per 1K tokens
- Output: $0.0006 per 1K tokens

**Estimated cost per full test run (27 tests):**
- ~50K input tokens (prompts) = $0.0075
- ~10K output tokens (responses) = $0.006
- **Total: ~$0.01 per run**

Running 100 test runs = ~$1.00 total cost.

## Security Notes

- ⚠️ `.env` is gitignored — do NOT commit API keys
- ✅ API keys are only used for testing, not in production extension
- ✅ Real AI tests run locally, not in CI/CD (no key exposure)

---

**Questions?** Check CLAUDE.md for agent workflow or ask @qa-tester.
