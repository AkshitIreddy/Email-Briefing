import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    DashboardBriefing, TopicDashboard, AppScreen, HistoryEntry, AppSettings,
    DEFAULT_SETTINGS, CohereKeyType, ProgressData, LegacyBriefing,
    FontFamilyOption, ContentWidthOption, ThemeOption, EmailContent,
} from './types';
import { ParticlesBackground } from './ParticlesBackground';
import { DashboardDetail, DashboardCard, Emoji } from './DashboardView';
import { mockBriefingAPI } from './mockApi';

// ============================================
// HELPERS
// ============================================

const getAPI = () => {
    if (window.briefingAPI) return window.briefingAPI;
    if (import.meta.env.DEV) {
        console.warn('Using Mock API for Browser Development');
        return mockBriefingAPI;
    }
    throw new Error('BriefingAPI not available. Run in Electron or Dev mode.');
};

const FONT_STACKS: Record<FontFamilyOption, string> = {
    'inter': "'Inter', -apple-system, 'Segoe UI', sans-serif",
    'space-grotesk': "'Space Grotesk', 'Inter', sans-serif",
    'serif': "'Source Serif 4', Georgia, 'Times New Roman', serif",
    'mono': "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    'system': "-apple-system, 'Segoe UI', system-ui, sans-serif",
};

const FONT_LABELS: Record<FontFamilyOption, string> = {
    'inter': 'Inter', 'space-grotesk': 'Space Grotesk', 'serif': 'Serif', 'mono': 'Mono', 'system': 'System',
};

const WIDTH_MAP: Record<ContentWidthOption, string> = {
    narrow: '720px', comfortable: '920px', wide: '1200px',
};

const THEME_LABELS: Record<ThemeOption, string> = {
    midnight: '🌌 Midnight', graphite: '🌑 Graphite', light: '☀️ Light', sepia: '📜 Sepia',
};

const ACCENT_COLORS = ['#7c5cff', '#06b6d4', '#ec4899', '#f59e0b', '#22c55e', '#3b82f6', '#f43f5e', '#14b8a6'];
const HIGHLIGHT_COLORS = ['#facc15', '#4ade80', '#67e8f9', '#f9a8d4', '#fdba74'];

function applySettings(s: AppSettings) {
    const root = document.documentElement;
    root.style.setProperty('--accent-primary', s.accentColor);
    root.style.setProperty('--hl-color', s.highlightColor);
    root.style.setProperty('--font-scale', `${s.fontSize}%`);
    root.style.setProperty('--reader-line-height', String(s.lineHeight));
    root.style.setProperty('--reader-font', FONT_STACKS[s.fontFamily] || FONT_STACKS.inter);
    root.style.setProperty('--content-width', WIDTH_MAP[s.contentWidth] || WIDTH_MAP.comfortable);
    root.dataset.theme = s.theme;
    root.classList.toggle('reduce-motion', !s.animationsEnabled);
}

// Convert legacy history entries (summary cards) into minimal dashboards
function legacyToDashboards(briefing: LegacyBriefing): TopicDashboard[] {
    return briefing.summary_blocks.map((b, i) => ({
        id: `legacy-${i}`,
        topic: b.headline,
        category: b.category,
        icon: b.icon,
        template: 'pulse' as const,
        content: {
            headline: b.headline,
            overview: '',
            sentiment: (b.sentiment === 'Good' ? 'Positive' : b.sentiment === 'Bad' ? 'Negative' : 'Neutral') as 'Positive' | 'Negative' | 'Neutral',
            stats: [],
            key_points: [
                ...b.bullet_points.map(t => ({ text: t })),
                ...(b.detailed_points || []).map(p => typeof p === 'string'
                    ? { text: p }
                    : { text: p.text, is_sponsored: p.isSponsored }),
            ],
            timeline: [], quotes: [], action_items: [], glossary: [], web_context: [],
        },
        sources: [],
        images: [],
        emails: [{
            subject: b.sourceEmailSubject || b.headline,
            senderName: b.senderName || 'Unknown',
            senderEmail: b.senderEmail || '',
        }],
        generatedAt: '',
    }));
}

const LOADING_STAGES: Record<string, string> = {
    emails: '📥 Reading your inbox',
    topics: '🧭 Mapping topics',
    dashboards: '📊 Building dashboards',
};

const STAGE_HINTS: Record<string, string> = {
    emails: 'Downloading and cleaning email content',
    topics: 'Analyzing the full text of every email — on trial API keys this stage can take a few minutes',
    dashboards: 'Searching the web and generating dashboards — the first one appears as soon as it’s ready',
};

// Two-tone chime via Web Audio — no asset files needed
function playChime() {
    try {
        const ctx = new AudioContext();
        [523.25, 783.99].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            osc.connect(gain);
            gain.connect(ctx.destination);
            const t = ctx.currentTime + i * 0.18;
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.3, t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
            osc.start(t);
            osc.stop(t + 0.55);
        });
        setTimeout(() => ctx.close().catch(() => { }), 1500);
    } catch { /* audio unavailable — never break the flow */ }
}

function notifyDashboardsReady(count: number) {
    playChime();
    try {
        new Notification('Your briefing is ready to view ✨', {
            body: `${count} dashboard${count !== 1 ? 's are' : ' is'} ready — the rest are streaming in.`,
            silent: true, // we play our own chime
        });
    } catch { /* notifications unavailable */ }
}

// ============================================
// EMAIL FORMATTER
// Cleaned newsletter text arrives as single-newline lines with mid-sentence
// breaks (artifacts of links/bold in the original HTML), "▸"/numbered bullets,
// and short section headers. Rebuild readable structure from that.
// ============================================

type EmailBlock = { type: 'heading' | 'bullet' | 'para' | 'meta'; text: string };

const CONNECTOR_END = /(,|:|\b(and|or|the|a|an|to|of|for|with|from|in|on|at|by|that|is|are|was|were|its|it's|about|into|like|your|their|our|as|but|can|will|has|have|new|more|releases|ships|adds|launches|introduces|announces|unveils|gets|brings|makes|offers|supports|hits|reaches|raises|beats|tests))$/i;
const BULLET_START = /^([▸•‣◦→]|[-*]\s|\d{1,2}\.\s)/;
const META_LINE = /^(read more|forward|signup|sign up|archive|work with us|follow (us|on)|share|view in browser|presented by|in partnership|sponsored|advertisement|unsubscribe|read time)/i;

function formatEmailBlocks(body: string): EmailBlock[] {
    const rawLines = body.split('\n').map(l => l.trim()).filter(Boolean);

    // Rejoin sentences that were broken mid-flow by formatting
    const lines: string[] = [];
    for (const line of rawLines) {
        const prev = lines[lines.length - 1];
        if (prev && !BULLET_START.test(line) && !META_LINE.test(line)) {
            const startsLower = /^[a-z(,&]/.test(line);
            const prevUnfinished = !/[.!?:…"”)\]]$/.test(prev);
            const prevEndsConnector = CONNECTOR_END.test(prev);
            if ((startsLower && prevUnfinished) || prevEndsConnector) {
                lines[lines.length - 1] = `${prev} ${line}`.replace(/\s+([,.;:])/g, '$1');
                continue;
            }
        }
        lines.push(line);
    }

    return lines.map((line): EmailBlock => {
        if (META_LINE.test(line) || /^[\d,.]+ (likes|views|upvotes)$/i.test(line)) {
            return { type: 'meta', text: line };
        }
        if (BULLET_START.test(line)) {
            return { type: 'bullet', text: line.replace(BULLET_START, '').trim() };
        }
        const words = line.split(/\s+/).length;
        if (line.length <= 48 && words <= 7 && !/[.!?,;]$/.test(line)) {
            return { type: 'heading', text: line };
        }
        return { type: 'para', text: line };
    });
}

// Some emails arrive/were stored with no newlines at all (one giant line) —
// break those into readable paragraphs at sentence boundaries.
function splitLongPara(text: string): string[] {
    if (text.length <= 500) return [text];
    const sentences = text.match(/[^.!?]+[.!?]+["”)\]]?\s*|[^.!?]+$/g) || [text];
    const out: string[] = [];
    let current = '';
    for (const s of sentences) {
        if (current && current.length + s.length > 380) {
            out.push(current.trim());
            current = s;
        } else {
            current += s;
        }
    }
    if (current.trim()) out.push(current.trim());
    return out;
}

const FormattedEmail = ({ body }: { body: string }) => {
    const blocks = formatEmailBlocks(body);
    const nodes: React.ReactNode[] = [];
    let bulletBuffer: string[] = [];

    const flushBullets = (key: number) => {
        if (!bulletBuffer.length) return;
        nodes.push(
            <ul className="email-bullets" key={`ul-${key}`}>
                {bulletBuffer.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
        );
        bulletBuffer = [];
    };

    blocks.forEach((block, i) => {
        if (block.type === 'bullet') {
            bulletBuffer.push(block.text);
            return;
        }
        flushBullets(i);
        if (block.type === 'heading') nodes.push(<h4 className="email-h" key={i}>{block.text}</h4>);
        else if (block.type === 'meta') nodes.push(<div className="email-meta-line" key={i}>{block.text}</div>);
        else splitLongPara(block.text).forEach((p, j) => nodes.push(<p key={`${i}-${j}`}>{p}</p>));
    });
    flushBullets(blocks.length);

    return <>{nodes}</>;
};

const CopyLogsButton = ({ compact = false }: { compact?: boolean }) => {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        const logs = (await getAPI().getLogs?.()) || 'No logs available.';
        try {
            await navigator.clipboard.writeText(logs);
        } catch {
            // Fallback for when the async clipboard API is unavailable/unfocused
            const ta = document.createElement('textarea');
            ta.value = logs;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };
    return (
        <button className={`copy-logs-btn ${compact ? 'compact' : ''}`} onClick={copy} title="Copy this session's logs to the clipboard">
            {copied ? '✓ Copied!' : '📋 Copy Logs'}
        </button>
    );
};

// ============================================
// APP
// ============================================

function App() {
    const [screen, setScreen] = useState<AppScreen>('idle');
    const [briefing, setBriefing] = useState<DashboardBriefing | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [emailCount, setEmailCount] = useState(0);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [hasApiKey, setHasApiKey] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [selectedDash, setSelectedDash] = useState<TopicDashboard | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [showReader, setShowReader] = useState(false);
    const [progress, setProgress] = useState<ProgressData | null>(null);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const [cohereKeyType, setCohereKeyType] = useState<CohereKeyType>('trial');
    const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
    const [isGenerating, setIsGenerating] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [emailView, setEmailView] = useState<EmailContent | null>(null);
    const [focusText, setFocusText] = useState('');
    const [defaultFocus, setDefaultFocus] = useState('');

    // One live generation at a time: a new Brief Me supersedes the previous
    // run's listeners and its late promise resolution must not touch the UI
    const runSeqRef = useRef(0);
    const activeSubsRef = useRef<Array<() => void>>([]);

    useEffect(() => {
        checkStatus();
    }, []);

    // Reserve the title-bar strip that the OS caption buttons
    // (minimize/maximize/close) are drawn into, so the header sits below them
    // and stays flush right. The overlay disappears in fullscreen, so track it
    // live and reclaim the space when it does.
    useEffect(() => {
        const wco = (navigator as any).windowControlsOverlay;
        if (!wco) return;
        const apply = () => {
            const height = wco.visible ? wco.getTitlebarAreaRect().height : 0;
            document.documentElement.style.setProperty('--wco-inset-top', `${height}px`);
            // The strip changes how much vertical room the content region has,
            // so the centring measurement has to be redone.
            window.dispatchEvent(new Event('app:relayout'));
        };
        apply();
        wco.addEventListener('geometrychange', apply);
        window.addEventListener('resize', apply);
        return () => {
            wco.removeEventListener('geometrychange', apply);
            window.removeEventListener('resize', apply);
        };
    }, []);

    // The header pushes the content region below the window's true centre, so
    // screens that centre themselves (idle/loading/error) end up sitting low.
    // Measure the offset and expose it as --center-shift. Recomputed on resize
    // and whenever the header's height changes (e.g. the font-size setting).
    useEffect(() => {
        const el = document.querySelector('.idle-screen, .loading-screen, .error-screen') as HTMLElement | null;
        if (!el) return;
        const root = document.documentElement;
        const apply = () => {
            // Measure where the box actually lands (transform included) and
            // correct by the remaining error — exact regardless of the
            // surrounding padding/margin maths.
            const current = parseFloat(getComputedStyle(root).getPropertyValue('--center-shift')) || 0;
            const r = el.getBoundingClientRect();
            const delta = window.innerHeight / 2 - (r.top + r.height / 2);
            if (Math.abs(delta) < 1) return;
            root.style.setProperty('--center-shift', `${Math.round(current + delta)}px`);
        };
        // Two passes: the first lands the box, the second settles any residual
        // error once fonts/layout have finished.
        apply();
        requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
        const ro = new ResizeObserver(apply);
        ro.observe(el);
        ro.observe(document.querySelector('.main-content') as HTMLElement);
        window.addEventListener('resize', apply);
        window.addEventListener('app:relayout', apply);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', apply);
            window.removeEventListener('app:relayout', apply);
        };
    }, [screen]);

    // Elapsed-time ticker so long stages visibly aren't frozen
    useEffect(() => {
        if (screen !== 'loading') return;
        setElapsed(0);
        const started = Date.now();
        const interval = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => clearInterval(interval);
    }, [screen]);

    const checkStatus = async () => {
        try {
            const api = getAPI();
            const status = await api.checkAuthStatus();
            setIsAuthenticated(status.isAuthenticated);
            setHasApiKey(status.hasApiKey);

            const savedKey = await api.getApiKey();
            if (savedKey) {
                setApiKeyInput(savedKey.slice(0, 10) + '...');
            }

            if (api.getSettings) {
                const s = { ...DEFAULT_SETTINGS, ...(await api.getSettings()) };
                setSettings(s);
                applySettings(s);
            }

            if (api.getCohereKeyType) {
                setCohereKeyType(await api.getCohereKeyType());
            }

            if (api.getBriefingFocus) {
                const f = await api.getBriefingFocus();
                setFocusText(f.focus);
                setDefaultFocus(f.defaultFocus);
            }
        } catch (err: any) {
            console.error('Failed to check status:', err);
            setError(err.message);
        }
    };

    const saveSettings = async (next: AppSettings) => {
        setSettings(next);
        applySettings(next);
        try {
            const api = getAPI();
            if (api.setSettings) await api.setSettings(next);
        } catch (err) {
            console.error('Failed to save settings:', err);
        }
    };

    const saveCohereKeyType = async (keyType: CohereKeyType) => {
        setCohereKeyType(keyType);
        try {
            const api = getAPI();
            if (api.setCohereKeyType) await api.setCohereKeyType(keyType);
        } catch (err) {
            console.error('Failed to save Cohere key type:', err);
        }
    };

    const openExternal = (url: string) => {
        try { getAPI().openExternal(url); } catch { window.open(url, '_blank'); }
    };

    const handleSignIn = async () => {
        try {
            const result = await getAPI().signInWithGoogle();
            if (result.success) {
                setIsAuthenticated(true);
            } else {
                setError(result.error || 'Failed to sign in');
                setScreen('error');
            }
        } catch (err: any) {
            setError(err.message);
            setScreen('error');
        }
    };

    const handleFetchBriefing = useCallback(async () => {
        const myRun = ++runSeqRef.current;
        const isCurrent = () => myRun === runSeqRef.current;

        // Tear down the previous run's listeners so it can't duplicate events
        activeSubsRef.current.forEach(u => u());
        activeSubsRef.current = [];

        setScreen('loading');
        setError(null);
        setProgress(null);
        setSelectedDash(null);
        setIsGenerating(true);

        const initial: DashboardBriefing = {
            title: `Briefing — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`,
            dashboards: [],
        };
        setBriefing(initial);
        setEmailCount(0);

        try {
            const api = getAPI();

            if (api.onTidbits) {
                activeSubsRef.current.push(api.onTidbits((tidbits) => {
                    setBriefing(prev => prev ? { ...prev, tidbits } : { ...initial, tidbits });
                }));
            }

            if (api.onEmailContents) {
                activeSubsRef.current.push(api.onEmailContents((contents) => {
                    setBriefing(prev => prev ? { ...prev, emailContents: contents } : { ...initial, emailContents: contents });
                }));
            }

            // Reveal the results grid only once at least half the dashboards
            // are built (the rest keep streaming in on the grid).
            let expectedTotal = 0;
            let received = 0;
            let revealed = false;

            if (api.onProgress) {
                activeSubsRef.current.push(api.onProgress(data => {
                    if (data.stage === 'dashboards' && data.total > 0) {
                        expectedTotal = data.total;
                    }
                    setProgress(data);
                }));
            }

            if (api.onDashboardGenerated) {
                activeSubsRef.current.push(api.onDashboardGenerated((dash) => {
                    received++;
                    setBriefing(prev => prev
                        ? { ...prev, dashboards: [...prev.dashboards, dash] }
                        : { ...initial, dashboards: [dash] });
                    if (!revealed && expectedTotal > 0 && received >= Math.ceil(expectedTotal / 2)) {
                        revealed = true;
                        setScreen('result');
                        notifyDashboardsReady(received);
                    }
                }));
            }

            const result = await api.fetchBriefing();

            // A newer run owns the UI now — this (stale) resolution must not touch it
            if (!isCurrent()) return;

            if (result.success && result.data) {
                setBriefing(result.data);
                setEmailCount(result.emailCount || 0);
                setScreen('result');
            } else {
                const errorMsg = result.error || 'Failed to fetch briefing';
                if (errorMsg.startsWith('Superseded')) return;
                setError(errorMsg);
                setScreen('error');
                if (errorMsg.toLowerCase().includes('session has expired') || errorMsg.toLowerCase().includes('invalid_grant') || errorMsg.toLowerCase().includes('sign in')) {
                    setIsAuthenticated(false);
                }
            }
        } catch (err: any) {
            if (!isCurrent()) return;
            setError(err.message || 'An unexpected error occurred');
            setScreen('error');
        } finally {
            if (isCurrent()) {
                setIsGenerating(false);
                activeSubsRef.current.forEach(u => u());
                activeSubsRef.current = [];
            }
        }
    }, []);

    const handleSaveApiKey = async () => {
        const api = getAPI();
        if (apiKeyInput && !apiKeyInput.includes('...')) {
            await api.setApiKey(apiKeyInput);
            setHasApiKey(true);
        }
        if (api.setBriefingFocus) {
            await api.setBriefingFocus(focusText);
        }
        setShowSettings(false);
        checkStatus();
    };

    const openEmail = (emailId: string) => {
        const content = briefing?.emailContents?.[emailId];
        if (content) setEmailView(content);
    };

    const handleReset = () => {
        setScreen('idle');
        setBriefing(null);
        setError(null);
        setSelectedDash(null);
        setShowHistory(false);
        setProgress(null);
    };

    const loadHistory = async () => {
        const historyData = await getAPI().getHistory();
        setHistory(historyData);
        setShowHistory(true);
    };

    const loadHistoryEntry = (entry: HistoryEntry) => {
        const dashboards = entry.dashboards
            || (entry.briefing ? legacyToDashboards(entry.briefing) : []);
        setBriefing({
            title: entry.title || entry.briefing?.title || 'Saved Briefing',
            dashboards,
            tidbits: entry.tidbits,
            emailContents: entry.emailContents,
        });
        setEmailCount(entry.emailCount);
        setSelectedDash(null);
        setScreen('result');
        setShowHistory(false);
    };

    return (
        <div className="app-container">
            {/* Drag area behind the OS caption buttons */}
            <div className="titlebar-drag" aria-hidden="true" />
            <div className="aurora" aria-hidden="true">
                <div className="aurora-blob a1" /><div className="aurora-blob a2" /><div className="aurora-blob a3" />
            </div>
            <ParticlesBackground mode={settings.backgroundMode || 'nebula'} />

            {/* Header */}
            <header className="header">
                <div className="logo" onClick={handleReset}>
                    <span className="logo-mark">◈</span> Email Briefing
                </div>
                <nav className="header-actions">
                    <button className="nav-pill" onClick={handleReset}>Home</button>
                    <button className="nav-pill" onClick={loadHistory}>History</button>
                    <button className="nav-pill" onClick={() => setShowReader(true)} title="Reading & appearance">Aa</button>
                    <button className="nav-pill" onClick={() => setShowSettings(true)}>⚙</button>
                </nav>
            </header>

            {/* Main Content */}
            <main className="main-content">
                {/* Idle Screen */}
                {screen === 'idle' && (
                    <div className="idle-screen">
                        <div className="idle-eyebrow">AI-POWERED INBOX INTELLIGENCE</div>
                        <h1 className="idle-title">
                            Your inbox, distilled into<br /><span className="gradient-text">living dashboards</span>
                        </h1>
                        <p className="idle-subtitle">
                            Topics are detected, deduplicated, enriched with live web context and imagery —
                            then rendered as rich, readable dashboards.
                        </p>

                        <button
                            className="brief-button"
                            onClick={handleFetchBriefing}
                            disabled={!isAuthenticated || !hasApiKey}
                        >
                            <span className="brief-button-inner">✨ Brief Me</span>
                        </button>

                        <div className="auth-status">
                            <div className={`auth-badge ${hasApiKey ? 'connected' : 'disconnected'}`}>
                                {hasApiKey ? '●' : '○'} Cohere API
                            </div>
                            <div className={`auth-badge ${isAuthenticated ? 'connected' : 'disconnected'}`}>
                                {isAuthenticated ? '●' : '○'} Google Account
                            </div>
                            {!isAuthenticated && (
                                <button className="connect-btn" onClick={handleSignIn}>Sign in with Google</button>
                            )}
                            {!hasApiKey && (
                                <button className="connect-btn" onClick={() => setShowSettings(true)}>Add API Key</button>
                            )}
                        </div>
                    </div>
                )}

                {/* Loading Screen */}
                {screen === 'loading' && (
                    <div className="loading-screen">
                        <div className="orbit-loader">
                            <div className="orbit-ring" /><div className="orbit-ring r2" /><div className="orbit-core" />
                        </div>
                        <p className="loading-message">
                            {progress ? (LOADING_STAGES[progress.stage] || progress.message) : 'Warming up the pipeline'}
                        </p>
                        {progress && (
                            <>
                                <div className="progress-bar">
                                    <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
                                </div>
                                <p className="loading-count">{progress.message} · {progress.current}/{progress.total}</p>
                                {STAGE_HINTS[progress.stage] && (
                                    <p className="loading-hint">{STAGE_HINTS[progress.stage]}</p>
                                )}
                            </>
                        )}
                        <p className="loading-elapsed">
                            {Math.floor(elapsed / 60) > 0 ? `${Math.floor(elapsed / 60)}m ` : ''}{elapsed % 60}s elapsed
                        </p>
                        <div className="loading-actions">
                            <CopyLogsButton />
                        </div>
                    </div>
                )}

                {/* Results: topic grid */}
                {screen === 'result' && briefing && !selectedDash && (
                    <div className="results-screen">
                        <div className="results-header">
                            <h1 className="briefing-title gradient-text">{briefing.title}</h1>
                            <p className="briefing-meta">
                                {isGenerating && progress && progress.percent < 100 ? (
                                    <span className="live-indicator">
                                        <span className="live-dot" /> Building dashboards… {progress.current}/{progress.total}
                                    </span>
                                ) : (
                                    <span>
                                        {briefing.dashboards.length} topic{briefing.dashboards.length !== 1 ? 's' : ''}
                                        {emailCount > 0 ? ` · ${emailCount} emails` : ''}
                                    </span>
                                )}
                            </p>
                        </div>

                        {briefing.tidbits && briefing.tidbits.length > 0 && (
                            <section className="quick-bits">
                                <div className="quick-bits-header">
                                    <h3 className="quick-bits-title"><Emoji char="⚡" size={16} /> Quick Bits</h3>
                                    <span className="quick-bits-count">{briefing.tidbits.length}</span>
                                </div>
                                <div className="quick-bits-strip">
                                    {briefing.tidbits.map((t, i) => (
                                        <div className="quick-bit-chip" key={i} style={{ animationDelay: `${i * 0.05}s` }}>
                                            <span className="quick-bit-emoji"><Emoji char={t.emoji || '✨'} size={18} /></span>
                                            <span>{t.text}</span>
                                            {(t.quote || t.source) && (
                                                <div className="app-tooltip qb-tooltip">
                                                    <div className="app-tooltip-label">Source</div>
                                                    {t.quote && <div className="app-tooltip-quote">“{t.quote}”</div>}
                                                    {t.source && (
                                                        <div className="app-tooltip-sub">
                                                            {t.source.senderName} · {t.source.subject}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </section>
                        )}

                        <div className="topics-grid">
                            {briefing.dashboards.map((dash, index) => (
                                <DashboardCard key={dash.id || index} dash={dash} index={index}
                                    onClick={() => setSelectedDash(dash)} />
                            ))}
                            {isGenerating && progress && progress.stage === 'dashboards' && progress.current < progress.total && (
                                <div className="topic-card skeleton-card">
                                    <div className="skeleton-shimmer" />
                                    <p>Generating next dashboard…</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Dashboard detail */}
                {screen === 'result' && selectedDash && (
                    <DashboardDetail
                        dash={selectedDash}
                        highlightsEnabled={settings.highlightsEnabled}
                        openExternal={openExternal}
                        onOpenEmail={openEmail}
                        onBack={() => setSelectedDash(null)}
                    />
                )}

                {/* Error Screen */}
                {screen === 'error' && (
                    <div className="error-screen">
                        <div className="error-icon">⚠️</div>
                        <h2 className="error-title">Something went wrong</h2>
                        <p className="error-message">{error}</p>
                        <div className="error-actions">
                            <button className="btn-secondary" onClick={handleReset}>Go Back</button>
                            <button className="btn-primary" onClick={handleFetchBriefing}>Try Again</button>
                        </div>
                        <div className="loading-actions">
                            <CopyLogsButton />
                        </div>
                    </div>
                )}
            </main>

            {/* Settings Modal */}
            {showSettings && (
                <div className="modal-overlay" onClick={() => setShowSettings(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">Settings</h2>
                            <button className="modal-close" onClick={() => setShowSettings(false)}>×</button>
                        </div>

                        <div className="form-group">
                            <label className="form-label">Cohere API Key</label>
                            <input
                                type="password"
                                className="form-input"
                                placeholder="Enter your Cohere API key..."
                                value={apiKeyInput}
                                onChange={e => setApiKeyInput(e.target.value)}
                            />
                            <p className="form-hint">
                                Get your API key from{' '}
                                <a href="#" onClick={(e) => { e.preventDefault(); openExternal('https://dashboard.cohere.com/api-keys'); }}>
                                    dashboard.cohere.com
                                </a>
                            </p>
                        </div>

                        <div className="form-group">
                            <label className="form-label">API Key Type</label>
                            <div className="segmented">
                                <button className={`segment ${cohereKeyType === 'trial' ? 'active' : ''}`}
                                    onClick={() => saveCohereKeyType('trial')}>🧪 Trial</button>
                                <button className={`segment ${cohereKeyType === 'production' ? 'active' : ''}`}
                                    onClick={() => saveCohereKeyType('production')}>🚀 Production</button>
                            </div>
                            <p className="form-hint">
                                {cohereKeyType === 'trial'
                                    ? 'Trial keys are rate-limited; a longer 90s timeout is used.'
                                    : 'Production keys use a faster 60s timeout.'}
                            </p>
                        </div>

                        <div className="form-group">
                            <label className="form-label">Google Account</label>
                            <div className={`auth-badge ${isAuthenticated ? 'connected' : 'disconnected'}`}>
                                {isAuthenticated ? '● Connected' : '○ Not connected'}
                            </div>
                            {!isAuthenticated ? (
                                <button className="connect-btn" style={{ marginTop: '0.5rem' }} onClick={handleSignIn}>
                                    Sign in with Google
                                </button>
                            ) : (
                                <button className="connect-btn" style={{ marginTop: '0.5rem' }}
                                    onClick={async () => { await getAPI().signOut(); setIsAuthenticated(false); }}>
                                    Sign Out
                                </button>
                            )}
                        </div>

                        <div className="form-group">
                            <label className="form-label">
                                Briefing Focus
                                {focusText.trim() !== defaultFocus.trim() && <span className="custom-badge">customized</span>}
                            </label>
                            <textarea
                                className="form-input focus-textarea"
                                rows={9}
                                value={focusText}
                                onChange={e => setFocusText(e.target.value)}
                                spellCheck={false}
                            />
                            <p className="form-hint">
                                This text is given verbatim to the AI as the rule for what becomes a dashboard.
                                Guidelines: describe what TO include and what NOT to include in plain language;
                                keep the "Do NOT" list — it prevents ads and filler; be concrete
                                (name the kinds of stories you care about). Saved on Save.
                            </p>
                            <button className="btn-secondary btn-small" onClick={() => setFocusText(defaultFocus)}
                                disabled={focusText.trim() === defaultFocus.trim()}>
                                Reset to default
                            </button>
                        </div>

                        <div className="form-group">
                            <label className="form-label">Diagnostics</label>
                            <CopyLogsButton compact />
                            <p className="form-hint">Copies this session's pipeline logs — useful when reporting a problem.</p>
                        </div>

                        <div className="modal-actions">
                            <button className="btn-secondary" onClick={() => setShowSettings(false)}>Cancel</button>
                            <button className="btn-primary" onClick={handleSaveApiKey}>Save</button>
                        </div>
                    </div>
                </div>
            )}

            {/* History Modal */}
            {showHistory && (
                <div className="modal-overlay" onClick={() => setShowHistory(false)}>
                    <div className="modal-content history-modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">Past Briefings</h2>
                            <div className="modal-header-actions">
                                {history.length > 0 && (
                                    <button className="clear-history-btn" onClick={() => setShowClearConfirm(true)}>
                                        Clear All
                                    </button>
                                )}
                                <button className="modal-close" onClick={() => setShowHistory(false)}>×</button>
                            </div>
                        </div>

                        <div className="history-list">
                            {history.length === 0 ? (
                                <p className="history-empty">No saved briefings yet. Generate your first briefing!</p>
                            ) : (
                                history.map((entry, index) => (
                                    <div key={index} className="history-item" onClick={() => loadHistoryEntry(entry)}>
                                        <div className="history-item-date">
                                            {new Date(entry.date).toLocaleDateString('en-US', {
                                                weekday: 'short', month: 'short', day: 'numeric',
                                                hour: '2-digit', minute: '2-digit'
                                            })}
                                        </div>
                                        <div className="history-item-title">
                                            {entry.title || entry.briefing?.title || 'Briefing'}
                                        </div>
                                        <div className="history-item-meta">
                                            {entry.emailCount} emails · {(entry.dashboards?.length ?? entry.briefing?.summary_blocks.length ?? 0)} topics
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Reader / Appearance Panel */}
            {showReader && (
                <div className="modal-overlay" onClick={() => setShowReader(false)}>
                    <div className="modal-content reader-modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">Reading & Appearance</h2>
                            <button className="modal-close" onClick={() => setShowReader(false)}>×</button>
                        </div>

                        <div className="settings-form">
                            <div className="form-group">
                                <label>Theme</label>
                                <div className="segmented wrap">
                                    {(Object.keys(THEME_LABELS) as ThemeOption[]).map(t => (
                                        <button key={t} className={`segment ${settings.theme === t ? 'active' : ''}`}
                                            onClick={() => saveSettings({ ...settings, theme: t })}>
                                            {THEME_LABELS[t]}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Accent Color</label>
                                <div className="color-picker-grid">
                                    {ACCENT_COLORS.map(color => (
                                        <button key={color}
                                            className={`color-swatch ${settings.accentColor === color ? 'active' : ''}`}
                                            style={{ backgroundColor: color }}
                                            onClick={() => saveSettings({ ...settings, accentColor: color })} />
                                    ))}
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Highlight Color</label>
                                <div className="color-picker-grid">
                                    {HIGHLIGHT_COLORS.map(color => (
                                        <button key={color}
                                            className={`color-swatch ${settings.highlightColor === color ? 'active' : ''}`}
                                            style={{ backgroundColor: color }}
                                            onClick={() => saveSettings({ ...settings, highlightColor: color })} />
                                    ))}
                                </div>
                            </div>

                            <div className="form-group row">
                                <label>Highlight key phrases</label>
                                <label className="toggle-switch">
                                    <input type="checkbox" checked={settings.highlightsEnabled}
                                        onChange={(e) => saveSettings({ ...settings, highlightsEnabled: e.target.checked })} />
                                    <span className="slider round"></span>
                                </label>
                            </div>

                            <div className="form-group">
                                <label>Font</label>
                                <div className="segmented wrap">
                                    {(Object.keys(FONT_LABELS) as FontFamilyOption[]).map(f => (
                                        <button key={f} className={`segment ${settings.fontFamily === f ? 'active' : ''}`}
                                            style={{ fontFamily: FONT_STACKS[f] }}
                                            onClick={() => saveSettings({ ...settings, fontFamily: f })}>
                                            {FONT_LABELS[f]}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Font Size ({settings.fontSize}%)</label>
                                <input type="range" min="80" max="150" step="5" value={settings.fontSize}
                                    onChange={(e) => saveSettings({ ...settings, fontSize: Number(e.target.value) })}
                                    className="range-slider" />
                            </div>

                            <div className="form-group">
                                <label>Line Spacing ({settings.lineHeight.toFixed(1)})</label>
                                <input type="range" min="1.3" max="2.2" step="0.1" value={settings.lineHeight}
                                    onChange={(e) => saveSettings({ ...settings, lineHeight: Number(e.target.value) })}
                                    className="range-slider" />
                            </div>

                            <div className="form-group">
                                <label>Reading Width</label>
                                <div className="segmented">
                                    {(['narrow', 'comfortable', 'wide'] as ContentWidthOption[]).map(w => (
                                        <button key={w} className={`segment ${settings.contentWidth === w ? 'active' : ''}`}
                                            onClick={() => saveSettings({ ...settings, contentWidth: w })}>
                                            {w[0].toUpperCase() + w.slice(1)}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Background Effect</label>
                                <div className="segmented">
                                    {([['simple', 'Calm'], ['snow', 'Snow ❄️'], ['nebula', 'Nebula 🌌']] as const).map(([mode, label]) => (
                                        <button key={mode} className={`segment ${settings.backgroundMode === mode ? 'active' : ''}`}
                                            onClick={() => saveSettings({ ...settings, backgroundMode: mode })}>
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="form-group row">
                                <label>Enable Animations</label>
                                <label className="toggle-switch">
                                    <input type="checkbox" checked={settings.animationsEnabled}
                                        onChange={(e) => saveSettings({ ...settings, animationsEnabled: e.target.checked })} />
                                    <span className="slider round"></span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Email Viewer Modal — read the source email in-app */}
            {emailView && (
                <div className="modal-overlay" onClick={() => setEmailView(null)}>
                    <div className="modal-content email-viewer reader-surface" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <div className="email-viewer-head">
                                <h2 className="modal-title"><Emoji char="✉️" size={20} /> {emailView.subject}</h2>
                                <p className="email-viewer-sender">
                                    {emailView.senderName} <span>&lt;{emailView.senderEmail}&gt;</span>
                                </p>
                            </div>
                            <button className="modal-close" onClick={() => setEmailView(null)}>×</button>
                        </div>
                        <div className="email-viewer-body">
                            <FormattedEmail body={emailView.body} />
                        </div>
                    </div>
                </div>
            )}

            {/* Clear History Confirmation Modal */}
            {showClearConfirm && (
                <div className="modal-overlay" onClick={() => setShowClearConfirm(false)}>
                    <div className="modal-content confirm-modal" onClick={e => e.stopPropagation()}>
                        <div className="confirm-icon">🗑️</div>
                        <h2 className="confirm-title">Clear All History?</h2>
                        <p className="confirm-message">
                            This will permanently delete all {history.length} saved briefing{history.length !== 1 ? 's' : ''}.
                            This action cannot be undone.
                        </p>
                        <div className="confirm-actions">
                            <button className="btn-secondary" onClick={() => setShowClearConfirm(false)}>Cancel</button>
                            <button className="btn-danger" onClick={async () => {
                                await getAPI().clearHistory();
                                setHistory([]);
                                setShowClearConfirm(false);
                            }}>Delete All</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;
