require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Safely serve all frontend files
app.use(express.static(__dirname));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AFFILIATE_TAG = process.env.AFFILIATE_TAG || 'yourtag-21';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Call Gemini forcing a strict JSON response
async function callGeminiWithRetry(prompt, maxRetries = 4) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
                // Force Gemini to return perfectly formatted JSON so the UI doesn't break
                generationConfig: { responseMimeType: "application/json" } 
            }, {
                headers: { 'Content-Type': 'application/json' }
            });
            return response.data.candidates[0].content.parts[0].text;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                const waitTime = Math.pow(2, i) * 5000; 
                console.warn(`[429 Rate Limit] Gemini overloaded. Retrying in ${waitTime / 1000}s...`);
                await sleep(waitTime);
            } else {
                console.error("Gemini API Error:", error.response ? error.response.data : error.message);
                throw error;
            }
        }
    }
    throw new Error("Max retries reached. Gemini API rate limit exceeded.");
}

// Fallback to explicitly serve index.html at the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// CORE API GENERATION ENDPOINT (Matches frontend /api/generate-content exactly)
app.post('/api/generate-content', async (req, res) => {
    try {
        // Match the exact variables sent by index.html
        const { amazonUrl, affiliateTag, platforms, generateImage } = req.body;
        
        if (!amazonUrl) {
            return res.status(400).json({ error: 'Amazon URL is required' });
        }

        const activeTag = affiliateTag || AFFILIATE_TAG;
        const cleanUrl = amazonUrl.split('?')[0] + `?tag=${activeTag}`;
        const platformsList = (platforms && platforms.length > 0) ? platforms.join(', ') : 'pinterest, facebook, instagram, threads';
        
        console.log("Analyzing product and generating content via Gemini...");
        
        // Single Mega-Prompt to drastically reduce API calls and perfectly format the JSON
        const masterPrompt = `
        Analyze this Amazon product URL: ${cleanUrl}
        Extract what you can from the URL string. Then, generate engaging social media content for these platforms: ${platformsList}.
        
        You MUST return a valid JSON object matching this exact structure. Do not include markdown blocks, just the raw JSON:
        {
          "product": {
            "title": "A catchy product name based on the URL",
            "brand": "Brand name if obvious, else 'Amazon product'",
            "category": "Product category",
            "price": "Check Amazon Link",
            "imageUrl": "https://via.placeholder.com/400?text=Product+Image"
          },
          "pinterest": {
            "title": "Catchy Pin Title",
            "description": "Engaging description",
            "hashtags": ["tag1", "tag2"]
          },
          "facebook": {
            "caption": "Engaging FB post",
            "hashtags": ["tag1", "tag2"]
          },
          "instagram": {
            "caption": "Aesthetic IG caption",
            "hashtags": ["tag1", "tag2"]
          },
          "threads": {
            "post": "Short punchy post",
            "hashtags": ["tag1", "tag2"]
          }
        }`;

        const aiResponseText = await callGeminiWithRetry(masterPrompt);
        
        // Parse the JSON safely
        const results = JSON.parse(aiResponseText);
        results.affiliateUrl = cleanUrl;

        // Mock image generation to prevent frontend crash if requested
        if (generateImage) {
            results.imageUrl = "https://via.placeholder.com/600x800?text=AI+Generated+Image";
        }

        res.json(results);

    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ error: 'Failed to process request', details: error.message });
    }
});

// Image Regeneration Stub (Matches frontend /api/generate-image)
app.post('/api/generate-image', (req, res) => {
    res.json({ imageUrl: "https://via.placeholder.com/600x800?text=Regenerated+AI+Image" });
});

// Queue Endpoints Stubs (Prevents errors when clicking tabs)
app.get('/api/queue', (req, res) => res.json({ queue: [], count: 0 }));
app.post('/api/queue', (req, res) => res.json({ success: true }));
app.delete('/api/queue', (req, res) => res.json({ success: true }));
app.delete('/api/queue/:id', (req, res) => res.json({ success: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
