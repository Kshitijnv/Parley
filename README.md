# Parley

A Windows desktop assistant for live calls and interviews. Parley sits in a small
always-on-top overlay, transcribes the call on your PC, and streams an AI answer when the
other person asks a question. It answers automatically or when you press a hotkey.

Built with Electron 45, React 19 and TypeScript. Speech-to-text runs locally (sherpa-onnx).
Answers come from the AI provider you choose, with your own API key.

> **Status:** personal project, under active development. Windows 10/11 only.

## Features

- **Overlay:** frameless, always on top, movable, with snap zones. It can be hidden to a
  small bubble.
- **Live transcript** of both sides: call audio (system loopback) as "Them", and your
  microphone as "You". Transcription runs offline on your PC.
- **Answers:**
  - Automatic answers when a question is detected, with cooldowns, caps and duplicate
    suppression so you don't burn through your API quota.
  - Manual answers with **Ctrl+Enter**, a typed question (Chat), or a screenshot of your
    screen.
  - Grounded in your resume, the job description, documents you attach, and your own
    instructions.
  - Streamed as Markdown, with code highlighting, math, answer history and Retry.
- **Private mode:** keeps the overlay out of screen shares and screenshots on Windows 10
  2004 or later.
- **Library:** past calls with transcripts and AI notes, resumes (PDF → Markdown), documents,
  mock interviews and settings.
- **Providers:** Google Gemini (default), OpenAI, Anthropic or Groq. An optional fallback
  model can take over when the main one is slow to start; it's off by default.
- **Local data:** everything is stored on your PC in SQLite. API keys are encrypted with
  Windows DPAPI.

## Requirements

- **Windows 10 (version 2004 or later) or Windows 11.** The overlay, system-audio capture
  and Private mode depend on Windows APIs.
- **Node.js 24** (developed on 24.19) and npm.
- **An API key** for at least one provider, for example a free
  [Gemini key](https://aistudio.google.com/apikey).
- **About 75 MB of disk space** for the English speech model, downloaded once from
  Hugging Face.
- **Headphones** are recommended. On laptop speakers the microphone also picks up the
  other person.

## Setup

```powershell
git clone https://github.com/Kshitijnv/Parley.git
cd Parley\app
npm install
```

### 1. API keys

Choose one way:

- **In the app (recommended):** start it, open **⋮ → Settings and API keys**, and paste
  your key. Keys saved there are encrypted on your PC.
- **For development:** copy the template and fill in at least one key:

  ```powershell
  Copy-Item .env.example .env.local
  notepad .env.local   # set GEMINI_API_KEY=...
  ```

  Only development builds read `.env.local`, and it's ignored by Git. Never commit it.

### 2. Run

```powershell
npm run dev
```

This opens the overlay, with hot reload. To try the production build instead:

```powershell
npm run build
npm run preview
```

### 3. First run

1. **Install the speech model.** Open **Settings → Speech models** and install the English
   model. It downloads once, is checked with sha256, and works offline after that.
   Downloads never start during a call.
2. **Add a key** if you didn't use `.env.local`.
3. **Create a session** in the overlay: company, role, job description, resume, language
   and model.
4. **Connect.** Pick your microphone and start. Call audio is captured from your PC's
   output, so play the call through this PC.

## Default hotkeys

These are active only while a call is live. You can change them in Settings.

| Action | Keys |
| --- | --- |
| Answer the latest question | Ctrl+Enter |
| Answer from a screenshot | Ctrl+Shift+Enter |
| Type a question (Chat) | Ctrl+Shift+Space |
| Previous / next answer | Ctrl+Left / Ctrl+Right |
| Clear the answer / the transcript | Ctrl+Backspace / Ctrl+Shift+Backspace |
| Move the overlay | Ctrl+Shift+Arrow keys |

## Scripts

Run these from `app/`:

| Command | What it does |
| --- | --- |
| `npm run dev` | Electron app in development mode |
| `npm run dev:web` | browser-only preview with demo data and simulated windows, at http://localhost:5199 |
| `npm run build` / `npm run preview` | production build / run it |
| `npm run typecheck` | TypeScript checks (main and renderer) |
| `npm run test:unit` | unit tests (no Electron, no network) |
| `npm run test:e2e` | unit + Electron end-to-end tests; run `npm run build` first |
| `npm run test:real` | tests against a **real** provider; makes paid or quota-limited calls, run on purpose only |
| `npm run smoke:electron` | quick check that the built app starts, hides, registers hotkeys and logs no errors |

The end-to-end tests use a scripted fake AI provider (`PARLEY_FAKE_PROVIDER`), so they make
**no real API calls**. They do need the speech model, and an interactive Windows desktop
for the screen-capture checks.

## Configuration

Development switches go in `app/.env.local`; see `app/.env.example` for the full list. The
useful ones:

| Variable | Effect |
| --- | --- |
| `PARLEY_MOCK=1` | use the built-in demo data instead of the real database |
| `PARLEY_IGNORE_ENV_KEYS=1` | ignore keys in `.env.local`; use only keys saved in Settings |
| `PARLEY_STT_MODEL` | `kroko` (default) or `zipformer-2023` |
| `PARLEY_USER_DATA` | use another folder instead of `%APPDATA%\parley` |

## Project layout

```
app/
  src/main/        Electron main process: windows, IPC, SQLite, AI engine and request gate,
                   speech-to-text worker, Private mode, hotkeys, logging
  src/preload/     the bridge between windows and main (context isolation)
  src/renderer/    React UI: overlay (live call), library, settings
  src/shared/      types, IPC schemas (zod) and catalog shared by every process
  e2e/             Playwright tests: unit, electron, real, hardware
  scripts/         smoke and helper scripts
```

## Privacy and data

- **Stored locally.** Transcripts, answers, resumes and settings are kept in
  `%APPDATA%\parley`, on your PC only.
- **Never sent:** audio is transcribed locally and never sent anywhere.
- **Sent per request:** what you asked for — the recent transcript, your context (resume,
  job description, documents, instructions) and, for Screenshot, an image of your screen.
  It goes to the provider you picked, using your key.
- **Logs** contain IDs, timings and error types only: no transcript, prompt, resume or key
  text.
- **Gemini's free tier** may use prompts to improve Google's products. Enable billing on
  the key, or use another provider, if that matters to you.

## Known limitations

- **Windows only.** There are no macOS, Linux or mobile builds.
- **English only.** Transcription for other languages isn't available yet; Hindi is
  disabled until it has been verified.
- **Private mode** has been verified with Windows screen capture only. Zoom, Teams, Meet and
  OBS haven't been tested. It never hides the window from a camera, a capture card or
  Remote Desktop.
- **Answer speed** depends mostly on the AI provider. Gemini's time to first token has
  varied from under 1 s to more than 25 s.
- **No installer** yet: packaging with `electron-builder` isn't set up.
