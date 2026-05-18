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

// ─── Image proxy (fixes Amazon hotlink blocking) ──────────────────────────────
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
    const contentType = r.headers["content-type"] || "image/jpeg";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(r.data);
  } catch {
    res.status(404).send("Image not found");
  }
});

// ─── Scrape Amazon page directly ──────────────────────────────────────────────
async function scrapeAmazon(url) {
  const { data: html } = await axios.get(url, {
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
    },
  });

  const $ = cheerio.load(html);

  // Title
  const title = ($("#productTitle").text() || $("h1.a-size-large").text()).trim();

  // Price
  const price =
    $(".a-price .a-offscreen").first().text().trim() ||
    $("#priceblock_ourprice").text().trim() ||
    $("#priceblock_dealprice").text().trim() ||
    $(".a-price-whole").first().text().trim();

  // Brand
  const brand =
    $("#bylineInfo").text().replace("Brand:", "").replace("Visit the", "").replace("Store", "").trim() ||
    $(".po-brand .a-span9 span").text().trim();

  // Image
  let imageUrl = "";
  const imgTag = $("#landingImage");
  imageUrl =
    imgTag.attr("data-old-hires") ||
    imgTag.attr("src") ||
    $(".a-dynamic-image").first().attr("src") ||
    "";

  // Clean up image URL (remove query params that cause issues)
  if (imageUrl && imageUrl.includes("?")) {
    imageUrl = imageUrl.split("?")[0];
  }

  // Description from bullet points
  const bullets = [];
  $("#feature-bullets ul li span:not(.a-list-item)").each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 10) bullets.push(text);
  });
  if (bullets.length === 0) {
    $("#feature-bullets li").each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 10) bullets.push(text);
    });
  }
  const description = bullets.slice(0, 2).join(". ") || "";

  if (!title) throw new Error("Could not extract title — Amazon blocked the request");

  return { title, price, brand, imageUrl, description };
}

// ─── Groq fallback ────────────────────────────────────────────────────────────
async function extractWithGroq(amazonUrl) {
  const r = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      max_tokens: 1000,
      messages: [
        {
          role: "system",
          content: `You are a product data extractor. Given an Amazon URL, extract product details.
Return ONLY valid JSON with no markdown or preamble:
{
  "title": "product name under 100 chars",
  "price": "price with currency symbol or empty string",
  "description": "2-3 sentence Pinterest-friendly description",
  "imageUrl": "",
  "brand": "brand name or empty string"
}
Note: Always return empty string for imageUrl as you cannot reliably provide image URLs.`,
        },
        {
          role: "user",
          content: `Extract product details from: ${amazonUrl}`,
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
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ─── Extract endpoint ─────────────────────────────────────────────────────────
app.post("/api/extract", async (req, res) => {
  const { amazonUrl } = req.body;
  if (!amazonUrl) return res.status(400).json({ error: "Missing amazonUrl" });

  let product = null;
  let source = "scrape";

  // Try scraping first
  try {
    product = await scrapeAmazon(amazonUrl);
  } catch (scrapeErr) {
    console.warn("Scrape failed:", scrapeErr.message, "— falling back to Groq");
    source = "groq";
    try {
      product = await extractWithGroq(amazonUrl);
    } catch (groqErr) {
      console.error("Groq also failed:", groqErr.response?.data || groqErr.message);
      return res.status(500).json({ error: "Failed to extract product details" });
    }
  }

  // Proxy image URL so it loads correctly
  if (product.imageUrl) {
    product.proxyImageUrl = `/api/proxy-image?url=${encodeURIComponent(product.imageUrl)}`;
  }

  console.log(`Extracted via ${source}:`, product.title);
  res.json({ product });
});

app.use((req, res) => res.status(404).json({ error: "Route not found" }));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
