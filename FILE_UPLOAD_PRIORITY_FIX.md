# File Upload Priority Fix - Implementation Summary

## Problem
When users uploaded files, the LLM was reading PERMANENT USER INSTRUCTIONS and responding based on those instead of analyzing the file, causing completely irrelevant responses.

**Example scenario:**
- User uploads a file with content: "Project deadline: March 15th"
- User has a permanent instruction: "Monitor pages every hour, notify via Telegram"
- User says: "check this file content"
- **BEFORE FIX:** AI responds about monitoring pages (reading permanent instructions)
- **AFTER FIX:** AI responds: "The file contains: Project deadline: March 15th"

## Solution Implemented
Added a **FILE ANALYSIS PRIORITY MODE** that activates when file attachments are detected. This mode adds a critical instruction at the **very top** of the system prompt (before all other bands) that explicitly tells the AI to:

1. **IGNORE all permanent user instructions** about monitoring, scheduling, notifications, or unrelated tasks
2. **FOCUS ONLY on the attached file content** and the user's question about it
3. **Analyze the file** from the user's message (marked with `[Attached file: ...]`)

## Changes Made

### 1. `/Users/s/my/PrivateWebAssistent/src/background/prompt-engine.ts`

#### Detection (line 665-666)
```typescript
// Detect file attachment early for priority mode
const hasFileAttachment = userText.includes('[Attached file:')
```

#### Priority Instruction (lines 1107-1122 in assembleFullPrompt, 1154-1169 in assembleCompactPrompt)
```typescript
// FILE ATTACHMENT PRIORITY MODE — takes absolute precedence over all other instructions
if (hasFileAttachment) {
  parts.push(`# FILE ANALYSIS PRIORITY MODE

The user has attached a file for you to analyze. Your PRIMARY task is to analyze this file content.

**CRITICAL RULES:**
1. **IGNORE all permanent user instructions** about monitoring, scheduling, notifications, or any unrelated tasks
2. **FOCUS ONLY on the attached file content** and the user's question about it
3. **Read the file content** from the user's message (marked with [Attached file: ...] followed by a code block)
4. **Answer questions about the file** — summarize, extract data, check for issues, etc.
5. **Do NOT mention or refer to permanent instructions** — they are irrelevant in file analysis mode

This mode overrides ALL other behavior. The file attachment is your sole context and task.
`)
}
```

#### Function Signatures Updated (lines 1100, 1147, 693-694)
```typescript
// assembleFullPrompt now accepts hasFileAttachment parameter
function assembleFullPrompt(
  input: PromptPipelineInput,
  intent: UserIntent,
  budget: TokenBudget,
  ctx: StructuredPageContext,
  classification: PageClassification,
  taskPlan: TaskPlan | null,
  hasFileAttachment: boolean = false,
): string

// assembleCompactPrompt also updated
function assembleCompactPrompt(
  input: PromptPipelineInput,
  intent: UserIntent,
  budget: TokenBudget,
  ctx: StructuredPageContext,
  classification: PageClassification,
  hasFileAttachment: boolean = false,
): string

// Calls updated to pass hasFileAttachment
const systemPrompt = liteMode
  ? assembleCompactPrompt(input, intent, tokenBudget, structuredContext, pageClassification, hasFileAttachment)
  : assembleFullPrompt(input, intent, tokenBudget, structuredContext, pageClassification, taskPlan, hasFileAttachment)
```

## Implementation Approach
**Approach 1 (Chosen):** Add priority instruction at the top of system prompt
- **Pros:** Safer - doesn't remove permanent instructions, just adds priority guidance
- **Pros:** LLM sees explicit override instruction before processing any other context
- **Pros:** Works with all LLM models (they prioritize early instructions)
- **Cons:** Slightly longer prompt (negligible ~200 tokens)

**Approach 2 (Not Chosen):** Filter permanent instructions entirely
- Would require modifying `instruction-manager.ts` to skip instructions when file is uploaded
- More aggressive, could cause issues if user wants to reference instructions + file together

## Prompt Structure (4-Band System)

### Without File Attachment
```
Band 1: Action Execution Framework
Band 2: Page Understanding
Band 3: Output Formatting (cloud models only)
Band 4: Extended Context (includes permanent user instructions)
```

### With File Attachment
```
FILE ANALYSIS PRIORITY MODE (NEW - at the very top)
Band 1: Action Execution Framework
Band 2: Page Understanding
Band 3: Output Formatting (cloud models only)
Band 4: Extended Context (permanent instructions still included but explicitly ignored)
```

## Key Design Decisions

1. **Permanent instructions are NOT filtered out** - they remain in Band 4
   - This allows LLM to reference them if needed for edge cases
   - Priority instruction explicitly overrides them

2. **Priority mode is added to BOTH full and compact prompts**
   - Works with cloud models (Gemini, OpenAI, Anthropic)
   - Works with local models (LM Studio)

3. **Detection is simple and reliable**
   - Uses exact string match: `userText.includes('[Attached file:')`
   - Matches the existing file attachment format used in `service-worker.ts` (line 927)

4. **No changes to file attachment parsing**
   - File content is already correctly passed in `userText` by sidepanel
   - No changes needed to `chat.ts` or file reading logic

## Build Verification
```bash
npm run build
```
**Result:** ✅ TypeScript compiles with no errors

## Testing Scenarios

### Test Case 1: File Analysis (Basic)
1. Create file: `test.txt` with content "Project deadline: March 15th"
2. Save permanent instruction: "Monitor pages every hour"
3. Upload `test.txt` in sidepanel
4. Say: "what's in this file?"
5. **Expected:** "The file contains: Project deadline: March 15th"
6. **NOT:** Response about monitoring pages

### Test Case 2: File Analysis (Code Review)
1. Create file: `script.js` with code containing a bug
2. Save permanent instruction: "Always check for security issues"
3. Upload `script.js`
4. Say: "check this code for issues"
5. **Expected:** Analysis of the JavaScript code
6. **NOT:** Generic security advice unrelated to the file

### Test Case 3: File + Form Filling
1. Create file: `data.csv` with personal information
2. Upload file
3. Say: "fill the form with data from this file"
4. **Expected:** AI extracts data from CSV and fills form fields
5. **NOT:** AI reads permanent instructions about forms

### Test Case 4: No File (Baseline)
1. Do NOT upload any file
2. Say: "help me with this page"
3. **Expected:** AI reads permanent instructions and acts normally
4. **Confirm:** File priority mode is NOT activated

## Files Modified
- `/Users/s/my/PrivateWebAssistent/src/background/prompt-engine.ts` (4 sections updated)
  1. Added `hasFileAttachment` detection in `buildPromptPipeline()`
  2. Updated `assembleFullPrompt()` signature and implementation
  3. Updated `assembleCompactPrompt()` signature and implementation
  4. Updated system prompt assembly calls to pass `hasFileAttachment`

## Version
- Implementation completed: 2026-04-13
- Orion version: 1.0.26 (auto-incremented by build)
- No breaking changes
- Backward compatible with existing functionality

## Notes
- File attachment marker format: `[Attached file: filename]` followed by code block (markdown)
- This format is already used in `service-worker.ts:927` for logging
- Priority instruction uses strong language: "IGNORE", "CRITICAL RULES", "PRIMARY task"
- Instruction is placed at the absolute top of system prompt (before Band 1)
- Works with both `liteMode` (compact prompts) and standard mode (full prompts)
