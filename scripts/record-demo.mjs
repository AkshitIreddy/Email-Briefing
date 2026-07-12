/**
 * Records the README demo GIF by driving the app (mock data) in a headless
 * Chrome via CDP screencast, then assembles a smooth, looping GIF with ffmpeg.
 *
 * This is the exact pipeline used to produce docs/demo.gif.
 *
 * Prerequisites:
 *   1. A Chromium-based browser installed (Chrome/Brave/Edge), or set
 *      PUPPETEER_EXECUTABLE_PATH to its binary.
 *   2. ffmpeg on your PATH.
 *   3. The dev server running with the mock API, e.g.:
 *        npm run dev            # then it serves http://localhost:5173
 *      The app auto-uses the mock API in dev mode. The mock reads
 *      window.__DEMO_PACE__ to slow its streaming for a smooth capture.
 *
 * Usage:
 *   node scripts/record-demo.mjs
 *
 * Config via env vars (all optional):
 *   DEMO_URL   default http://localhost:5173/?demo=1
 *   OUT        default docs/demo.gif
 *   WIDTH      default 720     (output width in px)
 *   FPS        default 14      (output frame rate)
 *   SPEED      default 1.85    (>1 speeds the loop up; keeps it smooth)
 *   PACE       default 1.6     (mock streaming slowdown while recording)
 *   CHROME     path to the browser binary (else auto-detected)
 */
import puppeteer from 'puppeteer-core';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = {
    url: process.env.DEMO_URL || 'http://localhost:5173/?demo=1',
    out: process.env.OUT || 'docs/demo.gif',
    width: Number(process.env.WIDTH || 720),
    fps: Number(process.env.FPS || 14),
    speed: Number(process.env.SPEED || 1.85),
    pace: Number(process.env.PACE || 1.6),
};
const VIEW = { width: 1280, height: 800 };

function findChrome() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    if (process.env.CHROME) return process.env.CHROME;
    const candidates = {
        win32: [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ],
        darwin: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ],
        linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/brave-browser'],
    }[process.platform] || [];
    const hit = candidates.find(p => fs.existsSync(p));
    if (!hit) throw new Error('No browser found. Set PUPPETEER_EXECUTABLE_PATH to a Chrome/Brave/Edge binary.');
    return hit;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Smoothly scroll a selector's scrollTop by `dist` over `dur` ms (in-page rAF).
const smoothScroll = (page, sel, dist, dur) => page.evaluate((sel, dist, dur) => new Promise(res => {
    const el = document.querySelector(sel); if (!el) return res();
    const start = el.scrollTop, t0 = performance.now();
    const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        el.scrollTop = start + dist * ease(p);
        if (p < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
}), sel, dist, dur);

function ffmpeg(args) {
    const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' '));
}

async function main() {
    const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-demo-'));
    const browser = await puppeteer.launch({
        executablePath: findChrome(),
        headless: true,
        args: [`--window-size=${VIEW.width},${VIEW.height}`, '--hide-scrollbars'],
        defaultViewport: VIEW,
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument((pace) => { window.__DEMO_PACE__ = pace; }, CFG.pace);
    await page.goto(CFG.url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('.brief-button', { timeout: 15000 });

    // CDP screencast streams frames as the page paints (~60fps) with timestamps.
    const client = await page.target().createCDPSession();
    let frame = 0;
    const times = [];
    client.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
        times.push(metadata?.timestamp ?? Date.now() / 1000);
        fs.writeFileSync(path.join(framesDir, String(frame++).padStart(4, '0') + '.jpg'), Buffer.from(data, 'base64'));
        try { await client.send('Page.screencastFrameAck', { sessionId }); } catch { /* frame dropped */ }
    });
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });

    // ---- scripted, relaxed walkthrough (real time drives pacing) ----
    await sleep(2200);                                                     // idle hero
    await page.click('.brief-button');
    await page.waitForFunction(() =>
        document.querySelectorAll('.topic-card').length >= 5 && !!document.querySelector('.quick-bit-chip'),
        { timeout: 20000 });
    await sleep(2800);                                                     // linger on grid + quick bits

    await page.$$eval('.topic-card', els => els[0].click());
    await page.waitForSelector('.dashboard-detail', { timeout: 10000 });
    await sleep(2200);                                                     // hero

    const maxScroll = await page.evaluate(() => {
        const m = document.querySelector('.main-content'); return m ? m.scrollHeight - m.clientHeight : 0;
    });
    const dist = Math.min(maxScroll, 1600);
    await smoothScroll(page, '.main-content', dist, 4200);                 // slow read-scroll down
    await sleep(1400);
    await smoothScroll(page, '.main-content', -dist, 1600);                // ease back up
    await sleep(500);

    await page.$eval('.back-btn', el => el.click());
    await page.waitForSelector('.topics-grid', { timeout: 10000 });
    await sleep(2600);                                                     // back on grid (loop point)

    await client.send('Page.stopScreencast');
    await sleep(200);
    await browser.close();

    // Per-frame durations from real timestamps, scaled by SPEED -> ffmpeg concat.
    const lines = [];
    for (let i = 0; i < frame; i++) {
        const d = (i < frame - 1) ? Math.max(0.016, Math.min(0.5, times[i + 1] - times[i])) : 0.4;
        lines.push(`file '${String(i).padStart(4, '0')}.jpg'`);
        lines.push(`duration ${(d / CFG.speed).toFixed(3)}`);
    }
    lines.push(`file '${String(frame - 1).padStart(4, '0')}.jpg'`);       // repeat last so it isn't dropped
    const concat = path.join(framesDir, 'concat.txt');
    fs.writeFileSync(concat, lines.join('\n'));

    // Two-pass palette for a clean, small, looping GIF.
    const palette = path.join(framesDir, 'palette.png');
    const vf = `fps=${CFG.fps},scale=${CFG.width}:-1:flags=lanczos`;
    ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concat, '-vf', `${vf},palettegen=max_colors=96:stats_mode=diff`, '-update', '1', '-frames:v', '1', palette]);
    fs.mkdirSync(path.dirname(CFG.out), { recursive: true });
    ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concat, '-i', palette,
        '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, CFG.out]);

    fs.rmSync(framesDir, { recursive: true, force: true });
    const kb = Math.round(fs.statSync(CFG.out).size / 1024);
    console.log(`Wrote ${CFG.out} (${frame} source frames -> ${(kb / 1024).toFixed(1)} MB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
