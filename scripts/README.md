# Demo GIF recorder

`record-demo.mjs` produces the animated demo at the top of the main README
(`docs/demo.gif`). It drives the app with **mock data** in a headless
Chromium via CDP screencast, then assembles a smooth, looping GIF with ffmpeg.

## Requirements

- A Chromium-based browser (Chrome / Brave / Edge). Auto-detected on common
  paths, or set `PUPPETEER_EXECUTABLE_PATH`.
- [`ffmpeg`](https://ffmpeg.org/) on your `PATH`.
- `puppeteer-core` (installed as a dev dependency via `npm install`).

## Usage

```bash
# 1. Start the dev server (the app auto-uses the mock API in dev mode)
npm run dev

# 2. In another terminal, record the GIF
npm run demo:gif
```

The output is written to `docs/demo.gif`.

## How it works

1. Launches headless Chrome and sets `window.__DEMO_PACE__` so the mock API
   (`src/mockApi.ts`) streams dashboards slowly enough to read.
2. Starts a **CDP screencast** — frames arrive as the page paints (~60fps),
   each with a real timestamp — while a scripted walkthrough runs:
   idle hero → generate → dashboards + Quick Bits stream in → open a
   dashboard → slow read-scroll → back to the grid (loop point).
3. Writes each frame plus a concat list whose per-frame durations come from
   the real timestamps (so pacing is true to life), scaled by `SPEED`.
4. Runs a two-pass ffmpeg palette (`palettegen` → `paletteuse`) for a clean,
   small, infinitely-looping GIF.

## Tuning (env vars)

| Var        | Default                              | Meaning                              |
|------------|--------------------------------------|--------------------------------------|
| `DEMO_URL` | `http://localhost:5173/?demo=1`      | Dev server URL                       |
| `OUT`      | `docs/demo.gif`                      | Output path                          |
| `WIDTH`    | `720`                                | Output width (px)                    |
| `FPS`      | `14`                                 | Output frame rate                    |
| `SPEED`    | `1.85`                               | `>1` speeds the loop up (stays smooth) |
| `PACE`     | `1.6`                                | Mock streaming slowdown while recording |
| `CHROME` / `PUPPETEER_EXECUTABLE_PATH` | auto-detect         | Browser binary                       |

Example — a slower, higher-res capture:

```bash
WIDTH=900 FPS=16 SPEED=1.4 npm run demo:gif
```
