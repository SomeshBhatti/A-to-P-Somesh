require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/api/status", (req, res) => res.json({ ok: true }));

// ─── Image proxy (fixes Amazon CDN hotlink blocking) ─────────────────────────
app.get("/api/proxy-image", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url");
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 8000,
      headers: {
        "Referer": "https://www.amazon.in/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
    });
    res.set("Content-Type", r.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(r.data);
  } catch { res.status(404).send("Not found"); }
});

// ─── Scrape Amazon ────────────────────────────────────────────────────────────
async function scrapeAmazon(url) {
  const { data: html } = await axios.get(url, {
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
    },
  });
  const $ = cheerio.load(html);
  const title = $("#productTitle").text().trim();
  if (!title) throw new Error("blocked");
  const price =
    $(".a-price .a-offscreen").first().text().trim() ||
    $("#priceblock_ourprice").text().trim() ||
    $("#priceblock_dealprice").text().trim();
  const brand = $("#bylineInfo").text()
    .replace(/Brand:|Visit the|Store/g, "").trim();
  let imageUrl =
    $("#landingImage").attr("data-old-hires") ||
    $("#landingImage").attr("src") ||
    $(".a-dynamic-image").first().attr("src") || "";
  if (imageUrl.includes("?")) imageUrl = imageUrl.split("?")[0];
  const bullets = [];
  $("#feature-bullets li span").each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 15 && t.length < 200) bullets.push(t);
  });
  return { title, price, brand, imageUrl, description: bullets.slice(0, 3).join(". ") };
}

async function groqCall(messages, apiKey, maxTokens = 800) {
  const key = apiKey || process.env.GROQ_API_KEY;
  const r = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    { model: "llama-3.3-70b-versatile", max_tokens: maxTokens, messages },
    { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } }
  );
  return r.data.choices[0].message.content;
}

// ─── Extract ──────────────────────────────────────────────────────────────────
app.post("/api/extract", async (req, res) => {
  const { amazonUrl, groqKey } = req.body;
  if (!amazonUrl) return res.status(400).json({ error: "Missing amazonUrl" });
  let product;
  try { product = await scrapeAmazon(amazonUrl); }
  catch {
    try {
      const text = await groqCall([
        { role: "system", content: 'Extract Amazon product. Return ONLY JSON:\n{"title":"","price":"","description":"2-3 sentences","imageUrl":"","brand":""}' },
        { role: "user", content: `Extract from: ${amazonUrl}` },
      ], groqKey);
      product = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch { return res.status(500).json({ error: "Failed to extract product details" }); }
  }
  if (product.imageUrl) product.proxyImageUrl = `/api/proxy-image?url=${encodeURIComponent(product.imageUrl)}`;
  res.json({ product });
});

// ─── Design pin + hashtags (single Groq call) ─────────────────────────────────
app.post("/api/design-pin", async (req, res) => {
  const { title, price, description, brand, style, groqKey } = req.body;
  const styleNotes = {
    luxury: "Premium gold/dark, elegant, high-end feel",
    bold: "High energy, urgent, SALE vibes, bright red",
    minimal: "Clean, white, airy, simple, modern",
    festive: "Warm oranges/golds, celebratory, Indian festival feel",
    natural: "Earthy greens, organic, calm, eco-friendly",
    dark: "Tech/sleek, deep purple-black, neon accents",
  };
  try {
    const text = await groqCall([
      {
        role: "system",
        content: `You are a Pinterest pin designer for Indian shoppers. Return ONLY valid JSON, no markdown:
{
  "tagline": "catchy 6-8 word hook for Indian shoppers",
  "ctaText": "3-4 word CTA e.g. Shop Now, Grab the Deal",
  "priceBadge": true,
  "imageFilter": "CSS filter e.g. brightness(1.05) contrast(1.1) saturate(1.15) or empty string",
  "hashtags": ["10 trending Pinterest India hashtags without # symbol, mix of English and relevant Hindi transliteration, SEO-optimized for product category"]
}
Rules: tagline must be exciting and click-worthy. hashtags array must have exactly 10 items.`
      },
      {
        role: "user",
        content: `Design a ${style} style pin for:\nProduct: ${title}\nBrand: ${brand || "N/A"}\nPrice: ${price || "N/A"}\nDescription: ${description}\nStyle notes: ${styleNotes[style] || "bold"}\n\nGenerate punchy tagline, CTA and 10 hashtags optimized for Pinterest India shopping.`
      }
    ], groqKey, 600);
    const design = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json({ design });
  } catch (e) {
    console.error("design-pin error:", e.response?.data || e.message);
    res.json({
      design: {
        tagline: "Must-Have for Every Home!",
        ctaText: "Shop on Amazon",
        priceBadge: true,
        imageFilter: "",
        hashtags: ["AmazonIndia","OnlineShopping","HomeDecor","MustHave","IndianShopper","AmazonFinds","ShopNow","DailyEssentials","BestDeals","IndiaShoping"]
      }
    });
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));
