require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(__dirname));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROK_API_KEY = process.env.GROK_API_KEY;
const AFFILIATE_TAG = process.env.AFFILIATE_TAG || "yourtag-21";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGrokWithRetry(prompt, maxRetries = 3) {
    const url = "https://api.x.ai/v1/chat/completions";

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.post(url, {
                model: "grok-2-latest",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3
            }, {
                headers: { 
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + GROK_API_KEY
                }
            });
            return response.data.choices[0].message.content;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                const waitTime = Math.pow(2, i) * 3000; 
                console.warn("[429 Rate Limit] Grok overloaded. Retrying in " + (waitTime / 1000) + "s...");
                await sleep(waitTime);
            } else {
                console.error("Grok API Error:", error.response ? error.response.data : error.message);
                throw new Error(error.response ? JSON.stringify(error.response.data) : error.message);
            }
        }
    }
    throw new Error("Grok API rate limit exceeded after maximum retries.");
}

async function callGeminiWithRetry(prompt, maxRetries = 3) {
    const url = "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=" + GEMINI_API_KEY;

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }]
            }, {
                headers: { "Content-Type": "application/json" }
            });
            return response.data.candidates[0].content.parts[0].text;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                const waitTime = Math.pow(2, i) * 3000; 
                console.warn("[429 Rate Limit] Gemini overloaded. Retrying in " + (waitTime / 1000) + "s...");
                await sleep(waitTime);
            } else {
                console.error("Gemini API Error:", error.response ? error.response.data : error.message);
                throw new Error(error.response ? JSON.stringify(error.response.data) : error.message);
            }
        }
    }
    throw new Error("Gemini API rate limit exceeded after maximum retries.");
}

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/generate-content", async (req, res) => {
    try {
        const { amazonUrl, affiliateTag } = req.body;
        
        if (!amazonUrl) {
            return res.status(400).json({ error: "Amazon URL is required" });
        }

        const activeTag = affiliateTag || AFFILIATE_TAG;
        
        let cleanUrl = amazonUrl;
        if (cleanUrl.indexOf("?") !== -1) {
            cleanUrl = cleanUrl.substring(0, cleanUrl.indexOf("?"));
        }
        cleanUrl = cleanUrl + "?tag=" + activeTag;
        
        console.log("Analyzing product URL with Grok: " + cleanUrl);
        
        // STEP 1: Use Grok to analyze URL and extract product info
        const analysisPrompt = "Extract product information from this Amazon URL: " + cleanUrl + "\n" +
        "Return JSON with: title (exact product name from URL), brand, category, price (if visible). Just the JSON, no markdown:\n" +
        "{\n" +
        "  \"title\": \"Product Name\",\n" +
        "  \"brand\": \"Brand\",\n" +
        "  \"category\": \"Category\",\n" +
        "  \"price\": \"$XX\"\n" +
        "}";
        
        const productJsonText = await callGrokWithRetry(analysisPrompt);
        const codeBlockRegex = new RegExp("`{3}json", "gi");
        const backtickRegex = new RegExp("`{3}", "gi");
        let cleanProductJson = productJsonText.replace(codeBlockRegex, "").replace(backtickRegex, "").trim();
        const productInfo = JSON.parse(cleanProductJson);
        
        console.log("Product info extracted. Now generating creative content with Gemini...");
        
        // STEP 2: Use Gemini to generate creative Pinterest content
        const creativePrompt = "Create engaging Pinterest content for this product:\n" +
        "Title: " + productInfo.title + "\n" +
        "Brand: " + productInfo.brand + "\n" +
        "Category: " + productInfo.category + "\n\n" +
        "Generate a Pinterest pin title (50-60 chars) and description (150-200 chars) plus 5 relevant hashtags.\n" +
        "Return ONLY this JSON, no markdown:\n" +
        "{\n" +
        "  \"pinTitle\": \"Your catchy title\",\n" +
        "  \"description\": \"Your engaging description\",\n" +
        "  \"hashtags\": [\"tag1\", \"tag2\", \"tag3\", \"tag4\", \"tag5\"]\n" +
        "}";
        
        const creativJsonText = await callGeminiWithRetry(creativePrompt);
        let cleanCreativeJson = creativJsonText.replace(codeBlockRegex, "").replace(backtickRegex, "").trim();
        const creativeContent = JSON.parse(cleanCreativeJson);
        
        const results = {
            product: productInfo,
            pinterest: {
                title: creativeContent.pinTitle,
                description: creativeContent.description,
                hashtags: creativeContent.hashtags
            },
            affiliateUrl: cleanUrl
        };

        res.json(results);

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: "Server Error: " + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
