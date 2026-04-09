# Orion — AI Browser Assistant

A Chrome extension that gives you an autonomous AI assistant right in your browser sidebar. It can navigate websites, fill forms, research topics, take screenshots, and remember context — all powered by your choice of AI model (local or cloud).

## What It Does

- **Browse autonomously** — navigates pages, clicks buttons, fills forms, searches Google, opens tabs for research
- **Form Coach** — step-by-step guided form filling with field highlighting, explanations, and suggested values
- **Memory** — remembers context per tab, per domain, and globally. Vault for encrypted sensitive data (PIN-protected)
- **Works with any AI** — local models via LM Studio/Ollama, or cloud APIs (Gemini, OpenAI, Anthropic)
- **Privacy-first** — runs 100% locally when using a local model. No data leaves your machine.

## Key Features

| Feature | Description |
|---------|-------------|
| **Sidebar Chat** | Ask questions, give commands, get things done |
| **33 Action Types** | Click, type, navigate, scroll, search, open tabs, fill forms, toggle, select, screenshot... |
| **Tab Grouping** | Active tabs are grouped under "Orion" — sidebar only shows on grouped tabs |
| **Form Coach** | Interactive step-by-step form filling with AI suggestions |
| **Web Research** | Opens multiple tabs, reads content, synthesizes findings |
| **CDP Clicks** | Uses Chrome DevTools Protocol for trusted browser-level click events |
| **Encrypted Vault** | PIN-protected storage for credentials, addresses, payment info |
| **Voice Input** | Speech-to-text via Web Speech API or local Whisper |

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Load in Chrome

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `dist/` folder

### 4. Connect an AI Model

**Local (LM Studio):**
- Install [LM Studio](https://lmstudio.ai/)
- Load a model (e.g., Gemma, Llama, Mistral)
- Start the local server (default: `http://localhost:1234/v1`)
- Click the Orion icon in Chrome, go to Settings, enter the URL

**Cloud (Gemini/OpenAI/Anthropic):**
- Go to Settings in the sidebar
- Select your provider
- Enter your API key

## Architecture

```
src/
  background/        # Service worker — AI client, action executor, memory
    service-worker.ts    # Main orchestrator
    ai-client.ts         # OpenAI/Anthropic/Gemini streaming
    action-executor.ts   # 33-action automation engine
    web-researcher.ts    # Tab group management, Google search, page reading
    form-intelligence.ts # Form field classification + vault matching
    crypto-manager.ts    # AES-GCM encryption for vault
  content/           # Content scripts — injected into web pages
    content-main.ts      # DOM interaction, click/type/scroll handlers
    form-coach.ts        # Step-by-step guided form filling overlay
    form-filler.ts       # Robust form filling (React-compatible)
  sidepanel/         # Sidebar UI
    sidepanel.ts         # Tab management, routing
    chat.ts              # Chat interface, streaming, widgets
    vault-ui.ts          # Encrypted vault management
    settings-ui.ts       # Provider configuration
  shared/            # Shared types, constants, utilities
```

## Testing

```bash
# Run all E2E tests (27 tests)
npm test

# Run with UI
npm run test:ui

# Run specific test file
npx playwright test e2e/tests/03-chat-basic.spec.ts
```

## Tech Stack

- **TypeScript** + esbuild (fast builds)
- **Chrome Extension Manifest V3** (service worker, side panel, content scripts)
- **Chrome DevTools Protocol** (CDP) for trusted clicks and accessibility tree
- **IndexedDB** for persistent storage (chat history, memory, settings)
- **AES-GCM** encryption for vault data
- **Playwright** for E2E testing

## Security

- API keys are stored in Chrome's encrypted browser storage, never in code
- Vault data is encrypted with AES-GCM (PBKDF2 key derivation from PIN)
- No secrets, tokens, or credentials in the repository
- All AI communication stays between your browser and your chosen AI provider

## License

Private project.
