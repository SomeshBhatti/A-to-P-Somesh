require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const FormData = require("form-data");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/api/status", (req, res) => res.json({ connected: true }));

// ─── Image proxy ──────────────────────────────────────────────────────────────
app.get("/api/proxy-image", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url");
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      headers: { "Referer": "https://www.amazon.in/", "User-Agent": "Mozilla/5.0 Chrome/120.0.0.0" },
      timeout: 8000,
    });
    res.set("Content-Type", r.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(r.data);
  } catch { res.status(404).send("Image not found"); }
});

// ─── Upload base64 image to imgbb → get public URL ───────────────────────────
app.post("/api/upload-image", async (req, res) => {
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: "Missing base64" });
  if (!process.env.IMGBB_API_KEY) return res.status(500).json({ error: "IMGBB_API_KEY not set" });
  try {
    const form = new FormData();
    form.append("key", process.env.IMGBB_API_KEY);
    form.append("image", base64.replace(/^data:image\/\w+;base64,/, ""));
    form.append("expiration", "600"); // auto-delete after 10 min
    const r = await axios.post("https://api.imgbb.com/1/upload", form, {
      headers: form.getHeaders(),
    });
    res.json({ url: r.data.data.url });
  } catch (e) {
    console.error("imgbb error:", e.response?.data || e.message);
    res.status(500).json({ error: "Image upload failed" });
  }
});

// ─── Scrape Amazon ────────────────────────────────────────────────────────────
async function scrapeAmazon(url) {
  const { data: html } = await axios.get(url, {
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
    },
  });
  const $ = cheerio.load(html);
  const title = $("#productTitle").text().trim();
  const price = $(".a-price .a-offscreen").first().text().trim() || $("#priceblock_ourprice").text().trim();
  const brand = $("#bylineInfo").text().replace("Brand:", "").replace("Visit the", "").replace("Store", "").trim();
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

async function extractWithGroq(amazonUrl) {
  const r = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile", max_tokens: 800,
      messages: [
        { role: "system", content: `Extract Amazon product. Return ONLY JSON no markdown:\n{"title":"under 100 chars","price":"with symbol or empty","description":"2-3 sentences","imageUrl":"","brand":"or empty"}` },
        { role: "user", content: `Extract from: ${amazonUrl}` },
      ],
    },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
  );
  return JSON.parse(r.data.choices[0].message.content.replace(/```json|```/g, "").trim());
}

app.post("/api/extract", async (req, res) => {
  const { amazonUrl } = req.body;
  if (!amazonUrl) return res.status(400).json({ error: "Missing amazonUrl" });
  let product;
  try { product = await scrapeAmazon(amazonUrl); }
  catch { try { product = await extractWithGroq(amazonUrl); } catch { return res.status(500).json({ error: "Failed to extract product details" }); } }
  if (product.imageUrl) product.proxyImageUrl = `/api/proxy-image?url=${encodeURIComponent(product.imageUrl)}`;
  res.json({ product });
});

// ─── Design pin with Groq ─────────────────────────────────────────────────────
app.post("/api/design-pin", async (req, res) => {
  const { title, price, description, brand, style } = req.body;
  const styleGuides = {
    luxury: "premium, gold accents, elegant dark background, sophisticated",
    bold: "high energy, bright red, big bold text, urgency, SALE",
    minimal: "clean white background, lots of whitespace, understated",
    festive: "warm golden/red palette, celebratory, joyful",
    natural: "earthy greens and browns, organic, calm",
    dark: "deep black, neon accents, modern, sleek"
  };
  const colorSchemes = {
    luxury: { bg: { type: "gradient", from: "#1a1200", to: "#0a0800" }, accent: "#c9a84c", text: "#f5e6c8", taglineColor: "rgba(201,168,76,0.75)" },
    bold: { bg: { type: "gradient", from: "#1a0000", to: "#0f0f0f" }, accent: "#ff2020", text: "#ffffff", taglineColor: "rgba(255,255,255,0.7)" },
    minimal: { bg: { type: "solid", color: "#f7f5f2" }, accent: "#222222", text: "#111111", taglineColor: "rgba(0,0,0,0.5)" },
    festive: { bg: { type: "gradient", from: "#1a0800", to: "#0f0505" }, accent: "#e8a020", text: "#fff8ee", taglineColor: "rgba(232,160,32,0.75)" },
    natural: { bg: { type: "gradient", from: "#0d1a0d", to: "#050f05" }, accent: "#4caf6e", text: "#e8f5e8", taglineColor: "rgba(76,175,110,0.75)" },
    dark: { bg: { type: "gradient", from: "#050510", to: "#0a0a1a" }, accent: "#7c6fff", text: "#e8e8ff", taglineColor: "rgba(124,111,255,0.75)" }
  };
  const scheme = colorSchemes[style] || colorSchemes.bold;
  try {
    const r = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile", max_tokens: 600,
        messages: [
          { role: "system", content: `You are a Pinterest pin designer. Return ONLY valid JSON no markdown:\n{"tagline":"punchy one-line max 8 words","ctaText":"max 4 words e.g. Shop Now","showBrand":true,"priceBadge":true,"imageOverlay":true,"imageFilter":"CSS filter string or empty","titleFontSize":42,"titleFont":"DM Sans,sans-serif","titleWeight":"700","priceFontSize":38,"imagePosition":"top"}` },
          { role: "user", content: `Design ${style} Pinterest pin:\nProduct: ${title}\nBrand: ${brand||"unknown"}\nPrice: ${price||"not listed"}\nDesc: ${description}\nStyle: ${styleGuides[style]||"bold"}\nMake tagline and CTA punchy for Indian Pinterest shoppers.` }
        ],
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
    );
    const aiDesign = JSON.parse(r.data.choices[0].message.content.replace(/```json|```/g, "").trim());
    res.json({ design: Object.assign({}, aiDesign, scheme) });
  } catch (e) {
    console.error("Design error:", e.response?.data || e.message);
    res.json({ design: Object.assign({ tagline: "Shop Now on Amazon", ctaText: "View Deal", showBrand: true, priceBadge: true, imageOverlay: true, imageFilter: "brightness(1.05) contrast(1.1)", titleFontSize: 42, titleFont: "DM Sans,sans-serif", titleWeight: "700", priceFontSize: 38, imagePosition: "top" }, scheme) });
  }
});

app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
