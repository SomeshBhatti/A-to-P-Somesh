require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const session = require("express-session");
const fs = require("fs");
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 3000;
const QUEUE_FILE = "/tmp/affiliate_content_queue.json";
const DEFAULT_PLATFORMS = {
  pinterest: true,
  facebook: true,
  instagram: true,
  threads: true,
};

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "affiliate-content-engine",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);
app.use(express.static(__dirname));

function wantsPassword() {
  return Boolean(process.env.APP_PASSWORD);
}

function isAuthed(req) {
  return !wantsPassword() || req.session?.authenticated;
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: "Authentication required" });
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/api/session", (req, res) => {
  res.json({ passwordRequired: wantsPassword(), authenticated: isAuthed(req) });
});

app.post("/api/login", (req, res) => {
  if (!wantsPassword()) return res.json({ ok: true });
  if (req.body?.password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function readQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
  } catch (e) {
    console.warn("Queue read failed:", e.message);
  }
  return [];
}

function writeQueue(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) {
    console.warn("Queue write failed:", e.message);
  }
}

let contentQueue = readQueue();

function normalizePlatforms(platforms = {}) {
  if (Array.isArray(platforms)) {
    return {
      pinterest: platforms.includes("pinterest"),
      facebook: platforms.includes("facebook"),
      instagram: platforms.includes("instagram"),
      threads: platforms.includes("threads"),
    };
  }
  return {
    pinterest: platforms.pinterest !== false,
    facebook: platforms.facebook !== false,
    instagram: platforms.instagram !== false,
    threads: platforms.threads !== false,
  };
}

function enabledPlatformNames(platforms) {
  return Object.entries(normalizePlatforms(platforms))
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

function randomUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

function extractHintFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const dpIdx = parts.indexOf("dp");
    if (dpIdx > 0) return parts[dpIdx - 1].replace(/-/g, " ");
    return parts.slice(0, 2).join(" ").replace(/-/g, " ");
  } catch {
    return "";
  }
}

function getBestImageUrl($) {
  const dynamicRaw =
    $("#landingImage").attr("data-a-dynamic-image") ||
    $(".a-dynamic-image").first().attr("data-a-dynamic-image");
  if (dynamicRaw) {
    try {
      const imgs = JSON.parse(dynamicRaw);
      const sorted = Object.entries(imgs).sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1]);
      if (sorted.length) return sorted[0][0];
    } catch {}
  }

  const ogImage =
    $("meta[property='og:image']").attr("content") ||
    $("meta[name='twitter:image']").attr("content");
  if (ogImage?.startsWith("http")) return ogImage;

  const oldHires = $("#landingImage").attr("data-old-hires");
  if (oldHires?.startsWith("http")) return oldHires;

  const src = $("#landingImage").attr("src") || $(".a-dynamic-image").first().attr("src") || "";
  if (src.startsWith("http")) {
    return src
      .replace(/_SX[0-9]+_/, "_SX679_")
      .replace(/_SY[0-9]+_/, "_SY679_")
      .replace(/_AC_US[0-9]+_/, "_AC_SX679_")
      .replace(/_SL[0-9]+_/, "_SL679_");
  }

  let galleryUrl = "";
  $("img[data-old-hires]").each((_, el) => {
    const u = $(el).attr("data-old-hires");
    if (u?.startsWith("http") && !galleryUrl) galleryUrl = u;
  });
  return galleryUrl;
}

async function scrapeAmazon(url) {
  let finalUrl = url;
  if (url.includes("amzn.to") || url.includes("amzn.eu")) {
    try {
      const redirected = await axios.get(url, {
        maxRedirects: 5,
        timeout: 8000,
        headers: { "User-Agent": randomUA() },
      });
      finalUrl = redirected.request?.res?.responseUrl || redirected.config?.url || url;
    } catch {}
  }

  const { data: html } = await axios.get(finalUrl, {
    timeout: 12000,
    headers: {
      "User-Agent": randomUA(),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
    },
  });

  const $ = cheerio.load(html);
  const title =
    $("#productTitle").text().trim() ||
    $("h1.a-size-large").text().trim() ||
    $("h1[data-feature-name='title']").text().trim() ||
    $(".product-title-word-break").text().trim();

  if (!title) throw new Error("Amazon blocked extraction or the URL is not a product page");

  const price =
    $(".a-price .a-offscreen").first().text().trim() ||
    $("#priceblock_ourprice").text().trim() ||
    $("#priceblock_dealprice").text().trim() ||
    $(".apexPriceToPay .a-offscreen").first().text().trim() ||
    $("[data-asin-price]").first().attr("data-asin-price") ||
    $(".a-price-whole").first().text().trim();

  const brand =
    $("#bylineInfo").text().replace(/Brand:|Visit the|Store|by\s+/gi, "").trim() ||
    $(".po-brand .a-span9 span").text().trim() ||
    $("a#bylineInfo").text().replace(/Visit the|Store/gi, "").trim();

  const bullets = [];
  $("#feature-bullets li span:not(.a-list-item)").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 15 && text.length < 260) bullets.push(text);
  });
  if (!bullets.length) {
    $("#feature-bullets li").each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 15 && text.length < 260) bullets.push(text);
    });
  }

  return {
    title,
    price,
    brand,
    imageUrl: getBestImageUrl($),
    description: bullets.slice(0, 4).join(". "),
    sourceUrl: finalUrl,
    urlHint: extractHintFromUrl(finalUrl),
  };
}

async function groqJSON(messages, maxTokens = 1100) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");
  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      temperature: 0.35,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages,
    },
    {
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    }
  );
  return JSON.parse(response.data.choices[0].message.content);
}

async function geminiJSON(prompt, maxTokens = 1400) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.75,
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
      },
    },
    { timeout: 30000, headers: { "Content-Type": "application/json" } }
  );
  const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty Gemini text response");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function geminiGenerateImage(prompt, productImageUrl) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const parts = [{ text: prompt }];
  if (productImageUrl) {
    try {
      const imgRes = await axios.get(productImageUrl, {
        responseType: "arraybuffer",
        timeout: 12000,
        headers: { "User-Agent": randomUA(), Referer: "https://www.amazon.in/" },
      });
      parts.push({
        inlineData: {
          mimeType: imgRes.headers["content-type"]?.split(";")[0] || "image/jpeg",
          data: Buffer.from(imgRes.data).toString("base64"),
        },
      });
    } catch (e) {
      console.warn("Product image fetch for Gemini failed:", e.message);
    }
  }

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${key}`,
    {
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"], temperature: 0.9 },
    },
    { timeout: 70000, headers: { "Content-Type": "application/json" } }
  );

  const imagePart = response.data.candidates?.[0]?.content?.parts?.find((part) => part.inlineData);
  if (!imagePart) throw new Error("Gemini did not return an image");
  return imagePart.inlineData.data;
}

async function uploadToImgBB(base64) {
  if (!process.env.IMGBB_API_KEY) throw new Error("IMGBB_API_KEY not set");
  const form = new FormData();
  form.append("key", process.env.IMGBB_API_KEY);
  form.append("image", base64.replace(/^data:image\/\w+;base64,/, ""));
  const response = await axios.post("https://api.imgbb.com/1/upload", form, {
    timeout: 30000,
    headers: form.getHeaders(),
  });
  return response.data.data.url;
}

function stripHash(tag) {
  return String(tag || "").replace(/^#+/, "").trim();
}

function toClientPackage(pkg) {
  return {
    ...pkg,
    imageUrl: pkg.image?.url || "",
    imagePrompt: pkg.image?.prompt || "",
    analysis: pkg.intelligence,
    pinterest: pkg.content?.pinterest
      ? { ...pkg.content.pinterest, hashtags: (pkg.content.pinterest.hashtags || []).map(stripHash) }
      : null,
    facebook: pkg.content?.facebook
      ? { ...pkg.content.facebook, hashtags: (pkg.content.facebook.hashtags || []).map(stripHash) }
      : null,
    instagram: pkg.content?.instagram
      ? { ...pkg.content.instagram, hashtags: (pkg.content.instagram.hashtags || []).map(stripHash) }
      : null,
    threads: pkg.content?.threads
      ? { ...pkg.content.threads, hashtags: (pkg.content.threads.hashtags || []).map(stripHash) }
      : null,
  };
}

async function analyzeProductFromData(product) {
  return groqJSON(
    [
      {
        role: "system",
        content:
          "You are a senior affiliate marketing strategist. Return compact JSON only. Use Groq for intelligence, not creative long copy.",
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "Analyze this Amazon product for multi-platform affiliate marketing.",
          product,
          requiredSchema: {
            category: "specific product category",
            subcategory: "specific niche",
            audience: ["3 target buyer segments"],
            buyingTriggers: ["5 purchase triggers"],
            benefits: ["5 concise benefit bullets"],
            objections: ["3 buyer objections"],
            keywords: ["12 SEO keywords"],
            hashtags: ["12 hashtags with #"],
            seoTitle: "search optimized title under 70 chars",
            seoDescription: "search optimized meta description under 160 chars",
            angle: "core marketing angle",
          },
        }),
      },
    ],
    1000
  );
}

async function generateCreativePackage(product, intelligence, platforms) {
  const activePlatforms = enabledPlatformNames(platforms);
  const prompt = `Return only JSON for a multi-platform affiliate content package.
Use this product and intelligence. Keep output concise but ready to publish.
Gemini is used only for creative copy and image prompt generation.

Product: ${JSON.stringify(product)}
Intelligence: ${JSON.stringify(intelligence)}
Platforms: ${activePlatforms.join(", ")}

Required JSON schema:
{
  "imagePrompt": "vertical 1080x1920 lifestyle marketing image prompt, no text in image, product dominant, realistic commercial photo style",
  "hooks": ["5 short hooks"],
  "ctas": ["5 short CTAs"],
  "pinterest": {"title":"max 100 chars","description":"SEO rich description under 450 chars","hashtags":["#tag"]},
  "facebook": {"caption":"conversion-focused caption with benefit bullets","hashtags":["#tag"]},
  "instagram": {"caption":"engaging caption with line breaks","hashtags":["#tag"]},
  "threads": {"post":"short conversational post under 500 chars","hashtags":["#tag"]}
}`;

  const creative = await geminiJSON(prompt, 1500);
  for (const platform of Object.keys(DEFAULT_PLATFORMS)) {
    if (!activePlatforms.includes(platform)) creative[platform] = null;
  }
  return creative;
}

async function buildContentPackage({ amazonUrl, product, intelligence, platforms = DEFAULT_PLATFORMS }) {
  const extractedProduct = product || (await scrapeAmazon(amazonUrl));
  const productIntelligence = intelligence || (await analyzeProductFromData(extractedProduct));
  const creative = await generateCreativePackage(extractedProduct, productIntelligence, platforms);
  const generatedImageBase64 = await geminiGenerateImage(creative.imagePrompt, extractedProduct.imageUrl);
  const imageUrl = await uploadToImgBB(generatedImageBase64);

  return {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    product: extractedProduct,
    intelligence: productIntelligence,
    image: {
      url: imageUrl,
      sourceProductImageUrl: extractedProduct.imageUrl || "",
      prompt: creative.imagePrompt,
    },
    content: {
      hooks: creative.hooks || [],
      ctas: creative.ctas || [],
      pinterest: creative.pinterest,
      facebook: creative.facebook,
      instagram: creative.instagram,
      threads: creative.threads,
    },
    platforms: normalizePlatforms(platforms),
  };
}

app.post("/api/analyze-product", requireAuth, async (req, res) => {
  try {
    const { amazonUrl } = req.body;
    if (!amazonUrl) return res.status(400).json({ error: "Missing amazonUrl" });
    const product = await scrapeAmazon(amazonUrl);
    const intelligence = await analyzeProductFromData(product);
    res.json({ product, intelligence });
  } catch (e) {
    console.error("analyze-product:", e.response?.data || e.message);
    res.status(500).json({ error: e.message || "Product analysis failed" });
  }
});

app.post("/api/generate-content", requireAuth, async (req, res) => {
  try {
    const { amazonUrl, product, intelligence, platforms } = req.body;
    if (!amazonUrl && !product) return res.status(400).json({ error: "Missing amazonUrl or product" });
    const result = await buildContentPackage({ amazonUrl, product, intelligence, platforms });
    res.json(toClientPackage(result));
  } catch (e) {
    console.error("generate-content:", e.response?.data || e.message);
    res.status(500).json({ error: e.message || "Content generation failed" });
  }
});

app.post("/api/generate-image", requireAuth, async (req, res) => {
  try {
    const { imagePrompt, productImageUrl } = req.body;
    if (!imagePrompt) return res.status(400).json({ error: "Missing imagePrompt" });
    const generatedImageBase64 = await geminiGenerateImage(imagePrompt, productImageUrl);
    const imageUrl = await uploadToImgBB(generatedImageBase64);
    res.json({ imageUrl });
  } catch (e) {
    console.error("generate-image:", e.response?.data || e.message);
    res.status(500).json({ error: e.message || "Image generation failed" });
  }
});

app.post("/api/bulk-import", requireAuth, (req, res) => {
  const urls = Array.isArray(req.body.urls)
    ? req.body.urls
    : String(req.body.urls || "")
        .split(/\r?\n/)
        .map((url) => url.trim())
        .filter(Boolean);

  if (!urls.length) return res.status(400).json({ error: "No URLs provided" });

  const platforms = normalizePlatforms(req.body.platforms);
  const scheduleHours = Number(req.body.scheduleHours || 4);
  const now = Date.now();
  const items = urls.slice(0, 100).map((amazonUrl, index) => ({
    id: now + index,
    amazonUrl,
    platforms,
    status: "queued",
    createdAt: new Date().toISOString(),
    scheduledFor: new Date(now + index * scheduleHours * 60 * 60 * 1000).toISOString(),
    scheduledAt: now + index * scheduleHours * 60 * 60 * 1000,
    attempts: 0,
    result: null,
    error: null,
    publishing: Object.fromEntries(enabledPlatformNames(platforms).map((name) => [name, "ready_for_manual_or_browser_posting"])),
  }));

  contentQueue.push(...items);
  writeQueue(contentQueue);
  res.json({ ok: true, imported: items.length, added: items.length, queue: contentQueue, count: contentQueue.length });
});

app.get("/api/queue", requireAuth, (req, res) => {
  res.json({ queue: contentQueue, count: contentQueue.length });
});

app.post("/api/queue", requireAuth, (req, res) => {
  const item = req.body || {};
  if (!item.amazonUrl) return res.status(400).json({ error: "Missing amazonUrl" });
  const queuedItem = {
    id: item.id || Date.now(),
    amazonUrl: item.amazonUrl,
    platforms: normalizePlatforms(item.platforms),
    status: item.status === "pending" ? "queued" : item.status || "queued",
    createdAt: item.createdAt || new Date().toISOString(),
    scheduledFor: item.scheduledFor || (item.scheduledAt ? new Date(item.scheduledAt).toISOString() : new Date().toISOString()),
    scheduledAt: item.scheduledAt || Date.now(),
    attempts: 0,
    result: item.content || null,
    error: null,
  };
  contentQueue.push(queuedItem);
  writeQueue(contentQueue);
  res.json({ ok: true, item: queuedItem, queue: contentQueue, count: contentQueue.length });
});

app.post("/api/queue/add", requireAuth, (req, res) => {
  const { amazonUrl, platforms, scheduledFor } = req.body;
  if (!amazonUrl) return res.status(400).json({ error: "Missing amazonUrl" });
  const item = {
    id: Date.now(),
    amazonUrl,
    platforms: normalizePlatforms(platforms),
    status: "queued",
    createdAt: new Date().toISOString(),
    scheduledFor: scheduledFor || new Date().toISOString(),
    scheduledAt: scheduledFor ? Date.parse(scheduledFor) : Date.now(),
    attempts: 0,
    result: null,
    error: null,
  };
  contentQueue.push(item);
  writeQueue(contentQueue);
  res.json({ ok: true, item, queue: contentQueue });
});

app.delete("/api/queue", requireAuth, (req, res) => {
  contentQueue = [];
  writeQueue(contentQueue);
  res.json({ ok: true, queue: contentQueue, count: 0 });
});

app.post("/api/queue/:id/run", requireAuth, async (req, res) => {
  const item = contentQueue.find((entry) => String(entry.id) === String(req.params.id));
  if (!item) return res.status(404).json({ error: "Queue item not found" });
  try {
    await processQueueItem(item);
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e.message || "Queue item failed", item });
  }
});

app.delete("/api/queue/:id", requireAuth, (req, res) => {
  contentQueue = contentQueue.filter((entry) => String(entry.id) !== String(req.params.id));
  writeQueue(contentQueue);
  res.json({ ok: true, queue: contentQueue });
});

async function processQueueItem(item) {
  item.status = "processing";
  item.startedAt = new Date().toISOString();
  item.attempts = (item.attempts || 0) + 1;
  item.error = null;
  writeQueue(contentQueue);

  try {
    item.result = await buildContentPackage({
      amazonUrl: item.amazonUrl,
      platforms: item.platforms || DEFAULT_PLATFORMS,
    });
    item.status = "complete";
    item.completedAt = new Date().toISOString();
    item.publishing = Object.fromEntries(
      enabledPlatformNames(item.platforms).map((name) => [name, "ready_for_manual_or_browser_posting"])
    );
  } catch (e) {
    item.status = "failed";
    item.error = e.message || "Unknown error";
    item.failedAt = new Date().toISOString();
    throw e;
  } finally {
    writeQueue(contentQueue);
  }
}

async function processDueQueue() {
  const now = Date.now();
  const due = contentQueue
    .filter((item) => item.status === "queued" && Date.parse(item.scheduledFor || item.createdAt) <= now)
    .slice(0, 1);

  for (const item of due) {
    try {
      await processQueueItem(item);
    } catch (e) {
      console.error("Scheduled queue item failed:", item.id, e.message);
    }
  }
}

setInterval(processDueQueue, 4 * 60 * 60 * 1000);
setTimeout(processDueQueue, 10000);

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.listen(PORT, () => console.log(`Affiliate content engine running on port ${PORT}`));
