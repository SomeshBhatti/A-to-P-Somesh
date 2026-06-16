require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path'); // Added to handle file paths safely

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from both the 'public' folder AND the root folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const AFFILIATE_TAG = process.env.AFFILIATE_TAG || 'yourtag-21';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Call Gemini with Exponential Backoff
async function callGeminiWithRetry(prompt, maxRetries = 4) {
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

// Explicit root route handler to fallback safely if index.html is in the root directory
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) {
            // If it's not found in 'public', try serving it from the root directory
            res.sendFile(path.join(__dirname, 'index.html'), (err2) => {
                if (err2) {
                    res.status(404).send("Error: index.html not found. Ensure your main HTML file is named exactly index.html and is located in either the main repository folder or a folder named 'public'.");
                }
            });
        }
    });
});

app.post('/api/generate', async (req, res) => {
    try {
        const { url, platforms } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'Amazon URL is required' });
        }

        const cleanUrl = url.split('?')[0] + `?tag=${AFFILIATE_TAG}`;
        
        console.log("Analyzing product with Gemini...");
        const analysisPrompt = `Analyze this Amazon product link and extract the core features, target audience, and main selling points. URL: ${cleanUrl}`;
        const productAnalysis = await callGeminiWithRetry(analysisPrompt);

        const results = {
            affiliateUrl: cleanUrl,
            content: {}
        };

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

        if (platforms.aiImage) {
            console.log("- Generating AI Image prompt...");
            const imagePrompt = await callGeminiWithRetry(`Create a short, descriptive image generation prompt (for DALL-E/Midjourney) based on this product: ${productAnalysis}`);
            results.content.aiImagePrompt = imagePrompt;
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
