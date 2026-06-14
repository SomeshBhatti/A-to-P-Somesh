require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const cheerio = require("cheerio");
const path    = require("path");
const fs      = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT         = process.env.PORT || 3000;
const QUEUE_FILE   = "/tmp/ace_queue.json";
const APP_PASSWORD = process.env.APP_PASSWORD;

// ─── Queue persistence ────────────────────────────────────────────────────────
let serverQueue = [];
try {
  if (fs.existsSync(QUEUE_FILE)) {
    serverQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
    console.log(`✅ Loaded ${serverQueue.length} queue items`);
  }
} catch(e) { serverQueue = []; }
function saveQueue() {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(serverQueue)); } catch(e) {}
}

// ─── Password middleware (optional — only active if APP_PASSWORD is set) ──────
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const open = ["/auth/login", "/auth/logout", "/login.html"];
  if (open.some(p => req.path.startsWith(p))) return next();
  if (req.session.authed) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  return res.sendFile(path.join(__dirname, "login.html"));
}
app.use(requireAuth);
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/auth/login", (req, res) => {
  if (req.body.password === APP_PASSWORD) { req.session.authed = true; res.json({ ok: true }); }
  else res.status(401).json({ error: "Wrong password" });
});
app.post("/auth/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

// ─── Utility: random User-Agent ───────────────────────────────────────────────
const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
const rUA = () => UAS[Math.floor(Math.random() * UAS.length)];

// ─── Amazon scraping ──────────────────────────────────────────────────────────
function getBestImage($) {
  const dyn = $("#landingImage").attr("data-a-dynamic-image") || $(".a-dynamic-image").first().attr("data-a-dynamic-image");
  if (dyn) {
    try {
      const imgs = JSON.parse(dyn);
      return Object.entries(imgs).sort((a,b) => (b[1][0]*b[1][1]) - (a[1][0]*a[1][1]))[0][0];
    } catch {}
  }
  const og = $("meta[property='og:image']").attr("content");
  if (og) return og;
  const old = $("#landingImage").attr("data-old-hires");
  if (old) return old;
  const src = $("#landingImage").attr("src") || "";
  return src.replace(/_SX[0-9]+_/,"_SX679_").replace(/_SL[0-9]+_/,"_SL679_");
}

function parseHtml(html) {
  const $ = cheerio.load(html);
  const title = ($("#productTitle").text() || $("h1.a-size-large").text()).trim();
  if (!title) throw new Error("Title not found — Amazon may have blocked this request");
  const price = $(".a-price .a-offscreen").first().text().trim()
    || $("#priceblock_ourprice").text().trim()
    || $(".apexPriceToPay .a-offscreen").first().text().trim()
    || $(".a-price-whole").first().text().trim();
  const brand = ($("#bylineInfo").text().replace(/Brand:|Visit the|Store|by /gi,"") || "").trim().substring(0,40);
  const imageUrl = getBestImage($);
  const bullets = [];
  $("#feature-bullets li span:not(.a-list-item), #feature-bullets li").each((_,el) => {
    const t = $(el).text().trim();
    if (t.length > 15 && t.length < 250) bullets.push(t);
  });
  return { title, price, brand, imageUrl, description: bullets.slice(0,4).join(". ") };
}

async function scrapeAmazon(url) {
  // Resolve short URLs
  if (url.includes("amzn.to") || url.includes("amzn.eu")) {
    try { url = (await axios.get(url,{maxRedirects:5,timeout:8000,headers:{"User-Agent":rUA()}})).request?.res?.responseUrl || url; } catch {}
  }
  const HDRS = {
    "User-Agent": rUA(),
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en-GB;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
  };
  // Try direct
  try {
    const { data } = await axios.get(url, { timeout: 12000, headers: HDRS, maxRedirects: 5 });
    return parseHtml(data);
  } catch {}
  // Try allorigins proxy
  try {
    const r = await axios.get(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, { timeout: 15000 });
    if (r.data?.contents?.length > 5000) return parseHtml(r.data.contents);
  } catch {}
  // Try codetabs proxy
  try {
    const r = await axios.get(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, { timeout: 15000 });
    if (typeof r.data === "string" && r.data.length > 5000) return parseHtml(r.data);
  } catch {}
  throw new Error("Could not scrape Amazon — try a direct amazon.in/amazon.com link");
}

// ─── Re-host image on ImgBB (permanent) ──────────────────────────────────────
async function reHostImage(imageUrl) {
  if (!imageUrl || !process.env.IMGBB_API_KEY) return imageUrl;
  try {
    const r = await axios.get(imageUrl, {
      responseType: "arraybuffer", timeout: 10000,
      headers: { "User-Agent": rUA(), "Referer": "https://www.amazon.in/" }
    });
    const base64 = Buffer.from(r.data).toString("base64");
    const FormData = require("form-data");
    const fd = new FormData();
    fd.append("key", process.env.IMGBB_API_KEY);
    fd.append("image", base64);
    // NO expiration — permanent hosting
    const up = await axios.post("https://api.imgbb.com/1/upload", fd, { headers: fd.getHeaders(), timeout: 15000 });
    return up.data.data.url;
  } catch(e) {
    console.warn("ImgBB re-host failed:", e.message);
    return imageUrl;
  }
}

// ─── Extract endpoint ─────────────────────────────────────────────────────────
app.post("/api/extract", async (req, res) => {
  const { amazonUrl } = req.body;
  if (!amazonUrl) return res.status(400).json({ error: "Missing amazonUrl" });
  try {
    const product = await scrapeAmazon(amazonUrl);
    product.affiliateUrl = injectTag(amazonUrl);
    if (product.imageUrl) product.hostedImageUrl = await reHostImage(product.imageUrl);
    res.json({ product });
  } catch(e) {
    console.error("Extract:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Affiliate tag injection ──────────────────────────────────────────────────
function injectTag(url, tag) {
  const t = tag || process.env.AFFILIATE_TAG || "";
  if (!t) return url;
  try { const u = new URL(url); u.searchParams.set("tag", t); return u.toString(); }
  catch { return url + (url.includes("?") ? "&" : "?") + "tag=" + t; }
}

// ─── Groq with retry + Gemini fallback ───────────────────────────────────────
async function callGroqWithRetry(prompt, retries = 3) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.3-70b-versatile",
          max_tokens: 1200,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" }
        },
        { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, timeout: 30000 }
      );
      return JSON.parse(r.data.choices[0].message.content);
    } catch(e) {
      const status = e.response?.status;
      const isRateLimit = status === 429 || status === 503;
      if (isRateLimit && attempt < retries - 1) {
        const wait = Math.pow(2, attempt + 1) * 3000; // 6s, 12s
        console.log(`Groq rate limit (${status}), waiting ${wait/1000}s before retry ${attempt+2}/${retries}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

async function analyzeWithGroq(product) {
  const isIndia = (product.affiliateUrl || "").includes("amazon.in");

  const prompt = `You are an expert affiliate marketer specializing in ${isIndia ? "Indian" : "global"} e-commerce content.

Analyze this product and return a complete content marketing brief:
Product: ${product.title}
Brand: ${product.brand || "Unknown"}
Price: ${product.price || "Check Amazon"}
Description: ${product.description || "Premium quality product"}

Return ONLY valid JSON, no markdown:
{
  "category": "one of: Tech, Kitchen, Beauty, Fashion, Home, Fitness, Baby, Food, Organic, Lifestyle",
  "subCategory": "specific subcategory",
  "targetAudience": {
    "primary": "2-3 word buyer description",
    "ageRange": "e.g. 25-40",
    "interests": ["interest1","interest2","interest3"]
  },
  "buyerPersona": "One sentence describing the ideal buyer",
  "topBenefits": ["Benefit 1","Benefit 2","Benefit 3"],
  "painPoints": ["Problem 1","Problem 2"],
  "buyingTriggers": ["Trigger 1","Trigger 2"],
  "pricePositioning": "budget or mid-range or premium",
  "contentAngle": "single best marketing angle",
  "uniqueHook": "One sentence that makes someone want to buy now",
  "hashtags": {
    "pinterest": ["15 Pinterest hashtags without #"],
    "instagram": ["20 Instagram hashtags without #"],
    "facebook": ["8 Facebook hashtags without #"],
    "threads": ["8 Threads hashtags without #"]
  },
  "seoKeywords": ["10 long-tail search keywords"],
  "imageSceneIdea": "Brief ideal lifestyle scene description"
}`;

  // Try Groq first
  try {
    return await callGroqWithRetry(prompt, 3);
  } catch(groqErr) {
    console.warn("Groq failed after retries:", groqErr.response?.status, groqErr.message, "— falling back to Gemini");

    // Gemini fallback for analysis
    const gemKey = process.env.GEMINI_API_KEY;
    if (!gemKey) throw new Error("Both Groq (rate limited) and Gemini (no key) unavailable");

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${gemKey}`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1200, responseMimeType: "application/json" }
      },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );
    return JSON.parse(r.data.candidates[0].content.parts[0].text);
  }
}

// ─── Gemini — creative content (minimal tokens) ───────────────────────────────
async function generateCreativeWithGemini(product, analysis) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const prompt = `You are an elite social media content creator for affiliate marketing.

Product: ${product.title}
Price: ${product.price || "N/A"}
Brand: ${product.brand || "N/A"}
Content Angle: ${analysis.contentAngle}
Target Buyer: ${analysis.buyerPersona}
Top Benefits: ${analysis.topBenefits?.join(", ")}
Unique Hook: ${analysis.uniqueHook}
Image Scene: ${analysis.imageSceneIdea}

Create platform-optimized content. Return ONLY valid JSON:
{
  "headline": "2-5 word ALL CAPS Pinterest headline communicating main benefit",
  "subHeadline": "Supporting line max 8 words",
  "pinterest": {
    "title": "SEO Pinterest title 60-100 chars with main keyword",
    "description": "Pinterest description 150-200 chars, benefit-focused, includes price, ends with soft CTA"
  },
  "facebook": {
    "caption": "Facebook post 80-120 words. Open with hook. 2-3 paragraphs. Conversational. Uses emoji. Includes price. Ends with question or CTA. Affiliate disclosure: #ad"
  },
  "instagram": {
    "caption": "Instagram caption 60-90 words. Aesthetic and aspirational. Line breaks for readability. 3-5 relevant emoji. Lifestyle-focused. Ends with CTA."
  },
  "threads": {
    "post": "Threads post max 400 chars. Opinion or discovery style. Casual and authentic. e.g. 'Found this and had to share...' or 'This changed my routine...'"
  },
  "imagePrompt": "Detailed image generation prompt: Pinterest ad style, 1080x1920 vertical, ${product.title} as hero product, ${analysis.imageSceneIdea}, premium commercial photography, dramatic cinematic lighting, lifestyle environment, ultra realistic 8K, no text overlay, viral Pinterest aesthetic, professional advertising quality"
}`;

  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 1500, responseMimeType: "application/json" }
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );

  const text = r.data.candidates[0].content.parts[0].text;
  return JSON.parse(text.replace(/```json|```/g,"").trim());
}

// ─── Gemini image generation ──────────────────────────────────────────────────
async function generateSceneImage(imagePrompt, productImageUrl) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const parts = [{ text: imagePrompt }];

  // Optionally include product image for Gemini to reference
  if (productImageUrl) {
    try {
      const imgR = await axios.get(productImageUrl, {
        responseType: "arraybuffer", timeout: 10000,
        headers: { "User-Agent": rUA(), "Referer": "https://www.amazon.in/" }
      });
      const b64 = Buffer.from(imgR.data).toString("base64");
      const mime = imgR.headers["content-type"]?.split(";")[0] || "image/jpeg";
      parts.push({ inlineData: { mimeType: mime, data: b64 } });
    } catch {}
  }

  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${key}`,
    {
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE","TEXT"], temperature: 1.0 }
    },
    { headers: { "Content-Type": "application/json" }, timeout: 60000 }
  );

  const imgPart = r.data.candidates[0].content.parts.find(p => p.inlineData);
  if (!imgPart) throw new Error("Gemini returned no image");
  return imgPart.inlineData.data; // base64
}

// ─── Upload base64 to ImgBB (permanent) ──────────────────────────────────────
async function uploadToImgBB(base64, mimeType) {
  const key = process.env.IMGBB_API_KEY;
  if (!key) throw new Error("IMGBB_API_KEY not set");
  const FormData = require("form-data");
  const fd = new FormData();
  fd.append("key", key);
  fd.append("image", base64.replace(/^data:image\/\w+;base64,/, ""));
  // No expiration = permanent
  const r = await axios.post("https://api.imgbb.com/1/upload", fd, {
    headers: fd.getHeaders(), timeout: 20000
  });
  return { url: r.data.data.url, deleteUrl: r.data.data.delete_url };
}

// ─── MAIN: Analyze product ────────────────────────────────────────────────────
app.post("/api/analyze-product", async (req, res) => {
  const { title, price, brand, description, affiliateUrl } = req.body;
  if (!title) return res.status(400).json({ error: "Missing product title" });
  try {
    const analysis = await analyzeWithGroq({ title, price, brand, description, affiliateUrl });
    res.json({ analysis });
  } catch(e) {
    console.error("Analyze:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── MAIN: Generate all content ───────────────────────────────────────────────
app.post("/api/generate-content", async (req, res) => {
  const { amazonUrl, product: existingProduct, analysis: existingAnalysis } = req.body;

  try {
    // Step 1: Extract if no product provided
    let product = existingProduct;
    if (!product && amazonUrl) {
      product = await scrapeAmazon(amazonUrl);
      product.affiliateUrl = injectTag(amazonUrl);
      if (product.imageUrl) product.hostedImageUrl = await reHostImage(product.imageUrl);
    }
    if (!product) return res.status(400).json({ error: "No product data" });

    // Step 2: Groq analysis (cheap)
    const analysis = existingAnalysis || await analyzeWithGroq(product);

    // Step 3: Gemini creative (minimal tokens)
    const creative = await generateCreativeWithGemini(product, analysis);

    // Step 4: Gemini image generation
    let generatedImageUrl = null;
    try {
      const b64 = await generateSceneImage(creative.imagePrompt, product.hostedImageUrl || product.imageUrl);
      const uploaded = await uploadToImgBB(b64, "image/png");
      generatedImageUrl = uploaded.url;
    } catch(e) {
      console.warn("Image gen failed:", e.message);
      generatedImageUrl = product.hostedImageUrl || product.imageUrl || null;
    }

    // Step 5: Build content package
    const pkg = {
      product,
      analysis,
      imageUrl: generatedImageUrl,
      pinterest: {
        title: creative.pinterest?.title || creative.headline,
        description: creative.pinterest?.description || "",
        hashtags: analysis.hashtags?.pinterest || [],
        headline: creative.headline,
        subHeadline: creative.subHeadline,
        imageUrl: generatedImageUrl,
      },
      facebook: {
        caption: creative.facebook?.caption || "",
        hashtags: analysis.hashtags?.facebook || [],
        imageUrl: generatedImageUrl,
      },
      instagram: {
        caption: creative.instagram?.caption || "",
        hashtags: analysis.hashtags?.instagram || [],
        imageUrl: generatedImageUrl,
      },
      threads: {
        post: creative.threads?.post || "",
        hashtags: analysis.hashtags?.threads || [],
      },
      affiliateUrl: product.affiliateUrl,
      generatedAt: new Date().toISOString(),
    };

    res.json(pkg);
  } catch(e) {
    console.error("Generate content:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Generate scene image only ────────────────────────────────────────────────
app.post("/api/generate-image", async (req, res) => {
  const { imagePrompt, productImageUrl } = req.body;
  if (!imagePrompt) return res.status(400).json({ error: "Missing imagePrompt" });
  try {
    const b64 = await generateSceneImage(imagePrompt, productImageUrl);
    const uploaded = await uploadToImgBB(b64, "image/png");
    res.json({ imageUrl: uploaded.url, deleteUrl: uploaded.deleteUrl });
  } catch(e) {
    console.error("Generate image:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Upload image ─────────────────────────────────────────────────────────────
app.post("/api/upload-image", async (req, res) => {
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: "Missing base64" });
  try {
    const result = await uploadToImgBB(base64);
    res.json({ url: result.url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Image proxy ──────────────────────────────────────────────────────────────
app.get("/api/proxy-image", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url");
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer", timeout: 10000,
      headers: { "User-Agent": rUA(), "Referer": "https://www.amazon.in/", "Accept": "image/*" }
    });
    res.set("Content-Type", r.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(r.data);
  } catch { res.status(404).send("Not found"); }
});

// ─── Bulk import ──────────────────────────────────────────────────────────────
app.post("/api/bulk-import", async (req, res) => {
  const { urls, platforms = ["pinterest","facebook","instagram","threads"], scheduleHours = 4 } = req.body;
  if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: "No URLs provided" });

  const items = urls.slice(0, 50).map((url, i) => ({
    id: Date.now() + i,
    amazonUrl: url.trim(),
    platforms,
    status: "pending",
    scheduledAt: Date.now() + (i * scheduleHours * 60 * 60 * 1000 / urls.length), // spread over interval
    content: null,
    createdAt: new Date().toISOString(),
  }));

  serverQueue.push(...items);
  saveQueue();
  res.json({ added: items.length, queueSize: serverQueue.length });
});

// ─── Queue CRUD ───────────────────────────────────────────────────────────────
app.get("/api/queue", (req, res) => res.json({ queue: serverQueue, count: serverQueue.length }));

app.post("/api/queue", (req, res) => {
  const item = req.body;
  if (!item?.id) return res.status(400).json({ error: "Missing id" });
  const idx = serverQueue.findIndex(q => q.id === item.id);
  if (idx >= 0) serverQueue[idx] = { ...serverQueue[idx], ...item };
  else serverQueue.push(item);
  saveQueue();
  res.json({ ok: true });
});

app.put("/api/queue/:id", (req, res) => {
  const id = Number(req.params.id);
  const idx = serverQueue.findIndex(q => q.id === id);
  if (idx < 0) return res.status(404).json({ error: "Not found" });
  serverQueue[idx] = { ...serverQueue[idx], ...req.body };
  saveQueue();
  res.json({ ok: true, item: serverQueue[idx] });
});

app.delete("/api/queue/:id", (req, res) => {
  serverQueue = serverQueue.filter(q => q.id !== Number(req.params.id));
  saveQueue();
  res.json({ ok: true });
});

app.delete("/api/queue", (req, res) => {
  serverQueue = [];
  saveQueue();
  res.json({ ok: true });
});

// ─── Queue processor (every 4 hours) ─────────────────────────────────────────
let isProcessing = false;

async function processQueue() {
  if (isProcessing) return;
  const now = Date.now();
  const due = serverQueue.filter(q => q.status === "pending" && q.scheduledAt <= now);
  if (!due.length) return;

  console.log(`⏰ Processing ${due.length} queue items`);
  isProcessing = true;

  for (const item of due) {
    try {
      const idx = serverQueue.findIndex(q => q.id === item.id);
      if (idx < 0) continue;
      serverQueue[idx].status = "processing";
      saveQueue();

      const pkg = await (async () => {
        const product = await scrapeAmazon(item.amazonUrl);
        product.affiliateUrl = injectTag(item.amazonUrl);
        if (product.imageUrl) product.hostedImageUrl = await reHostImage(product.imageUrl);
        const analysis = await analyzeWithGroq(product);
        const creative = await generateCreativeWithGemini(product, analysis);
        let imageUrl = product.hostedImageUrl || product.imageUrl;
        try {
          const b64 = await generateSceneImage(creative.imagePrompt, imageUrl);
          const up = await uploadToImgBB(b64, "image/png");
          imageUrl = up.url;
        } catch {}
        return { product, analysis, creative, imageUrl };
      })();

      serverQueue[idx].status = "done";
      serverQueue[idx].content = pkg;
      serverQueue[idx].completedAt = new Date().toISOString();
    } catch(e) {
      const idx = serverQueue.findIndex(q => q.id === item.id);
      if (idx >= 0) { serverQueue[idx].status = "failed"; serverQueue[idx].error = e.message; }
      console.error(`Queue item ${item.id} failed:`, e.message);
    }
    saveQueue();
    await new Promise(r => setTimeout(r, 2000)); // 2s between items
  }
  isProcessing = false;
}

setInterval(processQueue, 4 * 60 * 60 * 1000); // every 4 hours

// ─── Server start ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Amazon Content Engine running on port ${PORT}`);
  console.log(`   Gemini: ${process.env.GEMINI_API_KEY ? "✅" : "❌ Not set"}`);
  console.log(`   Groq:   ${process.env.GROQ_API_KEY   ? "✅" : "❌ Not set"}`);
  console.log(`   ImgBB:  ${process.env.IMGBB_API_KEY  ? "✅" : "❌ Not set"}\n`);
  processQueue(); // process any pending items on startup
});
