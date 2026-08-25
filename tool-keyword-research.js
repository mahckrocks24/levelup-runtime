'use strict';

/**
 * Tool: keyword_research
 * LLM-powered keyword research with search intent analysis.
 * Returns structured keyword data including difficulty estimates and content angles.
 */

const { callLLM } = require('./llm');

module.exports = {
    name:           'keyword_research',
    description:    'Researches keywords for a given topic or seed keyword. Returns primary and secondary keywords with search intent, estimated difficulty, content angles, and which keywords to prioritise based on opportunity.',
    execution_type: 'worker_job',
    governance_tier: 0,
    required_permissions: ['seo:read'],
    timeout_ms: 30000,

    parameters: {
        type: 'object',
        properties: {
            topic: {
                type:        'string',
                description: 'The topic or seed keyword to research (e.g. "project management software", "SEO for restaurants")',
            },
            industry: {
                type:        'string',
                description: 'The industry or business context (optional, improves relevance)',
            },
            intent: {
                type:        'string',
                description: 'Focus on specific intent: "informational", "commercial", "transactional", or "all" (default: all)',
                enum:        ['informational', 'commercial', 'transactional', 'all'],
            },
        },
        required: ['topic'],
    },

    async handler(payload, context) {
        const { topic, industry = '', intent = 'all' } = payload;
        if (!topic) throw new Error('topic is required for keyword research.');

        console.log(`[KW_RESEARCH] Topic: "${topic}" | Industry: "${industry}" | Intent: ${intent}`);

        const intentInstruction = intent !== 'all'
            ? `Focus primarily on ${intent} intent keywords.`
            : 'Include a mix of informational, commercial, and transactional intent keywords.';

        const industryContext = industry
            ? `The business is in the ${industry} industry.`
            : '';

        const prompt = `You are an expert SEO strategist. Perform comprehensive keyword research for the topic: "${topic}". ${industryContext} ${intentInstruction}

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation, just the JSON):

{
  "primary_keywords": [
    {
      "keyword": "exact keyword phrase",
      "monthly_searches": "estimated monthly search volume as range e.g. 1K-10K",
      "difficulty": "Low|Medium|High|Very High",
      "intent": "informational|commercial|transactional|navigational",
      "opportunity_score": 1-10,
      "rationale": "why this keyword is worth targeting"
    }
  ],
  "secondary_keywords": [
    {
      "keyword": "exact keyword phrase",
      "monthly_searches": "estimated range",
      "difficulty": "Low|Medium|High|Very High",
      "intent": "informational|commercial|transactional|navigational",
      "opportunity_score": 1-10
    }
  ],
  "long_tail_keywords": [
    {
      "keyword": "longer, more specific phrase",
      "monthly_searches": "estimated range",
      "difficulty": "Low|Medium|High|Very High",
      "intent": "informational|commercial|transactional|navigational",
      "opportunity_score": 1-10,
      "content_angle": "suggested angle for a piece of content targeting this"
    }
  ],
  "content_gaps": ["topic or keyword cluster the business should cover but might be missing"],
  "quick_wins": ["specific keywords with high opportunity and lower difficulty to target first"],
  "summary": "2-3 sentence strategic overview of the keyword landscape and recommended approach"
}

Provide exactly 5 primary keywords, 8 secondary keywords, and 6 long-tail keywords. Be specific and realistic with difficulty and volume estimates.`;

        const response = await callLLM({
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 2000,
            temperature: 0.3,
        });

        // Parse the JSON response
        let data;
        try {
            const clean = response.content
                .replace(/```json\n?/g, '')
                .replace(/```\n?/g, '')
                .trim();
            data = JSON.parse(clean);
        } catch (err) {
            console.error('[KW_RESEARCH] JSON parse failed:', response.content.substring(0, 200));
            throw new Error('Keyword research returned malformed data. Please try again.');
        }

        return {
            topic,
            industry:    industry || null,
            intent_focus: intent,
            researched_at: new Date().toISOString(),
            ...data,
        };
    },

    memory_hint(result) {
        const topKw = result.primary_keywords?.[0]?.keyword || 'unknown';
        const count = (result.primary_keywords?.length || 0) + (result.secondary_keywords?.length || 0);
        return `Keyword research for "${result.topic}": ${count} keywords found. Top opportunity: "${topKw}". Quick wins: ${result.quick_wins?.slice(0,2).join(', ')}.`;
    },
};
