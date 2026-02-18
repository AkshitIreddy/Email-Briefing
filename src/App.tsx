import { useState, useEffect, useCallback } from 'react';
import { Briefing, AppScreen, SummaryBlock, HistoryEntry, AccessibilitySettings, CohereKeyType } from './types';
import { ParticlesBackground } from './ParticlesBackground';

// Professional loading messages
const LOADING_MESSAGES = [
    "Analyzing your inbox...",
    "Processing email content...",
    "Generating summaries...",
    "Organizing insights...",
    "Preparing your briefing...",
    "Almost ready...",
];

import { mockBriefingAPI } from './mockApi';

// Helper to get API (real or mock)
const getAPI = () => {
    if (window.briefingAPI) return window.briefingAPI;
    if (import.meta.env.DEV) {
        console.warn('Using Mock API for Browser Development');
        return mockBriefingAPI;
    }
    throw new Error('BriefingAPI not available. Usage: Run in Electron or Dev mode.');
};

function App() {
    const [screen, setScreen] = useState<AppScreen>('idle');
    const [briefing, setBriefing] = useState<Briefing | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loadingMessage, setLoadingMessage] = useState(LOADING_MESSAGES[0]);
    const [emailCount, setEmailCount] = useState(0);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [hasApiKey, setHasApiKey] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [selectedBlock, setSelectedBlock] = useState<SummaryBlock | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [showAccessibility, setShowAccessibility] = useState(false);
    const [progress, setProgress] = useState<{ current: number; total: number; percent: number } | null>(null);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const [cohereKeyType, setCohereKeyType] = useState<CohereKeyType>('trial');
    const [accessSettings, setAccessSettings] = useState<AccessibilitySettings>({
        accentColor: '#06b6d4',
        fontSize: 100,
        animationsEnabled: true,
        backgroundMode: 'simple'
    });

    // Check auth status on mount
    useEffect(() => {
        checkStatus();
    }, []);

    // Rotate loading messages
    useEffect(() => {
        if (screen !== 'loading') return;

        const interval = setInterval(() => {
            setLoadingMessage(prev => {
                const currentIndex = LOADING_MESSAGES.indexOf(prev);
                const nextIndex = (currentIndex + 1) % LOADING_MESSAGES.length;
                return LOADING_MESSAGES[nextIndex];
            });
        }, 3000);

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

            // Load accessibility settings
            if (api.getSettings) {
                const settings = await api.getSettings();
                setAccessSettings(settings);
                applySettings(settings);
            }

            // Load Cohere key type setting
            if (api.getCohereKeyType) {
                const keyType = await api.getCohereKeyType();
                setCohereKeyType(keyType);
            }
        } catch (err: any) {
            console.error('Failed to check status:', err);
            setError(err.message);
        }
    };

    const applySettings = (settings: AccessibilitySettings) => {
        document.documentElement.style.setProperty('--accent-primary', settings.accentColor);
        document.documentElement.style.setProperty('--font-scale', `${settings.fontSize}%`);
        document.documentElement.classList.toggle('reduce-motion', !settings.animationsEnabled);
    };

    const saveAccessibilitySettings = async (newSettings: AccessibilitySettings) => {
        setAccessSettings(newSettings);
        applySettings(newSettings);
        try {
            const api = getAPI();
            if (api.setSettings) {
                await api.setSettings(newSettings);
            }
        } catch (err) {
            console.error('Failed to save settings:', err);
        }
    };

    const saveCohereKeyType = async (keyType: CohereKeyType) => {
        setCohereKeyType(keyType);
        try {
            const api = getAPI();
            if (api.setCohereKeyType) {
                await api.setCohereKeyType(keyType);
            }
        } catch (err) {
            console.error('Failed to save Cohere key type:', err);
        }
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
        setScreen('loading');
        setError(null);
        setProgress(null);
        setLoadingMessage(LOADING_MESSAGES[0]);

        // Streaming state initialization
        const initialBriefing: Briefing = {
            title: `Daily Briefing - ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`,
            summary_blocks: []
        };
        setBriefing(initialBriefing);
        setEmailCount(0); // Will update at the end

        // Subscribe to progress and card events
        let unsubscribeProgress: (() => void) | undefined;
        let unsubscribeCards: (() => void) | undefined;

        try {
            const api = getAPI();

            if (api.onProgress) {
                unsubscribeProgress = api.onProgress((data) => {
                    setProgress(data);
                });
            }

            if (api.onCardGenerated) {
                unsubscribeCards = api.onCardGenerated((card) => {
                    setBriefing(prev => {
                        if (!prev) return { ...initialBriefing, summary_blocks: [card] };
                        return {
                            ...prev,
                            summary_blocks: [...prev.summary_blocks, card]
                        };
                    });

                    // Switch to result screen as soon as we have the first card
                    setScreen('result');
                });
            }

            const result = await api.fetchBriefing();

            if (result.success && result.data) {
                // Final update to ensure consistency and correct count
                setBriefing(result.data);
                setEmailCount(result.emailCount || 0);
                setScreen('result');
            } else {
                const errorMsg = result.error || 'Failed to fetch briefing';
                setError(errorMsg);
                setScreen('error');

                // Auto-logout on session expiry
                if (errorMsg.toLowerCase().includes('session has expired') || errorMsg.toLowerCase().includes('invalid_grant') || errorMsg.toLowerCase().includes('sign in')) {
                    setIsAuthenticated(false);
                }
            }
        } catch (err: any) {
            setError(err.message || 'An unexpected error occurred');
            setScreen('error');
        } finally {
            if (unsubscribeProgress) unsubscribeProgress();
            if (unsubscribeCards) unsubscribeCards();
        }
    }, []);

    const handleSaveApiKey = async () => {
        if (apiKeyInput && !apiKeyInput.includes('...')) {
            await getAPI().setApiKey(apiKeyInput);
            setHasApiKey(true);
        }
        setShowSettings(false);
        checkStatus();
    };

    const handleReset = () => {
        setScreen('idle');
        setBriefing(null);
        setError(null);
        setSelectedBlock(null);
        setShowHistory(false);
        setProgress(null);
    };

    const loadHistory = async () => {
        const historyData = await getAPI().getHistory();
        setHistory(historyData);
        setShowHistory(true);
    };

    const loadHistoryEntry = (entry: HistoryEntry) => {
        setBriefing(entry.briefing);
        setEmailCount(entry.emailCount);
        setScreen('result');
        setShowHistory(false);
    };

    return (
        <div className="app-container">
            <ParticlesBackground mode={accessSettings.backgroundMode || 'simple'} />
            {/* Header */}
            <header className="header">
                <div className="logo" onClick={handleReset} style={{ cursor: 'pointer' }}>Email Briefing</div>
                <div className="header-actions">
                    <button className="home-btn" onClick={handleReset} title="Go Home">
                        🏠 Home
                    </button>
                    <button className="history-btn" onClick={loadHistory}>
                        📜 History
                    </button>
                    <button className="settings-btn" onClick={() => setShowAccessibility(true)} title="Accessibility">
                        🎨
                    </button>
                    <button className="settings-btn" onClick={() => setShowSettings(true)}>
                        ⚙️ Settings
                    </button>
                </div>
            </header>

            {/* Main Content */}
            <main className="main-content">
                {/* Idle Screen */}
                {screen === 'idle' && (
                    <div className="idle-screen">
                        <p className="idle-subtitle">
                            Transform your inbox chaos into executive clarity
                        </p>

                        <button
                            className="brief-button"
                            onClick={handleFetchBriefing}
                            disabled={!isAuthenticated || !hasApiKey}
                        >
                            ✨ Brief Me
                        </button>

                        <div className="auth-status">
                            <div className={`auth-badge ${hasApiKey ? 'connected' : 'disconnected'}`}>
                                {hasApiKey ? '✓' : '✗'} Cohere API Key
                            </div>

                            <div className={`auth-badge ${isAuthenticated ? 'connected' : 'disconnected'}`}>
                                {isAuthenticated ? '✓' : '✗'} Google Account
                            </div>

                            {!isAuthenticated && (
                                <button className="connect-btn" onClick={handleSignIn}>
                                    Sign in with Google
                                </button>
                            )}

                            {!hasApiKey && (
                                <button className="connect-btn" onClick={() => setShowSettings(true)}>
                                    Add API Key
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* Loading Screen */}
                {screen === 'loading' && (
                    <div className="loading-screen">
                        <div className="loading-spinner" />
                        <p className="loading-message">{loadingMessage}</p>
                        {progress ? (
                            <p className="loading-count">
                                Processing {progress.current} of {progress.total} emails ({progress.percent}%)
                            </p>
                        ) : (
                            <p className="loading-count">Initializing pipeline...</p>
                        )}
                    </div>
                )}

                {/* Results Screen */}
                {screen === 'result' && briefing && !selectedBlock && (
                    <div className="results-screen">
                        <div className="results-header">
                            <h1 className="briefing-title">{briefing.title}</h1>
                            <p className="briefing-meta">
                                {progress && progress.percent < 100 ? (
                                    <span style={{ color: 'var(--accent-primary)', fontWeight: 'bold' }}>
                                        {/* Spinner could be added here if desired */}
                                        Processing... {progress.percent}% ({progress.current}/{progress.total})
                                    </span>
                                ) : (
                                    <span>Synthesized from {emailCount} email{emailCount !== 1 ? 's' : ''}</span>
                                )}
                            </p>
                            <button className="reset-btn" onClick={handleReset}>
                                ← New Brief
                            </button>
                        </div>

                        <div className="cards-grid">
                            {briefing.summary_blocks.map((block, index) => (
                                <article
                                    key={index}
                                    className="glass-card clickable"
                                    style={{ animationDelay: `${index * 0.1}s` }}
                                    onClick={() => setSelectedBlock(block)}
                                >
                                    <div className="card-header">
                                        <span className="card-icon">{block.icon}</span>
                                        <span className="card-category">{block.category}</span>
                                        {block.isSponsored && (
                                            <span className="sponsored-badge">📢 Ad</span>
                                        )}
                                        <span className={`sentiment-badge ${block.sentiment.toLowerCase()}`} />
                                    </div>

                                    <h2 className="card-headline">{block.headline}</h2>

                                    {block.senderName && (
                                        <p className="card-sender">From: {block.senderName}</p>
                                    )}

                                    <ul className="card-bullets">
                                        {block.bullet_points.map((point, i) => (
                                            <li key={i}>{point}</li>
                                        ))}
                                    </ul>

                                    <p className="card-hint">Click to view full details →</p>
                                </article>
                            ))}
                        </div>
                    </div>
                )}

                {/* Detail View Screen */}
                {screen === 'result' && selectedBlock && (
                    <div className="detail-screen">
                        <div className="detail-header">
                            <button className="back-btn" onClick={() => setSelectedBlock(null)}>
                                ← Back to Briefing
                            </button>
                            <div className="detail-meta">
                                <span className="card-icon">{selectedBlock.icon}</span>
                                <span className="card-category">{selectedBlock.category}</span>
                                {selectedBlock.isSponsored && (
                                    <span className="sponsored-badge">📢 Sponsored Content</span>
                                )}
                                <span className={`sentiment-badge ${selectedBlock.sentiment.toLowerCase()}`} />
                            </div>
                        </div>

                        <h1 className="detail-headline">{selectedBlock.headline}</h1>

                        {selectedBlock.sourceEmailSubject && (
                            <p className="detail-source">
                                Source: {selectedBlock.sourceEmailSubject}
                            </p>
                        )}

                        <div className="detail-content glass-card">
                            <h3>Key Takeaways</h3>
                            <ul className="detail-bullets">
                                {selectedBlock.bullet_points.map((point, i) => (
                                    <li key={i} className="bullet-item-with-source">
                                        <span>{point}</span>
                                        <div className="tooltip-container">
                                            <button className="source-btn">📄</button>
                                            <div className="tooltip-bubble">
                                                <div className="tooltip-header">Source Info</div>
                                                <div className="tooltip-content">
                                                    <div><strong>Subject:</strong> {selectedBlock.sourceEmailSubject || 'Unknown'}</div>
                                                    <div style={{ marginTop: '4px' }}><strong>Sender:</strong> {selectedBlock.senderName || 'Unknown'}</div>
                                                    <div style={{ fontSize: '0.8em', opacity: 0.8 }}>{selectedBlock.senderEmail}</div>
                                                </div>
                                            </div>
                                        </div>
                                    </li>
                                ))}
                            </ul>

                            {selectedBlock.detailed_points && selectedBlock.detailed_points.length > 0 && (
                                <>
                                    <h3>Full Details</h3>
                                    <ul className="detail-full-points">
                                        {selectedBlock.detailed_points.map((point, i) => {
                                            // Handle both legacy string format and new object format
                                            const isObject = typeof point === 'object' && point !== null;
                                            const text = isObject ? (point as { text: string }).text : point as string;
                                            const isSponsored = isObject ? (point as { isSponsored?: boolean }).isSponsored : false;

                                            return (
                                                <li key={i} className={isSponsored ? 'sponsored-point' : ''}>
                                                    {isSponsored && <span className="point-sponsored-badge">📢 Ad</span>}
                                                    {text}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </>
                            )}
                        </div>
                    </div>
                )}

                {/* Error Screen */}
                {screen === 'error' && (
                    <div className="error-screen">
                        <div className="error-icon">😵</div>
                        <h2 className="error-title">Something went wrong</h2>
                        <p className="error-message">{error}</p>
                        <div className="error-actions">
                            <button className="btn-secondary" onClick={handleReset}>
                                Go Back
                            </button>
                            <button className="btn-primary" onClick={handleFetchBriefing}>
                                Try Again
                            </button>
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
                            <button className="modal-close" onClick={() => setShowSettings(false)}>
                                ×
                            </button>
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
                                <a
                                    href="#"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        window.briefingAPI.openExternal('https://dashboard.cohere.com/api-keys');
                                    }}
                                    style={{ color: '#667eea' }}
                                >
                                    dashboard.cohere.com
                                </a>
                            </p>
                        </div>

                        <div className="form-group">
                            <label className="form-label">
                                API Key Type
                                <span className="tooltip-trigger" title="Trial keys have slower response times due to rate limiting. Production keys are faster. This setting adjusts the timeout accordingly (90s for trial, 60s for production).">
                                    ⓘ
                                </span>
                            </label>
                            <div className="key-type-toggle">
                                <button
                                    className={`key-type-btn ${cohereKeyType === 'trial' ? 'active' : ''}`}
                                    onClick={() => saveCohereKeyType('trial')}
                                >
                                    🧪 Trial
                                </button>
                                <button
                                    className={`key-type-btn ${cohereKeyType === 'production' ? 'active' : ''}`}
                                    onClick={() => saveCohereKeyType('production')}
                                >
                                    🚀 Production
                                </button>
                            </div>
                            <p className="form-hint key-type-hint">
                                {cohereKeyType === 'trial'
                                    ? 'Using 90s timeout for trial API (slower due to rate limits)'
                                    : 'Using 60s timeout for production API (faster responses)'}
                            </p>
                        </div>

                        <div className="form-group">
                            <label className="form-label">Google Account</label>
                            <div className={`auth-badge ${isAuthenticated ? 'connected' : 'disconnected'}`}>
                                {isAuthenticated ? '✓ Connected' : '✗ Not connected'}
                            </div>
                            {!isAuthenticated && (
                                <button
                                    className="connect-btn"
                                    style={{ marginTop: '0.5rem' }}
                                    onClick={handleSignIn}
                                >
                                    Sign in with Google
                                </button>
                            )}
                            {isAuthenticated && (
                                <button
                                    className="connect-btn"
                                    style={{ marginTop: '0.5rem' }}
                                    onClick={async () => {
                                        await getAPI().signOut();
                                        setIsAuthenticated(false);
                                    }}
                                >
                                    Sign Out
                                </button>
                            )}
                        </div>

                        <div className="modal-actions">
                            <button className="btn-secondary" onClick={() => setShowSettings(false)}>
                                Cancel
                            </button>
                            <button className="btn-primary" onClick={handleSaveApiKey}>
                                Save
                            </button>
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
                                    <button
                                        className="clear-history-btn"
                                        onClick={() => setShowClearConfirm(true)}
                                    >
                                        🗑️ Clear All
                                    </button>
                                )}
                                <button className="modal-close" onClick={() => setShowHistory(false)}>
                                    ×
                                </button>
                            </div>
                        </div>

                        <div className="history-list">
                            {history.length === 0 ? (
                                <p className="history-empty">No saved briefings yet. Generate your first briefing!</p>
                            ) : (
                                history.map((entry, index) => (
                                    <div
                                        key={index}
                                        className="history-item glass-card clickable"
                                        onClick={() => loadHistoryEntry(entry)}
                                    >
                                        <div className="history-item-date">
                                            {new Date(entry.date).toLocaleDateString('en-US', {
                                                weekday: 'short',
                                                month: 'short',
                                                day: 'numeric',
                                                hour: '2-digit',
                                                minute: '2-digit'
                                            })}
                                        </div>
                                        <div className="history-item-title">{entry.briefing.title}</div>
                                        <div className="history-item-meta">
                                            {entry.emailCount} email{entry.emailCount !== 1 ? 's' : ''} • {entry.briefing.summary_blocks.length} cards
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Accessibility Modal */}
            {showAccessibility && (
                <div className="modal-overlay" onClick={() => setShowAccessibility(false)}>
                    <div className="modal-content settings-modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">Appearance & Accessibility</h2>
                            <button className="modal-close" onClick={() => setShowAccessibility(false)}>×</button>
                        </div>

                        <div className="settings-form">
                            <div className="form-group">
                                <label>Accent Color</label>
                                <div className="color-picker-grid">
                                    {['#06b6d4', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#3b82f6'].map(color => (
                                        <button
                                            key={color}
                                            className={`color-swatch ${accessSettings.accentColor === color ? 'active' : ''}`}
                                            style={{ backgroundColor: color }}
                                            onClick={() => saveAccessibilitySettings({ ...accessSettings, accentColor: color })}
                                        />
                                    ))}
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Background Style</label>
                                <div className="background-selector">
                                    <button
                                        className={`bg-option ${accessSettings.backgroundMode === 'simple' || !accessSettings.backgroundMode ? 'active' : ''}`}
                                        onClick={() => saveAccessibilitySettings({ ...accessSettings, backgroundMode: 'simple' })}
                                    >
                                        Simple 🕸️
                                    </button>
                                    <button
                                        className={`bg-option ${accessSettings.backgroundMode === 'snow' ? 'active' : ''}`}
                                        onClick={() => saveAccessibilitySettings({ ...accessSettings, backgroundMode: 'snow' })}
                                    >
                                        Snow ❄️
                                    </button>
                                    <button
                                        className={`bg-option ${accessSettings.backgroundMode === 'nebula' ? 'active' : ''}`}
                                        onClick={() => saveAccessibilitySettings({ ...accessSettings, backgroundMode: 'nebula' })}
                                    >
                                        Nebula 🌌
                                    </button>
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Font Size ({accessSettings.fontSize}%)</label>
                                <input
                                    type="range"
                                    min="80"
                                    max="150"
                                    step="10"
                                    value={accessSettings.fontSize}
                                    onChange={(e) => saveAccessibilitySettings({ ...accessSettings, fontSize: Number(e.target.value) })}
                                    className="range-slider"
                                />
                            </div>

                            <div className="form-group row">
                                <label>Enable Animations</label>
                                <label className="toggle-switch">
                                    <input
                                        type="checkbox"
                                        checked={accessSettings.animationsEnabled}
                                        onChange={(e) => saveAccessibilitySettings({ ...accessSettings, animationsEnabled: e.target.checked })}
                                    />
                                    <span className="slider round"></span>
                                </label>
                            </div>
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
                            <button
                                className="btn-secondary"
                                onClick={() => setShowClearConfirm(false)}
                            >
                                Cancel
                            </button>
                            <button
                                className="btn-danger"
                                onClick={async () => {
                                    await getAPI().clearHistory();
                                    setHistory([]);
                                    setShowClearConfirm(false);
                                }}
                            >
                                Delete All
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;
