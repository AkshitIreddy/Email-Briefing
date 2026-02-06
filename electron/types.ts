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
