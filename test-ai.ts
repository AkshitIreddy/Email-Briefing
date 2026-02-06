
import { ChatCohere } from '@langchain/cohere';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

dotenv.config();

// Define Schema (Same as main.ts)
const SummaryBlockSchema = z.object({
    category: z.enum(['Tech', 'Markets', 'World', 'AI', 'Business', 'Science', 'Politics']),
    icon: z.string().describe('An emoji representing this category'),
    headline: z.string().describe('A punchy, one-line headline'),
    bullet_points: z.array(z.string()).describe('3-5 key takeaways'),
    sentiment: z.enum(['Neutral', 'Good', 'Bad']).describe('Overall sentiment of this topic'),
});

const BriefingSchema = z.object({
    title: z.string().describe('A witty, creative title for today\'s briefing'),
    summary_blocks: z.array(SummaryBlockSchema).describe('Array of categorized summaries'),
});

async function runTest() {
    const apiKey = process.env.COHERE_API_KEY;
    if (!apiKey) {
        console.error("❌ No COHERE_API_KEY found in .env");
        process.exit(1);
    }

    console.log("🚀 Testing Cohere Model: command-r-08-2024");

    const model = new ChatCohere({
        model: 'command-r-08-2024',
        apiKey: apiKey,
        temperature: 0,
    });

    // STRATEGY CHANGE: Use Raw JSON Mode
    const systemPrompt = `You are an elite Chief of Staff preparing an executive briefing. 
Your goal is to summarize the provided emails into a structured JSON format.

JSON SCHEMA:
{
  "title": "A witty, creative title for today's briefing",
  "summary_blocks": [
    {
      "category": "Tech" | "Markets" | "AI" | "World" | "Business" | "Science" | "Politics",
      "icon": "Emoji string",
      "headline": "Punchy one-line headline",
      "bullet_points": ["Key takeaway 1", "Key takeaway 2", "Key takeaway 3"],
      "sentiment": "Neutral" | "Good" | "Bad"
    }
  ]
}

INSTRUCTIONS:
1. AGGRESSIVELY filter out ads, promos, and intro/outro fluff.
2. SYNTHESIZE insights into the categories above.
3. RETURN ONLY VALID JSON. Do not include markdown formatting (like \`\`\`json).
`;

    const dummyEmails = `
=== EMAIL: Tech Daily ===
FROM: newsletter@tech.com
---
Big news today! Apple revealed the iPhone 16. It has a transparent screen and lasts 4 weeks on a charge. 
Critics are saying it's the biggest leap in a decade. Usage of the device requires a retinal scan.
Also, Google announced they are shutting down Gmail in favor of "Inbox AI", a tool that writes emails for you.

=== EMAIL: Market Watch ===
FROM: updates@markets.com
---
The S&P 500 is down 2% today after the Fed announced interest rates will hit 10%.
Wait, that was a typo. They meant 1.0%. Markets rallied immediately after the correction.
Bitcoin is currently stable at $65k.
`;

    console.log("📡 Sending request...");
    const start = Date.now();

    try {
        const response = await model.invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(dummyEmails),
        ]);

        console.log(`✅ Response received in ${(Date.now() - start) / 1000}s`);

        let briefingData;
        try {
            let cleanJson = response.content.toString();
            cleanJson = cleanJson.replace(/```json/g, '').replace(/```/g, '').trim();
            briefingData = JSON.parse(cleanJson);
        } catch (e) {
            console.error('[AI ERROR] Failed to parse JSON:', e);
            console.error('[RAW TEXT]:', response.content);
            throw new Error('AI returned invalid JSON');
        }

        console.log("---------------------------------------------------");
        console.log(JSON.stringify(briefingData, null, 2));
        console.log("---------------------------------------------------");

        // Verify blocks
        // @ts-ignore
        if (briefingData.summary_blocks && briefingData.summary_blocks.length > 0) {
            console.log(`🎉 SUCCESS: Received ${briefingData.summary_blocks.length} summary blocks.`);
        } else {
            console.error("⚠️ WARNING: Received empty summary_blocks array.");
        }

    } catch (error) {
        console.error("❌ Error:", error);
    }
}

runTest();
