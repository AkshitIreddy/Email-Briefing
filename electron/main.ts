import { app, BrowserWindow, ipcMain, shell, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { ChatCohere } from '@langchain/cohere';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import Store from 'electron-store';
import { convert } from 'html-to-text';
import * as dotenv from 'dotenv';
import { BriefingSchema, Briefing } from './types';
import pLimit from 'p-limit';

// Load environment variables
dotenv.config();

// ============================================
// CONFIGURATION
// ============================================

const store = new Store<{
    cohereApiKey?: string;
    googleTokens?: {
        access_token?: string;
        refresh_token?: string;
        expiry_date?: number;
    };
    briefingHistory?: Array<{
        date: string;
        briefing: Briefing;
        emailCount: number;
    }>;
    accessibilitySettings?: {
        accentColor: string;
        fontSize: number;
        animationsEnabled: boolean;
        backgroundMode: 'simple' | 'snow' | 'nebula';
    };
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
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
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

    // Remove default menu bar
    mainWindow.setMenuBarVisibility(false);

    // Load the app
    if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
        mainWindow.loadURL('http://localhost:5173');
        // DevTools disabled - use View menu or Ctrl+Shift+I if needed
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    // SECURITY: Content Security Policy
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.cohere.ai https://api.cohere.com;"]
            }
        });
    });

    // Ensure userData directory exists for credentials.json
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

// ============================================
// OAUTH2 INITIALIZATION
// ============================================

function initializeOAuth() {
    // Priority 1: Check User Data directory (e.g. %APPDATA%/BriefingOS/credentials.json)
    // This allows users to easily drop their own credentials file.
    const userDataPath = path.join(app.getPath('userData'), 'credentials.json');

    // Priority 2: Check App Bundle (fallback for dev or bundled builds)
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

            // Use the first redirect URI from credentials
            currentRedirectUri = redirect_uris?.[0] || 'http://localhost:3000/oauth2callback';

            oauth2Client = new google.auth.OAuth2(
                client_id,
                client_secret,
                currentRedirectUri
            );

            // Restore saved tokens
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
// IPC HANDLERS
// ============================================

// Check authentication status
ipcMain.handle('check-auth-status', async () => {
    const apiKey = store.get('cohereApiKey') || process.env.COHERE_API_KEY;
    const tokens = store.get('googleTokens');

    return {
        isAuthenticated: !!(tokens?.access_token),
        hasApiKey: !!apiKey,
    };
});

// Get briefing history
ipcMain.handle('get-history', async () => {
    return store.get('briefingHistory') || [];
});

// Clear briefing history
ipcMain.handle('clear-history', async () => {
    store.set('briefingHistory', []);
    console.log('[History] Cleared all history');
});

// Get accessibility settings
ipcMain.handle('get-settings', async () => {
    return store.get('accessibilitySettings') || {
        accentColor: '#06b6d4',
        fontSize: 100,
        animationsEnabled: true,
        backgroundMode: 'simple'
    };
});

// Save accessibility settings
ipcMain.handle('set-settings', async (_, settings: any) => {
    store.set('accessibilitySettings', settings);
    console.log('[Settings] Saved accessibility settings');
});

// Get Cohere API key type (trial vs production)
ipcMain.handle('get-cohere-key-type', async () => {
    return store.get('cohereKeyType') || 'trial'; // Default to trial for safety
});

// Set Cohere API key type
ipcMain.handle('set-cohere-key-type', async (_, keyType: 'trial' | 'production') => {
    store.set('cohereKeyType', keyType);
    console.log(`[Settings] Cohere key type set to: ${keyType}`);
});

// Set Cohere API Key
ipcMain.handle('set-api-key', async (_, key: string) => {
    store.set('cohereApiKey', key);
});

// Get Cohere API Key
ipcMain.handle('get-api-key', async () => {
    const key = store.get('cohereApiKey') || process.env.COHERE_API_KEY;
    if (!key) return null;
    // Return masked key for UI display (e.g. sk-....1234)
    if (key.length > 8) {
        return `${key.substring(0, 3)}...${key.substring(key.length - 4)}`;
    }
    return '********';
});

// Google Sign In
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

        // Open browser for authentication
        await shell.openExternal(authUrl);

        // Dynamic Server Configuration
        const urlObj = new URL(currentRedirectUri);
        const port = parseInt(urlObj.port || '80');
        const pathname = urlObj.pathname || '/oauth2callback';

        console.log(`OAuth Server starting. Expecting callback at: ${currentRedirectUri}`);
        console.log(`Listening on Port: ${port}, Path: ${pathname}`);

        if (port === 80) {
            console.warn('WARNING: Using port 80 for OAuth callback. This requires admin privileges or might fail. We recommend using http://localhost:3000/oauth2callback in Google Console.');
        }

        // Create a simple local server to receive the callback
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
                  <body style="font-family: Inter, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #1a1a2e; color: white;">
                    <div style="text-align: center;">
                      <h1>✅ Authentication Successful!</h1>
                      <p>You can close this window and return to BriefingOS.</p>
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

            // Timeout after 5 minutes
            setTimeout(() => {
                server.close();
                resolve({ success: false, error: 'Authentication timed out' });
            }, 300000);
        });
    } catch (error: any) {
        return { success: false, error: error.message };
    }
});

// Sign out
ipcMain.handle('sign-out', async () => {
    store.delete('googleTokens');
    if (oauth2Client) {
        oauth2Client.revokeCredentials();
    }
});

// Open external URL
ipcMain.handle('open-external', async (_, url: string) => {
    await shell.openExternal(url);
});

// ============================================
// MAIN BRIEFING PIPELINE
// ============================================

ipcMain.handle('fetch-briefing', async () => {
    try {
        // Check API key
        const apiKey = store.get('cohereApiKey') || process.env.COHERE_API_KEY;
        if (!apiKey) {
            return { success: false, error: 'Cohere API key not configured. Please add it in settings.' };
        }

        // Check Google auth
        const tokens = store.get('googleTokens');
        if (!tokens?.access_token || !oauth2Client) {
            return { success: false, error: 'Please sign in with Google first.' };
        }

        oauth2Client.setCredentials(tokens);

        // ========== STEP 1: FETCH EMAILS ==========
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Build query for ANY email in Inbox (read or unread)
        const query = `label:inbox -label:trash -label:spam`;
        console.log('Fetching emails with query:', query);

        const listResponse = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: 20,
        });

        const messages = listResponse.data.messages || [];

        if (messages.length === 0) {
            return {
                success: false,
                error: 'No emails found in your Inbox. Please check if your Inbox is empty.',
                emailCount: 0
            };
        }

        // ========== STEP 2: FETCH EMAIL BODIES ==========
        interface EmailData {
            id: string;
            subject: string;
            from: string;
            body: string;
        }

        const emails: EmailData[] = [];
        const MAX_EMAIL_SIZE = 100 * 1024; // 100KB limit per email

        for (const message of messages.slice(0, 15)) { // Limit to 15 emails for speed
            try {
                const emailResponse = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id!,
                    format: 'full',
                });

                const headers = emailResponse.data.payload?.headers || [];
                const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || 'No Subject';
                const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value || 'Unknown';

                // Extract body content
                let body = '';
                const payload = emailResponse.data.payload;

                // ========== AGGRESSIVE HTML-TO-TEXT CONVERSION ==========
                // These selectors strip out junk that inflates token counts
                const htmlToTextOptions = {
                    wordwrap: false as const,
                    preserveNewlines: false as const,
                    selectors: [
                        // Skip links but keep link text
                        { selector: 'a', options: { ignoreHref: true } },
                        // Skip all images (tracking pixels, logos, etc.)
                        { selector: 'img', format: 'skip' },
                        // Skip scripts, styles, metadata
                        { selector: 'script', format: 'skip' },
                        { selector: 'style', format: 'skip' },
                        { selector: 'meta', format: 'skip' },
                        { selector: 'link', format: 'skip' },
                        { selector: 'noscript', format: 'skip' },
                        // Skip navigation and layout elements
                        { selector: 'nav', format: 'skip' },
                        { selector: 'header', format: 'skip' },
                        { selector: 'footer', format: 'skip' },
                        { selector: 'aside', format: 'skip' },
                        // Skip social media sections
                        { selector: '[class*="social"]', format: 'skip' },
                        { selector: '[class*="share"]', format: 'skip' },
                        { selector: '[class*="footer"]', format: 'skip' },
                        { selector: '[class*="unsubscribe"]', format: 'skip' },
                        { selector: '[class*="header"]', format: 'skip' },
                        { selector: '[class*="nav"]', format: 'skip' },
                        { selector: '[class*="menu"]', format: 'skip' },
                        { selector: '[class*="sidebar"]', format: 'skip' },
                        { selector: '[class*="advertisement"]', format: 'skip' },
                        { selector: '[class*="promo"]', format: 'skip' },
                        { selector: '[class*="banner"]', format: 'skip' },
                        // Skip hidden elements
                        { selector: '[style*="display:none"]', format: 'skip' },
                        { selector: '[style*="display: none"]', format: 'skip' },
                        { selector: '[hidden]', format: 'skip' },
                        // Skip buttons (usually CTAs)
                        { selector: 'button', format: 'skip' },
                    ]
                };

                // Track sizes at each stage for clear logging
                let rawHtmlSize = 0;
                let afterHtmlToTextSize = 0;
                let afterRegexCleanSize = 0;
                let finalSize = 0;

                // Helper to detect if content has HTML tags
                const hasHtmlTags = (content: string): boolean => {
                    return /<[a-z][\s\S]*>/i.test(content);
                };

                // Helper to clean content (always run HTML-to-text if HTML detected)
                const cleanHtml = (content: string): string => {
                    if (hasHtmlTags(content)) {
                        return convert(content, htmlToTextOptions);
                    }
                    return content;
                };

                if (payload?.body?.data) {
                    const rawContent = Buffer.from(payload.body.data, 'base64').toString('utf8');
                    rawHtmlSize = rawContent.length;
                    body = cleanHtml(rawContent);
                    afterHtmlToTextSize = body.length;
                } else if (payload?.parts) {
                    // Prefer text/plain, but fall back to text/html
                    let plainText = '';
                    let htmlContent = '';

                    for (const part of payload.parts) {
                        if (part.mimeType === 'text/plain' && part.body?.data) {
                            plainText = Buffer.from(part.body.data, 'base64').toString('utf8');
                        } else if (part.mimeType === 'text/html' && part.body?.data) {
                            htmlContent = Buffer.from(part.body.data, 'base64').toString('utf8');
                        }
                    }

                    // Use plain text if available, but ALWAYS clean it in case it has HTML fragments
                    if (plainText) {
                        rawHtmlSize = plainText.length;
                        body = cleanHtml(plainText);
                        afterHtmlToTextSize = body.length;
                    } else if (htmlContent) {
                        rawHtmlSize = htmlContent.length;
                        body = cleanHtml(htmlContent);
                        afterHtmlToTextSize = body.length;
                    }
                }

                if (body) {
                    // ========== AGGRESSIVE POST-PROCESSING ==========

                    // Remove quoted replies (lines starting with >)
                    body = body.split('\n').filter(line => !line.trim().startsWith('>')).join('\n');

                    // Remove zero-width characters and invisible Unicode (common in email spam/tracking)
                    body = body.replace(/[\u200B-\u200D\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180D\u2060-\u206F\u3164\uFFA0]/g, '');
                    // Remove variation selectors
                    body = body.replace(/[\uFE00-\uFE0F]/g, '');
                    // Remove other problematic Unicode ranges (emojis modifiers, combining marks, etc.)
                    body = body.replace(/[\u0300-\u036F]/g, ''); // Combining diacritical marks
                    body = body.replace(/[\u1AB0-\u1AFF]/g, ''); // Combining diacritical marks extended
                    body = body.replace(/[\u1DC0-\u1DFF]/g, ''); // Combining diacritical marks supplement
                    body = body.replace(/[\uFE20-\uFE2F]/g, ''); // Combining half marks
                    // Remove control characters (except newlines and tabs)
                    body = body.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

                    // Remove URLs (http/https links)
                    body = body.replace(/https?:\/\/[^\s\)\]\}]+/gi, '');

                    // Remove email addresses (except in From field which we track separately)
                    body = body.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');

                    // Remove common email boilerplate
                    body = body.replace(/Unsubscribe|View in browser|View online|Open in app|Copyright ©|All rights reserved|Privacy Policy|Terms of Service|Terms & Conditions|Manage preferences|Update preferences|Email preferences|Click here|Read more|Learn more|See more|View more|Read online|Sent to:|You received this|This email was sent|If you no longer wish|To unsubscribe|Opt out|Forward to a friend|Add us to your address book|Was this email forwarded|Having trouble viewing|View as webpage/gi, '');

                    // Remove social media mentions
                    body = body.replace(/Follow us on|Like us on|Connect with us|Join us on|Find us on|Twitter|Facebook|Instagram|LinkedIn|YouTube|TikTok/gi, '');

                    // Remove phone numbers
                    body = body.replace(/\+?[\d\s\-\(\)]{10,}/g, '');

                    // Remove markdown image syntax leftovers
                    body = body.replace(/!\[.*?\]\(.*?\)/g, '');
                    body = body.replace(/\[image:.*?\]/gi, '');
                    body = body.replace(/View image:.*$/gm, '');

                    // Remove excessive special characters and formatting
                    body = body.replace(/[\*\#\^\~\`]{2,}/g, '');
                    body = body.replace(/[-=_]{3,}/g, '');

                    // Normalize whitespace
                    body = body.replace(/\t/g, ' ');
                    body = body.replace(/[ ]{2,}/g, ' ');
                    body = body.replace(/\n[ ]+/g, '\n');
                    body = body.replace(/[ ]+\n/g, '\n');
                    body = body.replace(/\n{3,}/g, '\n\n');

                    // Remove lines that are just punctuation or very short (likely formatting)
                    body = body.split('\n').filter(line => {
                        const trimmed = line.trim();
                        if (trimmed.length < 3) return false;
                        if (/^[\s\.\,\|\-\*\#\:\;\!\?\&\@\$\%\^\(\)\[\]\{\}\/\\]+$/.test(trimmed)) return false;
                        return true;
                    }).join('\n');

                    body = body.trim();
                    afterRegexCleanSize = body.length;

                    // ========== SMART TRUNCATION (after cleaning) ==========
                    const CLEAN_LIMIT = 15000; // 15k chars - generous limit, Cohere has 128k context
                    let truncatedAmount = 0;
                    if (body.length > CLEAN_LIMIT) {
                        // Try to truncate at a sentence boundary
                        let truncated = body.substring(0, CLEAN_LIMIT);
                        const lastPeriod = truncated.lastIndexOf('.');
                        const lastNewline = truncated.lastIndexOf('\n');
                        const cutPoint = Math.max(lastPeriod, lastNewline, CLEAN_LIMIT - 500);
                        if (cutPoint > CLEAN_LIMIT - 500) {
                            truncated = truncated.substring(0, cutPoint + 1);
                        }
                        truncatedAmount = body.length - truncated.length;
                        body = truncated.trim();
                    }
                    finalSize = body.length;

                    if (body.trim().length > 100) {
                        emails.push({ id: message.id!, subject, from, body });

                        // Clear, detailed logging
                        const htmlJunkRemoved = rawHtmlSize - afterHtmlToTextSize;
                        const regexJunkRemoved = afterHtmlToTextSize - afterRegexCleanSize;
                        const totalJunkRemoved = htmlJunkRemoved + regexJunkRemoved;

                        console.log(`[Email ${emails.length}] "${subject.substring(0, 55)}..."`);
                        console.log(`  ├─ Raw HTML:        ${rawHtmlSize.toLocaleString().padStart(7)} chars`);
                        console.log(`  ├─ After HTML→Text: ${afterHtmlToTextSize.toLocaleString().padStart(7)} chars (removed ${htmlJunkRemoved.toLocaleString()} HTML/CSS/tags)`);
                        console.log(`  ├─ After Regex:     ${afterRegexCleanSize.toLocaleString().padStart(7)} chars (removed ${regexJunkRemoved.toLocaleString()} URLs/boilerplate)`);
                        if (truncatedAmount > 0) {
                            console.log(`  ├─ After Truncate:  ${finalSize.toLocaleString().padStart(7)} chars (cut ${truncatedAmount.toLocaleString()} to fit 15k limit)`);
                        }
                        console.log(`  └─ FINAL: ${rawHtmlSize.toLocaleString()} → ${finalSize.toLocaleString()} chars (${Math.round((1 - finalSize / rawHtmlSize) * 100)}% total reduction)`);
                    }
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

        console.log(`[Pipeline] Fetched ${emails.length} emails. Starting parallel summarization...`);

        // ========== STEP 3: PARALLEL PER-EMAIL AI SUMMARIZATION ==========
        const model = new ChatCohere({
            model: 'command-r-08-2024',
            apiKey: apiKey,
            temperature: 0,
        });

        // Concurrency limiter: Process emails with controlled parallelism
        // Too many parallel requests can cause some to hang/timeout
        // 5 concurrent requests is a good balance between speed and reliability
        const limit = pLimit(5);

        // Progress Tracking
        let processedCount = 0;
        const totalEmails = emails.length;

        const perEmailSystemPrompt = `You are a PROFESSIONAL executive briefing assistant. 
Your goal is to summarize the provided email into structured JSON.

CRITICAL GUIDELINES:
- Be PROFESSIONAL and SERIOUS. No humor, jokes, or casual language.
- Present information in CLEAR, ORGANIZED bullet points.
- Be CONCISE but COMPLETE.
- Structure is paramount.

JSON SCHEMA:
{
  "category": "Tech" | "Markets" | "AI" | "World" | "Business" | "Science" | "Politics" | "General",
  "icon": "Single emoji representing the category",
  "headline": "Professional one-line headline summarizing the core topic",
  "bullet_points": ["Key insight 1", "Key insight 2", "Key insight 3"],
  "detailed_points": [
    {"text": "Full organized point 1", "isSponsored": false},
    {"text": "Full organized point 2", "isSponsored": false},
    {"text": "This is a sponsored/ad section", "isSponsored": true},
    ...up to 10 points
  ],
  "sentiment": "Neutral" | "Good" | "Bad"
}

INSTRUCTIONS:
1. Extract ALL key information into detailed_points (comprehensive, organized).
2. For EACH detailed_point, set isSponsored: true ONLY if that specific point is promotional/advertising content.
3. Summarize the most important 3-5 NON-SPONSORED items into bullet_points.
4. RETURN ONLY VALID JSON. No markdown, no extra text.
`;

        // Retry configuration
        const MAX_RETRIES = 3;
        const BASE_DELAY_MS = 2000; // 2 seconds base delay

        // Dynamic timeout based on API key type
        // Trial keys have slower response times due to rate limiting, need longer timeout
        // Production keys are faster and more reliable
        const cohereKeyType = store.get('cohereKeyType') || 'trial';
        const REQUEST_TIMEOUT_MS = cohereKeyType === 'production' ? 60000 : 90000; // 60s for production, 90s for trial
        console.log(`[AI] Using ${cohereKeyType} timeout: ${REQUEST_TIMEOUT_MS / 1000}s`);

        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        // Timeout wrapper for API calls
        const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
            return Promise.race([
                promise,
                new Promise<T>((_, reject) =>
                    setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
                )
            ]);
        };

        const normalizeBlock = (block: any): any => ({
            category: block.category || 'General',
            icon: block.icon || '💡',
            headline: block.headline || block.title || 'Update',
            bullet_points: Array.isArray(block.bullet_points) ? block.bullet_points : ['Details unavailable'],
            detailed_points: Array.isArray(block.detailed_points) ? block.detailed_points : [],
            sentiment: block.sentiment || 'Neutral',
            isSponsored: block.isSponsored === true,
            sourceEmailSubject: block.sourceEmailSubject || '',
            senderName: block.senderName || '',
            senderEmail: block.senderEmail || ''
        });

        const summarizeEmail = async (email: EmailData, emailIndex: number): Promise<any> => {
            const userPrompt = `EMAIL SUBJECT: ${email.subject}\nFROM: ${email.from}\n\nCONTENT:\n${email.body}`;

            console.log(`\n${'='.repeat(60)}`);
            console.log(`[AI] START Processing Email ${emailIndex + 1}/${totalEmails}`);
            console.log(`[AI] Subject: "${email.subject}"`);
            console.log(`[AI] From: ${email.from}`);
            console.log(`[AI] Body Length: ${email.body.length} characters`);
            console.log(`[AI] Body Preview: "${email.body.substring(0, 150).replace(/\n/g, ' ')}..."`);

            // Retry loop
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                const attemptLabel = attempt > 1 ? ` (Retry ${attempt}/${MAX_RETRIES})` : '';
                console.log(`[AI] Sending request to Cohere API...${attemptLabel}`);

                // On retry, log first 200 chars to help debug problematic content
                if (attempt > 1) {
                    const contentPreview = email.body.substring(0, 200).replace(/\n/g, ' ').trim();
                    console.log(`[AI] Content preview (first 200 chars): "${contentPreview}..."`);
                }

                const startTime = Date.now();

                try {
                    // Wrap the API call with a timeout
                    const response = await withTimeout(
                        model.invoke([
                            new SystemMessage(perEmailSystemPrompt),
                            new HumanMessage(userPrompt),
                        ]),
                        REQUEST_TIMEOUT_MS,
                        `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
                    );

                    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                    console.log(`[AI] Response received in ${duration}s`);

                    // Update progress
                    processedCount++;
                    const percent = Math.round((processedCount / totalEmails) * 100);

                    // Emit progress event to renderer
                    mainWindow?.webContents.send('briefing-progress', {
                        current: processedCount,
                        total: totalEmails,
                        percent: percent
                    });

                    let cleanJson = response.content.toString();
                    console.log(`[AI] Raw response length: ${cleanJson.length} chars`);

                    cleanJson = cleanJson.replace(/```json/g, '').replace(/```/g, '').trim();
                    const parsed = JSON.parse(cleanJson);

                    console.log(`[AI] SUCCESS - Category: ${parsed.category}, Headline: "${parsed.headline?.substring(0, 50)}..."`);
                    console.log(`[AI] END Email ${emailIndex + 1}/${totalEmails} - ${duration}s`);
                    console.log(`${'='.repeat(60)}\n`);

                    // Add source email info and sender
                    parsed.sourceEmailSubject = email.subject;

                    // Parse sender name and email from "Name <email@example.com>" format
                    const senderMatch = email.from.match(/^(.+?)\s*<(.+?)>$/);
                    if (senderMatch) {
                        parsed.senderName = senderMatch[1].replace(/"/g, '').trim();
                        parsed.senderEmail = senderMatch[2].trim();
                    } else {
                        parsed.senderName = email.from;
                        parsed.senderEmail = email.from;
                    }

                    // ========== STREAMING CHANGE: Emit card immediately ==========
                    const normalized = normalizeBlock(parsed);
                    mainWindow?.webContents.send('briefing-card-generated', normalized);
                    // ==========================================================

                    return normalized;

                } catch (error: any) {
                    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                    const errorMessage = error?.message || String(error);
                    const errorLower = errorMessage.toLowerCase();
                    const httpStatus = error?.response?.status;

                    // Determine if error is retryable
                    const isRateLimited = httpStatus === 429 || errorMessage.includes('429') || errorLower.includes('rate limit');
                    const isServerError = httpStatus >= 500 && httpStatus < 600;
                    // Check for various timeout patterns: "timeout", "timed out", "ETIMEDOUT"
                    const isTimeout = errorLower.includes('timeout') || errorLower.includes('timed out') || errorMessage.includes('ETIMEDOUT');
                    const isRetryable = isRateLimited || isServerError || isTimeout;

                    console.log(`[AI] FAILED after ${duration}s (Attempt ${attempt}/${MAX_RETRIES})`);
                    console.log(`[AI] Error Type: ${error?.constructor?.name || 'Unknown'}`);
                    console.log(`[AI] Error Message: ${errorMessage}`);
                    console.log(`[AI] Is Retryable: ${isRetryable} (RateLimit: ${isRateLimited}, ServerError: ${isServerError}, Timeout: ${isTimeout})`);
                    if (httpStatus) {
                        console.log(`[AI] HTTP Status: ${httpStatus}`);
                    }
                    if (error?.response?.data) {
                        console.log(`[AI] Response Data: ${JSON.stringify(error.response.data).substring(0, 300)}`);
                    }

                    // Retry if retryable and not last attempt
                    if (isRetryable && attempt < MAX_RETRIES) {
                        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff: 2s, 4s, 8s
                        const jitter = Math.random() * 1000; // Add 0-1s jitter
                        const totalDelay = Math.round(delayMs + jitter);
                        console.log(`[AI] Retrying in ${totalDelay}ms... (${isRateLimited ? 'Rate Limited' : isServerError ? 'Server Error' : 'Timeout'})`);
                        await sleep(totalDelay);
                        continue; // Retry
                    }

                    // Final failure - no more retries
                    const reason = attempt >= MAX_RETRIES ? 'max retries reached' : 'non-retryable error';
                    console.log(`[AI] END Email ${emailIndex + 1}/${totalEmails} - FAILED (${reason})`);
                    console.log(`${'='.repeat(60)}\n`);

                    // Update progress even on failure
                    processedCount++;
                    mainWindow?.webContents.send('briefing-progress', {
                        current: processedCount,
                        total: totalEmails,
                        percent: Math.round((processedCount / totalEmails) * 100)
                    });

                    const errorBlock = {
                        category: 'General',
                        icon: '📧',
                        headline: email.subject,
                        bullet_points: ['Could not summarize this email.'],
                        detailed_points: [`Error after ${MAX_RETRIES} attempts: ${errorMessage}`],
                        sentiment: 'Neutral',
                        isSponsored: false,
                        sourceEmailSubject: email.subject,
                        senderName: email.from,
                        senderEmail: email.from
                    };

                    const normalized = normalizeBlock(errorBlock);
                    mainWindow?.webContents.send('briefing-card-generated', normalized);

                    return normalized;
                }
            }

            // Should never reach here, but TypeScript needs it
            const fallback = normalizeBlock({
                category: 'General',
                icon: '📧',
                headline: email.subject,
                bullet_points: ['Processing error.'],
                detailed_points: [],
                sentiment: 'Neutral',
                isSponsored: false,
                sourceEmailSubject: email.subject
            });
            mainWindow?.webContents.send('briefing-card-generated', fallback);
            return fallback;
        };

        const start = Date.now();
        console.log(`\n${'#'.repeat(60)}`);
        console.log(`[Pipeline] Starting AI summarization for ${totalEmails} emails`);
        console.log(`[Pipeline] Concurrency: 5 parallel requests (balanced for reliability)`);
        console.log(`${'#'.repeat(60)}\n`);

        // Process all emails in parallel with concurrency limit
        const summaryPromises = emails.map((email, index) => limit(() => summarizeEmail(email, index)));
        const summaryBlocks = await Promise.all(summaryPromises);

        console.log(`[AI] Completed ${summaryBlocks.length} summaries in ${(Date.now() - start) / 1000}s`);

        // Blocks are already normalized in summarizeEmail
        const normalizedBlocks = summaryBlocks;

        const briefingData: Briefing = {
            title: `Daily Briefing - ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`,
            summary_blocks: normalizedBlocks
        };

        console.log(`[Pipeline] Final block count: ${briefingData.summary_blocks.length}`);

        // Save to history (max 10 entries)
        const history = store.get('briefingHistory') || [];
        history.unshift({
            date: new Date().toISOString(),
            briefing: briefingData,
            emailCount: emails.length
        });
        if (history.length > 10) {
            history.pop();
        }
        store.set('briefingHistory', history);
        console.log(`[History] Saved briefing. Total history entries: ${history.length}`);

        return {
            success: true,
            data: briefingData,
            emailCount: emails.length,
        };

    } catch (error: any) {
        console.error('Briefing pipeline error:', error);

        // Detailed error logging
        if (error.response) {
            console.error('API Error Status:', error.response.status);
            console.error('API Error Body:', JSON.stringify(error.response.data, null, 2));
        }

        return {
            success: false,
            error: error.message || 'An unexpected error occurred.',
        };
    }
});
