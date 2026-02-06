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
        mainWindow.webContents.openDevTools();
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

                if (payload?.body?.data) {
                    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
                } else if (payload?.parts) {
                    for (const part of payload.parts) {
                        if (part.mimeType === 'text/plain' && part.body?.data) {
                            body = Buffer.from(part.body.data, 'base64').toString('utf8');
                            break;
                        } else if (part.mimeType === 'text/html' && part.body?.data) {
                            const html = Buffer.from(part.body.data, 'base64').toString('utf8');
                            body = convert(html, {
                                wordwrap: false, selectors: [
                                    { selector: 'a', options: { ignoreHref: true } },
                                    { selector: 'img', format: 'skip' },
                                ]
                            });
                        }
                    }
                }

                if (body) {
                    // Clean content
                    body = body.split('\n').filter(line => !line.trim().startsWith('>')).join('\n');
                    body = body.replace(/Unsubscribe|View in browser|Copyright ©|All rights reserved/gi, '');
                    body = body.replace(/\n\s*\n\s*\n/g, '\n\n');

                    // Truncate for per-email processing (less aggressive since each email is processed separately)
                    const TRUNCATE_LIMIT = 6000;
                    if (body.length > TRUNCATE_LIMIT) {
                        body = body.substring(0, TRUNCATE_LIMIT) + '... [truncated]';
                    }

                    if (body.trim().length > 100) {
                        emails.push({ id: message.id!, subject, from, body });
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

        // Concurrency limiter: 5 parallel requests (safe margin for 20 RPM limit)
        const limit = pLimit(5);

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
  "detailed_points": ["Full organized point 1", "Full organized point 2", ...up to 10 points],
  "sentiment": "Neutral" | "Good" | "Bad",
  "isSponsored": true if this email is primarily an advertisement/sponsored content, false otherwise
}

INSTRUCTIONS:
1. Extract ALL key information into detailed_points (comprehensive, organized).
2. Summarize the most important 3-5 items into bullet_points.
3. Set isSponsored: true ONLY if the email is primarily promotional/advertising.
4. RETURN ONLY VALID JSON. No markdown, no extra text.
`;

        const summarizeEmail = async (email: EmailData): Promise<any> => {
            const userPrompt = `EMAIL SUBJECT: ${email.subject}\nFROM: ${email.from}\n\nCONTENT:\n${email.body}`;

            try {
                const response = await model.invoke([
                    new SystemMessage(perEmailSystemPrompt),
                    new HumanMessage(userPrompt),
                ]);

                let cleanJson = response.content.toString();
                cleanJson = cleanJson.replace(/```json/g, '').replace(/```/g, '').trim();
                const parsed = JSON.parse(cleanJson);

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

                return parsed;
            } catch (error) {
                console.error(`[AI] Failed to summarize email "${email.subject}":`, error);
                return {
                    category: 'General',
                    icon: '📧',
                    headline: email.subject,
                    bullet_points: ['Could not summarize this email.'],
                    detailed_points: ['Error processing this email content.'],
                    sentiment: 'Neutral',
                    isSponsored: false,
                    sourceEmailSubject: email.subject
                };
            }
        };

        const start = Date.now();

        // Process all emails in parallel with concurrency limit
        const summaryPromises = emails.map(email => limit(() => summarizeEmail(email)));
        const summaryBlocks = await Promise.all(summaryPromises);

        console.log(`[AI] Completed ${summaryBlocks.length} summaries in ${(Date.now() - start) / 1000}s`);

        // Normalize blocks
        const normalizedBlocks = summaryBlocks.map((block: any) => ({
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
        }));

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
