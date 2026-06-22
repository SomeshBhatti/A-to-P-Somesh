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

// ============================================
// AI MODEL CONFIGURATION & FALLBACK SYSTEM
// ============================================

const MODELS = {
  groq: {
    name: 'Groq',
    endpoint: 'https://api.groq.com/v1/chat/completions',
    apiKey: process.env.GROQ_API_KEY,
    model: 'mixtral-8x7b-32768',
    timeout: 30000,
    enabled: !!process.env.GROQ_API_KEY,
    type: 'openai',
  },
  ollama: {
    name: 'Ollama (Local)',
    endpoint: process.env.OLLAMA_ENDPOINT || 'http://localhost:11434/v1/chat/completions',
    apiKey: 'not-needed',
    model: process.env.OLLAMA_MODEL || 'mistral',
    timeout: 60000,
    enabled: process.env.OLLAMA_ENABLED === 'true',
    type: 'openai',
  },
  huggingface: {
    name: 'HuggingFace',
    endpoint: 'https://api-inference.huggingface.co/v1/chat/completions',
    apiKey: process.env.HUGGINGFACE_API_KEY,
    model: 'mistralai/Mistral-7B-Instruct-v0.1',
    timeout: 60000,
    enabled: !!process.env.HUGGINGFACE_API_KEY,
    type: 'openai',
  },
};

// Get enabled models in priority order
function getEnabledModels() {
  const modelOrder = ['groq', 'ollama', 'huggingface'];
  return modelOrder
    .filter(key => MODELS[key].enabled)
    .map(key => ({ key, ...MODELS[key] }));
}

// Log available models
console.log('[Models] Available models:', getEnabledModels().map(m => m.name));

// Call AI model with retry logic
async function callAIModel(modelConfig, messages, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[${modelConfig.name}] Attempt ${attempt}/${retries}`);
      console.log(`[${modelConfig.name}] Endpoint: ${modelConfig.endpoint}`);
      console.log(`[${modelConfig.name}] Model: ${modelConfig.model}`);

      const headers = {
        'Content-Type': 'application/json',
      };

      if (modelConfig.apiKey && modelConfig.apiKey !== 'not-needed') {
        headers['Authorization'] = `Bearer ${modelConfig.apiKey}`;
      }

      const payload = {
        model: modelConfig.model,
        messages: messages,
        temperature: 0.7,
      };

      console.log(`[${modelConfig.name}] Payload size:`, JSON.stringify(payload).length, 'bytes');

      const response = await axios.post(
        modelConfig.endpoint,
        payload,
        {
          headers,
          timeout: modelConfig.timeout,
        }
      );

      console.log(`[${modelConfig.name}] Success`);
      return { success: true, data: response.data, model: modelConfig.name };
    } catch (error) {
      console.error(`[${modelConfig.name}] Attempt ${attempt} failed:`, {
        status: error.response?.status,
        statusText: error.response?.statusText,
        errorData: error.response?.data,
        message: error.message,
        code: error.code,
      });

      if (attempt === retries) {
        return {
          success: false,
          error: error.message,
          model: modelConfig.name,
        };
      }

      const delay = Math.pow(2, attempt - 1) * 1000;
      console.log(`[${modelConfig.name}] Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Generate content with fallback system
async function generateContentWithFallback(amazonUrl, affiliateTag = '') {
  const enabledModels = getEnabledModels();

  if (enabledModels.length === 0) {
    throw new Error(
      'No AI models configured. Please set up Groq, Ollama, or HuggingFace API keys.'
    );
  }

  const userPrompt = `Analyze: ${amazonUrl}

Return JSON only:
{
  "product": {"title": "", "brand": "", "category": ""},
  "pinterest": {
    "title": "Pinterest title (50-60 chars)",
    "description": "Pinterest description (150-200 chars)",
    "hashtags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
  },
  "seo": {"keywords": ["key1", "key2", "key3"]},
  "imageConcepts": ["concept1", "concept2"],
  "imagePrompt": "Pinterest vertical 1080x1920 pin prompt"
}`;

  const messages = [
    {
      role: 'user',
      content: userPrompt,
    },
  ];

  console.log('[Content Generation] Starting with fallback system...');

  // Try each model in order
  for (const modelConfig of enabledModels) {
    console.log(`[Content Generation] Attempting ${modelConfig.name}...`);

    const result = await callAIModel(modelConfig, messages, 2);

    if (!result.success) {
      console.log(`[Content Generation] ${modelConfig.name} failed, trying next model...`);
      continue;
    }

    // Parse response
    let generatedText = '';
    if (result.data.choices && result.data.choices.length > 0) {
      const message = result.data.choices[0].message;
      if (message && message.content) {
        generatedText = message.content;
      }
    }

    if (!generatedText) {
      console.log(`[Content Generation] ${modelConfig.name} returned empty content, trying next model...`);
      continue;
    }

    console.log(`[Content Generation] Raw response from ${modelConfig.name}:`, generatedText.substring(0, 200));

    // Parse JSON
    let parsedData;
    try {
      const cleanedText = generatedText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      parsedData = JSON.parse(cleanedText);
      console.log(`[Content Generation] JSON parsed successfully using ${modelConfig.name}`);
    } catch (parseError) {
      console.error(`[Content Generation] ${modelConfig.name} JSON parse error:`, parseError.message);
      console.log(`[Content Generation] Trying next model...`);
      continue;
    }

    // Validate structure
    if (
      !parsedData.product ||
      !parsedData.pinterest ||
      !parsedData.seo ||
      !parsedData.imageConcepts ||
      !parsedData.imagePrompt
    ) {
      console.log(`[Content Generation] ${modelConfig.name} missing required fields, trying next model...`);
      continue;
    }

    // Success!
    return { ...parsedData, usedModel: modelConfig.name };
  }

  // All models failed
  throw new Error(
    `All AI models failed. Tried: ${enabledModels.map(m => m.name).join(', ')}`
  );
}

// ============================================
// API ENDPOINTS
// ============================================

app.post('/api/generate-content', async (req, res) => {
  try {
    const { amazonUrl, affiliateTag } = req.body;

    // Validation
    if (!amazonUrl || !amazonUrl.trim()) {
      return res.status(400).json({ error: 'Amazon URL is required' });
    }

    // Save affiliate tag
    if (affiliateTag && affiliateTag.trim()) {
      lastAffiliateTag = affiliateTag.trim();
    }

    // Check cache
    const cacheKey = getCacheKey(amazonUrl, '');
    if (responseCache.has(cacheKey)) {
      console.log('[Cache] Hit for:', cacheKey);
      const cachedData = responseCache.get(cacheKey);
      return res.json({ cached: true, lastAffiliateTag, ...cachedData });
    }

    console.log('[Request] Processing:', { amazonUrl: amazonUrl.substring(0, 50) });

    // Generate content with fallback
    const content = await generateContentWithFallback(amazonUrl, affiliateTag || '');

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
  const enabledModels = getEnabledModels();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    availableModels: enabledModels.map(m => m.name),
  });
});

app.get('/api/last-affiliate-tag', (req, res) => {
  res.json({ lastAffiliateTag });
});

app.get('/api/models', (req, res) => {
  const enabledModels = getEnabledModels();
  const allModels = Object.entries(MODELS).map(([key, config]) => ({
    key,
    name: config.name,
    enabled: config.enabled,
    model: config.model,
  }));

  res.json({
    available: enabledModels.map(m => m.name),
    all: allModels,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Available models: ${getEnabledModels().map(m => m.name).join(', ') || 'NONE'}`);
  console.log('\nSetup instructions:');
  console.log('1. Groq: export GROQ_API_KEY=your_key');
  console.log('2. Ollama: export OLLAMA_ENABLED=true (requires Ollama running locally)');
  console.log('3. HuggingFace: export HUGGINGFACE_API_KEY=your_key');
});
