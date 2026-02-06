import { z } from 'zod';

// ============================================
// AI OUTPUT SCHEMA (Zod)
// ============================================

// Detailed point with per-point sponsored flag
export const DetailedPointSchema = z.union([
    z.string(), // Legacy format (plain string)
    z.object({
        text: z.string(),
        isSponsored: z.boolean().optional()
    })
]);

export const SummaryBlockSchema = z.object({
    category: z.enum(['Tech', 'Markets', 'World', 'AI', 'Business', 'Science', 'Politics', 'General']),
    icon: z.string().describe('An emoji representing this category'),
    headline: z.string().describe('A punchy, one-line headline'),
    bullet_points: z.array(z.string()).describe('3-5 key takeaways'),
    detailed_points: z.array(DetailedPointSchema).describe('Full organized content from the email').optional(),
    sentiment: z.enum(['Neutral', 'Good', 'Bad']).describe('Overall sentiment of this topic'),
    isSponsored: z.boolean().describe('True if ENTIRE email is an ad/sponsored content').optional(),
    sourceEmailSubject: z.string().describe('Original email subject line').optional(),
    senderName: z.string().describe('Name of the email sender').optional(),
    senderEmail: z.string().describe('Email address of the sender').optional(),
});

// Helper type for detailed points
export type DetailedPoint = z.infer<typeof DetailedPointSchema>;

export const BriefingSchema = z.object({
    title: z.string().describe('A witty, creative title for today\'s briefing'),
    summary_blocks: z.array(SummaryBlockSchema).describe('Array of categorized summaries'),
});

// ============================================
// TYPESCRIPT TYPES
// ============================================

export type SummaryBlock = z.infer<typeof SummaryBlockSchema>;
export type Briefing = z.infer<typeof BriefingSchema>;

// App State Types
export type AppScreen = 'idle' | 'loading' | 'result' | 'error' | 'settings';

export interface AppState {
    screen: AppScreen;
    briefing: Briefing | null;
    error: string | null;
    loadingMessage: string;
    emailCount: number;
    isAuthenticated: boolean;
    hasApiKey: boolean;
}

// IPC API Types
export interface HistoryEntry {
    date: string;
    briefing: Briefing;
    emailCount: number;
}

export interface AccessibilitySettings {
    accentColor: string;
    fontSize: number;
    animationsEnabled: boolean;
    backgroundMode: 'simple' | 'snow' | 'nebula';
}

// Cohere API key type - affects timeout values
export type CohereKeyType = 'trial' | 'production';

export interface CohereSettings {
    keyType: CohereKeyType;
}

export interface BriefingAPI {
    fetchBriefing: () => Promise<{ success: boolean; data?: Briefing; error?: string; emailCount?: number }>;
    signInWithGoogle: () => Promise<{ success: boolean; error?: string }>;
    signOut: () => Promise<void>;
    checkAuthStatus: () => Promise<{ isAuthenticated: boolean; hasApiKey: boolean }>;
    setApiKey: (key: string) => Promise<void>;
    getApiKey: () => Promise<string | null>;
    getHistory: () => Promise<HistoryEntry[]>;
    clearHistory: () => Promise<void>;
    getSettings: () => Promise<AccessibilitySettings>;
    setSettings: (settings: AccessibilitySettings) => Promise<void>;
    getCohereKeyType: () => Promise<CohereKeyType>;
    setCohereKeyType: (keyType: CohereKeyType) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    onProgress: (callback: (data: { current: number; total: number; percent: number }) => void) => () => void;
    onCardGenerated: (callback: (card: SummaryBlock) => void) => () => void;
}

declare global {
    interface Window {
        briefingAPI: BriefingAPI;
    }
}
