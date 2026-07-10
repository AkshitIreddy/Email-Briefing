// ============================================
// DASHBOARD TYPES (mirror of electron/types.ts)
// ============================================

export type DashboardTemplate = 'pulse' | 'editorial' | 'timeline' | 'spotlight' | 'matrix';

export interface SearchSource {
    title: string;
    url: string;
    snippet: string;
    engine: 'duckduckgo' | 'wikipedia';
}

export interface DashboardImage {
    url: string;
    title?: string;
    sourceUrl?: string;
    provider: 'wikipedia' | 'openverse' | 'commons' | 'scenic';
}

export interface EmailRef {
    subject: string;
    senderName: string;
    senderEmail: string;
    emailId?: string;
}

export interface EmailContent {
    subject: string;
    senderName: string;
    senderEmail: string;
    body: string;
}

export interface DashboardStat {
    label: string;
    value: string;
    context?: string;
}

export interface DashboardKeyPoint {
    text: string;
    tag?: string;
    is_sponsored?: boolean;
}

export interface DashboardContent {
    headline: string;
    overview: string;
    sentiment: 'Positive' | 'Negative' | 'Neutral';
    stats: DashboardStat[];
    key_points: DashboardKeyPoint[];
    timeline: Array<{ label: string; text: string }>;
    quotes: Array<{ text: string; attribution?: string }>;
    action_items: string[];
    glossary: Array<{ term: string; definition: string }>;
    web_context: Array<{ title: string; text: string; source_index?: number }>;
    fun_fact?: string;
}

export interface TopicDashboard {
    id: string;
    topic: string;
    category: string;
    icon: string;
    template: DashboardTemplate;
    content: DashboardContent;
    sources: SearchSource[];
    images: DashboardImage[];
    emails: EmailRef[];
    generatedAt: string;
}

export interface Tidbit {
    text: string;
    emoji?: string;
    quote?: string;
    source?: EmailRef;
}

export interface DashboardBriefing {
    title: string;
    dashboards: TopicDashboard[];
    tidbits?: Tidbit[];
    emailContents?: Record<string, EmailContent>;
}

// ============================================
// LEGACY TYPES (old history entries)
// ============================================

export interface LegacySummaryBlock {
    category: string;
    icon: string;
    headline: string;
    bullet_points: string[];
    detailed_points?: Array<string | { text: string; isSponsored?: boolean }>;
    sentiment: string;
    isSponsored?: boolean;
    sourceEmailSubject?: string;
    senderName?: string;
    senderEmail?: string;
}

export interface LegacyBriefing {
    title: string;
    summary_blocks: LegacySummaryBlock[];
}

// ============================================
// APP STATE TYPES
// ============================================

export type AppScreen = 'idle' | 'loading' | 'result' | 'error';

export interface HistoryEntry {
    date: string;
    title?: string;
    emailCount: number;
    dashboards?: TopicDashboard[];
    tidbits?: Tidbit[];
    emailContents?: Record<string, EmailContent>;
    briefing?: LegacyBriefing; // legacy entries
}

export type FontFamilyOption = 'inter' | 'space-grotesk' | 'serif' | 'mono' | 'system';
export type ContentWidthOption = 'narrow' | 'comfortable' | 'wide';
export type ThemeOption = 'midnight' | 'graphite' | 'light' | 'sepia';
export type BackgroundMode = 'simple' | 'snow' | 'nebula';

export interface AppSettings {
    accentColor: string;
    highlightColor: string;
    fontSize: number;
    fontFamily: FontFamilyOption;
    lineHeight: number;
    contentWidth: ContentWidthOption;
    theme: ThemeOption;
    highlightsEnabled: boolean;
    animationsEnabled: boolean;
    backgroundMode: BackgroundMode;
}

export const DEFAULT_SETTINGS: AppSettings = {
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

// Cohere API key type - affects timeout values
export type CohereKeyType = 'trial' | 'production';

export interface ProgressData {
    stage: string;
    message: string;
    current: number;
    total: number;
    percent: number;
}

export interface BriefingAPI {
    fetchBriefing: () => Promise<{ success: boolean; data?: DashboardBriefing; error?: string; emailCount?: number }>;
    signInWithGoogle: () => Promise<{ success: boolean; error?: string }>;
    signOut: () => Promise<void>;
    checkAuthStatus: () => Promise<{ isAuthenticated: boolean; hasApiKey: boolean }>;
    setApiKey: (key: string) => Promise<void>;
    getApiKey: () => Promise<string | null>;
    getHistory: () => Promise<HistoryEntry[]>;
    clearHistory: () => Promise<void>;
    getLogs?: () => Promise<string>;
    getBriefingFocus?: () => Promise<{ focus: string; defaultFocus: string }>;
    setBriefingFocus?: (focus: string) => Promise<void>;
    getSettings: () => Promise<AppSettings>;
    setSettings: (settings: AppSettings) => Promise<void>;
    getCohereKeyType: () => Promise<CohereKeyType>;
    setCohereKeyType: (keyType: CohereKeyType) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    onProgress: (callback: (data: ProgressData) => void) => () => void;
    onDashboardGenerated: (callback: (dashboard: TopicDashboard) => void) => () => void;
    onTidbits?: (callback: (tidbits: Tidbit[]) => void) => () => void;
    onEmailContents?: (callback: (contents: Record<string, EmailContent>) => void) => () => void;
}

declare global {
    interface Window {
        briefingAPI: BriefingAPI;
    }
}
