# Live Event Translator Demo

Local demo for recording an AI by Huy long-form tutorial. It translates live
international events playing in a browser tab into Vietnamese speech and
captions using Gemini Live Translate.

Model: `gemini-3.5-live-translate-preview`

Docs:
https://ai.google.dev/gemini-api/docs/live-api/live-translate

## What It Does

- Captures audio from a browser tab selected by the user.
- Creates a short-lived Gemini Live ephemeral token on the server.
- Streams tab audio to Gemini Live Translate over WebSocket as PCM 16 kHz.
- Plays translated speech locally and displays translated transcript deltas.
- Defaults the output language to Vietnamese.

Good demo sources:

- Official government speech or press conference.
- Federal Reserve / central bank speech.
- K-pop, athlete, or celebrity interview from an official channel.
- Product launch, keynote, or live event in English, Korean, Japanese, or Chinese.

## Setup

Create a local `.env` file in this folder:

```bash
GEMINI_API_KEY=your-gemini-api-key
```

Optional:

```bash
GEMINI_TRANSLATION_MODEL=gemini-3.5-live-translate-preview
PORT=5173
HOST=127.0.0.1
```

## Run

If you are behind a corporate proxy (`HTTPS_PROXY` / `HTTP_PROXY`), the npm
scripts already pass Node's `--use-env-proxy` flag so server-side Gemini calls
work.

```bash
npm install
npm run dev
```

Open the printed local URL, normally:

```text
http://127.0.0.1:5173
```

## End-User Flow To Record

1. Open an official event/interview/keynote tab with audio.
2. Open this app in another tab.
3. Keep `Vietnamese` selected.
4. Click `Choose event tab`.
5. Pick the source tab and enable tab audio.
6. Capture the translated audio, transcript, audio meter, and WebSocket status.
7. Adjust the audio mix so the translated voice is dominant.

## Validation

```bash
npm test
```

Live API smoke test, only after `.env` has `GEMINI_API_KEY`:

```bash
npm run smoke
```

## Notes For The Video

- Position this as a practical live-event translator, not a claim that Google
  invented realtime translation.
- Avoid claiming perfect realtime or perfect interpretation.
- For short-form clips, use short excerpts from official/public sources and
  keep the focus on the app behavior.
