require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(__dirname));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AFFILIATE_TAG = process.env.AFFILIATE_TAG || 'yourtag-21';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGeminiWithRetry(prompt, maxRetries = 4) {
    const url = `[https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=$){GEMINI_API_KEY}`;

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
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
                throw new Error(error.response ? JSON.stringify(error.response.data) : error.message);
            }
        }
    }
    throw new Error("Gemini API rate limit exceeded after maximum retries.");
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/generate-content', async (req, res) => {
    try {
        const { amazonUrl, affiliateTag, platforms, generateImage } = req.body;
        
        if (!amazonUrl) {
            return res.status(400).json({ error: 'Amazon URL is required' });
        }

        const activeTag = affiliateTag || AFFILIATE_TAG;
        const cleanUrl = amazonUrl.split('?
