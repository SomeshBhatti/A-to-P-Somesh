require('dotenv').config();
const express = require('express');
const axios = require('axios');
const session = require('express-session');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'amz-pin-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const {
  PINTEREST_CLIENT_ID,
  PINTEREST_CLIENT_SECRET,
  ANTHROPIC_API_KEY,
  REDIRECT_URI = 'http://localhost:3000/auth/callback',
  PORT = 3000,
} = process.env;

// ─── Auth: Redirect to Pinterest OAuth ───────────────────────────────────────
app.get('/auth/pinterest', (req, res) => {
  if (!PINTEREST_CLIENT_ID) {
    return res.redirect('/?error=missing_client_id');
  }
  const scope = 'pins:write,boards:read,user_accounts:read';
  const url = `https://www.pinterest.com/oauth/?client_id=${PINTEREST_CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&response_type=code&scope=${scope}`;
  res.redirect(url);
});

// ─── Auth: Handle OAuth callback ─────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=auth_failed');

  try {
    const credentials = Buffer.from(
      `${PINTEREST_CLIENT_ID}:${PINTEREST_CLIENT_SECRET}`
    ).toString('base64');

    const tokenRes = await axios.post(
      'https://api.pinterest.com/v5/oauth/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
      }
    );

    req.session.accessToken = tokenRes.data.access_token;
    req.session.refreshToken = tokenRes.data.refresh_token;

    // Fetch user info for display
    const userRes = await axios.get('https://api.pinterest.com/v5/user_account', {
      headers: { Authorization: `Bearer ${req.session.accessToken}` },
    });
    req.session.username = userRes.data.username;

    res.redirect('/?connected=true');
  } catch (err) {
    console.error('Token error:', err.response?.data || err.message);
    res.redirect('/?error=token_failed');
  }
});

// ─── API: Auth status ─────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    connected: !!req.session.accessToken,
    username: req.session.username || null,
  });
});

// ─── API: Disconnect ──────────────────────────────────────────────────────────
app.post('/auth/disconnect', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ─── API: Fetch user's boards ─────────────────────────────────────────────────
app.get('/api/boards', async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const r = await axios.get('https://api.pinterest.com/v5/boards', {
      headers: { Authorization: `Bearer ${req.session.accessToken}` },
      params: { page_size: 50 },
    });
    res.json({ boards: r.data.items });
  } catch (err) {
    console.error('Boards error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch boards' });
  }
});

// ─── API: Extract product info from Amazon URL ────────────────────────────────
app.post('/api/extract', async (req, res) => {
  const { amazonUrl } = req.body;
  if (!amazonUrl) return res.status(400).json({ error: 'Missing amazonUrl' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `You are a product data extractor. Search the given Amazon URL and extract product details.
Return ONLY a valid JSON object — no markdown fences, no preamble — with exactly these fields:
{
  "title": "product name, concise, under 100 characters",
  "price": "price with currency symbol e.g. $24.99, or empty string if not found",
  "description": "2–3 sentence product description ideal for a Pinterest pin",
  "imageUrl": "direct CDN image URL (must end in .jpg, .jpeg, .png, .webp, or similar) or empty string",
  "brand": "brand name or empty string"
}`,
        messages: [{ role: 'user', content: `Extract product details from: ${amazonUrl}` }],
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      }
    );

    const textBlock = claudeRes.data.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text block in Claude response');

    const product = JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
    res.json({ product });
  } catch (err) {
    console.error('Extract error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to extract product details' });
  }
});

// ─── API: Post pin to Pinterest ───────────────────────────────────────────────
app.post('/api/post-pin', async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });

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
        Authorization: `Bearer ${req.session.accessToken}`,
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
  console.log(`\n✅  Amazon → Pinterest server running at http://localhost:${PORT}\n`);
  console.log(`   Open your browser and go to: http://localhost:${PORT}\n`);
});
