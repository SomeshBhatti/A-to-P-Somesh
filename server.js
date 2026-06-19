const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Cache for responses
const responseCache = new Map();

// Store last used affiliate tag
let lastAffiliateTag = '';

// Generate cache key from URL + Product Title
function getCacheKey(amazonUrl, productTitle) {
  return `${amazonUrl}||${productTitle}`;
}

// Gemini 1.5 Flash Latest API endpoint
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';

// Retry logic - max 3 retries
async function callGeminiWithRetry(payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Gemini API] Attempt ${attempt}/${retries}`);
      
      const response = await axios.post(
        `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      console.log('[Gemini API] Success');
      return response.data;
    } catch (error) {
      console.error(`[Gemini API] Attempt ${attempt} failed:`, {
        status: error.response?.status,
        statusText: error.response?.statusText,
        errorData: error.response?.data,
        message: error.message,
      });

      if (attempt === retries) {
        throw new Error(
          `Gemini API failed after ${retries} retries: ${error.response?.data?.error?.message || error.message}`
        );
      }

      // Wait before retry (exponential backoff)
      const delay = Math.pow(2, attempt - 1) * 1000;
      console.log(`[Gemini API] Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Single Gemini request to generate all content
async function generateContentWithGemini(amazonUrl, productTitle, affiliateTag = '') {
  const systemPrompt = `You are an expert Amazon product analyst and Pinterest content creator. Your task is to analyze a product and generate high-quality Pinterest pin content, SEO data, and image prompt instructions.

Return ONLY valid JSON (no markdown, no code blocks, no explanations). The response MUST be parseable JSON.`;

  const userPrompt = `Analyze this Amazon product and generate Pinterest content:

Product Title: ${productTitle}
Amazon URL: ${amazonUrl}
Affiliate Tag: ${affiliateTag || 'none'}

Return a JSON object with this exact structure:
{
  "product": {
    "title": "optimized product title",
    "brand": "brand name",
    "category": "product category"
  },
  "pinterest": {
    "title": "Pinterest pin title (50-60 chars, compelling, SEO keyword-rich)",
    "description": "Pinterest pin description (150-200 chars, benefit-focused, includes call-to-action)",
    "hashtags": ["hashtag1", "hashtag2", "hashtag3", "hashtag4", "hashtag5"]
  },
  "seo": {
    "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
  },
  "imageConcepts": ["concept1", "concept2", "concept3"],
  "imagePrompt": "A detailed prompt for generating a Pinterest vertical pin (2:3 aspect ratio, 1080x1920px). Must be photorealistic, lifestyle-focused, high CTR commercial advertising style. Product naturally integrated into scene. Professional, high-quality. Space for text overlay at top. Bright, engaging, conversion-optimized."
}

Generate ONLY the JSON response. No other text.`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: userPrompt,
          },
        ],
      },
    ],
    systemInstruction: {
      parts: [
        {
          text: systemPrompt,
        },
      ],
    },
  };

  console.log('[Content Generation] Starting Gemini request');
  const geminiResponse = await callGeminiWithRetry(payload);

  // Extract text from Gemini response
  let generatedText = '';
  if (geminiResponse.candidates && geminiResponse.candidates.length > 0) {
    const content = geminiResponse.candidates[0].content;
    if (content && content.parts && content.parts.length > 0) {
      generatedText = content.parts[0].text;
    }
  }

  if (!generatedText) {
    throw new Error('No text content returned from Gemini API');
  }

  console.log('[Content Generation] Raw response:', generatedText.substring(0, 200));

  // Parse JSON response
  let parsedData;
  try {
    // Remove markdown code blocks if present
    const cleanedText = generatedText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    
    parsedData = JSON.parse(cleanedText);
    console.log('[Content Generation] JSON parsed successfully');
  } catch (parseError) {
    console.error('[Content Generation] JSON parse error:', parseError.message);
    console.error('[Content Generation] Failed text:', generatedText);
    throw new Error(`Failed to parse Gemini response as JSON: ${parseError.message}`);
  }

  // Validate response structure
  if (
    !parsedData.product ||
    !parsedData.pinterest ||
    !parsedData.seo ||
    !parsedData.imageConcepts ||
    !parsedData.imagePrompt
  ) {
    throw new Error('Gemini response missing required fields');
  }

  return parsedData;
}

// API Endpoints

app.post('/api/generate-content', async (req, res) => {
  try {
    const { amazonUrl, productTitle, affiliateTag } = req.body;

    // Validation
    if (!amazonUrl || !amazonUrl.trim()) {
      return res.status(400).json({ error: 'Amazon URL is required' });
    }

    if (!productTitle || !productTitle.trim()) {
      return res.status(400).json({ error: 'Product Title is required' });
    }

    // Save affiliate tag for future use
    if (affiliateTag && affiliateTag.trim()) {
      lastAffiliateTag = affiliateTag.trim();
    }

    // Check cache
    const cacheKey = getCacheKey(amazonUrl, productTitle);
    if (responseCache.has(cacheKey)) {
      console.log('[Cache] Hit for:', cacheKey);
      return res.json({ cached: true, lastAffiliateTag, ...responseCache.get(cacheKey) });
    }

    console.log('[Request] Processing:', { amazonUrl: amazonUrl.substring(0, 50), productTitle });

    // Generate content
    const content = await generateContentWithGemini(amazonUrl, productTitle, affiliateTag || '');

    // Store in cache
    responseCache.set(cacheKey, content);

    res.json({ lastAffiliateTag, ...content });
  } catch (error) {
    console.error('[API Error]', error.message);
    res.status(500).json({
      error: error.message || 'Failed to generate content',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/last-affiliate-tag', (req, res) => {
  res.json({ lastAffiliateTag });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini API Key: ${GEMINI_API_KEY ? 'Configured' : 'NOT SET'}`);
});
