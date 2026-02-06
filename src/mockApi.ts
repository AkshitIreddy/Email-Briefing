import { BriefingAPI, Briefing } from './types';

export const mockBriefingAPI: BriefingAPI = {
    fetchBriefing: async () => {
        console.log('[MOCK] Fetching briefing...');
        await new Promise(resolve => setTimeout(resolve, 2000)); // Simulate delay

        // Return mock data
        const mockData: Briefing = {
            title: "The Daily Signal: Tech & AI Overload 🚀",
            summary_blocks: [
                {
                    category: "Tech",
                    icon: "💻",
                    headline: "Silicon Valley's New obsession",
                    bullet_points: [
                        "Developers are shifting to Rust en masse",
                        "New framework 'Hydra' promises 10x speeds",
                        "Tech giants pause hiring for Q3"
                    ],
                    sentiment: "Neutral"
                },
                {
                    category: "AI",
                    icon: "🤖",
                    headline: "AGI is closer than we think?",
                    bullet_points: [
                        "OpenAI releases cryptic tweet about Q*",
                        "DeepMind announces new folding breakthrough",
                        "Regulation talks heat up in EU parliament"
                    ],
                    sentiment: "Good"
                },
                {
                    category: "Markets",
                    icon: "📈",
                    headline: "Crypto bounces back",
                    bullet_points: [
                        "Bitcoin touches 70k again",
                        "SEC approves new ETF applications",
                        "Tech stocks rally on earnings beat"
                    ],
                    sentiment: "Good"
                }
            ]
        };

        return { success: true, data: mockData, emailCount: 15 };
    },

    signInWithGoogle: async () => {
        console.log('[MOCK] Signing in with Google...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { success: true };
    },

    signOut: async () => {
        console.log('[MOCK] Signing out...');
        await new Promise(resolve => setTimeout(resolve, 500));
    },

    checkAuthStatus: async () => {
        console.log('[MOCK] Checking auth status...');
        // Return authenticated for testing happy path
        return { isAuthenticated: true, hasApiKey: true };
    },

    setApiKey: async (key: string) => {
        console.log('[MOCK] Setting API key:', key);
    },

    getApiKey: async () => {
        console.log('[MOCK] Getting API key...');
        return "mok_dummy_api_key_12345";
    },

    openExternal: async (url: string) => {
        console.log('[MOCK] Opening external URL:', url);
        window.open(url, '_blank');
    },

    // Missing methods implementation
    getHistory: async () => {
        console.log('[MOCK] Getting history...');
        return [];
    },
    clearHistory: async () => {
        console.log('[MOCK] Clearing history...');
    },
    getSettings: async () => {
        return {
            accentColor: '#06b6d4',
            fontSize: 100,
            animationsEnabled: true,
            backgroundMode: 'simple'
        };
    },
    setSettings: async (settings) => {
        console.log('[MOCK] Setting settings:', settings);
    },
    getCohereKeyType: async () => 'trial',
    setCohereKeyType: async (type) => { console.log('Set key type:', type); },

    onProgress: (callback) => {
        // Simulate progress
        let count = 0;
        const total = 10;
        const interval = setInterval(() => {
            count++;
            callback({ current: count, total, percent: Math.round((count / total) * 100) });
            if (count >= total) clearInterval(interval);
        }, 500);
        return () => clearInterval(interval);
    },

    onCardGenerated: (callback) => {
        // Simulate streaming cards
        let count = 0;
        const interval = setInterval(() => {
            if (count >= 3) {
                clearInterval(interval);
                return;
            }
            callback({
                category: "Tech",
                icon: "💻",
                headline: `Mock Streamed Card ${count + 1}`,
                bullet_points: ["Streamed point 1", "Streamed point 2"],
                sentiment: "Good"
            });
            count++;
        }, 800);
        return () => clearInterval(interval);
    }
};
