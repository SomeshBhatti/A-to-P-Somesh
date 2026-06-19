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

const cache = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGemini(prompt, retries = 3) {
    const url =
        "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=" +
        GEMINI_API_KEY;

    let delay = 1000;

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            console.log(`Gemini attempt ${attempt + 1}/${retries}`);

            const response = await axios.post(
                url,
                {
                    contents: [
                        {
                            parts: [
                                {
                                    text: prompt
                                }
                            ]
                        }
                    ]
                },
                {
                    headers: {
                        "Content-Type": "application/json"
                    },
                    timeout: 15000
                }
            );

            return response.data.candidates[0].content.parts[0].text;

        } catch (error) {

            if (
                error.response &&
                (error.response.status === 429 ||
                 error.response.status === 503)
            ) {
                console.warn(`Gemini rate limited. Retrying in ${delay / 1000}s`);
                await sleep(delay);
                delay *= 2;
                continue;
            }

            console.error(
                "Gemini Error:",
                error.response?.data || error.message
            );

            throw error;
        }
    }

    throw new Error("Gemini failed after retries");
}

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/generate-content", async (req, res) => {

    try {

        const { amazonUrl, affiliateTag } = req.body;

        if (!amazonUrl) {
            return res.status(400).json({
                error: "Amazon URL is required"
            });
        }

        const activeTag = affiliateTag || AFFILIATE_TAG;

        let cleanUrl = amazonUrl;

        if (cleanUrl.includes("?")) {
            cleanUrl = cleanUrl.substring(0, cleanUrl.indexOf("?"));
        }

        cleanUrl += "?tag=" + activeTag;

        console.log("Processing:", cleanUrl);

        if (cache.has(cleanUrl)) {
            console.log("Serving from cache");
            return res.json(cache.get(cleanUrl));
        }

        const masterPrompt = `
You are an expert Pinterest affiliate marketer.

Analyze this Amazon product URL:

${cleanUrl}

Return ONLY valid JSON.

{
  "product": {
    "title": "",
    "brand": "",
    "category": "",
    "targetAudience": ""
  },

  "pinterest": {
    "title": "",
    "description": "",
    "hashtags": []
  },

  "seo": {
    "keywords": []
  },

  "imageConcepts": [
    "",
    "",
    ""
  ],

  "imagePrompt": ""
}

Requirements:

1. Create a highly clickable Pinterest title.
2. Create a conversion-focused Pinterest description.
3. Generate 5 relevant hashtags.
4. Generate 10 SEO keywords.
5. Generate 3 image concepts:
   - Lifestyle
   - Problem/Solution
   - Premium Product Advertisement
6. Generate ONE final image prompt.

Image prompt requirements:

- Pinterest vertical 2:3 ratio
- Photorealistic
- Premium commercial advertising
- Lifestyle focused
- Product naturally integrated
- High click-through rate
- Clean composition
- Natural lighting
- Space for text overlay

Return JSON only.
`;

        const rawResponse = await callGemini(masterPrompt);

        const cleanResponse = rawResponse
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();

        const parsed = JSON.parse(cleanResponse);

        const result = {
            product: parsed.product,
            pinterest: parsed.pinterest,
            seo: parsed.seo,
            imageConcepts: parsed.imageConcepts,
            imagePrompt: parsed.imagePrompt,
            affiliateUrl: cleanUrl
        };

        cache.set(cleanUrl, result);

        res.json(result);

    } catch (error) {

        console.error("Server Error:", error);

        res.status(500).json({
            error: error.message || "Unknown server error"
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});