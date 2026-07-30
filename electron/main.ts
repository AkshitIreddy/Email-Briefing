import { app, BrowserWindow, ipcMain, shell, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { ChatCohere } from '@langchain/cohere';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import Store from 'electron-store';
import { convert } from 'html-to-text';
import * as dotenv from 'dotenv';
import { z } from 'zod';
import {
    TopicPlanSchema,
    TopicPlan,
    Tidbit,
    EmailContent,
    DashboardContentSchema,
    DashboardTemplate,
    SearchSource,
    DashboardImage,
    TopicDashboard,
    DashboardBriefing,
    EmailRef,
} from './types';
import pLimit from 'p-limit';

// Load environment variables
dotenv.config();

// ============================================
// FILE LOGGING
// Packaged apps have no console, so every console.log/warn/error is teed to
// %APPDATA%/email-briefing/logs/main.log and an in-memory buffer that the
// renderer can copy via the "Copy Logs" button.
// ============================================

const logBuffer: string[] = [];
let logFilePath = '';

function formatLogArg(a: any): string {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
}

function initFileLogging() {
    try {
        const logDir = path.join(app.getPath('userData'), 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        logFilePath = path.join(logDir, 'main.log');
        // Keep the previous session for post-mortems, start this one fresh
        if (fs.existsSync(logFilePath)) {
            try { fs.copyFileSync(logFilePath, path.join(logDir, 'main.prev.log')); } catch { /* best effort */ }
        }
        fs.writeFileSync(logFilePath, `=== Email Briefing v${app.getVersion()} session started ${new Date().toISOString()} ===\n`);
    } catch { /* logging must never crash the app */ }

    const wrap = (level: string, orig: (...args: any[]) => void) => (...args: any[]) => {
        orig(...args);
        try {
            const line = `[${new Date().toISOString().substring(11, 23)}] [${level}] ${args.map(formatLogArg).join(' ')}`;
            logBuffer.push(line);
            if (logBuffer.length > 8000) logBuffer.splice(0, logBuffer.length - 8000);
            if (logFilePath) fs.appendFileSync(logFilePath, line + '\n');
        } catch { /* never throw from logging */ }
    };
    console.log = wrap('INFO', console.log.bind(console));
    console.warn = wrap('WARN', console.warn.bind(console));
    console.error = wrap('ERROR', console.error.bind(console));
}

// ============================================
// CONFIGURATION
// ============================================

interface HistoryEntryStore {
    date: string;
    title: string;
    emailCount: number;
    dashboards?: TopicDashboard[];
    tidbits?: Tidbit[];
    emailContents?: Record<string, EmailContent>;
    briefing?: any; // legacy entries
}

const DEFAULT_SETTINGS = {
    accentColor: '#7c5cff',
    highlightColor: '#facc15',
    fontSize: 100,
    fontFamily: 'inter',
    lineHeight: 1.7,
    contentWidth: 'comfortable',
    theme: 'midnight',
    highlightsEnabled: true,
    animationsEnabled: true,
    backgroundMode: 'nebula',
};

const store = new Store<{
    cohereApiKey?: string;
    cohereKeyType?: 'trial' | 'production';
    briefingFocus?: string;
    googleTokens?: {
        access_token?: string;
        refresh_token?: string;
        expiry_date?: number;
    };
    briefingHistory?: HistoryEntryStore[];
    accessibilitySettings?: Record<string, any>;
}>({
    encryptionKey: 'briefing-os-local-secure-key-v1'
});

// Gmail OAuth scopes
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// OAuth2 client (will be initialized when credentials.json exists)
let oauth2Client: OAuth2Client | null = null;
let currentRedirectUri: string = 'http://localhost:3000/oauth2callback';

// ============================================
// WINDOW MANAGEMENT
// ============================================

let mainWindow: BrowserWindow | null = null;

function createWindow() {
    // 'hiddenInset' is macOS-only. On Windows/Linux the custom title bar needs
    // 'hidden' — passing 'hiddenInset' there left the window without proper
    // maximize/fullscreen window styles (both appeared greyed out).
    const isMac = process.platform === 'darwin';

    mainWindow = new BrowserWindow({
        title: 'Email Briefing',
        width: 1280,
        height: 840,
        minWidth: 940,
        minHeight: 620,
        resizable: true,
        maximizable: true,
        fullscreenable: true,
        // Windows 11 Mica effect
        backgroundMaterial: 'mica',
        backgroundColor: '#00000000',
        titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
        // titleBarOverlay draws the OS caption buttons; Windows/Linux only
        ...(isMac ? {} : {
            titleBarOverlay: {
                color: '#1a1a2e00',
                symbolColor: '#ffffff',
                height: 40,
            },
        }),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true,
            devTools: !app.isPackaged
        },
    });

    mainWindow.setMenuBarVisibility(false);

    // The menu bar is hidden, so bind F11 (and Alt+Enter) ourselves rather than
    // relying on the default menu's accelerator.
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || !mainWindow) return;
        const isF11 = input.key === 'F11';
        const isAltEnter = input.alt && input.key === 'Enter';
        if (isF11 || isAltEnter) {
            mainWindow.setFullScreen(!mainWindow.isFullScreen());
            event.preventDefault();
        }
    });

    console.log(`[Window] resizable=${mainWindow.isResizable()} maximizable=${mainWindow.isMaximizable()} fullscreenable=${mainWindow.isFullScreenable()}`);

    if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    initFileLogging();
    // Required for Windows toast notifications from the renderer
    app.setAppUserModelId('com.emailbriefing.app');
    console.log(`[App] Email Briefing v${app.getVersion()} starting (packaged: ${app.isPackaged})`);

    // SECURITY: Content Security Policy
    // img-src allows https so dashboard images (Wikimedia/Openverse/etc.) can render.
    // Network fetches for search run in the main process, not the renderer.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.cohere.ai https://api.cohere.com;"]
            }
        });
    });

    const userDataPath = app.getPath('userData');
    if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath, { recursive: true });
    }

    initializeOAuth();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ============================================
// OAUTH2 INITIALIZATION
// ============================================

function initializeOAuth() {
    // Priority 1: User Data directory (e.g. %APPDATA%/Email Briefing/credentials.json)
    const userDataPath = path.join(app.getPath('userData'), 'credentials.json');
    // Priority 2: App bundle (dev fallback)
    const appPath = path.join(app.getAppPath(), 'credentials.json');

    let credentialsPath = '';
    if (fs.existsSync(userDataPath)) {
        credentialsPath = userDataPath;
        console.log('[Auth] Loaded credentials from User Data:', userDataPath);
    } else if (fs.existsSync(appPath)) {
        credentialsPath = appPath;
        console.log('[Auth] Loaded credentials from App Path:', appPath);
    } else {
        console.warn('[Auth] credentials.json not found in User Data or App Path.');
    }

    if (credentialsPath) {
        try {
            const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
            const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

            currentRedirectUri = redirect_uris?.[0] || 'http://localhost:3000/oauth2callback';

            oauth2Client = new google.auth.OAuth2(
                client_id,
                client_secret,
                currentRedirectUri
            );

            // Persist refreshed tokens: google-auth-library auto-refreshes the
            // access token using the refresh_token, but the new token only lives
            // in memory unless we save it back to the store.
            oauth2Client.on('tokens', (newTokens) => {
                const existing = store.get('googleTokens') || {};
                store.set('googleTokens', { ...existing, ...newTokens });
                console.log('[Auth] Persisted refreshed Google tokens');
            });

            const savedTokens = store.get('googleTokens');
            if (savedTokens) {
                oauth2Client.setCredentials(savedTokens);
            }
        } catch (error) {
            console.error('Failed to load OAuth credentials:', error);
        }
    } else {
        console.warn('credentials.json not found. Gmail integration will not work.');
    }
}

// ============================================
// BASIC IPC HANDLERS
// ============================================

ipcMain.handle('check-auth-status', async () => {
    const apiKey = store.get('cohereApiKey') || process.env.COHERE_API_KEY;
    const tokens = store.get('googleTokens');

    return {
        isAuthenticated: !!(tokens?.access_token),
        hasApiKey: !!apiKey,
    };
});

ipcMain.handle('get-history', async () => {
    return store.get('briefingHistory') || [];
});

// Current session logs (for the "Copy Logs" button)
ipcMain.handle('get-logs', async () => {
    return logBuffer.join('\n') || 'No log entries yet this session.';
});

// Briefing focus/philosophy — the user-editable prompt block that decides
// what becomes a dashboard
ipcMain.handle('get-briefing-focus', async () => ({
    focus: store.get('briefingFocus') || DEFAULT_FOCUS,
    defaultFocus: DEFAULT_FOCUS,
}));

ipcMain.handle('set-briefing-focus', async (_, focus: string) => {
    const trimmed = (focus || '').trim();
    if (!trimmed || trimmed === DEFAULT_FOCUS) {
        store.delete('briefingFocus');
        console.log('[Settings] Briefing focus reset to default');
    } else {
        store.set('briefingFocus', trimmed);
        console.log(`[Settings] Briefing focus customized (${trimmed.length} chars)`);
    }
});

ipcMain.handle('clear-history', async () => {
    store.set('briefingHistory', []);
    console.log('[History] Cleared all history');
});

ipcMain.handle('get-settings', async () => {
    const saved = store.get('accessibilitySettings') || {};
    return { ...DEFAULT_SETTINGS, ...saved };
});

ipcMain.handle('set-settings', async (_, settings: any) => {
    store.set('accessibilitySettings', settings);
});

ipcMain.handle('get-cohere-key-type', async () => {
    return store.get('cohereKeyType') || 'trial';
});

ipcMain.handle('set-cohere-key-type', async (_, keyType: 'trial' | 'production') => {
    store.set('cohereKeyType', keyType);
    console.log(`[Settings] Cohere key type set to: ${keyType}`);
});

ipcMain.handle('set-api-key', async (_, key: string) => {
    store.set('cohereApiKey', key);
});

ipcMain.handle('get-api-key', async () => {
    const key = store.get('cohereApiKey') || process.env.COHERE_API_KEY;
    if (!key) return null;
    if (key.length > 8) {
        return `${key.substring(0, 3)}...${key.substring(key.length - 4)}`;
    }
    return '********';
});

ipcMain.handle('sign-in-google', async () => {
    if (!oauth2Client) {
        return {
            success: false,
            error: `Missing credentials.json. Please add it to: ${app.getPath('userData')}`
        };
    }

    try {
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent',
        });

        await shell.openExternal(authUrl);

        const urlObj = new URL(currentRedirectUri);
        const port = parseInt(urlObj.port || '80');
        const pathname = urlObj.pathname || '/oauth2callback';

        console.log(`OAuth Server starting. Expecting callback at: ${currentRedirectUri}`);

        const http = await import('http');
        const url = await import('url');

        return new Promise((resolve) => {
            const server = http.createServer(async (req, res) => {
                if (req.url?.startsWith(pathname)) {
                    const parsedUrl = url.parse(req.url, true);
                    const code = parsedUrl.query.code as string;

                    if (code) {
                        try {
                            const { tokens } = await oauth2Client!.getToken(code);
                            oauth2Client!.setCredentials(tokens);
                            store.set('googleTokens', tokens);

                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(`
                <html>
                  <body style="font-family: Inter, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #0b0b16; color: white;">
                    <div style="text-align: center;">
                      <h1>&#9989; Authentication Successful!</h1>
                      <p>You can close this window and return to Email Briefing.</p>
                      <script>
                        setTimeout(() => window.close(), 2000);
                      </script>
                    </div>
                  </body>
                </html>
              `);

                            server.close();
                            resolve({ success: true });
                        } catch (error: any) {
                            res.writeHead(500, { 'Content-Type': 'text/html' });
                            res.end('<h1>Authentication failed</h1>');
                            server.close();
                            resolve({ success: false, error: error.message });
                        }
                    }
                }
            });

            server.on('error', (e: any) => {
                console.error('OAuth Server Error:', e);
                if (e.code === 'EADDRINUSE') {
                    resolve({ success: false, error: `Port ${port} is already in use.` });
                } else if (e.code === 'EACCES') {
                    resolve({ success: false, error: `Permission denied for port ${port}. Please change redirect URI to use port 3000.` });
                } else {
                    resolve({ success: false, error: `Server error: ${e.message}` });
                }
            });

            server.listen(port, () => {
                console.log(`OAuth callback server listening on port ${port}`);
            });

            setTimeout(() => {
                server.close();
                resolve({ success: false, error: 'Authentication timed out' });
            }, 300000);
        });
    } catch (error: any) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('sign-out', async () => {
    store.delete('googleTokens');
    if (oauth2Client) {
        oauth2Client.revokeCredentials();
    }
});

ipcMain.handle('open-external', async (_, url: string) => {
    if (/^https?:\/\//i.test(url)) {
        await shell.openExternal(url);
    }
});

// ============================================
// FREE SEARCH TOOL (DuckDuckGo HTML + Wikipedia)
// No API keys required.
// ============================================

async function fetchWithTimeout(url: string, options: any = {}, timeoutMs = 12000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                ...(options.headers || {}),
            },
        });
    } finally {
        clearTimeout(timer);
    }
}

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
    return decodeHtmlEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Bing wraps result URLs in a /ck/a redirect with the real URL base64url-encoded
// in the "u" param (prefixed "a1"). Decode it back to the destination.
function decodeBingUrl(href: string): string {
    try {
        const u = new URL(href);
        if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
            const param = u.searchParams.get('u') || '';
            if (param.startsWith('a1')) {
                const b64 = param.slice(2).replace(/-/g, '+').replace(/_/g, '/');
                const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
                const decoded = Buffer.from(padded, 'base64').toString('utf8');
                if (decoded.startsWith('http')) return decoded;
            }
        }
    } catch { /* keep original */ }
    return href;
}

// Bing's plain HTML results page needs no key and no JS — last-resort fallback.
async function searchBing(query: string, maxResults = 5): Promise<SearchSource[]> {
    try {
        const res = await fetchWithTimeout(`https://www.bing.com/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) {
            console.warn(`[Search] Bing returned ${res.status} for "${query}"`);
            return [];
        }
        const html = await res.text();
        const results: SearchSource[] = [];

        const titleRegex = /<h2[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/g;
        const titles: Array<{ url: string; title: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = titleRegex.exec(html)) !== null && titles.length < maxResults + 3) {
            const hrefMatch = m[1].match(/href="([^"]+)"/);
            if (!hrefMatch) continue;
            const url = decodeBingUrl(decodeHtmlEntities(hrefMatch[1]));
            if (!url.startsWith('http')) continue;
            const title = stripTags(m[2]);
            if (!title) continue;
            titles.push({ url, title });
        }

        const snippets: string[] = [];
        const snippetRegex = /<div class="b_caption"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/g;
        while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults + 3) {
            snippets.push(stripTags(m[1]).substring(0, 400));
        }

        for (let i = 0; i < titles.length && results.length < maxResults; i++) {
            if (/bing\.com|microsoft\.com\/en-us\/bing/i.test(titles[i].url)) continue;
            results.push({ title: titles[i].title, url: titles[i].url, snippet: snippets[i] || '', engine: 'duckduckgo' });
        }
        console.log(`[Search] Bing "${query}" -> ${results.length} results`);
        return results;
    } catch (error: any) {
        console.warn(`[Search] Bing failed for "${query}": ${error.message}`);
        return [];
    }
}

// DDG's lite endpoint — simpler markup, separate rate-limit surface. Used as
// fallback when the html endpoint blocks or returns nothing.
async function searchDuckDuckGoLite(query: string, maxResults = 5): Promise<SearchSource[]> {
    try {
        const res = await fetchWithTimeout(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
        if (!res.ok) {
            console.warn(`[Search] DDG-lite returned ${res.status} for "${query}" — trying Bing`);
            return searchBing(query, maxResults);
        }
        const html = await res.text();
        if (/anomal|challenge|captcha/i.test(html.substring(0, 3000))) {
            console.warn(`[Search] DDG-lite served a block page for "${query}" — trying Bing`);
            return searchBing(query, maxResults);
        }

        // Attribute order and quote style vary — parse anchors generically
        const links: Array<{ url: string; title: string }> = [];
        const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
        let m: RegExpExecArray | null;
        while ((m = anchorRegex.exec(html)) !== null && links.length < maxResults + 5) {
            const attrs = m[1];
            const hrefMatch = attrs.match(/href=['"]([^'"]+)['"]/);
            if (!hrefMatch) continue;
            let href = decodeHtmlEntities(hrefMatch[1]);
            const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
            if (uddgMatch) {
                try { href = decodeURIComponent(uddgMatch[1]); } catch { /* keep raw */ }
            }
            if (href.startsWith('//')) href = 'https:' + href;
            if (!href.startsWith('http')) continue;
            if (/duckduckgo\.com|duck\.co/i.test(href)) continue;
            const title = stripTags(m[2]);
            if (!title || title.length < 3) continue;
            links.push({ url: href, title });
        }

        const snippets: string[] = [];
        const snippetRegex = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
        while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults + 5) {
            snippets.push(stripTags(m[1]));
        }

        const results: SearchSource[] = [];
        for (let i = 0; i < links.length && results.length < maxResults; i++) {
            results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '', engine: 'duckduckgo' });
        }
        if (results.length === 0) {
            console.warn(`[Search] DDG-lite parsed 0 results for "${query}" — trying Bing`);
            return searchBing(query, maxResults);
        }
        console.log(`[Search] DDG-lite "${query}" -> ${results.length} results`);
        return results;
    } catch (error: any) {
        console.warn(`[Search] DDG-lite failed for "${query}": ${error.message} — trying Bing`);
        return searchBing(query, maxResults);
    }
}

async function searchDuckDuckGo(query: string, maxResults = 5): Promise<SearchSource[]> {
    try {
        const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
        if (!res.ok) {
            console.warn(`[Search] DuckDuckGo returned ${res.status} for "${query}" — trying lite endpoint`);
            return searchDuckDuckGoLite(query, maxResults);
        }
        const html = await res.text();

        const results: SearchSource[] = [];
        const titleRegex = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

        const titles: Array<{ url: string; title: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = titleRegex.exec(html)) !== null && titles.length < maxResults + 3) {
            let href = decodeHtmlEntities(m[1]);
            // DDG wraps URLs: //duckduckgo.com/l/?uddg=<encoded>&rut=...
            const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
            if (uddgMatch) {
                try { href = decodeURIComponent(uddgMatch[1]); } catch { /* keep raw */ }
            }
            if (href.startsWith('//')) href = 'https:' + href;
            titles.push({ url: href, title: stripTags(m[2]) });
        }

        const snippets: string[] = [];
        while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults + 3) {
            snippets.push(stripTags(m[1]));
        }

        for (let i = 0; i < titles.length && results.length < maxResults; i++) {
            const t = titles[i];
            if (!t.url.startsWith('http')) continue;
            // Skip ad redirects
            if (t.url.includes('duckduckgo.com/y.js')) continue;
            results.push({
                title: t.title,
                url: t.url,
                snippet: snippets[i] || '',
                engine: 'duckduckgo',
            });
        }
        if (results.length === 0) {
            console.warn(`[Search] DuckDuckGo html parse yielded 0 for "${query}" — trying lite endpoint`);
            return searchDuckDuckGoLite(query, maxResults);
        }
        console.log(`[Search] DuckDuckGo "${query}" -> ${results.length} results`);
        return results;
    } catch (error: any) {
        console.warn(`[Search] DuckDuckGo failed for "${query}": ${error.message} — trying lite endpoint`);
        return searchDuckDuckGoLite(query, maxResults);
    }
}

interface WikiResult {
    source?: SearchSource;
    image?: DashboardImage;
}

async function searchWikipedia(query: string): Promise<WikiResult> {
    try {
        const searchRes = await fetchWithTimeout(
            `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`
        );
        if (!searchRes.ok) return {};
        const searchData: any = await searchRes.json();
        const title = searchData?.[1]?.[0];
        if (!title) return {};

        const summaryRes = await fetchWithTimeout(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
        );
        if (!summaryRes.ok) return {};
        const summary: any = await summaryRes.json();

        const result: WikiResult = {};
        if (summary?.extract) {
            result.source = {
                title: `Wikipedia: ${summary.title || title}`,
                url: summary?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
                snippet: String(summary.extract).substring(0, 600),
                engine: 'wikipedia',
            };
        }
        const thumb = summary?.originalimage?.source || summary?.thumbnail?.source;
        if (thumb) {
            result.image = {
                url: thumb,
                title: summary.title || title,
                sourceUrl: summary?.content_urls?.desktop?.page,
                provider: 'wikipedia',
            };
        }
        console.log(`[Search] Wikipedia "${query}" -> ${result.source ? 'summary' : 'none'}${result.image ? ' + image' : ''}`);
        return result;
    } catch (error: any) {
        console.warn(`[Search] Wikipedia failed for "${query}": ${error.message}`);
        return {};
    }
}

// ============================================
// FREE IMAGE TOOL (Wikipedia + Wikimedia Commons — no API key)
// Openverse was removed on purpose: its keyword matching surfaced random
// stock/ad-looking photos. Commons/Wikipedia results are keyword-matched
// and encyclopedic, so they stay on-topic.
// ============================================

// Wikimedia Commons image search (free, no key)
async function searchCommonsImages(query: string, maxResults = 5): Promise<DashboardImage[]> {
    try {
        const res = await fetchWithTimeout(
            `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${maxResults + 3}&gsrnamespace=6&prop=imageinfo&iiprop=url&iiurlwidth=640&format=json&origin=*`
        );
        if (!res.ok) return [];
        const data: any = await res.json();
        const pages = Object.values(data?.query?.pages || {});
        const images: DashboardImage[] = [];
        for (const page of pages as any[]) {
            if (images.length >= maxResults) break;
            const info = page?.imageinfo?.[0];
            const url = info?.thumburl || info?.url;
            if (!url || !/\.(jpe?g|png|webp|gif)$/i.test(String(info?.url || url))) continue;
            images.push({
                url: String(url),
                title: String(page?.title || '').replace(/^File:/, '').replace(/\.\w+$/, ''),
                sourceUrl: info?.descriptionurl || undefined,
                provider: 'commons',
            });
        }
        console.log(`[Images] Commons "${query}" -> ${images.length} images`);
        return images;
    } catch (error: any) {
        console.warn(`[Images] Commons failed for "${query}": ${error.message}`);
        return [];
    }
}

// Drop images whose URLs don't actually resolve to an image — prevents
// broken tiles in the dashboards. HEAD first, GET (headers only) as fallback.
async function validateImage(img: DashboardImage): Promise<DashboardImage | null> {
    try {
        let res = await fetchWithTimeout(img.url, { method: 'HEAD' }, 6000);
        let ct = res.headers.get('content-type') || '';
        if (!res.ok || !ct.startsWith('image/')) {
            res = await fetchWithTimeout(img.url, { method: 'GET' }, 8000);
            ct = res.headers.get('content-type') || '';
            try { await res.body?.cancel(); } catch { /* body already consumed/closed */ }
            if (!res.ok || !ct.startsWith('image/')) return null;
        }
        return img;
    } catch {
        return null;
    }
}

async function filterWorkingImages(images: DashboardImage[], max: number): Promise<DashboardImage[]> {
    // Dedupe by URL first
    const unique: DashboardImage[] = [];
    const seenUrls = new Set<string>();
    for (const img of images) {
        if (!img?.url || seenUrls.has(img.url)) continue;
        seenUrls.add(img.url);
        unique.push(img);
    }
    const results = await Promise.all(unique.map(validateImage));
    return results.filter((i): i is DashboardImage => i !== null).slice(0, max);
}

// ============================================
// EMAIL BODY EXTRACTION & CLEANING
// ============================================

const htmlToTextOptions = {
    wordwrap: false as const,
    preserveNewlines: false as const,
    selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'meta', format: 'skip' },
        { selector: 'link', format: 'skip' },
        { selector: 'noscript', format: 'skip' },
        { selector: 'nav', format: 'skip' },
        { selector: 'header', format: 'skip' },
        { selector: 'footer', format: 'skip' },
        { selector: 'aside', format: 'skip' },
        { selector: '[class*="unsubscribe"]', format: 'skip' },
        { selector: '[class*="advertisement"]', format: 'skip' },
        { selector: '[style*="display:none"]', format: 'skip' },
        { selector: '[style*="display: none"]', format: 'skip' },
        { selector: '[hidden]', format: 'skip' },
    ]
};

// Recursively walk MIME parts to find text/plain and text/html bodies.
// Nested multipart structures (multipart/mixed > multipart/alternative > text/*)
// are common; a single-level scan misses them.
function extractMimeBodies(payload: any): { plain: string; html: string } {
    let plain = '';
    let html = '';

    const walk = (part: any) => {
        if (!part) return;
        if (part.body?.data) {
            try {
                const content = Buffer.from(part.body.data, 'base64').toString('utf8');
                if (part.mimeType === 'text/plain') plain += content + '\n';
                else if (part.mimeType === 'text/html') html += content + '\n';
            } catch { /* skip malformed part */ }
        }
        if (Array.isArray(part.parts)) {
            for (const child of part.parts) walk(child);
        }
    };

    walk(payload);
    return { plain, html };
}

function hasHtmlTags(content: string): boolean {
    // Require a REAL html tag. Plain-text emails often contain <https://...>
    // style bracketed URLs — treating those as HTML collapses every newline
    // in the body into one giant unreadable line.
    return /<(!doctype|html|head|body|div|p[\s>]|br\s*\/?>|table|td|tr|th|span|a\s|img|h[1-6][\s>]|ul[\s>]|ol[\s>]|li[\s>]|strong[\s>]|em[\s>]|b>|i>|center|font)/i.test(content);
}

function cleanEmailBody(raw: string): string {
    let body = hasHtmlTags(raw) ? convert(raw, htmlToTextOptions) : raw;

    // Remove quoted replies
    body = body.split('\n').filter(line => !line.trim().startsWith('>')).join('\n');

    // Remove zero-width/invisible Unicode and control characters
    body = body.replace(/[\u200B-\u200D\uFEFF\u00AD\u034F\u061C\u2060-\u206F\u3164\uFFA0]/g, '');
    body = body.replace(/[\uFE00-\uFE0F]/g, '');
    body = body.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Remove URLs and bare email addresses (senders are tracked separately)
    body = body.replace(/https?:\/\/[^\s\)\]\}]+/gi, '');
    body = body.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');

    // Remove common boilerplate PHRASES only (not standalone words, so real
    // content mentioning e.g. "LinkedIn" survives)
    body = body.replace(/\b(unsubscribe( here)?|view (this email )?in( your)? browser|view online|open in app|manage (your )?preferences|update (your )?preferences|email preferences|forward to a friend|add us to your address book|was this email forwarded( to you)?|having trouble viewing|view as webpage|you( are)? receiv(ed|ing) this (email|message)|this email was sent to|if you no longer wish to receive|to unsubscribe|opt[- ]out|all rights reserved|privacy policy|terms of service|terms & conditions|copyright ©)\b[^\n]*/gi, '');
    body = body.replace(/\b(follow|like|join|find|connect with) us on [^\n.]{0,40}/gi, '');

    // Remove markdown image leftovers
    body = body.replace(/!\[.*?\]\(.*?\)/g, '');
    body = body.replace(/\[image:.*?\]/gi, '');

    // Remove decorative runs
    body = body.replace(/[\*\#\^\~\`]{2,}/g, '');
    body = body.replace(/[-=_]{4,}/g, '');

    // Normalize whitespace
    body = body.replace(/\t/g, ' ');
    body = body.replace(/[ ]{2,}/g, ' ');
    body = body.replace(/\n[ ]+/g, '\n');
    body = body.replace(/[ ]+\n/g, '\n');
    body = body.replace(/\n{3,}/g, '\n\n');

    // Drop lines that are pure punctuation
    body = body.split('\n').filter(line => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return true; // keep paragraph breaks
        if (trimmed.length < 3) return false;
        if (/^[\s\.\,\|\-\*\#\:\;\!\?\&\@\$\%\^\(\)\[\]\{\}\/\\]+$/.test(trimmed)) return false;
        return true;
    }).join('\n');

    return body.trim();
}

// Newsletters bundle many unrelated stories. Before writing a dashboard,
// keep only the blocks of each email that mention the topic's keywords
// (plus one neighbor each side for context) so other stories can't bleed in.
function selectTopicRelevantContent(body: string, keywords: Set<string>, budget: number): string {
    const blocks = body.split(/\n+/);
    const keep = new Array<boolean>(blocks.length).fill(false);
    blocks.forEach((block, i) => {
        const lower = block.toLowerCase();
        for (const k of keywords) {
            if (lower.includes(k)) {
                keep[i] = true;
                if (i > 0) keep[i - 1] = true;
                if (i + 1 < blocks.length) keep[i + 1] = true;
                break;
            }
        }
    });
    const selected = blocks.filter((_, i) => keep[i]).join('\n');
    // If barely anything matched, the whole email is probably about the topic
    // (or the keywords are too narrow) — fall back to the full text.
    if (selected.length < Math.min(1200, body.length * 0.25)) {
        return truncateAtBoundary(body, budget);
    }
    return truncateAtBoundary(selected, budget);
}

// Words too generic to identify a topic — ignored when comparing titles for
// duplicates and when selecting topic-relevant email excerpts.
const GENERIC_TOPIC_WORDS = new Set([
    'news', 'new', 'today', 'daily', 'weekly', 'latest', 'update', 'updates',
    'model', 'models', 'tool', 'tools', 'app', 'apps', 'agent', 'agents',
    'image', 'images', 'video', 'videos', 'voice', 'coding',
    'launch', 'launches', 'release', 'releases', 'announces', 'with', 'from', 'faces',
]);

function topicKeywords(topic: { title: string; search_queries: string[]; image_query: string }): Set<string> {
    const keywords = new Set<string>();
    for (const s of [topic.title, ...(topic.search_queries || []), topic.image_query || '']) {
        s.toLowerCase().replace(/[^a-z0-9\s.\-]/g, ' ').split(/\s+/).forEach(w => {
            if (w.length >= 4 && !GENERIC_TOPIC_WORDS.has(w)) keywords.add(w);
        });
    }
    return keywords;
}

function truncateAtBoundary(text: string, limit: number): string {
    if (text.length <= limit) return text;
    let truncated = text.substring(0, limit);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline);
    if (cutPoint > limit - 500) {
        truncated = truncated.substring(0, cutPoint + 1);
    }
    return truncated.trim();
}

// ============================================
// LLM HELPERS (LangChain + Cohere best practices)
// ============================================

// Cohere's Command models respond most reliably to JSON tasks when:
//  - the system preamble uses clear markdown sections (## Task, ## Output Format)
//  - the exact JSON schema is shown, with types, in a fenced block
//  - the instruction "Output ONLY the JSON object" appears at the END of the user turn
//  - temperature is low (0.2-0.3) for extraction/structuring tasks
// We validate with Zod and retry once with the validation error appended,
// which fixes the vast majority of malformed generations.

function extractJsonObject(text: string): any {
    let t = text.trim();
    // Strip markdown fences
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    // Slice from first { to last }
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first === -1 || last <= first) {
        throw new Error('No JSON object found in model response');
    }
    t = t.slice(first, last + 1);
    try {
        return stripNulls(JSON.parse(t));
    } catch (parseError) {
        // Long generations sometimes get cut off at the output-token ceiling,
        // leaving JSON that ends mid-value. Salvage the complete prefix rather
        // than discarding minutes of generation.
        const repaired = repairTruncatedJson(t);
        if (repaired !== null) {
            console.warn('[AI] Response JSON was truncated — repaired the complete prefix');
            return stripNulls(repaired);
        }
        throw parseError;
    }
}

// Trim a truncated JSON string back to its last complete value, then close
// every bracket still open. Returns null if nothing parseable can be salvaged.
function repairTruncatedJson(text: string): any | null {
    let cut = text.length;
    for (let i = 0; i < 200 && cut > 50; i++) {
        const idx = Math.max(text.lastIndexOf('}', cut - 1), text.lastIndexOf(']', cut - 1));
        if (idx <= 0) return null;
        let candidate = text.substring(0, idx + 1).replace(/,\s*$/, '');

        // Track open brackets outside of strings
        const stack: string[] = [];
        let inString = false;
        let escaped = false;
        for (const ch of candidate) {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') stack.push('}');
            else if (ch === '[') stack.push(']');
            else if (ch === '}' || ch === ']') stack.pop();
        }

        if (!inString) {
            try {
                return JSON.parse(candidate + stack.reverse().join(''));
            } catch { /* trim further back */ }
        }
        cut = idx;
    }
    return null;
}

// Models routinely emit `null` for optional fields ("fun_fact": null), which
// z.string().optional() rejects. Strip null values everywhere so optional
// really means optional.
function stripNulls(value: any): any {
    if (Array.isArray(value)) {
        return value.filter(v => v !== null && v !== undefined).map(stripNulls);
    }
    if (value !== null && typeof value === 'object') {
        const out: any = {};
        for (const [k, v] of Object.entries(value)) {
            if (v === null || v === undefined) continue;
            out[k] = stripNulls(v);
        }
        return out;
    }
    return value;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
        )
    ]);
}

interface InvokeOptions {
    timeoutMs: number;
    maxRetries: number;
    label: string;
    onAttempt?: (attempt: number) => void;
}

async function invokeStructured<T>(
    model: ChatCohere,
    systemPrompt: string,
    userPrompt: string,
    schema: { parse: (data: unknown) => T },
    opts: InvokeOptions
): Promise<T> {
    let correctionNote = '';
    let lastError: any = null;

    for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
        const start = Date.now();
        try {
            const messages = [
                new SystemMessage(systemPrompt),
                new HumanMessage(correctionNote ? `${userPrompt}\n\n${correctionNote}` : userPrompt),
            ];

            // Escalate the timeout on retries — rate-limited trial keys queue
            // requests server-side, so a retry often needs more time, not less
            const attemptTimeout = Math.round(opts.timeoutMs * (1 + 0.5 * (attempt - 1)));

            const totalChars = systemPrompt.length + userPrompt.length;
            console.log(`[AI:${opts.label}] Attempt ${attempt}/${opts.maxRetries}: sending ${totalChars.toLocaleString()} chars (~${Math.round(totalChars / 4).toLocaleString()} tokens), timeout ${attemptTimeout / 1000}s`);
            opts.onAttempt?.(attempt);

            const response = await withTimeout(
                // Always request the full output ceiling — truncated JSON is
                // the most expensive failure mode (minutes of generation lost)
                model.invoke(messages, { maxTokens: 4000 }),
                attemptTimeout,
                `Request timed out after ${attemptTimeout / 1000}s`
            );

            const rawText = response.content.toString();
            const parsed = extractJsonObject(rawText);
            const validated = schema.parse(parsed);
            console.log(`[AI:${opts.label}] OK in ${((Date.now() - start) / 1000).toFixed(1)}s (attempt ${attempt})`);
            return validated;
        } catch (error: any) {
            lastError = error;
            const message = error?.message || String(error);
            const lower = message.toLowerCase();
            const isFormatError = error instanceof z.ZodError || lower.includes('json');
            const isRetryable = isFormatError
                || lower.includes('429') || lower.includes('rate limit')
                || lower.includes('timeout') || lower.includes('timed out')
                || /5\d\d/.test(String(error?.response?.status || ''));

            console.warn(`[AI:${opts.label}] Attempt ${attempt}/${opts.maxRetries} failed: ${message.substring(0, 200)}`);

            if (attempt >= opts.maxRetries || !isRetryable) break;

            if (isFormatError) {
                const detail = error instanceof z.ZodError
                    ? JSON.stringify(error.issues.slice(0, 3))
                    : message.substring(0, 200);
                correctionNote = `IMPORTANT: Your previous response was not valid JSON matching the schema (error: ${detail}). Respond again with ONLY the corrected JSON object — no prose, no markdown fences.`;
            } else {
                await sleep(2000 * Math.pow(2, attempt - 1) + Math.random() * 1000);
            }
        }
    }
    throw lastError || new Error(`${opts.label} failed`);
}

// ============================================
// DASHBOARD TEMPLATES
// ============================================

interface TemplateSpec {
    id: DashboardTemplate;
    name: string;
    guidance: string;
}

const TEMPLATE_SPECS: TemplateSpec[] = [
    {
        id: 'pulse',
        name: 'Pulse Board',
        guidance: 'A metrics-anchored deep read. REQUIRED: 4-6 "stats" (numbers, percentages, dates, counts — pulled from the emails or web results), 6-9 "key_points" (each 2-3 full sentences), 3-4 "web_context" entries (each a 3-4 sentence paragraph).',
    },
    {
        id: 'editorial',
        name: 'Editorial',
        guidance: 'A magazine-style deep read. REQUIRED: a rich 6-8 sentence "overview" telling the full story, 2-3 "quotes" (verbatim or lightly-edited quotes from the emails/web results, with attribution), 5-7 "key_points" (each 2-3 full sentences), 3-4 "web_context" paragraphs for background. Include 2-4 "stats" if real figures exist.',
    },
    {
        id: 'timeline',
        name: 'Chronicle',
        guidance: 'A chronological view of how this topic is developing. REQUIRED: 5-8 "timeline" entries (label = date or phase like "Earlier this week" / "Next month"; text = 2-3 full sentences on what happened and why it matters), 4-6 "key_points" (each 2-3 sentences), 2-4 "stats". Order timeline oldest to newest.',
    },
    {
        id: 'spotlight',
        name: 'Spotlight',
        guidance: 'A hero-story layout focused on the single most important development. REQUIRED: a strong 5-7 sentence "overview", 6-8 "key_points" (each 2-3 full sentences digging into a different facet), one "fun_fact", 3-4 "web_context" paragraphs.',
    },
    {
        id: 'matrix',
        name: 'Matrix',
        guidance: 'A tagged facts grid covering many angles. REQUIRED: 10-14 "key_points" (each 1-2 COMPLETE sentences — no terse phrases — each with a "tag" like "Launch", "Funding", "Risk", "Deal"), 4-8 "stats", 2-3 "web_context" paragraphs.',
    },
];

// ============================================
// PROMPTS
// ============================================

// The default "philosophy" for what becomes a dashboard. Users can edit this
// in Settings; their custom text replaces this block in the planner prompt.
const DEFAULT_FOCUS = `Create topics ONLY for concrete, newsworthy stories. This includes BOTH:
- Product & tech news: launches, announcements, new features, model/software releases, funding, acquisitions, benchmarks, research results
- World news: geopolitics, elections, conflicts, economy and markets, science, health, climate, sports — any significant real-world event

Do NOT create topics for:
- Advertising/promotion (sponsor segments, product plugs, sales/discount emails)
- Opinion essays, think-pieces, philosophical or societal reflections ("AI and the future of X", "what Y means for society")
- Lifestyle content, career advice, reflective commentary, listicles of tips`;

function buildTopicPlanSystem(focus: string): string {
    return `You are the planning engine of an email-briefing application.

## Task
You receive a numbered list of emails (subject, sender, content excerpt). Extract EVERY distinct substantive TOPIC/STORY covered across them. Newsletters typically contain several unrelated stories each — create a SEPARATE topic for every substantial story. Do NOT collapse a multi-story newsletter into one topic.

## What counts as a topic (user's briefing philosophy)
${focus}

If an ENTIRE email contains nothing that qualifies, put its index in "skip_email_indexes" and create no topics for it. Non-qualifying SEGMENTS inside otherwise qualifying emails are simply ignored.

## Tidbits
Small qualifying mentions that are too minor for a full topic — a useful tool name, a version bump, a quick stat or fact — go in "tidbits" instead: one line each, max ~20 words, with a fitting "emoji", a "source_line" (the exact sentence from the email this tidbit came from, verbatim, max 30 words), and the email index. Do not duplicate content that is already a topic, and no two tidbits may state the same fact — if several emails mention the same thing, it becomes ONE tidbit.

## Rules
- HARD LIMIT: at most 14 topics and at most 12 tidbits. NEVER exceed these — merge closely-related stories and demote minor ones to tidbits instead.
- A story needs substantial source material (several sentences) to be a topic. A one-or-two-line mention is a TIDBIT, not a topic. Sponsor segments, webinars, and event promos are ADS — skip them entirely.
- NO DUPLICATES — FINAL CHECK: before answering, verify no two topics cover the same story; if two topics overlap substantially, MERGE them into one.
- Merge stories that are genuinely about the SAME subject (e.g. two newsletters covering the same product launch → one topic).
- The same email index MAY appear in multiple topics (one newsletter → many stories).
- Every email index must appear in at least one topic OR in "skip_email_indexes".
- "title": a short, specific topic title (3-8 words). Name the actual story — NEVER use vague prefixes like "AI news:" or "Update:".
- "category": one of "Tech", "Markets", "World", "AI", "Business", "Science", "Politics", "Health", "Culture", "General".
- "icon": one emoji that fits the topic.
- "search_queries": 1-2 web search queries that would surface CURRENT context for this topic. Make them specific (names, products, events), not generic.
- "image_query": a short 2-4 word visual query for finding a representative image (e.g. "OpenAI logo", "stock market chart", "SpaceX rocket launch").
- "importance": integer 1-10 rating how important this topic is for the reader — weigh impact, urgency, novelty, and how much source material covers it. 10 = major must-know development, 1 = minor footnote.

## Output Format
CRITICAL: Output MINIFIED JSON on a single line — no indentation, no line breaks, no pretty-printing. Your response must fit within the output limit; compact JSON is mandatory.
Output the keys in EXACTLY this order — "skip_email_indexes" first, then "tidbits", then "topics" (ordered most-important topic first) — so nothing essential is lost if the output is cut short.
Output ONLY the JSON object, no markdown fences, no commentary:
{
  "skip_email_indexes": [5],
  "tidbits": [
    { "text": "One-line mention too small for a topic", "emoji": "🔧", "source_line": "The exact sentence from the email it came from.", "email_index": 2 }
  ],
  "topics": [
    {
      "title": "string",
      "category": "string",
      "icon": "emoji",
      "email_indexes": [0, 3],
      "search_queries": ["query one", "query two"],
      "image_query": "short visual query",
      "importance": 8
    }
  ]
}`;
}

function buildDashboardSystemPrompt(template: TemplateSpec): string {
    return `You are a professional research analyst producing a TOPIC DASHBOARD for an executive briefing application.

## Task
You receive: (1) the full content of one or more emails about a single topic, and (2) numbered web search results providing outside context. Synthesize BOTH into a rich, factual dashboard.

## Template: "${template.name}"
${template.guidance}

## Content Rules
- STRICT TOPIC SCOPE — the single most important rule: this dashboard is about ONE topic only. The email excerpts may still contain fragments of OTHER stories (different companies, products, or events); you MUST exclude every fact that is not directly about this dashboard's topic. If a stat, name, or event does not belong to this topic, it does not appear anywhere in your output.
- DEPTH OVER BREVITY: this briefing is meant to be READ. Write complete, information-rich sentences — never compress into terse phrases or fragments. Each "key_points" text should be 2-3 full sentences (roughly 30-60 words) carrying real detail: names, numbers, context, implications. Aim for 600-1000 words of content across all sections.
- Be professional, precise, and information-dense. No filler, no hype — depth means more facts and explanation, not padding.
- Ground every claim in the emails or the numbered search results. NEVER invent statistics, quotes, dates, or names.
- "stats" values must be real figures found in the source material. If a figure is approximate, prefix with "~". If you cannot find enough real figures, return fewer stats — do not fabricate.
- "web_context" entries must come from the search results; set "source_index" to the matching result number.
- Mark promotional/sponsored content with "is_sponsored": true on that key point.
- Highlighting: wrap the 1-2 most important phrases in each "overview" and each "key_points" text in ==double equals== (e.g. "The company raised ==$40M Series B== led by..."). Use sparingly.
- "sentiment": overall sentiment of this topic for the reader ("Positive", "Negative", or "Neutral").

## Output Format
Output MINIFIED JSON on a single line — no indentation, no line breaks. Output ONLY a JSON object with this exact shape (omit optional arrays you have no content for, or use []):
{
  "headline": "string — punchy one-line headline",
  "overview": "string — a rich multi-sentence synthesis of the topic",
  "sentiment": "Positive" | "Negative" | "Neutral",
  "stats": [{ "label": "string", "value": "string", "context": "string (optional)" }],
  "key_points": [{ "text": "string — 2-3 full sentences", "tag": "string (optional)", "is_sponsored": false }],
  "timeline": [{ "label": "string", "text": "string — 2-3 full sentences" }],
  "quotes": [{ "text": "string", "attribution": "string (optional)" }],
  "web_context": [{ "title": "string", "text": "string — a 3-4 sentence paragraph", "source_index": 1 }],
  "fun_fact": "string (optional)"
}`;
}

// ============================================
// MAIN BRIEFING PIPELINE
// ============================================

interface EmailData {
    id: string;
    subject: string;
    from: string;
    body: string;
    ref: EmailRef;
}

function parseSender(from: string): EmailRef {
    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    if (senderMatch) {
        return {
            subject: '',
            senderName: senderMatch[1].replace(/"/g, '').trim(),
            senderEmail: senderMatch[2].trim(),
        };
    }
    return { subject: '', senderName: from, senderEmail: from };
}

function sendProgress(stage: string, message: string, current: number, total: number) {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    mainWindow?.webContents.send('briefing-progress', { stage, message, current, total, percent });
}

// True only for GOOGLE auth failures (expired/revoked session). Must never be
// applied to Cohere or other errors — clearing Google tokens on a non-Google
// 401 sends the user into an endless "sign in again" loop.
function isGoogleAuthError(error: any): boolean {
    const message = (error?.message || String(error)).toLowerCase();
    const status = error?.response?.status ?? error?.status ?? error?.code;
    return message.includes('invalid_grant')
        || message.includes('invalid credentials')
        || message.includes('login required')
        || message.includes('token has been expired or revoked')
        || status === 401;
}

const GOOGLE_SESSION_EXPIRED_MSG = 'Your Google session has expired. Please sign in again from Settings.';

// Only one briefing pipeline may be "live" at a time. Clicking Brief Me again
// supersedes the old run: its stages notice and bail out instead of racing the
// new run for rate-limited API capacity.
let activeRunId = 0;

ipcMain.handle('fetch-briefing', async () => {
    const runId = ++activeRunId;
    const isStale = () => runId !== activeRunId;
    const STALE_RESULT = { success: false, error: 'Superseded by a newer briefing request.' };
    try {
        const apiKey = store.get('cohereApiKey') || process.env.COHERE_API_KEY;
        if (!apiKey) {
            return { success: false, error: 'Cohere API key not configured. Please add it in settings.' };
        }

        const tokens = store.get('googleTokens');
        if (!tokens?.access_token || !oauth2Client) {
            return { success: false, error: 'Please sign in with Google first.' };
        }

        oauth2Client.setCredentials(tokens);

        // ========== STEP 1: FETCH EMAILS ==========
        sendProgress('emails', 'Fetching your inbox...', 0, 1);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        const query = `label:inbox -label:trash -label:spam`;
        let listResponse;
        try {
            listResponse = await gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults: 20,
            });
        } catch (gmailError: any) {
            if (isGoogleAuthError(gmailError)) {
                console.log('[Auth] Google auth failed while listing inbox. Clearing tokens.');
                store.delete('googleTokens');
                return { success: false, error: GOOGLE_SESSION_EXPIRED_MSG };
            }
            throw gmailError;
        }

        const messages = listResponse.data.messages || [];
        if (messages.length === 0) {
            return {
                success: false,
                error: 'No emails found in your Inbox.',
                emailCount: 0
            };
        }

        // ========== STEP 2: EXTRACT EMAIL BODIES ==========
        const emails: EmailData[] = [];
        const toFetch = messages.slice(0, 15);

        for (let i = 0; i < toFetch.length; i++) {
            if (isStale()) return STALE_RESULT;
            const message = toFetch[i];
            sendProgress('emails', 'Reading emails...', i + 1, toFetch.length);
            try {
                const emailResponse = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id!,
                    format: 'full',
                });

                const headers = emailResponse.data.payload?.headers || [];
                const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || 'No Subject';
                const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value || 'Unknown';

                const { plain, html } = extractMimeBodies(emailResponse.data.payload);

                // Prefer plain text when substantial, else fall back to converted HTML
                let body = '';
                const cleanedPlain = plain ? cleanEmailBody(plain) : '';
                if (cleanedPlain.length > 200) {
                    body = cleanedPlain;
                } else if (html) {
                    body = cleanEmailBody(html);
                    if (body.length < cleanedPlain.length) body = cleanedPlain;
                } else {
                    body = cleanedPlain;
                }

                // Last-resort fallback: Gmail's own snippet, so a scrape failure
                // never silently drops an email from the briefing
                if (body.trim().length < 80 && emailResponse.data.snippet) {
                    body = decodeHtmlEntities(emailResponse.data.snippet);
                    console.warn(`[Email] Body extraction thin for "${subject}"; using Gmail snippet fallback`);
                }

                // No content limit — the full cleaned text goes to the model
                // (HTML/boilerplate garbage is already stripped above). The cap
                // below only guards against pathological megabyte-sized bodies.
                body = truncateAtBoundary(body, 120000);

                if (body.trim().length >= 40) {
                    const ref = parseSender(from);
                    ref.subject = subject;
                    ref.emailId = message.id!;
                    emails.push({ id: message.id!, subject, from, body, ref });
                    console.log(`[Email ${emails.length}] "${subject.substring(0, 60)}" — ${body.length} chars`);
                } else {
                    console.warn(`[Email] Skipped "${subject}" — no usable content`);
                }
            } catch (error: any) {
                if (isGoogleAuthError(error)) {
                    console.log('[Auth] Google auth failed while reading an email. Clearing tokens.');
                    store.delete('googleTokens');
                    return { success: false, error: GOOGLE_SESSION_EXPIRED_MSG };
                }
                console.error(`Failed to fetch email ${message.id}:`, error);
            }
        }

        if (emails.length === 0) {
            return {
                success: false,
                error: 'Could not extract content from any emails.',
                emailCount: 0
            };
        }

        // Ship the cleaned email bodies to the renderer so sources can be
        // read in-app without another Gmail round-trip
        const emailContents: Record<string, EmailContent> = {};
        for (const e of emails) {
            emailContents[e.id] = {
                subject: e.subject,
                senderName: e.ref.senderName,
                senderEmail: e.ref.senderEmail,
                body: e.body,
            };
        }
        mainWindow?.webContents.send('email-contents', emailContents);

        // ========== STEP 3: TOPIC CLUSTERING ==========
        const cohereKeyType = store.get('cohereKeyType') || 'trial';
        const REQUEST_TIMEOUT_MS = cohereKeyType === 'production' ? 60000 : 90000;

        const plannerModel = new ChatCohere({
            model: 'command-r-08-2024',
            apiKey: apiKey,
            temperature: 0.2,
        });
        const writerModel = new ChatCohere({
            model: 'command-r-08-2024',
            apiKey: apiKey,
            temperature: 0.3,
        });

        sendProgress('topics', 'Identifying topics across your emails...', 0, 1);

        // The planner gets the FULL cleaned text of every email so no story is
        // missed. Command R has a 128k-token context (~350k chars of prompt
        // headroom); only if the combined inbox exceeds that budget do we trim
        // each email proportionally, largest-last, at sentence boundaries.
        const PLANNER_CHAR_BUDGET = 300000;
        const totalChars = emails.reduce((sum, e) => sum + e.body.length, 0);
        let plannerBodies = emails.map(e => e.body);
        if (totalChars > PLANNER_CHAR_BUDGET) {
            const ratio = PLANNER_CHAR_BUDGET / totalChars;
            plannerBodies = emails.map(e =>
                truncateAtBoundary(e.body, Math.max(2000, Math.floor(e.body.length * ratio)))
            );
            console.warn(`[Pipeline] Inbox text ${totalChars.toLocaleString()} chars exceeds planner budget; trimmed proportionally to ~${PLANNER_CHAR_BUDGET.toLocaleString()}`);
        }
        const emailList = emails.map((e, i) =>
            `[${i}] SUBJECT: ${e.subject}\n    FROM: ${e.from}\n    CONTENT: ${plannerBodies[i].replace(/\n+/g, ' ')}`
        ).join('\n\n');

        console.log(`[Pipeline] Topic planning over ${emails.length} emails (${emailList.length.toLocaleString()} chars of content)`);

        const briefingFocus = store.get('briefingFocus') || DEFAULT_FOCUS;
        const topicPlan: TopicPlan = await invokeStructured(
            plannerModel,
            buildTopicPlanSystem(briefingFocus),
            `Here are today's ${emails.length} emails:\n\n${emailList}\n\nExtract every distinct topic (skip non-qualifying content). Output ONLY the JSON object.`,
            TopicPlanSchema,
            // The planner reads the whole inbox in one call — give it double time
            {
                timeoutMs: REQUEST_TIMEOUT_MS * 2,
                maxRetries: 3,
                label: 'topic-plan',
                onAttempt: (a) => sendProgress('topics', a > 1 ? `Analyzing inbox (retry ${a}/3)...` : 'Analyzing your full inbox...', 0, 1),
            }
        );

        if (isStale()) return STALE_RESULT;

        // Sanitize: clamp indexes and drop empty topics. Emails MAY appear in
        // multiple topics (a newsletter contributes to several stories).
        const skipIndexes = new Set(topicPlan.skip_email_indexes.filter(i => Number.isInteger(i) && i >= 0 && i < emails.length));
        const seen = new Set<number>();
        let topics = topicPlan.topics
            .map(t => ({
                ...t,
                email_indexes: [...new Set(t.email_indexes.filter(i =>
                    Number.isInteger(i) && i >= 0 && i < emails.length
                ))],
            }))
            .filter(t => t.email_indexes.length > 0);
        topics.forEach(t => t.email_indexes.forEach(i => seen.add(i)));

        // Any email the planner neither used nor marked as skippable still gets a topic
        const orphans = emails.map((_, i) => i).filter(i => !seen.has(i) && !skipIndexes.has(i));
        for (const idx of orphans) {
            topics.push({
                title: emails[idx].subject.substring(0, 60),
                category: 'General',
                icon: '📧',
                email_indexes: [idx],
                search_queries: [emails[idx].subject.substring(0, 80)],
                image_query: emails[idx].subject.split(/\s+/).slice(0, 4).join(' '),
                importance: 3,
            });
        }

        // The model is told to merge duplicate stories but doesn't always
        // comply — dedupe programmatically by title-word overlap. Generic
        // domain words don't count: "AI news: X" and "AI news: Y" sharing
        // only "news" must NOT merge.
        const significantWords = (s: string) => new Set(
            s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
                .filter(w => w.length >= 3 && !GENERIC_TOPIC_WORDS.has(w))
        );
        const topicSimilarity = (a: string, b: string): number => {
            const A = significantWords(a);
            const B = significantWords(b);
            if (!A.size || !B.size) return 0;
            let inter = 0;
            for (const w of A) if (B.has(w)) inter++;
            return inter / Math.min(A.size, B.size);
        };
        const merged: typeof topics = [];
        for (const t of topics) {
            const existing = merged.find(m => topicSimilarity(m.title, t.title) >= 0.5);
            if (existing) {
                existing.email_indexes = [...new Set([...existing.email_indexes, ...t.email_indexes])];
                existing.importance = Math.max(existing.importance ?? 5, t.importance ?? 5);
                if ((t.search_queries?.length || 0) > (existing.search_queries?.length || 0)) {
                    existing.search_queries = t.search_queries;
                }
                console.log(`[Pipeline] Merged duplicate topic "${t.title}" into "${existing.title}"`);
            } else {
                merged.push({ ...t });
            }
        }
        topics = merged;

        // Rank by importance, THEN apply the ceiling — if there are more than
        // 20 topics, the least important ones are the ones dropped.
        const MAX_TOPICS = 20;
        topics.sort((a, b) => (b.importance ?? 5) - (a.importance ?? 5));
        if (topics.length > MAX_TOPICS) {
            const dropped = topics.slice(MAX_TOPICS).map(t => t.title).join(' | ');
            console.warn(`[Pipeline] ${topics.length} topics ranked; keeping top ${MAX_TOPICS}, dropping least-important: ${dropped}`);
            topics = topics.slice(0, MAX_TOPICS);
        }

        console.log(`[Pipeline] ${emails.length} emails -> ${topics.length} topics (${skipIndexes.size} non-news emails skipped): ${topics.map(t => t.title).join(' | ')}`);

        // Tidbits: one-line mentions too small for a dashboard. Dedupe by word
        // overlap — against other tidbits AND against topic titles, so the
        // same fact never appears twice.
        const rawTidbits: Tidbit[] = topicPlan.tidbits
            .filter(t => t.text && t.text.trim().length > 0)
            .map(t => ({
                text: t.text.trim(),
                emoji: t.emoji || '✨',
                quote: t.source_line?.trim() || undefined,
                source: t.email_index != null && emails[t.email_index] ? emails[t.email_index].ref : undefined,
            }));
        const tidbits: Tidbit[] = [];
        for (const t of rawTidbits) {
            if (tidbits.length >= 20) break;
            if (tidbits.some(k => topicSimilarity(k.text, t.text) >= 0.6)) {
                console.log(`[Pipeline] Dropped duplicate tidbit: "${t.text.substring(0, 60)}"`);
                continue;
            }
            if (topics.some(tp => topicSimilarity(tp.title, t.text) >= 0.7)) {
                console.log(`[Pipeline] Dropped tidbit duplicating topic: "${t.text.substring(0, 60)}"`);
                continue;
            }
            tidbits.push(t);
        }
        if (tidbits.length > 0) {
            console.log(`[Pipeline] ${tidbits.length} tidbits extracted`);
            mainWindow?.webContents.send('tidbits-generated', tidbits);
        }

        // ========== STEP 4: PER-TOPIC DASHBOARDS (search + generate) ==========
        const totalTopics = topics.length;
        let completedTopics = 0;
        sendProgress('dashboards', `Building ${totalTopics} dashboards...`, 0, totalTopics);

        const limit = pLimit(4); // topic-level concurrency (each does searches + 1 LLM call)

        const buildDashboard = async (topic: typeof topics[number], topicIndex: number): Promise<TopicDashboard | null> => {
            if (isStale()) return null;
            const template = TEMPLATE_SPECS[Math.floor(Math.random() * TEMPLATE_SPECS.length)];
            console.log(`[Topic ${topicIndex + 1}/${totalTopics}] "${topic.title}" — template: ${template.name}`);

            // --- Gather web context (all free, all failure-tolerant) ---
            const imageQuery = topic.image_query || topic.title;
            const searchQueries = topic.search_queries.slice(0, 2);
            const [ddgResults, wikiResult, commonsImages] = await Promise.all([
                Promise.all(searchQueries.map(q => searchDuckDuckGo(q, 4))).then(r => r.flat()),
                searchWikipedia(topic.search_queries[0] || topic.title),
                searchCommonsImages(imageQuery, 6),
            ]);

            const sources: SearchSource[] = [];
            const seenUrls = new Set<string>();
            for (const s of [...(wikiResult.source ? [wikiResult.source] : []), ...ddgResults]) {
                if (seenUrls.has(s.url)) continue;
                seenUrls.add(s.url);
                sources.push(s);
                if (sources.length >= 8) break;
            }

            const candidateImages: DashboardImage[] = [
                ...(wikiResult.image ? [wikiResult.image] : []),
                ...commonsImages,
            ];
            // Second, broader Commons pass only if the topic-specific query found little
            if (candidateImages.length < 2) {
                candidateImages.push(...await searchCommonsImages(topic.title, 4));
            }
            const images = await filterWorkingImages(candidateImages, 8);
            // Every dashboard gets imagery — fall back to calm scenic photos
            // (Picsum, keyless and reliable) when nothing topical was found
            if (images.length === 0) {
                const seed = encodeURIComponent(topic.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 24));
                images.push(
                    { url: `https://picsum.photos/seed/${seed}/1000/560`, title: 'A scenic breather', provider: 'scenic' },
                    { url: `https://picsum.photos/seed/${seed}-2/1000/560`, title: 'A scenic breather', provider: 'scenic' },
                );
            }
            console.log(`[Topic] "${topic.title}": ${images.length}/${candidateImages.length} images (scenic fallback: ${candidateImages.length === 0})`);

            // --- Compose generation prompt ---
            const topicEmails = topic.email_indexes.map(i => emails[i]);
            const perEmailBudget = Math.max(12000, Math.floor(100000 / topicEmails.length));
            // Feed the writer only the topic-relevant portions of each email —
            // whole newsletters made unrelated stories bleed into dashboards
            const keywords = topicKeywords(topic);
            const emailSection = topicEmails.map((e, i) =>
                `### EMAIL ${i + 1} (excerpts relevant to the topic)\nSUBJECT: ${e.subject}\nFROM: ${e.from}\nCONTENT:\n${selectTopicRelevantContent(e.body, keywords, perEmailBudget)}`
            ).join('\n\n');

            const searchSection = sources.length > 0
                ? sources.map((s, i) => `[${i + 1}] ${s.title}\n    ${s.snippet}`).join('\n\n')
                : '(no web results available — build the dashboard from the emails alone and omit web_context)';

            const userPrompt = `TOPIC: ${topic.title}

## Emails
${emailSection}

## Web Search Results
${searchSection}

Build the "${template.name}" dashboard for this topic now. Output ONLY the JSON object.`;

            try {
                const content = await invokeStructured(
                    writerModel,
                    buildDashboardSystemPrompt(template),
                    userPrompt,
                    DashboardContentSchema,
                    { timeoutMs: REQUEST_TIMEOUT_MS, maxRetries: 3, label: `dashboard:${topic.title.substring(0, 25)}` }
                );

                const dashboard: TopicDashboard = {
                    id: crypto.randomUUID(),
                    topic: topic.title,
                    category: topic.category,
                    icon: topic.icon,
                    template: template.id,
                    content,
                    sources,
                    images,
                    emails: topicEmails.map(e => e.ref),
                    generatedAt: new Date().toISOString(),
                };

                if (isStale()) return null;
                completedTopics++;
                sendProgress('dashboards', `Built "${topic.title}"`, completedTopics, totalTopics);
                mainWindow?.webContents.send('dashboard-generated', dashboard);
                return dashboard;
            } catch (error: any) {
                // No degraded fallback cards — a topic that can't be generated
                // properly is skipped (and logged), never rendered broken.
                console.error(`[Topic] Dashboard failed for "${topic.title}" — skipping it: ${error?.message}`);
                completedTopics++;
                sendProgress('dashboards', `Skipped "${topic.title}" (generation failed)`, completedTopics, totalTopics);
                return null;
            }
        };

        const start = Date.now();
        const dashboards = (await Promise.all(
            topics.map((t, i) => limit(() => buildDashboard(t, i)))
        )).filter((d): d is TopicDashboard => d !== null);

        if (isStale()) return STALE_RESULT;

        console.log(`[Pipeline] Built ${dashboards.length} dashboards in ${((Date.now() - start) / 1000).toFixed(1)}s`);

        const briefing: DashboardBriefing = {
            title: `Briefing — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`,
            dashboards,
            tidbits,
            emailContents,
        };

        // Save to history (max 10 entries)
        const history = store.get('briefingHistory') || [];
        history.unshift({
            date: new Date().toISOString(),
            title: briefing.title,
            emailCount: emails.length,
            dashboards,
            tidbits,
            emailContents,
        });
        if (history.length > 10) history.length = 10;
        store.set('briefingHistory', history);

        return {
            success: true,
            data: briefing,
            emailCount: emails.length,
        };

    } catch (error: any) {
        console.error('Briefing pipeline error:', error);

        if (error.response) {
            console.error('API Error Status:', error.response.status);
            console.error('API Error Body:', JSON.stringify(error.response.data || {}, null, 2).substring(0, 500));
        }

        const errorMessage = error.message || String(error);
        const lower = errorMessage.toLowerCase();

        // Gmail auth errors are handled where the Gmail calls happen (STEP 1/2).
        // Only an explicit OAuth invalid_grant is treated as a Google session
        // problem here — a generic "401" at this point is NOT Google (it's
        // usually Cohere) and clearing tokens for it caused a sign-in loop.
        if (lower.includes('invalid_grant')) {
            console.log('[Auth] Detected invalid_grant. Clearing tokens.');
            store.delete('googleTokens');
            return { success: false, error: GOOGLE_SESSION_EXPIRED_MSG };
        }

        // Cohere / model auth problems get their own honest message
        if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api token') || lower.includes('403')) {
            return {
                success: false,
                error: `Cohere rejected the request — your API key may be invalid or expired. Please check it in Settings. (${errorMessage.substring(0, 140)})`,
            };
        }

        return {
            success: false,
            error: errorMessage || 'An unexpected error occurred.',
        };
    }
});
