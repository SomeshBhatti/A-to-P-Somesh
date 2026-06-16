require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const AFFILIATE_TAG = process.env.AFFILIATE_TAG || 'yourtag-21';

// Helper: Sleep function for our delays
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Call Gemini with Exponential Backoff
async function callGeminiWithRetry(prompt, maxRetries = 4) {
    // Using 1.5-flash as it has the best free-tier rate limits and speed
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }]
            }, {
                headers: { 'Content-Type': 'application/json' }
            });
            return response.data.candidates[0].content.parts[0].text;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                // Exponential backoff: 5s, 10s, 20s, 40s
                const waitTime = Math.pow(2, i) * 5000; 
                console.warn(`[429 Rate Limit] Gemini overloaded. Retrying in ${waitTime / 1000}s... (Attempt ${i + 1} of ${maxRetries})`);
                await sleep(waitTime);
            } else {
                console.error("Gemini API Error:", error.response ? error.response.data : error.message);
                throw error;
            }
        }
    }
    throw new Error("Max retries reached. Gemini API rate limit exceeded.");
}

app.post('/api/generate', async (req, res) => {
    try {
        const { url, platforms } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'Amazon URL is required' });
        }

        // 1. Scrape Basic Amazon Info (Mocked/Simplified for this example - replace with your actual scraper if needed)
        // In a real scenario, you'd use Puppeteer or Cheerio here to get the title and description
        const cleanUrl = url.split('?')[0] + `?tag=${AFFILIATE_TAG}`;
        
        // 2. Product Analysis via Gemini
        console.log("Analyzing product with Gemini...");
        const analysisPrompt = `Analyze this Amazon product link and extract the core features, target audience, and main selling points. URL: ${cleanUrl}`;
        const productAnalysis = await callGeminiWithRetry(analysisPrompt);

        const results = {
            affiliateUrl: cleanUrl,
            content: {}
        };

        // 3. Generate Content based on Selected Platforms
        console.log("Generating platform-specific content...");
        
        if (platforms.pinterest) {
            console.log("- Generating Pinterest content...");
            const pinPrompt = `Based on this product analysis: ${productAnalysis}. Write a highly engaging Pinterest pin description. Include catchy title, description, and relevant hashtags. Format clearly.`;
            results.content.pinterest = await callGeminiWithRetry(pinPrompt);
        }

        if (platforms.facebook) {
            console.log("- Generating Facebook content...");
            const fbPrompt = `Based on this product analysis: ${productAnalysis}. Write a conversational and engaging Facebook post promoting this product. Include a call to action and emojis.`;
            results.content.facebook = await callGeminiWithRetry(fbPrompt);
        }

        if (platforms.instagram) {
            console.log("- Generating Instagram content...");
            const igPrompt = `Based on this product analysis: ${productAnalysis}. Write an aesthetic and trendy Instagram caption. Include spacing, emojis, and 15 highly targeted hashtags.`;
            results.content.instagram = await callGeminiWithRetry(igPrompt);
        }

        if (platforms.threads) {
            console.log("- Generating Threads content...");
            const threadsPrompt = `Based on this product analysis: ${productAnalysis}. Write a short, punchy, conversational post for Threads (under 500 characters). Make it snappy.`;
            results.content.threads = await callGeminiWithRetry(threadsPrompt);
        }

        // 4. Handle AI Image Generation (Mocked placeholder for whatever image API you were using)
        if (platforms.aiImage) {
            console.log("- Generating AI Image prompt...");
            const imagePrompt = await callGeminiWithRetry(`Create a short, descriptive image generation prompt (for DALL-E/Midjourney) based on this product: ${productAnalysis}`);
            results.content.aiImagePrompt = imagePrompt;
            // Add your ImgBB / Image Generation API logic here if needed
        }

        res.json(results);

    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ 
            error: 'Failed to process request', 
            details: error.message 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
