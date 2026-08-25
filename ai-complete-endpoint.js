// ═══════════════════════════════════════════════════════════════════
// POST /internal/ai/complete
// Add this route to your levelup-runtime2 Express server.
// Paste INSIDE your existing app setup, after other routes.
// ═══════════════════════════════════════════════════════════════════

app.post('/internal/ai/complete', async (req, res) => {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'DEEPSEEK_API_KEY not set in environment' });
    }

    const { model, messages, max_tokens, temperature } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || require('./deepseek-models').DEFAULT_MODEL,
        messages,
        max_tokens: require('./deepseek-models').withReasoningHeadroom(max_tokens, 4000),
        temperature: temperature ?? 0.7,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || 'DeepSeek error' });
    }

    const text = data.choices?.[0]?.message?.content || '';
    res.json({ text, content: text, choices: data.choices });

  } catch (err) {
    console.error('[AI Complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});
