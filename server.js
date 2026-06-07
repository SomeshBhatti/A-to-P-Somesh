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

async function groqCall(messages, apiKey, maxTokens = 800) {
  const key = apiKey || process.env.GROQ_API_KEY;
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

  const stylePersona = {
    luxury:   "You are creating for affluent Indian buyers aged 28-45. Premium feel, exclusivity, aspirational. Tone: sophisticated, confident, tasteful. Language: refined, no slang.",
    bold:     "You are creating a HIGH-URGENCY deal pin for value-conscious Indian shoppers. Tone: excited, urgent, can't-miss. Use FOMO, scarcity, deal language. Make them feel they'll regret missing this.",
    minimal:  "You are creating for modern urban Indian professionals aged 22-35. Clean, intelligent, no-nonsense. Tone: calm, confident, quality-focused. Let the product speak.",
    festive:  "You are creating for Indian festival season (Diwali/Holi/Rakhi/Wedding). Warm, celebratory, gifting-focused. Tone: joyful, generous, auspicious. Family and gifting angles work best.",
    natural:  "You are creating for health-conscious, eco-aware Indian buyers. Organic, sustainable, wellness-focused. Tone: calm, trustworthy, mindful. Emphasize natural ingredients, sustainability, health benefits.",
    dark:     "You are creating for tech-savvy Indian youth aged 18-30. Sleek, futuristic, premium gadget energy. Tone: cool, knowledgeable, aspirational. Spec-focused with lifestyle appeal.",
    rosegold: "You are creating for modern Indian women aged 20-38. Elegant, feminine, stylish. Tone: warm, empowering, beautiful. Self-care, gifting for her, lifestyle aesthetics.",
    neon:     "You are creating for young urban Indian audience aged 16-28. Bold, trendy, Gen-Z energy. Tone: hype, street-smart, FOMO-driven. Use current slang sensibility without being cringe.",
    ocean:    "You are creating for wellness, beauty and lifestyle Indian buyers. Cool, refreshing, serene. Tone: calming, premium, self-care focused. Health and beauty products shine here.",
    sunset:   "You are creating for aspirational Indian lifestyle buyers. Warm, travel-inspired, fashionable. Tone: dreamy, aspirational, wanderlust. Lifestyle and fashion products.",
    royal:    "You are creating for premium gifting and jewellery Indian buyers. Grand, regal, celebratory. Tone: majestic, proud, gift-worthy. Perfect for jewellery, premium gifts, special occasions.",
    vintage:  "You are creating for artisan, handmade and heritage Indian products. Nostalgic, warm, authentic. Tone: storytelling, craftsmanship-proud, cultural. Handmade, traditional and artisan products.",
  };

  const imageFilterMap = {
    food:    "brightness(1.08) contrast(1.12) saturate(1.28)",
    tech:    "brightness(0.97) contrast(1.18) saturate(0.82)",
    fashion: "brightness(1.06) contrast(1.2) saturate(1.12)",
    home:    "brightness(1.07) contrast(1.1) saturate(1.18)",
    beauty:  "brightness(1.12) contrast(1.06) saturate(1.22)",
    fitness: "brightness(1.08) contrast(1.22) saturate(1.18)",
    baby:    "brightness(1.12) contrast(1.04) saturate(1.2)",
    jewelry: "brightness(1.06) contrast(1.16) saturate(0.92)",
    default: "brightness(1.05) contrast(1.1) saturate(1.12)",
  };

  try {
    const text = await groqCall([
      {
        role: "system",
        content: `You are a world-class Pinterest Marketing Strategist, Visual Designer and Copywriter specializing in Indian e-commerce with 10+ years of experience creating viral Pinterest content.

You deeply understand:
- Pinterest India algorithm: what drives saves, click-throughs, and search discovery
- Indian consumer psychology: value consciousness, aspiration, gifting culture, festival buying patterns, joint family dynamics
- Proven copywriting formulas: curiosity gap, FOMO, social proof, problem-solution, aspirational storytelling
- Pinterest SEO: it is a visual search engine — hashtags and descriptions directly drive discovery
- Visual psychology: how colors, contrast, and text placement affect purchase intent

TASK: Analyze the product deeply and return a JSON pin design that CONVERTS Indian Pinterest users into buyers.

Return ONLY valid JSON, no markdown, no preamble, no explanation:
{
  "tagline": "THE MAIN HOOK — 7-10 words. MUST be product-specific using a proven formula. Examples of GREAT taglines: 'The Toilet Roll Holder That Holds Your Phone Too', 'Why 50,000 Indian Kitchens Swear By This Pan', 'This ₹749 Holder Solves Your Bathroom Storage Problem', 'The Gadget Your Bathroom Desperately Needs Right Now'. NEVER write generic lines like 'Must Have Product' or 'Shop Now'.",
  "subTagline": "5-7 word supporting line — adds proof, urgency or emotional resonance. E.g. 'Best seller on Amazon India', 'Ships in 2 days', 'Perfect gift idea'",
  "ctaText": "3-4 word urgent action phrase. E.g. 'Grab Yours Now', 'Order Before It Sells Out', 'Shop Today Only', 'Add to Cart'",
  "categoryEmoji": "The single most perfect emoji for this product category",
  "categoryLabel": "2-3 word ALL CAPS category. E.g. 'BATHROOM ESSENTIAL', 'TECH GADGET', 'KITCHEN UPGRADE', 'GIFT IDEA'",
  "keyFeature": "The #1 most compelling product benefit in 5-8 words. What makes THIS product uniquely valuable to the buyer.",
  "emotionalHook": "The transformation or feeling this product gives in 4-6 words. E.g. 'Finally, an organized bathroom', 'Cook like a professional chef'",
  "urgencyText": "Short urgency element — choose one: 'Best Seller', 'Limited Stock', 'Deal of the Day', 'Top Rated', 'Customer Favourite', or empty string if none fits",
  "pinAngle": "Primary psychological angle — one of: aspirational, practical, gifting, deal, lifestyle, problem-solver, trending",
  "imageFilter": "Canvas filter string precisely matched to this product category. Use these exact filters: food/kitchen=${imageFilterMap.food}, tech/electronics=${imageFilterMap.tech}, fashion/clothing=${imageFilterMap.fashion}, home/decor=${imageFilterMap.home}, beauty/skincare=${imageFilterMap.beauty}, fitness/sports=${imageFilterMap.fitness}, baby/kids=${imageFilterMap.baby}, jewelry/accessories=${imageFilterMap.jewelry}, other=${imageFilterMap.default}",
  "hashtags": "Array of EXACTLY 20 strings (no # symbol). Strategic mix: 3 broad reach tags (AmazonIndia, OnlineShopping, IndianShopper), 4 product-specific tags (exact product type), 3 use-case tags (how/where used), 3 audience tags (who buys this), 3 aspirational/lifestyle tags, 2 Hindi transliteration tags (Hindi words in Roman script), 2 trending Indian tags. ALL must be real searchable Pinterest India tags.",
  "descriptionSEO": "45-65 word SEO-optimized Pinterest description. Structure: Start with main keyword naturally → describe key benefit → mention price if available → include use case → end with soft CTA. Include 3-4 naturally embedded search phrases. Must read like a human wrote it, not keyword stuffing. Example style: 'This 304 grade stainless steel toilet paper holder from Plantex does more than hold your roll — it has a built-in phone stand for your bathroom! Priced at just ₹749, it is perfect for modern bathrooms. Shop now on Amazon India.'"
}

CRITICAL: tagline must mention the actual product or its key feature. hashtags must be an array of exactly 20 strings.`
      },
      {
        role: "user",
        content: `Analyze this product and create an optimized ${style.toUpperCase()} style Pinterest pin for Indian shoppers:

PRODUCT NAME: ${title}
BRAND: ${brand || "Unknown Brand"}
PRICE: ${price || "Check on Amazon"}
PRODUCT DESCRIPTION: ${description || "Quality product available on Amazon India"}
STYLE PERSONA: ${stylePersona[style] || stylePersona.bold}

Think through this step by step before generating:
1. What is this product's PRIMARY use case and who needs it most?
2. What is the #1 pain point this product solves for Indian buyers?
3. What emotional transformation does this product create?
4. What copywriting angle works best for ${style} style + this specific product?
5. Which 20 hashtags will maximize Pinterest India discovery for this exact product?

Now generate the complete pin design JSON. Make the tagline SPECIFIC to this product — not generic.`
      }
    ], null, 1200);

    let design = JSON.parse(text.replace(/```json|```/g, "").trim());

    // Ensure hashtags is a proper array of strings
    if (!Array.isArray(design.hashtags)) {
      design.hashtags = ["AmazonIndia","OnlineShopping","IndianShopper","AmazonFinds","MustHave","ShopNow","HomeDecor","LifestyleIndia","BestDeals","IndianBuyer","DailyEssentials","QualityProducts","AffordableLuxury","SmartShopping","IndiaShoping","GiftIdeas","HomeUpgrade","BudgetBuy","TrendingIndia","ShopIndia"];
    }
    design.hashtags = design.hashtags.slice(0, 20).map(h => String(h).replace(/^#+/, "").trim());

    // Ensure imageFilter is never empty
    if (!design.imageFilter || design.imageFilter.trim() === "") {
      design.imageFilter = imageFilterMap.default;
    }

    res.json({ design });

  } catch (e) {
    console.error("design-pin error:", e.response?.data || e.message);
    res.json({
      design: {
        tagline: `The ${title?.split(" ").slice(0,3).join(" ")} Every Indian Home Needs`,
        subTagline: "Top rated on Amazon India",
        ctaText: "Shop on Amazon",
        categoryEmoji: "🛍️",
        categoryLabel: "AMAZON FIND",
        keyFeature: "Premium quality at unbeatable price",
        emotionalHook: "Upgrade your space today",
        urgencyText: "Best Seller",
        pinAngle: "practical",
        imageFilter: imageFilterMap.default,
        hashtags: ["AmazonIndia","OnlineShopping","IndianShopper","AmazonFinds","MustHave","ShopNow","HomeDecor","LifestyleIndia","BestDeals","IndianBuyer","DailyEssentials","QualityProducts","AffordableLuxury","SmartShopping","IndiaShoping","GiftIdeas","HomeUpgrade","BudgetBuy","TrendingIndia","ShopIndia"],
        descriptionSEO: `${title} is a must-have product available on Amazon India${price ? " at just " + price : ""}. ${description ? description.slice(0, 80) : "Premium quality, trusted by thousands of Indian buyers"}. Order now and get fast delivery!`
      }
    });
  }
});

// ─── Upload image to imgbb (uses IMGBB_API_KEY from Render env) ───────────────
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
