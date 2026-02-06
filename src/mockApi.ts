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
    }
};
