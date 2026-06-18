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

async function callGrokWithFallback(prompt, maxRetries = 3) {
    const models = ["grok-beta", "grok-vision-beta"];
    
    for (let modelIdx = 0; modelIdx < models.length; modelIdx++) {
        const model = models[modelIdx];
        const url = "https://api.x.ai/v1/chat/completions";

        for (let i = 0; i < maxRetries; i++) {
            try {
                console.log("Trying Grok with model: " + model);
                const response = await axios.post(url, {
                    model: model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.3
                }, {
                    headers: { 
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + GROK_API_KEY
                    },
                    timeout: 15000
                });
                return response.data.choices[0].message.content;
            } catch (error) {
                if (error.response && error.response.status === 429) {
                    const waitTime = Math.pow(2, i) * 3000; 
                    console.warn("[429 Rate Limit] Grok overloaded. Retrying in " + (waitTime / 1000) + "s...");
                    await sleep(waitTime);
                } else if (error.response && error.response.status === 404) {
                    console.warn("Model " + model + " not found. Trying next model...");
                    break;
                } else if (error.code === "ECONNABORTED") {
                    console.warn("Grok timeout, trying next model...");
                    break;
                } else {
                    console.error("Grok API Error:", error.response ? error.response.data : error.message);
                    if (modelIdx === models.length - 1) {
                        throw new Error(error.response ? JSON.stringify(error.response.data) : error.message);
                    }
                    break;
                }
            }
        }
    }
    throw new Error("All Grok models failed or unavailable. Using Gemini for analysis.");
}

async function callGeminiWithRetry(prompt, maxRetries = 5, delayBetweenRetries = 2000) {
    const url = "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=" + GEMINI_API_KEY;

    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log("Gemini attempt " + (i + 1) + " of " + maxRetries);
            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }]
            }, {
                headers: { "Content-Type": "application/json" },
                timeout: 20000
            });
            return response.data.candidates[0].content.parts[0].text;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                const waitTime = delayBetweenRetries * Math.pow(2, i);
                console.warn("[429 Rate Limit] Gemini quota exceeded. Waiting " + (waitTime / 1000) + "s before retry " + (i + 1) + "...");
                await sleep(waitTime);
            } else if (error.response && error.response.status === 503) {
                const waitTime = delayBetweenRetries * Math.pow(2, i);
                console.warn("[503 Service Unavailable] Gemini overloaded. Waiting " + (waitTime / 1000) + "s before retry " + (i + 1) + "...");
                await sleep(waitTime);
            } else {
                console.error("Gemini API Error:", error.response ? error.response.data : error.message);
                throw new Error(error.response ? JSON.stringify(error.response.data) : error.message);
            }
        }
    }
    throw new Error("Gemini API rate limit exceeded after " + maxRetries + " retries. Please try again in a few minutes.");
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
        
        console.log("Analyzing product URL: " + cleanUrl);
        
        // STEP 1: Try Grok first, fall back to Gemini if it fails
        let productInfo = null;
        const analysisPrompt = "Extract product information from this Amazon URL: " + cleanUrl + "\n" +
        "Return JSON with: title (exact product name from URL), brand, category, price (if visible). Just the JSON, no markdown:\n" +
        "{\n" +
        "  \"title\": \"Product Name\",\n" +
        "  \"brand\": \"Brand\",\n" +
        "  \"category\": \"Category\",\n" +
        "  \"price\": \"$XX\"\n" +
        "}";
        
        try {
            const productJsonText = await callGrokWithFallback(analysisPrompt);
            const codeBlockRegex = new RegExp("`{3}json", "gi");
            const backtickRegex = new RegExp("`{3}", "gi");
            let cleanProductJson = productJsonText.replace(codeBlockRegex, "").replace(backtickRegex, "").trim();
            productInfo = JSON.parse(cleanProductJson);
            console.log("✓ Grok analyzed product successfully");
        } catch (grokError) {
            console.log("Grok failed, using Gemini for analysis instead");
            // Wait 2 seconds before calling Gemini to avoid rate limits
            await sleep(2000);
            const productJsonText = await callGeminiWithRetry(analysisPrompt, 5, 2500);
            const codeBlockRegex = new RegExp("`{3}json", "gi");
            const backtickRegex = new RegExp("`{3}", "gi");
            let cleanProductJson = productJsonText.replace(codeBlockRegex, "").replace(backtickRegex, "").trim();
            productInfo = JSON.parse(cleanProductJson);
            console.log("✓ Gemini analyzed product successfully");
        }
        
        console.log("Product info extracted. Waiting before creative content generation...");
        // Wait 3 seconds between Gemini calls to respect free tier rate limits
        await sleep(3000);
        
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
        
        const creativJsonText = await callGeminiWithRetry(creativePrompt, 5, 2500);
        const codeBlockRegex = new RegExp("`{3}json", "gi");
        const backtickRegex = new RegExp("`{3}", "gi");
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
