require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/status", (req, res) => {
  res.json({ connected: true });
});

// ─── Extract product via Groq (free, no credit card needed) ──────────────────
app.post("/api/extract", async (req, res) => {
  const { amazonUrl } = req.body;
  if (!amazonUrl) return res.status(400).json({ error: "Missing amazonUrl" });

  try {
    const r = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        max_tokens: 1000,
        messages: [
          {
            role: "system",
            content: `You are a product data extractor. When given an Amazon URL, extract product details from your knowledge or by analyzing the URL structure.
Return ONLY a valid JSON object — no markdown fences, no preamble — with exactly these fields:
{
  "title": "product name, concise, under 100 characters",
  "price": "price with currency symbol e.g. ₹999 or $24.99, or empty string if not found",
  "description": "2-3 sentence product description ideal for a Pinterest pin",
  "imageUrl": "direct CDN image URL ending in .jpg/.jpeg/.png/.webp or empty string",
  "brand": "brand name or empty string"
}`,
          },
          {
            role: "user",
            content: `Extract product details from this Amazon URL: ${amazonUrl}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const text = r.data.choices[0].message.content;
    const product = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json({ product });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: "Failed to extract product details" });
  }
});

app.use((req, res) => res.status(404).json({ error: "Route not found" }));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
