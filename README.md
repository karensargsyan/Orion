# Orion — Your Private AI Browser Assistant

Like [Claude for Chrome](https://chrome.google.com/webstore/detail/claude/), but **yours**. Orion is an open-source Chrome extension that gives you a fully autonomous AI assistant in your browser sidebar — with one critical difference: **it can run entirely on a local AI model, so your data never leaves your machine.**

No cloud subscriptions. No data harvesting. No API costs if you run locally. Just you and your own AI, browsing the web together.

## Why Orion?

Cloud-based AI assistants (Claude, ChatGPT, Gemini extensions) send every page you visit, every form you fill, every email you read to their servers. Orion flips that model:

- **Run locally** with [LM Studio](https://lmstudio.ai/) — your conversations, your browsing history, your personal data stays on YOUR computer
- **Or use cloud APIs** (Gemini, OpenAI, Anthropic) when you need more power — your choice
- **Tested with Google Gemma 4 26B (A4B)** running locally via LM Studio — a fully capable reasoning model that runs on consumer hardware
- **Also tested with Gemini 2.5 Pro** for cloud-powered usage

## What Can It Do?

The idea behind Orion is simple: **a completely private AI assistant that helps you with everyday browsing tasks**, just like having a smart friend looking over your shoulder:

- **Research anything** — "Find me flights from Stuttgart to Novosibirsk and compare prices" — it opens tabs, reads results, synthesizes findings
- **Answer emails** — reads your inbox, drafts replies, warns about phishing
- **Fill out forms** — visa applications, registrations, checkout forms — with guided step-by-step Form Coach mode
- **Find deals** — tickets, hotels, products — opens multiple sites, compares options
- **Analyze pages** — summarize articles, extract data, explain complex documents
- **Remember context** — knows what you were working on across sessions

## Key Features

| Feature | Description |
|---------|-------------|
| **Sidebar Chat** | Ask questions, give commands, get things done |
| **33 Action Types** | Click, type, navigate, scroll, search, open tabs, fill forms, toggle, select, screenshot... |
| **Form Coach** | Step-by-step guided form filling — highlights each field, explains what to enter, suggests values |
| **Web Research** | Opens multiple tabs, reads content, synthesizes findings with source citations |
| **Tab Grouping** | Active tabs grouped under "Orion" — sidebar only shows on grouped tabs |
| **CDP Clicks** | Chrome DevTools Protocol for trusted browser-level click events (works on React, Angular, etc.) |
| **Encrypted Vault** | PIN-protected storage for credentials, addresses, payment info |
| **Memory** | Per-tab, per-domain, and global memory — remembers context across sessions |
| **Voice Input** | Speech-to-text via Web Speech API or local Whisper |
| **Privacy-first** | Zero data sent anywhere when using a local model |

## Quick Start

### 1. Install & Build

```bash
npm install
npm run build
```

### 2. Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist/` folder

### 3. Connect an AI Model

**Local (recommended for privacy):**
1. Install [LM Studio](https://lmstudio.ai/)
2. Download a model — tested with **Google Gemma 4 26B (A4B)** (`google/gemma-4-26b-a4b`)
3. Start the local server (default: `http://localhost:1234/v1`)
4. Click the Orion icon in Chrome, go to Settings, enter the URL

**Cloud (for maximum capability):**
1. Go to Settings in the sidebar
2. Select your provider (Gemini / OpenAI / Anthropic)
3. Enter your API key
4. Tested with **Gemini 2.5 Pro** — fast and reliable

## How It Works

1. Click the Orion icon on any tab
2. The sidebar opens, and the tab joins the blue **Orion** tab group
3. Type your request — "Help me fill this visa form" / "Research cheap flights to Berlin" / "Summarize this article"
4. Orion reads the page, decides what to do, and executes actions autonomously
5. For complex tasks, it chains up to 25 rounds of actions — navigating, clicking, typing, searching
6. Switch to a non-Orion tab — sidebar disappears. Switch back — it reappears.

## Architecture

```
src/
  background/          # Service worker — AI client, action executor, memory
    service-worker.ts      # Main orchestrator
    ai-client.ts           # OpenAI/Anthropic/Gemini streaming + reasoning model support
    action-executor.ts     # 33-action automation engine with CDP clicks
    web-researcher.ts      # Tab group management, Google search, page reading
    form-intelligence.ts   # Form field classification + vault matching
    crypto-manager.ts      # AES-GCM encryption for vault
  content/             # Content scripts — injected into web pages
    content-main.ts        # DOM interaction, click/type/scroll handlers
    form-coach.ts          # Step-by-step guided form filling overlay
    form-filler.ts         # Robust form filling (React-compatible)
  sidepanel/           # Sidebar UI
    sidepanel.ts           # Tab management, routing
    chat.ts                # Chat interface, streaming, widgets
    vault-ui.ts            # Encrypted vault management
    settings-ui.ts         # Provider configuration
  shared/              # Shared types, constants, utilities
```

## Testing

27 E2E tests covering extension loading, chat, navigation, search, form filling, error handling, and settings:

```bash
npm test                    # Run all tests
npm run test:ui             # Interactive test runner
npx playwright test --headed  # Watch tests run in a real browser
```

## Tech Stack

- **TypeScript** + esbuild
- **Chrome Extension Manifest V3** (service worker, side panel, content scripts)
- **Chrome DevTools Protocol** for trusted clicks and accessibility tree
- **IndexedDB** for persistent storage
- **AES-GCM** encryption for vault data
- **Playwright** for E2E testing

## Security & Privacy

- **No secrets in the codebase** — API keys stored in Chrome's encrypted browser storage
- **Vault** — AES-GCM encryption with PBKDF2 key derivation from your PIN
- **Local model = zero data leakage** — everything stays on your machine
- **Cloud model = direct connection** — data goes only to your chosen provider, nowhere else
- **Open source** — audit the code yourself

## Tested Models

| Model | Type | Performance |
|-------|------|-------------|
| **Google Gemma 4 26B (A4B)** | Local (LM Studio) | Good reasoning, slower (~33 tok/s). Works for most tasks. |
| **Gemini 2.5 Pro** | Cloud (Google) | Excellent. Fast and reliable for complex multi-step tasks. |
| **GPT-4o / Claude** | Cloud | Should work (OpenAI/Anthropic API compatible). |
| **Llama / Mistral / Qwen** | Local | Should work via LM Studio/Ollama (untested). |

## License

MIT
