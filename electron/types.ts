import { z } from 'zod';

// ============================================
// AI OUTPUT SCHEMAS (Zod)
// ============================================

// ---- Stage 1: Topic clustering ----
export const TopicPlanSchema = z.object({
    topics: z.array(z.object({
        title: z.string(),
        category: z.enum(['Tech', 'Markets', 'World', 'AI', 'Business', 'Science', 'Politics', 'Health', 'Culture', 'General']),
        icon: z.string(),
        email_indexes: z.array(z.number()),
        search_queries: z.array(z.string()).min(1).max(3),
        image_query: z.string(),
    })).min(1),
});

export type TopicPlan = z.infer<typeof TopicPlanSchema>;

// ---- Stage 2: Dashboard content ----
export const DashboardContentSchema = z.object({
    headline: z.string(),
    overview: z.string(),
    sentiment: z.enum(['Positive', 'Negative', 'Neutral']),
    stats: z.array(z.object({
        label: z.string(),
        value: z.string(),
        context: z.string().optional(),
    })).default([]),
    key_points: z.array(z.object({
        text: z.string(),
        tag: z.string().optional(),
        is_sponsored: z.boolean().optional(),
    })).default([]),
    timeline: z.array(z.object({
        label: z.string(),
        text: z.string(),
    })).optional().default([]),
    quotes: z.array(z.object({
        text: z.string(),
        attribution: z.string().optional(),
    })).optional().default([]),
    action_items: z.array(z.string()).optional().default([]),
    glossary: z.array(z.object({
        term: z.string(),
        definition: z.string(),
    })).optional().default([]),
    web_context: z.array(z.object({
        title: z.string(),
        text: z.string(),
        source_index: z.number().optional(),
    })).optional().default([]),
    fun_fact: z.string().optional(),
});

export type DashboardContent = z.infer<typeof DashboardContentSchema>;

// ============================================
// DASHBOARD TYPES
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
    provider: 'wikipedia' | 'openverse';
}

export interface EmailRef {
    subject: string;
    senderName: string;
    senderEmail: string;
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

export interface DashboardBriefing {
    title: string;
    dashboards: TopicDashboard[];
}

// ============================================
// LEGACY TYPES (for old history entries)
// ============================================

export const SummaryBlockSchema = z.object({
    category: z.string(),
    icon: z.string(),
    headline: z.string(),
    bullet_points: z.array(z.string()),
    detailed_points: z.array(z.any()).optional(),
    sentiment: z.string(),
    isSponsored: z.boolean().optional(),
    sourceEmailSubject: z.string().optional(),
    senderName: z.string().optional(),
    senderEmail: z.string().optional(),
});

export const BriefingSchema = z.object({
    title: z.string(),
    summary_blocks: z.array(SummaryBlockSchema),
});

export type SummaryBlock = z.infer<typeof SummaryBlockSchema>;
export type Briefing = z.infer<typeof BriefingSchema>;
