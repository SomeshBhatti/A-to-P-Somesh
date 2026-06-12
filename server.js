require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const session = require("express-session");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "amzpin-secret-key",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

const PORT = process.env.PORT || 3000;
const REDIRECT_URI = process.env.REDIRECT_URI || "https://a-to-p-somesh.onrender.com/auth/callback";
const APP_PASSWORD = process.env.APP_PASSWORD || "pinterest123";

// ─── Global Pinterest token (shared across ALL devices) ───────────────────────
const TOKEN_FILE = "/tmp/amzpin_token.json";
let globalToken = { accessToken: null, refreshToken: null, username: null };
try {
  if (fs.existsSync(TOKEN_FILE)) {
    globalToken = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    console.log("✅ Loaded Pinterest token for:", globalToken.username);
  }
} catch(e) {}
function saveToken() {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(globalToken)); } catch(e) {}
}

// ─── Password protection middleware ──────────────────────────────────────────
const PUBLIC_PATHS = ["/auth/app-login", "/auth/app-logout", "/auth/callback", "/login.html"];
function requireAppAuth(req, res, next) {
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();
  if (req.session.appAuthed) return next();
  if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
    return res.status(401).json({ error: "App not unlocked" });
  }
  res.sendFile(path.join(__dirname, "login.html"));
}
app.use(requireAppAuth);
app.use(express.static(__dirname));

// ─── App login/logout ─────────────────────────────────────────────────────────
app.post("/auth/app-login", (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    req.session.appAuthed = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "Wrong password" });
  }
});
app.post("/auth/app-logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ─── Pinterest status (uses global token) ────────────────────────────────────
app.get("/api/status", async (req, res) => {
  if (!globalToken.accessToken) return res.json({ connected: false });
  try {
    const r = await axios.get("https://api.pinterest.com/v5/user_account", {
      headers: { Authorization: `Bearer ${globalToken.accessToken}` }
    });
    globalToken.username = r.data.username;
    saveToken();
    res.json({ connected: true, username: r.data.username });
  } catch(e) {
    if (e.response?.status === 401) {
      globalToken.accessToken = null;
      saveToken();
    }
    res.json({ connected: false });
  }
});

// ─── Pinterest OAuth (stores token globally) ─────────────────────────────────
app.get("/auth/pinterest", (req, res) => {
  const clientId = process.env.PINTEREST_CLIENT_ID;
  if (!clientId) return res.redirect("/?error=missing_client_id");
  const scope = "pins:write,pins:read,boards:read,boards:write,user_accounts:read";
  const url = `https://www.pinterest.com/oauth/?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/?error=auth_failed");
  try {
    const creds = Buffer.from(`${process.env.PINTEREST_CLIENT_ID}:${process.env.PINTEREST_CLIENT_SECRET}`).toString("base64");
    const tokenRes = await axios.post(
      "https://api.pinterest.com/v5/oauth/token",
      new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` } }
    );
    globalToken.accessToken = tokenRes.data.access_token;
    globalToken.refreshToken = tokenRes.data.refresh_token;
    try {
      const user = await axios.get("https://api.pinterest.com/v5/user_account", {
        headers: { Authorization: `Bearer ${globalToken.accessToken}` }
      });
      globalToken.username = user.data.username;
    } catch {}
    saveToken();
    console.log("✅ Pinterest connected for:", globalToken.username);
    res.redirect("/?connected=true");
  } catch (e) {
    console.error("OAuth error:", e.response?.data || e.message);
    res.redirect("/?error=token_failed");
  }
});

app.post("/auth/disconnect", (req, res) => {
  globalToken = { accessToken: null, refreshToken: null, username: null };
  saveToken();
  res.json({ ok: true });
});

// ─── Get boards (global token) ────────────────────────────────────────────────
app.get("/api/boards", async (req, res) => {
  if (!globalToken.accessToken) return res.status(401).json({ error: "Pinterest not connected" });
  try {
    const r = await axios.get("https://api.pinterest.com/v5/boards", {
      headers: { Authorization: `Bearer ${globalToken.accessToken}` },
      params: { page_size: 50 }
    });
    res.json({ boards: r.data.items });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch boards" });
  }
});

// ─── Post pin directly (global token) ────────────────────────────────────────
app.post("/api/post-pin", async (req, res) => {
  if (!globalToken.accessToken) return res.status(401).json({ error: "Pinterest not connected" });
  const { boardId, title, description, imageUrl, link } = req.body;
  if (!boardId) return res.status(400).json({ error: "Missing boardId" });
  try {
    const pinBody = { board_id: boardId, title: (title||"").slice(0,100), description: description||"", link: link||"" };
    if (imageUrl) pinBody.media_source = { source_type: "image_url", url: imageUrl };
    const r = await axios.post("https://api.pinterest.com/v5/pins", pinBody, {
      headers: { Authorization: `Bearer ${globalToken.accessToken}`, "Content-Type": "application/json" }
    });
    res.json({ success: true, pin: r.data });
  } catch (e) {
    console.error("Post pin:", e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || "Failed to post pin" });
  }
});

// ─── Server-side queue (in-memory + file backup) ─────────────────────────────
const QUEUE_FILE = "/tmp/amzpin_queue.json";
let serverQueue = [];

// Load from file on startup
try {
  if (fs.existsSync(QUEUE_FILE)) {
    serverQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
    console.log(`Loaded ${serverQueue.length} queued pins from disk`);
  }
} catch(e) { serverQueue = []; }

function saveQueueFile() {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(serverQueue)); } catch(e) {}
}

// Get full queue
app.get("/api/queue", (req, res) => {
  res.json({ queue: serverQueue });
});

// Sync full queue from client
app.post("/api/queue/sync", (req, res) => {
  const { queue } = req.body;
  if (!Array.isArray(queue)) return res.status(400).json({ error: "Invalid queue" });
  serverQueue = queue;
  saveQueueFile();
  res.json({ ok: true, count: serverQueue.length });
});

// Add single item
app.post("/api/queue/add", (req, res) => {
  const item = req.body.item;
  if (!item) return res.status(400).json({ error: "Missing item" });
  serverQueue.push(item);
  saveQueueFile();
  res.json({ ok: true, count: serverQueue.length });
});

// Update item (after extraction)
app.post("/api/queue/update", (req, res) => {
  const { id, updates } = req.body;
  const idx = serverQueue.findIndex(x => x.id === id);
  if (idx >= 0) Object.assign(serverQueue[idx], updates);
  saveQueueFile();
  res.json({ ok: true });
});

// Remove item
app.delete("/api/queue/:id", (req, res) => {
  const id = parseInt(req.params.id);
  serverQueue = serverQueue.filter(x => x.id !== id);
  saveQueueFile();
  res.json({ ok: true, count: serverQueue.length });
});

// ─── Image proxy (fixes Amazon CDN hotlink blocking) ─────────────────────────
// ─── Image proxy ─────────────────────────────────────────────────────────────
app.get("/api/proxy-image", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url");
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-IN,en;q=0.9",
        "Referer": "https://www.amazon.in/",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
        "sec-fetch-dest": "image",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-site": "cross-site",
        "Cache-Control": "no-cache",
      },
      maxRedirects: 5,
    });
    res.set("Content-Type", r.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(r.data);
  } catch (e) {
    console.error("Proxy image error:", e.message, url.substring(0, 80));
    res.status(404).send("Not found");
  }
});

// ─── Scrape Amazon ────────────────────────────────────────────────────────────
const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];
function randomUA() { return UA_LIST[Math.floor(Math.random() * UA_LIST.length)]; }

function getBestImageUrl($) {
  // Method 1: data-a-dynamic-image JSON — pick largest resolution
  const dynamicRaw = $("#landingImage").attr("data-a-dynamic-image") ||
                     $(".a-dynamic-image").first().attr("data-a-dynamic-image");
  if (dynamicRaw) {
    try {
      const imgs = JSON.parse(dynamicRaw);
      const sorted = Object.entries(imgs).sort((a, b) => (b[1][0] * b[1][1]) - (a[1][0] * a[1][1]));
      if (sorted.length) return sorted[0][0];
    } catch {}
  }
  // Method 2: og:image meta tag (often high quality)
  const ogImage = $("meta[property='og:image']").attr("content") ||
                  $("meta[name='twitter:image']").attr("content");
  if (ogImage && ogImage.startsWith("http")) return ogImage;
  // Method 3: data-old-hires
  const oldHires = $("#landingImage").attr("data-old-hires");
  if (oldHires && oldHires.startsWith("http")) return oldHires;
  // Method 4: src upgraded to large size
  const src = $("#landingImage").attr("src") || $(".a-dynamic-image").first().attr("src") || "";
  if (src && src.startsWith("http")) {
    return src.replace(/_SX[0-9]+_/, "_SX679_")
              .replace(/_SY[0-9]+_/, "_SY679_")
              .replace(/_AC_US[0-9]+_/, "_AC_SX679_")
              .replace(/_SL[0-9]+_/, "_SL679_");
  }
  // Method 5: any img with data-old-hires in gallery
  let galleryUrl = "";
  $("img[data-old-hires]").each((_, el) => {
    const u = $(el).attr("data-old-hires");
    if (u && u.startsWith("http") && !galleryUrl) galleryUrl = u;
  });
  return galleryUrl;
}

// Note: Amazon CDN blocks all server-side image requests (403)
// Images are served directly to browser via <img> tag (works fine)
// Canvas uses CORS proxies (handled client-side)

async function scrapeAmazon(url) {
  // Follow short URLs (amzn.to) first
  let finalUrl = url;
  if (url.includes("amzn.to") || url.includes("amzn.eu")) {
    try {
      const redirected = await axios.get(url, {
        maxRedirects: 5,
        timeout: 8000,
        headers: { "User-Agent": randomUA() },
      });
      finalUrl = redirected.request.res.responseUrl || redirected.config.url || url;
    } catch {}
  }

  const { data: html } = await axios.get(finalUrl, {
    timeout: 12000,
    headers: {
      "User-Agent": randomUA(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
    },
  });

  const $ = cheerio.load(html);

  // Title — try multiple selectors
  const title = (
    $("#productTitle").text().trim() ||
    $("h1.a-size-large").text().trim() ||
    $("h1[data-feature-name='title']").text().trim() ||
    $(".product-title-word-break").text().trim()
  );
  if (!title) throw new Error("Amazon blocked or wrong page");

  // Price — try multiple selectors
  const price = (
    $(".a-price .a-offscreen").first().text().trim() ||
    $("#priceblock_ourprice").text().trim() ||
    $("#priceblock_dealprice").text().trim() ||
    $(".apexPriceToPay .a-offscreen").first().text().trim() ||
    $("[data-asin-price]").first().attr("data-asin-price") ||
    $(".a-price-whole").first().text().trim()
  );

  // Brand
  const brand = (
    $("#bylineInfo").text().replace(/Brand:|Visit the|Store|by\s+/gi, "").trim() ||
    $(".po-brand .a-span9 span").text().trim() ||
    $("a#bylineInfo").text().replace(/Visit the|Store/gi, "").trim()
  );

  // Image — best quality
  const imageUrl = getBestImageUrl($);

  // Description from bullets
  const bullets = [];
  $("#feature-bullets li span:not(.a-list-item)").each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 15 && t.length < 250) bullets.push(t);
  });
  if (!bullets.length) {
    $("#feature-bullets li").each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > 15 && t.length < 250) bullets.push(t);
    });
  }

  console.log(`✅ Scraped: "${title.substring(0,50)}" | image: ${imageUrl ? "found" : "missing"}`);
  return { title, price, brand, imageUrl, description: bullets.slice(0, 3).join(". ") };
}

// ─── Gemini AI (replaces Groq) ───────────────────────────────────────────────
async function geminiText(prompt, maxTokens = 2048) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set in Render environment");
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: maxTokens, responseMimeType: "application/json" }
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );
  return r.data.candidates[0].content.parts[0].text;
}

async function geminiGenerateImage(prompt, productImageBase64, mimeType) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const parts = [{ text: prompt }];
  if (productImageBase64) {
    parts.push({ inlineData: { mimeType: mimeType || "image/jpeg", data: productImageBase64 } });
  }
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${key}`,
    {
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"], temperature: 1.0 }
    },
    { headers: { "Content-Type": "application/json" }, timeout: 60000 }
  );
  const imgPart = r.data.candidates[0].content.parts.find(p => p.inlineData);
  if (!imgPart) throw new Error("No image in Gemini response");
  return imgPart.inlineData.data; // base64
}

// Keep Groq as optional fallback
async function groqCall(messages, apiKey, maxTokens = 800) {
  const key = apiKey || process.env.GROQ_API_KEY;
  if (!key) throw new Error("No Groq key");
  const r = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    { model: "llama-3.3-70b-versatile", max_tokens: maxTokens, messages },
    { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } }
  );
  return r.data.choices[0].message.content;
}

// Extract product name from URL path as a hint for Groq fallback
function extractHintFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // Amazon URL format: /product-name/dp/ASIN or /dp/ASIN
    const dpIdx = parts.indexOf("dp");
    if (dpIdx > 0) return parts[dpIdx - 1].replace(/-/g, " ");
    return parts.slice(0, 2).join(" ").replace(/-/g, " ");
  } catch { return ""; }
}

// ─── Extract ──────────────────────────────────────────────────────────────────
app.post("/api/extract", async (req, res) => {
  const { amazonUrl } = req.body;
  if (!amazonUrl) return res.status(400).json({ error: "Missing amazonUrl" });
  let product;
  try {
    product = await scrapeAmazon(amazonUrl);
  } catch (scrapeErr) {
    console.warn("Scrape failed:", scrapeErr.message, "— trying Groq fallback");
    const urlHint = extractHintFromUrl(amazonUrl);
    try {
      const text = await groqCall([
        {
          role: "system",
          content: `You are a product data expert. Extract Amazon product details from the URL and URL path hint.
Return ONLY valid JSON, no markdown:
{"title":"full product name","price":"","description":"2-3 sentence product description","imageUrl":"","brand":"brand name"}`
        },
        {
          role: "user",
          content: `Amazon URL: ${amazonUrl}
Product name hint from URL: "${urlHint}"

Extract the product details. Use the URL hint to determine the product name. Leave imageUrl empty.`
        },
      ]);
      product = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      return res.status(500).json({ error: "Failed to extract product details. Try a full Amazon product URL." });
    }
  }
  // Return image URL as-is — browser <img> tags can display Amazon images fine
  // Canvas uses client-side CORS proxies
  res.json({ product });
});

// ─── Design pin + hashtags (single Groq call) ─────────────────────────────────
app.post("/api/design-pin", async (req, res) => {
  const { title, price, description, brand, style } = req.body;

  const categoryDetect = (t) => {
    t = (t || "").toLowerCase();
    if (/phone|laptop|tablet|earphone|earbuds|speaker|camera|charger|powerbank|gadget|bluetooth|gaming|keyboard|mouse|monitor|ssd|headphone|router|wifi/.test(t)) return "Tech & Gadgets";
    if (/kitchen|cook|pan|mixer|grinder|cooker|vessel|tawa|air.?fryer|utensil|cookware|oven/.test(t)) return "Kitchen";
    if (/serum|moisturis|sunscreen|makeup|skincare|haircare|shampoo|lotion|perfume|beauty|cosmetic/.test(t)) return "Beauty & Skincare";
    if (/kurta|saree|shirt|dress|shoes|bag|purse|jewellery|clothing|fashion/.test(t)) return "Fashion";
    if (/sofa|mattress|curtain|lamp|decor|furniture|shelf|carpet|bedsheet|pillow/.test(t)) return "Home Decor";
    if (/gym|fitness|yoga|dumbbell|protein|supplement|running|sports|exercise/.test(t)) return "Fitness & Sports";
    if (/organic|herbal|ayurvedic|eco|bamboo|natural|essential.?oil|wellness/.test(t)) return "Natural & Organic";
    if (/baby|kids|toy|stationery|school|children/.test(t)) return "Baby & Kids";
    return "Lifestyle";
  };

  const category = categoryDetect(title + " " + (description || ""));

  const prompt = `You are an elite Pinterest Creative Director and Performance Marketer.
Transform this Amazon product into a HIGH-CONVERTING Pinterest Pin concept.
The output must NEVER look like an Amazon listing. Create Pinterest-native lifestyle content.

Product Name: ${title}
Brand: ${brand || "Unknown"}
Category: ${category}
Features: ${description || "Premium quality product"}
Price: ${price || "Check Amazon"}

GOAL: Create a pin that stops scrolling instantly, feels aspirational, creates desire, encourages Saves.

HEADLINE RULES:
- 2-5 words MAXIMUM
- Communicates the MAIN BENEFIT, not the product name
- Examples: Wireless Mouse → "WORK WITHOUT NOISE", Power Bank → "POWER ALL DAY", Air Fryer → "CRISPY WITHOUT OIL", Laptop Stand → "BETTER POSTURE", Coffee Maker → "CAFE AT HOME"
- All caps or title case, punchy and memorable

VISUAL EFFECTS by category:
- Tech: productivity glow, motion trails, blue/purple ambient light
- Kitchen: steam, food splash, warm lighting, ingredients around product
- Beauty: soft bokeh, rose petals, glow effect, luxury vanity setting
- Fitness: energy lines, sweat drops, gym environment, dynamic lighting
- Home: cozy warm light, lifestyle home setting

SCENE RULES:
- Pinterest-native lifestyle setting (NOT Amazon white background)
- Premium commercial photography style
- Dramatic cinematic lighting
- Product is centered and dominant (60-70% of frame)
- Clean space for text overlay at top and bottom

Return ONLY valid JSON:
{
  "headline": "2-5 word ALL CAPS benefit headline",
  "subHeadline": "One line supporting benefit, max 8 words",
  "benefits": ["Benefit 1 max 5 words", "Benefit 2 max 5 words", "Benefit 3 max 5 words"],
  "badge": "2-3 word social proof badge",
  "ctaText": "2-4 word save-focused CTA",
  "image_generation_prompt": "Highly detailed image generation prompt: Pinterest ad style, 1080x1920 vertical pin, [product name] centered and dominant in frame, [lifestyle scene matching category], premium commercial product photography, dramatic cinematic lighting, [specific visual effects for this product], ultra realistic, 8K quality, no text overlay, clean composition, viral Pinterest ad aesthetic, professional advertising campaign quality, [specific colors and mood matching the ${style} style]",
  "pinterest_description": "2-3 sentence Pinterest SEO description. Natural language, includes key benefits, price hint, and reason to save. Max 120 words.",
  "keywords": ["12 targeted Pinterest search keywords, no # symbol, specific to this product and Indian shoppers"]
}`;

  try {
    const text = await geminiText(prompt, 1500);
    let design;
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      design = JSON.parse(clean);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      design = match ? JSON.parse(match[0]) : null;
      if (!design) throw new Error("JSON parse failed");
    }

    // Validate
    if (!Array.isArray(design.benefits) || design.benefits.length < 3) {
      design.benefits = ["Premium quality", "Best value", "Fast delivery"];
    }
    design.benefits = design.benefits.slice(0, 3);
    if (!Array.isArray(design.keywords)) design.keywords = [];
    design.keywords = design.keywords.slice(0, 12).map(k => k.replace(/^#/, "").trim()).filter(Boolean);

    res.json({ design });
  } catch (e) {
    console.error("design-pin (Gemini):", e.response?.data || e.message);
    // Fallback
    res.json({ design: {
      headline: "MUST HAVE",
      subHeadline: "Trusted by thousands of shoppers",
      benefits: ["Premium quality", "Best value for money", "Fast Amazon delivery"],
      badge: "Top Rated",
      ctaText: "Save This",
      image_generation_prompt: `Pinterest ad style vertical pin, ${title} centered, premium commercial photography, dramatic lighting, ultra realistic`,
      pinterest_description: `${title} - available on Amazon India. ${price ? "Priced at " + price + "." : ""} Premium quality with fast delivery.`,
      keywords: ["AmazonIndia","OnlineShopping","IndianShopper","MustHave","BestDeals","TopRated","AmazonFinds","SmartShopping","QualityProducts","LifestyleIndia","TrendingNow","HomeEssentials"]
    }});
  }
});

// ─── Generate lifestyle scene via Gemini image generation ─────────────────────
app.post("/api/generate-scene", async (req, res) => {
  const { imagePrompt, productImageUrl } = req.body;
  if (!imagePrompt) return res.status(400).json({ error: "Missing imagePrompt" });

  // Fetch product image server-side and convert to base64
  let productImageBase64 = null, mimeType = "image/jpeg";
  if (productImageUrl) {
    try {
      const imgRes = await axios.get(productImageUrl, {
        responseType: "arraybuffer", timeout: 10000,
        headers: { "User-Agent": randomUA(), "Referer": "https://www.amazon.in/" }
      });
      productImageBase64 = Buffer.from(imgRes.data).toString("base64");
      mimeType = imgRes.headers["content-type"]?.split(";")[0] || "image/jpeg";
      console.log("✅ Product image fetched for scene gen, size:", imgRes.data.byteLength);
    } catch (e) { console.warn("Could not fetch product image:", e.message); }
  }

  try {
    const base64 = await geminiGenerateImage(imagePrompt, productImageBase64, mimeType);
    res.json({ imageBase64: base64, mimeType: "image/png" });
  } catch (e) {
    console.error("generate-scene:", e.response?.data || e.message);
    res.status(500).json({ error: "Scene generation failed: " + (e.message || "Unknown error") });
  }
});


app.post("/api/upload-image", async (req, res) => {
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: "Missing base64" });
  if (!process.env.IMGBB_API_KEY) return res.status(500).json({ error: "IMGBB_API_KEY not set in Render environment variables" });
  try {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("key", process.env.IMGBB_API_KEY);
    form.append("image", base64.replace(/^data:image\/\w+;base64,/, ""));
    form.append("expiration", "600");
    const r = await axios.post("https://api.imgbb.com/1/upload", form, { headers: form.getHeaders() });
    res.json({ url: r.data.data.url });
  } catch(e) {
    console.error("imgbb:", e.response?.data || e.message);
    res.status(500).json({ error: "Image upload failed — check IMGBB_API_KEY in Render" });
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));
