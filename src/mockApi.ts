import { BriefingAPI, DashboardBriefing, TopicDashboard, DEFAULT_SETTINGS } from './types';

const mockDashboard = (i: number): TopicDashboard => ({
    id: `mock-${i}`,
    topic: ['AI Model Releases', 'Crypto Market Rally', 'SpaceX Starship Update'][i % 3],
    category: ['AI', 'Markets', 'Science'][i % 3],
    icon: ['🤖', '📈', '🚀'][i % 3],
    template: (['pulse', 'editorial', 'timeline', 'spotlight', 'matrix'] as const)[i % 5],
    content: {
        headline: `Mock dashboard headline number ${i + 1} with ==highlighted phrase==`,
        overview: 'This is a mock overview synthesizing several emails and web results. It mentions ==a key development== and explains why it matters in two or three sentences for testing the reading experience.',
        sentiment: (['Positive', 'Neutral', 'Negative'] as const)[i % 3],
        stats: [
            { label: 'Funding Raised', value: '$40M', context: 'Series B round' },
            { label: 'Users', value: '2.1M', context: 'up 30% MoM' },
            { label: 'Launch Date', value: 'Aug 2026' },
            { label: 'Valuation', value: '$1.2B' },
        ],
        key_points: [
            { text: 'First key point with ==important detail== for testing.', tag: 'Launch' },
            { text: 'Second key point about market movement.', tag: 'Markets' },
            { text: 'A sponsored key point example.', is_sponsored: true },
            { text: 'Fourth insight with **bold text** rendering.', tag: 'Risk' },
            { text: 'Fifth point to fill out the layout.' },
        ],
        timeline: [
            { label: 'Last Week', text: 'Initial announcement made at the developer conference.' },
            { label: 'Yesterday', text: 'Pricing details leaked via newsletter.' },
            { label: 'Next Month', text: 'Public availability expected worldwide.' },
        ],
        quotes: [
            { text: 'This changes everything about how we think about email.', attribution: 'Mock CEO, TechCorp' },
        ],
        action_items: ['Review the new pricing tiers', 'Watch the keynote replay', 'Update the team on changes'],
        glossary: [
            { term: 'RAG', definition: 'Retrieval-augmented generation, a technique for grounding LLM output in documents.' },
            { term: 'Series B', definition: 'A second round of institutional venture funding.' },
        ],
        web_context: [
            { title: 'Background from the web', text: 'Additional context found via search results for testing.', source_index: 1 },
            { title: 'Analyst reaction', text: 'Analysts are cautiously optimistic about the announcement.', source_index: 2 },
        ],
        fun_fact: 'The first email was sent in 1971 by Ray Tomlinson — to himself.',
    },
    sources: [
        { title: 'Example Coverage', url: 'https://example.com/article', snippet: 'Snippet one', engine: 'duckduckgo' },
        { title: 'Wikipedia: Example', url: 'https://en.wikipedia.org/wiki/Example', snippet: 'Snippet two', engine: 'wikipedia' },
    ],
    images: [
        { url: 'https://picsum.photos/seed/mock' + i + '/600/400', title: 'Mock image', provider: 'openverse' },
    ],
    emails: [
        { subject: 'The Download: today in tech', senderName: 'MIT Tech Review', senderEmail: 'newsletter@technologyreview.com' },
        { subject: 'Morning Brew ☕', senderName: 'Morning Brew', senderEmail: 'crew@morningbrew.com' },
    ],
    generatedAt: new Date().toISOString(),
});

export const mockBriefingAPI: BriefingAPI = {
    fetchBriefing: async () => {
        console.log('[MOCK] Fetching briefing...');
        await new Promise(resolve => setTimeout(resolve, 2500));
        const data: DashboardBriefing = {
            title: 'Briefing — Mock Edition',
            dashboards: [0, 1, 2, 3, 4].map(mockDashboard),
        };
        return { success: true, data, emailCount: 12 };
    },

    signInWithGoogle: async () => {
        await new Promise(resolve => setTimeout(resolve, 800));
        return { success: true };
    },

    signOut: async () => { },

    checkAuthStatus: async () => ({ isAuthenticated: true, hasApiKey: true }),

    setApiKey: async () => { },
    getApiKey: async () => 'mok_dummy_api_key_12345',

    openExternal: async (url: string) => { window.open(url, '_blank'); },

    getHistory: async () => [],
    clearHistory: async () => { },

    getSettings: async () => ({ ...DEFAULT_SETTINGS }),
    setSettings: async () => { },

    getCohereKeyType: async () => 'trial',
    setCohereKeyType: async () => { },

    onProgress: (callback) => {
        let count = 0;
        const total = 5;
        const interval = setInterval(() => {
            count++;
            callback({
                stage: count <= 1 ? 'emails' : count <= 2 ? 'topics' : 'dashboards',
                message: 'Working...',
                current: count, total,
                percent: Math.round((count / total) * 100),
            });
            if (count >= total) clearInterval(interval);
        }, 500);
        return () => clearInterval(interval);
    },

    onDashboardGenerated: (callback) => {
        let count = 0;
        const interval = setInterval(() => {
            if (count >= 5) { clearInterval(interval); return; }
            callback(mockDashboard(count));
            count++;
        }, 450);
        return () => clearInterval(interval);
    }
};
