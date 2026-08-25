'use strict';

/**
 * Tool: content_brief
 * Generates a detailed, actionable content brief for a target keyword.
 * Output is ready to hand to a writer.
 */

const { callLLM } = require('./llm');

module.exports = {
    name:           'content_brief',
    description:    'Creates a comprehensive content brief for a target keyword. Includes suggested title, meta description, heading structure, key points to cover, competitor content angles, internal linking suggestions, word count recommendation, and content format guidance.',
    execution_type: 'worker_job',
    governance_tier: 0,
    required_permissions: ['seo:read'],
    timeout_ms: 30000,

    parameters: {
        type: 'object',
        properties: {
            keyword: {
                type:        'string',
                description: 'The primary target keyword for this content piece',
            },
            business_context: {
                type:        'string',
                description: 'Brief description of the business, its products/services, and target audience',
            },
            content_type: {
                type:        'string',
                description: 'Type of content to create',
                enum:        ['blog_post', 'landing_page', 'product_page', 'guide', 'comparison'],
            },
            word_count_target: {
                type:        'number',
                description: 'Target word count (optional — will be recommended if not provided)',
            },
        },
        required: ['keyword'],
    },

    async handler(payload, context) {
        const {
            keyword,
            business_context = '',
            content_type     = 'blog_post',
            word_count_target,
        } = payload;

        if (!keyword) throw new Error('keyword is required for content brief.');
        console.log(`[CONTENT_BRIEF] Keyword: "${keyword}" | Type: ${content_type}`);

        const wordCountInstruction = word_count_target
            ? `Target word count: ${word_count_target} words.`
            : 'Recommend an appropriate word count based on the keyword and content type.';

        const businessCtx = business_context
            ? `Business context: ${business_context}`
            : '';

        const prompt = `You are a senior content strategist and SEO expert. Create a detailed content brief for the following:

Primary keyword: "${keyword}"
Content type: ${content_type}
${businessCtx}
${wordCountInstruction}

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):

{
  "keyword": "${keyword}",
  "content_type": "${content_type}",
  "recommended_title": "SEO-optimised title tag (50-60 chars)",
  "alt_titles": ["2 alternative title options"],
  "meta_description": "Compelling meta description (140-160 chars)",
  "recommended_word_count": 1500,
  "content_angle": "The unique angle this content should take to stand out",
  "search_intent": "What the user actually wants when searching this keyword",
  "target_audience": "Who this content is for",
  "outline": [
    {
      "heading": "H1: Main Heading",
      "type": "h1",
      "notes": "Key points to cover in this section",
      "suggested_word_count": 0
    },
    {
      "heading": "H2: Introduction",
      "type": "h2",
      "notes": "Hook, problem statement, what reader will learn",
      "suggested_word_count": 150
    }
  ],
  "key_points_to_cover": ["essential point 1", "essential point 2"],
  "keywords_to_include": {
    "primary": ["${keyword}", "close variations"],
    "secondary": ["supporting keywords to naturally include"],
    "avoid": ["terms that might confuse or dilute the focus"]
  },
  "content_format_notes": "e.g. include a table, FAQ section, statistics, examples",
  "internal_link_opportunities": ["suggested internal pages to link to"],
  "external_link_suggestions": ["types of authoritative sources to reference"],
  "call_to_action": "What the reader should do after reading this content",
  "competitive_differentiation": "How to make this better than existing content ranking for this keyword",
  "estimated_time_to_write": "e.g. 3-4 hours"
}

Make the outline detailed with 6-10 sections. Be specific and actionable throughout.`;

        const response = await callLLM({
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 2500,
            temperature: 0.4,
        });

        let data;
        try {
            const clean = response.content
                .replace(/```json\n?/g, '')
                .replace(/```\n?/g, '')
                .trim();
            data = JSON.parse(clean);
        } catch (err) {
            console.error('[CONTENT_BRIEF] JSON parse failed:', response.content.substring(0, 200));
            throw new Error('Content brief generation returned malformed data. Please try again.');
        }

        return {
            ...data,
            business_context: business_context || null,
            generated_at:     new Date().toISOString(),
        };
    },

    memory_hint(result) {
        return `Content brief created for "${result.keyword}": ${result.content_type}, ${result.recommended_word_count} words, angle: "${result.content_angle?.substring(0, 80)}".`;
    },
};
