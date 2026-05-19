require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
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

// ─── Image proxy ──────────────────────────────────────────────────────────────
app.get("/api/proxy-image", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url");
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      headers: {
        "Referer": "https://www.amazon.in/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 8000,
    });
    res.set("Content-Type", r.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(r.data);
  } catch {
    res.status(404).send("Image not found");
  }
});

// ─── Scrape Amazon ────────────────────────────────────────────────────────────
async function scrapeAmazon(url) {
  const { data: html } = await axios.get(url, {
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
    },
  });
  const $ = cheerio.load(html);
  const title = $("#productTitle").text().trim();
  const price = $(".a-price .a-offscreen").first().text().trim() || $("#priceblock_ourprice").text().trim();
  const brand = $("#bylineInfo").text().replace("Brand:","").replace("Visit the","").replace("Store","").trim();
  let imageUrl = $("#landingImage").attr("data-old-hires") || $("#landingImage").attr("src") || $(".a-dynamic-image").first().attr("src") || "";
  if (imageUrl && imageUrl.includes("?")) imageUrl = imageUrl.split("?")[0];
  const bullets = [];
  $("#feature-bullets li").each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length > 10) bullets.push(t);
  });
  const description = bullets.slice(0, 2).join(". ");
  if (!title) throw new Error("Amazon blocked");
  return { title, price, brand, imageUrl, description };
}

// ─── Groq fallback for extraction ─────────────────────────────────────────────
async function extractWithGroq(amazonUrl) {
  const r = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      max_tokens: 800,
      messages: [
        { role: "system", content: `Extract Amazon product details. Return ONLY valid JSON no markdown:
{"title":"product name under 100 chars","price":"price with symbol or empty","description":"2-3 sentences","imageUrl":"","brand":"brand or empty"}` },
        { role: "user", content: `Extract from: ${amazonUrl}` },
      ],
    },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
  );
  return JSON.parse(r.data.choices[0].message.content.replace(/```json|```/g, "").trim());
}

// ─── Extract endpoint ─────────────────────────────────────────────────────────
app.post("/api/extract", async (req, res) => {
  const { amazonUrl } = req.body;
  if (!amazonUrl) return res.status(400).json({ error: "Missing amazonUrl" });
  let product;
  try {
    product = await scrapeAmazon(amazonUrl);
  } catch {
    try { product = await extractWithGroq(amazonUrl); } 
    catch (e) { return res.status(500).json({ error: "Failed to extract product details" }); }
  }
  if (product.imageUrl) {
    product.proxyImageUrl = `/api/proxy-image?url=${encodeURIComponent(product.imageUrl)}`;
  }
  res.json({ product });
});

// ─── Design pin with Groq ─────────────────────────────────────────────────────
app.post("/api/design-pin", async (req, res) => {
  const { title, price, description, brand, style } = req.body;

  const styleGuides = {
    luxury: "premium, gold accents, elegant dark background, serif fonts, sophisticated",
    bold: "high energy, bright red/orange, big bold text, SALE badge, urgency",
    minimal: "clean white/light background, lots of whitespace, thin fonts, understated",
    festive: "warm colors, celebratory, golden/red palette, festive and joyful",
    natural: "earthy greens and browns, organic feel, nature-inspired, calm",
    dark: "deep black background, neon accents, modern, tech-forward, sleek"
  };

  const colorSchemes = {
    luxury: { bg: { type: "gradient", from: "#1a1200", to: "#0a0800" }, accent: "#c9a84c", text: "#f5e6c8", taglineColor: "rgba(201,168,76,0.7)" },
    bold: { bg: { type: "gradient", from: "#1a0000", to: "#0f0f0f" }, accent: "#ff2020", text: "#ffffff", taglineColor: "rgba(255,255,255,0.65)" },
    minimal: { bg: { type: "solid", color: "#f7f5f2" }, accent: "#222222", text: "#111111", taglineColor: "rgba(0,0,0,0.45)" },
    festive: { bg: { type: "gradient", from: "#1a0800", to: "#0f0505" }, accent: "#e8a020", text: "#fff8ee", taglineColor: "rgba(232,160,32,0.7)" },
    natural: { bg: { type: "gradient", from: "#0d1a0d", to: "#050f05" }, accent: "#4caf6e", text: "#e8f5e8", taglineColor: "rgba(76,175,110,0.7)" },
    dark: { bg: { type: "gradient", from: "#050510", to: "#0a0a1a" }, accent: "#7c6fff", text: "#e8e8ff", taglineColor: "rgba(124,111,255,0.7)" }
  };

  const scheme = colorSchemes[style] || colorSchemes.bold;

  try {
    const r = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        max_tokens: 600,
        messages: [
          {
            role: "system",
            content: `You are a Pinterest pin designer. Given product details and a style, return ONLY a valid JSON design spec with no markdown or preamble.
The JSON must have exactly these fields:
{
  "tagline": "short punchy one-line text to grab attention (max 8 words)",
  "ctaText": "call to action button text (max 4 words, e.g. Shop Now, View Deal)",
  "showBrand": true or false,
  "priceBadge": true or false (true = price in colored badge),
  "imageOverlay": true or false,
  "imageFilter": "CSS filter string e.g. brightness(1.05) contrast(1.1) saturate(1.2) or empty string",
  "titleFontSize": number between 36 and 48,
  "titleFont": "DM Sans,sans-serif",
  "titleWeight": "700",
  "priceFontSize": number between 32 and 44,
  "imagePosition": "top"
}`
          },
          {
            role: "user",
            content: `Design a ${style} Pinterest pin for:
Product: ${title}
Brand: ${brand || "unknown"}
Price: ${price || "not listed"}
Description: ${description}
Style guide: ${styleGuides[style] || "bold and eye-catching"}

Make the tagline and CTA punchy and click-worthy for Pinterest shoppers in India.`
          }
        ],
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
    );

    const text = r.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    const aiDesign = JSON.parse(text);

    // Merge AI decisions with color scheme
    const design = Object.assign({}, aiDesign, scheme);
    res.json({ design });
  } catch (e) {
    console.error("Design error:", e.response?.data || e.message);
    // Fallback design if Groq fails
    res.json({
      design: Object.assign({
        tagline: "Shop Now on Amazon",
        ctaText: "View Deal",
        showBrand: true,
        priceBadge: true,
        imageOverlay: true,
        imageFilter: "brightness(1.05) contrast(1.1) saturate(1.15)",
        titleFontSize: 42,
        titleFont: "DM Sans,sans-serif",
        titleWeight: "700",
        priceFontSize: 38,
        imagePosition: "top"
      }, scheme)
    });
  }
});

app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
