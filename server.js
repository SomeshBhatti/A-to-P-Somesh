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
const AFFILIATE_TAG = process.env.AFFILIATE_TAG || "yourtag-21";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGeminiWithRetry(prompt, maxRetries = 4) {
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
                const waitTime = Math.pow(2, i) * 5000; 
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
        
        // SAFE URL PARSING: Replaced .split with .indexOf to stop GitHub editor breaks
        let cleanUrl = amazonUrl;
        if (cleanUrl.indexOf("?") !== -1) {
            cleanUrl = cleanUrl.substring(0, cleanUrl.indexOf("?"));
        }
        cleanUrl = cleanUrl + "?tag=" + activeTag;
        
        console.log("Analyzing product URL: " + cleanUrl);
        
        // SAFE STRING BUILDING: No backticks used here
        const masterPrompt = "Analyze this Amazon product URL: " + cleanUrl + "\n" +
        "Extract what you can from the URL string. Then, generate engaging Pinterest content.\n\n" +
        "You MUST return a valid JSON object matching this exact structure. Do not include markdown blocks, just the raw JSON:\n" +
        "{\n" +
        "  \"product\": {\n" +
        "    \"title\": \"A catchy product name based on the URL\",\n" +
        "    \"brand\": \"Brand name if obvious, else Amazon product\",\n" +
        "    \"category\": \"Product category\",\n" +
        "    \"price\": \"Check Amazon Link\"\n" +
        "  },\n" +
        "  \"pinterest\": {\n" +
        "    \"title\": \"Catchy Pin Title (50-60 chars)\",\n" +
        "    \"description\": \"Engaging Pinterest description (150-200 chars)\",\n" +
        "    \"hashtags\": [\"tag1\", \"tag2\", \"tag3\", \"tag4\", \"tag5\"]\n" +
        "  }\n" +
        "}";

        const aiResponseText = await callGeminiWithRetry(masterPrompt);
        console.log("Raw AI Response received.");
        
        // SAFE REGEX: Avoids using slashes that confuse the editor
        const codeBlockRegex = new RegExp("`{3}json", "gi");
        const backtickRegex = new RegExp("`{3}", "gi");
        let cleanJsonText = aiResponseText.replace(codeBlockRegex, "").replace(backtickRegex, "").trim();
        
        const results = JSON.parse(cleanJsonText);
        results.affiliateUrl = cleanUrl;

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
