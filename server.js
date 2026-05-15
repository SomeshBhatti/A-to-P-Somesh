require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const {
  PINTEREST_ACCESS_TOKEN,
  OPENAI_API_KEY,
  PORT = 3000,
} = process.env;

// ─── Auth: status ─────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  if (!PINTEREST_ACCESS_TOKEN) return res.json({ connected: false });
  try {
    const r = await axios.get('https://api.pinterest.com/v5/user_account', {
      headers: { Authorization: `Bearer ${PINTEREST_ACCESS_TOKEN}` },
    });
    res.json({ connected: true, username: r.data.username });
  } catch {
    res.json({ connected: false });
  }
});

// ─── API: Fetch boards ────────────────────────────────────────────────────────
app.get('/api/boards', async (req, res) => {
  try {
    const r = await axios.get('https://api.pinterest.com/v5/boards', {
      headers: { Authorization: `Bearer ${PINTEREST_ACCESS_TOKEN}` },
      params: { page_size: 50 },
    });
    res.json({ boards: r.data.items });
  } catch (err) {
    console.error('Boards error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch boards' });
  }
});

// ─── API: Extract product from Amazon URL via OpenAI ─────────────────────────
app.post('/api/extract', async (req, res) => {
  const { amazonUrl } = req.body;
  if (!amazonUrl) return res.status(400).json({ error: 'Missing amazonUrl' });

  try {
    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        max_tokens: 1000,
        messages: [
          {
            role: 'system',
            content: `You are a product data extractor. When given an Amazon URL, extract product details.
Return ONLY a valid JSON object — no markdown fences, no preamble — with exactly these fields:
{
  "title": "product name, concise, under 100 characters",
  "price": "price with currency symbol e.g. $24.99, or empty string if not found",
  "description": "2-3 sentence product description ideal for a Pinterest pin",
  "imageUrl": "direct CDN image URL ending in .jpg/.jpeg/.png/.webp or empty string",
  "brand": "brand name or empty string"
}`,
          },
          {
            role: 'user',
            content: `Extract product details from this Amazon URL: ${amazonUrl}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const text = openaiRes.data.choices[0].message.content;
    const product = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json({ product });
  } catch (err) {
    console.error('Extract error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to extract product details' });
  }
});

// ─── API: Post pin ────────────────────────────────────────────────────────────
app.post('/api/post-pin', async (req, res) => {
  const { amazonUrl, boardId, title, description, imageUrl, price } = req.body;
  if (!amazonUrl || !boardId) return res.status(400).json({ error: 'Missing amazonUrl or boardId' });

  try {
    const pinBody = {
      board_id: boardId,
      title: title?.slice(0, 100) || '',
      description: `${description || ''}${price ? `\n\nPrice: ${price}` : ''}`.trim(),
      link: amazonUrl,
    };

    if (imageUrl) {
      pinBody.media_source = { source_type: 'image_url', url: imageUrl };
    }

    const pinRes = await axios.post('https://api.pinterest.com/v5/pins', pinBody, {
      headers: {
        Authorization: `Bearer ${PINTEREST_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    res.json({ success: true, pin: pinRes.data });
  } catch (err) {
    console.error('Post pin error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || 'Failed to post pin' });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Server running on port ${PORT}\n`);
});
