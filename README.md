# Orion — Your Private AI Browser Assistant

**An open-source Chrome extension that gives you a fully autonomous AI assistant in your browser sidebar. It can run entirely on a local AI model, so your data never leaves your machine.**

No cloud subscriptions. No data harvesting. No API costs when running locally. Just you and your own AI, browsing the web together.

---

## The Idea Behind Orion

Every cloud-based AI assistant (Claude, ChatGPT, Gemini extensions) works by sending your data to remote servers. Every page you visit, every form you fill, every email you read — all transmitted to third parties for processing. You have no control over what happens to that data.

**Orion takes a fundamentally different approach:**

- **All LLM usage happens through a model YOU choose** — local or cloud, your decision
- **When running locally**, zero bytes of your data leave your machine. No telemetry, no analytics, no tracking
- **When using cloud APIs**, data goes directly to your chosen provider (Google, OpenAI, Anthropic) and nowhere else — no intermediary servers, no data brokers
- **Open source** — every line of code is auditable. No hidden data collection, no obfuscated network calls
- **Your credentials stay encrypted on your device** — AES-GCM encryption with PBKDF2 key derivation, protected by a PIN only you know

This is the core philosophy: **you should be able to use AI to browse the web without giving up your privacy.**

## What Can Orion Do?

Orion is a fully autonomous browser agent. It reads pages, clicks buttons, fills forms, navigates between sites, and chains multi-step workflows — all from natural language commands in the sidebar chat.

### Everyday Tasks

- **Research** — "Find flights from Stuttgart to Tokyo and compare prices" — opens tabs, reads results, synthesizes findings
- **Email** — reads your inbox, drafts replies, detects phishing attempts
- **Forms** — visa applications, registrations, checkout forms — with guided step-by-step Form Coach mode
- **Shopping** — compare products, find deals across multiple stores
- **Reading** — summarize articles, extract key data, explain complex documents
- **Memory** — remembers context across sessions, learns from your preferences

### Technical Capabilities

| Capability | Details |
|------------|---------|
| **33 Action Types** | Click, type, navigate, scroll, search, open/close tabs, fill forms, toggle, select, screenshot, hover, double-click, key press, and more |
| **Chrome DevTools Protocol** | Trusted browser-level events (`isTrusted: true`) that work on React, Angular, Vue, Gmail, and all modern frameworks |
| **Accessibility Tree** | Reads the full a11y tree to understand page structure, interactive elements, and ARIA labels |
| **Multi-Step Automation** | Chains up to 25 rounds of actions per request with visual verification between rounds |
| **Intent Classification** | Automatically detects what you want (navigate, search, fill form, extract info, compose, research) and optimizes accordingly |
| **Domain Awareness** | Recognizes 17 page types (email, shopping, travel, banking, social media, etc.) with specialized strategies for each |
| **Smart Prompting** | Built-in prompt engineering pipeline that expands user queries, decomposes complex tasks, and allocates context budgets |
| **Tab Management** | Global tab registry with deduplication, auto-close of research tabs, and a 12-tab safety limit |

## Key Features

### Sidebar Chat
Natural language interface in Chrome's side panel. Ask questions, give commands, get things done. Links in responses are clickable and copyable (Ctrl+click to copy URLs).

### Form Coach
Step-by-step guided form filling. Orion highlights each field, explains what to enter, and suggests values from your vault. You stay in control — it guides, you confirm.

### Encrypted Vault
PIN-protected storage for credentials, addresses, and sensitive data. AES-GCM encryption with PBKDF2 key derivation. Data never leaves your device, even when using cloud models.

### Web Research
Opens background tabs, searches Google, reads multiple pages in parallel, and synthesizes findings with source links. Research tabs auto-close when done.

### Persistent Memory
- **Per-tab memory** — remembers what you were doing on each tab
- **Per-domain knowledge** — learns site-specific patterns and strategies
- **Global instructions** — "remember: always use German airports" is formatted and stored permanently
- **MemPalace** — optional long-term memory with vector embeddings (local Python service)

### Voice Input
Speech-to-text via Chrome's Web Speech API or a fully local Whisper model — your choice of privacy level.

### Background Intelligence
Optional background tasks that learn from your browsing:
- Page summarization and context tracking
- Action success/failure learning for self-improvement
- Calendar event detection with .ics export
- PII detection with vault storage suggestions

All toggleable in Settings. 100% local when using a local model.

## Quick Start

### 1. Install & Build

```bash
git clone https://github.com/ArekSrorth/PrivateWebAssistent.git
cd PrivateWebAssistent
npm install
npm run build
```

### 2. Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` folder
4. The Orion icon appears in your toolbar

### 3. Connect an AI Model

#### Local (Recommended for Privacy)

1. Install [LM Studio](https://lmstudio.ai/)
2. Download a model — tested with **Google Gemma 4 26B (A4B)**
3. Start the local server (default: `http://localhost:1234/v1`)
4. Click the Orion icon, go to Settings, enter the URL
5. Done — all AI processing now happens on your machine

#### Cloud (For Maximum Capability)

1. Open Settings in the Orion sidebar
2. Select your provider: **Gemini** / **OpenAI** / **Anthropic**
3. Enter your API key
4. Select a model (tested with **Gemini 2.5 Pro**)

## How It Works

1. **Click the Orion icon** on any tab — the sidebar opens
2. The tab joins the blue **Orion** tab group (Orion only sees grouped tabs)
3. **Type your request** — "Help me fill this visa form" / "Research flights to Berlin" / "Summarize this page"
4. Orion reads the page via accessibility tree and page content, classifies your intent, and builds an optimized prompt
5. The AI responds with actions (`CLICK`, `TYPE`, `NAVIGATE`, etc.) which execute automatically
6. For complex tasks, it chains multiple rounds — navigating, reading, comparing, filling
7. **Switch to a non-Orion tab** — sidebar disappears. **Switch back** — it reappears with full context

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+O` | Toggle Orion panel |
| `Alt+Shift+A` | Focus chat input |
| `Alt+Shift+M` | Search memory |
| `Alt+Space` | Command palette |

### Omnibox

Type `ai` in the address bar followed by your query for quick access.

## Architecture

```
src/
  background/              # Service worker (Chrome MV3)
    service-worker.ts          # Main orchestrator, event listeners
    ai-client.ts               # LLM client (OpenAI/Anthropic/Gemini streaming)
    prompt-engine.ts           # Intent classification, query expansion, prompt pipeline
    action-executor.ts         # 33-action automation engine with CDP
    web-researcher.ts          # Tab management, Google search, page reading
    page-context-builder.ts    # Structured page context with flow detection
    page-persona.ts            # Domain-aware strategies for 17 page types
    instruction-manager.ts     # User instruction formatting and storage
    form-intelligence.ts       # Form field classification + vault matching
    crypto-manager.ts          # AES-GCM encryption for vault
    cdp-session.ts             # Chrome DevTools Protocol session management
    cdp-actions.ts             # CDP click, type, hover, scroll primitives
    cdp-accessibility.ts       # Accessibility tree extraction
    workflow-engine.ts         # Multi-step workflow orchestration
    error-logger.ts            # Debug logging (actions, tabs, AI rounds, errors)
    skill-manager.ts           # Reusable action sequences
    tab-state.ts               # Per-tab page state tracking
  content/                 # Content scripts (injected into web pages)
    content-main.ts            # DOM interaction handlers
    form-coach.ts              # Step-by-step form filling overlay
    form-filler.ts             # Robust form filling (React-compatible)
  sidepanel/               # Sidebar UI
    sidepanel.ts               # Tab routing, panel management
    chat.ts                    # Chat interface, streaming, markdown rendering
    vault-ui.ts                # Encrypted vault management UI
    settings-ui.ts             # Provider and feature configuration
    markdown.ts                # Zero-dependency markdown renderer with link auto-detection
  shared/                  # Types, constants, sanitization utilities
```

## Security & Privacy

### Data Flow

```
[Your Browser] --> [Local LM Studio] --> [Response]
       |                                      |
       |          Everything stays here        |
       +--------------------------------------+
```

When using a local model, the entire data flow is:
1. Orion reads the current page via Chrome APIs (content script + accessibility tree)
2. Page context + your message are sent to your local LM Studio server
3. The AI responds with actions, which execute in your browser
4. **Nothing leaves localhost**

### Encryption

- **Vault** — AES-GCM with 256-bit keys, derived via PBKDF2 (100k iterations) from your PIN
- **API keys** — stored in Chrome's `chrome.storage.local` (encrypted by the browser)
- **Session data** — in-memory only, cleared when the browser closes

### Privacy Guarantees (Local Mode)

- Zero network requests to external servers (verified by open source code)
- No telemetry, analytics, or usage tracking
- No browser history transmitted anywhere
- Vault data encrypted at rest, decrypted only in memory with your PIN
- Content scripts only activate on tabs you explicitly add to Orion

## Testing

```bash
npm run test:unit           # Unit tests (Vitest)
npm test                    # E2E tests (Playwright)
npm run test:headed         # Watch tests in a real browser
npm run test:ui             # Interactive test runner
npm run typecheck           # TypeScript verification
```

## Optional Services

All optional — the extension works without them.

### MemPalace (Long-Term Memory)

A local Python service that gives Orion persistent cross-session memory using vector embeddings.

```bash
cd bridge && pip install -r requirements.txt && python mempalace_bridge.py
```

Stores action insights, domain knowledge, error recovery strategies, and user preferences in local SQLite + vector embeddings.

### Local Whisper (Voice Input)

100% local speech-to-text using OpenAI's Whisper model.

```bash
cd whisper-mcp && pip install -r requirements.txt && python server.py
```

Recommended model: `distil-large-v3` (fast + accurate). Runs entirely on your hardware.

## Tested Models

| Model | Type | Notes |
|-------|------|-------|
| **Google Gemma 4 26B (A4B)** | Local (LM Studio) | Good reasoning, works for most tasks |
| **Gemini 2.5 Pro** | Cloud (Google) | Excellent for complex multi-step automation |
| **GPT-4o** | Cloud (OpenAI) | OpenAI API compatible |
| **Claude** | Cloud (Anthropic) | Anthropic API compatible |
| **Llama / Mistral / Qwen** | Local | Should work via LM Studio/Ollama (community testing welcome) |

## Tech Stack

- **TypeScript** + esbuild (fast builds)
- **Chrome Extension Manifest V3** (service worker, side panel, content scripts)
- **Chrome DevTools Protocol** for trusted mouse/keyboard events and accessibility tree
- **IndexedDB** for persistent storage
- **AES-GCM** + PBKDF2 for vault encryption
- **Vitest** for unit tests, **Playwright** for E2E tests

## Contributing

Contributions are welcome. Areas where help is especially valuable:

- **Action reliability** — improving click/type accuracy on complex SPAs
- **Local model optimization** — better prompts for smaller models
- **New features** — file upload, multi-language support, better voice UI
- **Testing** — more tests, edge case coverage
- **Security review** — audit the encryption, data flow, and content script isolation

## License

MIT
