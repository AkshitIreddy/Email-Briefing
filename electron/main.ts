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
// CONFIGURATION
// ============================================

interface HistoryEntryStore {
    date: string;
    title: string;
    emailCount: number;
    dashboards?: TopicDashboard[];
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
    mainWindow = new BrowserWindow({
        title: 'Email Briefing',
        width: 1280,
        height: 840,
        minWidth: 940,
        minHeight: 620,
        maximizable: true,
        // Windows 11 Mica effect
        backgroundMaterial: 'mica',
        backgroundColor: '#00000000',
        titleBarStyle: 'hiddenInset',
        titleBarOverlay: {
            color: '#1a1a2e00',
            symbolColor: '#ffffff',
            height: 40,
        },
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true,
            devTools: !app.isPackaged
        },
    });

    mainWindow.setMenuBarVisibility(false);

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

async function searchDuckDuckGo(query: string, maxResults = 5): Promise<SearchSource[]> {
    try {
        const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
        if (!res.ok) {
            console.warn(`[Search] DuckDuckGo returned ${res.status} for "${query}"`);
            return [];
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
        console.log(`[Search] DuckDuckGo "${query}" -> ${results.length} results`);
        return results;
    } catch (error: any) {
        console.warn(`[Search] DuckDuckGo failed for "${query}": ${error.message}`);
        return [];
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
// FREE IMAGE TOOL (Openverse — no API key)
// ============================================

async function searchOpenverseImages(query: string, maxResults = 4): Promise<DashboardImage[]> {
    try {
        const res = await fetchWithTimeout(
            `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${maxResults + 4}&mature=false`
        );
        if (!res.ok) {
            console.warn(`[Images] Openverse returned ${res.status} for "${query}"`);
            return [];
        }
        const data: any = await res.json();
        const images: DashboardImage[] = [];
        for (const item of data?.results || []) {
            if (images.length >= maxResults) break;
            const url = item?.thumbnail || item?.url;
            if (!url || !String(url).startsWith('http')) continue;
            images.push({
                url: String(url),
                title: item?.title || undefined,
                sourceUrl: item?.foreign_landing_url || undefined,
                provider: 'openverse',
            });
        }
        console.log(`[Images] Openverse "${query}" -> ${images.length} images`);
        return images;
    } catch (error: any) {
        console.warn(`[Images] Openverse failed for "${query}": ${error.message}`);
        return [];
    }
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
    return /<[a-z][\s\S]*>/i.test(content);
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
    return JSON.parse(t);
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

            const response = await withTimeout(
                model.invoke(messages),
                opts.timeoutMs,
                `Request timed out after ${opts.timeoutMs / 1000}s`
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
        guidance: 'A metrics-first dashboard. REQUIRED: 4-6 "stats" (numbers, percentages, dates, counts — pulled from the emails or web results), 5-8 "key_points", 2-4 "web_context" entries. Include "action_items" if the emails imply any follow-ups.',
    },
    {
        id: 'editorial',
        name: 'Editorial',
        guidance: 'A magazine-style deep read. REQUIRED: a rich 3-5 sentence "overview", 2-3 "quotes" (verbatim or lightly-edited quotes from the emails/web results, with attribution), 4-6 "key_points", 3-5 "glossary" terms explaining jargon. Include 2-3 "web_context" entries for background.',
    },
    {
        id: 'timeline',
        name: 'Chronicle',
        guidance: 'A chronological view of how this topic is developing. REQUIRED: 4-7 "timeline" entries (label = date or phase like "Earlier this week" / "Next month", text = what happened or will happen), 4-6 "key_points", 2-4 "stats". Order timeline oldest to newest.',
    },
    {
        id: 'spotlight',
        name: 'Spotlight',
        guidance: 'A hero-story layout focused on the single most important development. REQUIRED: a strong 3-4 sentence "overview", 3-6 "action_items" (what a reader should do, watch, or decide), 4-6 "key_points", one "fun_fact". Include 2-3 "web_context" entries.',
    },
    {
        id: 'matrix',
        name: 'Matrix',
        guidance: 'A dense facts grid for fast scanning. REQUIRED: 8-12 short "key_points" (each under 25 words, each with a "tag" like "Launch", "Funding", "Risk", "Deal"), 4-6 "stats", 3-5 "glossary" terms. Keep everything terse.',
    },
];

// ============================================
// PROMPTS
// ============================================

const TOPIC_PLAN_SYSTEM = `You are the planning engine of an email-briefing application.

## Task
You receive a numbered list of emails (subject, sender, content preview). Group them into distinct TOPICS. Emails about the same subject matter MUST share one topic (e.g. two newsletters covering the same product launch). An email covering several unrelated stories should be assigned to the topic of its dominant story.

## Rules
- Create between 1 and 8 topics. Every email index must appear in exactly one topic.
- "title": a short, specific topic title (3-8 words). Not a vague label — name the actual subject.
- "category": one of "Tech", "Markets", "World", "AI", "Business", "Science", "Politics", "Health", "Culture", "General".
- "icon": one emoji that fits the topic.
- "search_queries": 1-3 web search queries that would surface CURRENT context for this topic. Make them specific (names, products, events), not generic.
- "image_query": a short 2-4 word visual query for finding a representative image (e.g. "OpenAI logo", "stock market chart", "SpaceX rocket launch").

## Output Format
Output ONLY a JSON object, no markdown fences, no commentary:
{
  "topics": [
    {
      "title": "string",
      "category": "string",
      "icon": "emoji",
      "email_indexes": [0, 3],
      "search_queries": ["query one", "query two"],
      "image_query": "short visual query"
    }
  ]
}`;

function buildDashboardSystemPrompt(template: TemplateSpec): string {
    return `You are a professional research analyst producing a TOPIC DASHBOARD for an executive briefing application.

## Task
You receive: (1) the full content of one or more emails about a single topic, and (2) numbered web search results providing outside context. Synthesize BOTH into a rich, factual dashboard.

## Template: "${template.name}"
${template.guidance}

## Content Rules
- Be professional, precise, and information-dense. No filler, no hype.
- Ground every claim in the emails or the numbered search results. NEVER invent statistics, quotes, dates, or names.
- "stats" values must be real figures found in the source material. If a figure is approximate, prefix with "~". If you cannot find enough real figures, return fewer stats — do not fabricate.
- "web_context" entries must come from the search results; set "source_index" to the matching result number.
- Mark promotional/sponsored content with "is_sponsored": true on that key point.
- Highlighting: wrap the 1-2 most important phrases in each "overview" and each "key_points" text in ==double equals== (e.g. "The company raised ==$40M Series B== led by..."). Use sparingly.
- "sentiment": overall sentiment of this topic for the reader ("Positive", "Negative", or "Neutral").

## Output Format
Output ONLY a JSON object with this exact shape (omit optional arrays you have no content for, or use []):
{
  "headline": "string — punchy one-line headline",
  "overview": "string — 2-5 sentence synthesis of the topic",
  "sentiment": "Positive" | "Negative" | "Neutral",
  "stats": [{ "label": "string", "value": "string", "context": "string (optional)" }],
  "key_points": [{ "text": "string", "tag": "string (optional)", "is_sponsored": false }],
  "timeline": [{ "label": "string", "text": "string" }],
  "quotes": [{ "text": "string", "attribution": "string (optional)" }],
  "action_items": ["string"],
  "glossary": [{ "term": "string", "definition": "string" }],
  "web_context": [{ "title": "string", "text": "string", "source_index": 1 }],
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

ipcMain.handle('fetch-briefing', async () => {
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
        const listResponse = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: 20,
        });

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

                body = truncateAtBoundary(body, 12000);

                if (body.trim().length >= 40) {
                    const ref = parseSender(from);
                    ref.subject = subject;
                    emails.push({ id: message.id!, subject, from, body, ref });
                    console.log(`[Email ${emails.length}] "${subject.substring(0, 60)}" — ${body.length} chars`);
                } else {
                    console.warn(`[Email] Skipped "${subject}" — no usable content`);
                }
            } catch (error) {
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

        const emailList = emails.map((e, i) =>
            `[${i}] SUBJECT: ${e.subject}\n    FROM: ${e.from}\n    PREVIEW: ${e.body.substring(0, 700).replace(/\n+/g, ' ')}`
        ).join('\n\n');

        const topicPlan = await invokeStructured(
            plannerModel,
            TOPIC_PLAN_SYSTEM,
            `Here are today's ${emails.length} emails:\n\n${emailList}\n\nGroup them into topics. Output ONLY the JSON object.`,
            TopicPlanSchema,
            { timeoutMs: REQUEST_TIMEOUT_MS, maxRetries: 3, label: 'topic-plan' }
        );

        // Sanitize: clamp indexes, drop empty topics, assign orphan emails
        const seen = new Set<number>();
        const topics = topicPlan.topics
            .map(t => ({
                ...t,
                email_indexes: t.email_indexes.filter(i =>
                    Number.isInteger(i) && i >= 0 && i < emails.length && !seen.has(i) && (seen.add(i), true)
                ),
            }))
            .filter(t => t.email_indexes.length > 0);

        const orphans = emails.map((_, i) => i).filter(i => !seen.has(i));
        for (const idx of orphans) {
            topics.push({
                title: emails[idx].subject.substring(0, 60),
                category: 'General',
                icon: '📧',
                email_indexes: [idx],
                search_queries: [emails[idx].subject.substring(0, 80)],
                image_query: emails[idx].subject.split(/\s+/).slice(0, 4).join(' '),
            });
        }

        console.log(`[Pipeline] ${emails.length} emails -> ${topics.length} topics: ${topics.map(t => t.title).join(' | ')}`);

        // ========== STEP 4: PER-TOPIC DASHBOARDS (search + generate) ==========
        const totalTopics = topics.length;
        let completedTopics = 0;
        sendProgress('dashboards', `Building ${totalTopics} dashboards...`, 0, totalTopics);

        const limit = pLimit(2); // topic-level concurrency (each does searches + 1 LLM call)

        const buildDashboard = async (topic: typeof topics[number], topicIndex: number): Promise<TopicDashboard | null> => {
            const template = TEMPLATE_SPECS[Math.floor(Math.random() * TEMPLATE_SPECS.length)];
            console.log(`[Topic ${topicIndex + 1}/${totalTopics}] "${topic.title}" — template: ${template.name}`);

            // --- Gather web context (all free, all failure-tolerant) ---
            const searchQueries = topic.search_queries.slice(0, 2);
            const [ddgResults, wikiResult, openverseImages] = await Promise.all([
                Promise.all(searchQueries.map(q => searchDuckDuckGo(q, 4))).then(r => r.flat()),
                searchWikipedia(topic.search_queries[0] || topic.title),
                searchOpenverseImages(topic.image_query || topic.title, 3),
            ]);

            const sources: SearchSource[] = [];
            const seenUrls = new Set<string>();
            for (const s of [...(wikiResult.source ? [wikiResult.source] : []), ...ddgResults]) {
                if (seenUrls.has(s.url)) continue;
                seenUrls.add(s.url);
                sources.push(s);
                if (sources.length >= 8) break;
            }

            const images: DashboardImage[] = [];
            if (wikiResult.image) images.push(wikiResult.image);
            images.push(...openverseImages);

            // --- Compose generation prompt ---
            const topicEmails = topic.email_indexes.map(i => emails[i]);
            const perEmailBudget = Math.max(3000, Math.floor(16000 / topicEmails.length));
            const emailSection = topicEmails.map((e, i) =>
                `### EMAIL ${i + 1}\nSUBJECT: ${e.subject}\nFROM: ${e.from}\nCONTENT:\n${truncateAtBoundary(e.body, perEmailBudget)}`
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

                completedTopics++;
                sendProgress('dashboards', `Built "${topic.title}"`, completedTopics, totalTopics);
                mainWindow?.webContents.send('dashboard-generated', dashboard);
                return dashboard;
            } catch (error: any) {
                console.error(`[Topic] Dashboard failed for "${topic.title}": ${error?.message}`);
                completedTopics++;
                sendProgress('dashboards', `Skipped "${topic.title}" (generation failed)`, completedTopics, totalTopics);

                // Degraded fallback so the topic still appears
                const fallback: TopicDashboard = {
                    id: crypto.randomUUID(),
                    topic: topic.title,
                    category: topic.category,
                    icon: topic.icon,
                    template: 'pulse',
                    content: {
                        headline: topic.title,
                        overview: `We couldn't generate the full dashboard for this topic (${(error?.message || 'unknown error').substring(0, 120)}). The source emails are listed below.`,
                        sentiment: 'Neutral',
                        stats: [],
                        key_points: topicEmails.map(e => ({ text: `Email: ${e.subject}` })),
                        timeline: [], quotes: [], action_items: [], glossary: [], web_context: [],
                    },
                    sources,
                    images,
                    emails: topicEmails.map(e => e.ref),
                    generatedAt: new Date().toISOString(),
                };
                mainWindow?.webContents.send('dashboard-generated', fallback);
                return fallback;
            }
        };

        const start = Date.now();
        const dashboards = (await Promise.all(
            topics.map((t, i) => limit(() => buildDashboard(t, i)))
        )).filter((d): d is TopicDashboard => d !== null);

        console.log(`[Pipeline] Built ${dashboards.length} dashboards in ${((Date.now() - start) / 1000).toFixed(1)}s`);

        const briefing: DashboardBriefing = {
            title: `Briefing — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`,
            dashboards,
        };

        // Save to history (max 10 entries)
        const history = store.get('briefingHistory') || [];
        history.unshift({
            date: new Date().toISOString(),
            title: briefing.title,
            emailCount: emails.length,
            dashboards,
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

        if (errorMessage.includes('invalid_grant') || errorMessage.includes('401')) {
            console.log('[Auth] Detected invalid_grant/401. Clearing tokens.');
            store.delete('googleTokens');
            return {
                success: false,
                error: 'Your Google session has expired. Please go to Settings and Sign In again.',
            };
        }

        return {
            success: false,
            error: errorMessage || 'An unexpected error occurred.',
        };
    }
});
