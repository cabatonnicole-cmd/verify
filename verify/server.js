/* VERIFY backend
 * - Serves the existing VERIFY app from /public (unchanged UI).
 * - Exposes POST /api/search, which asks Gemini to understand the search text.
 * - The Gemini API key lives only in .env on the server and is never sent to the browser.
 */
require("dotenv").config();
const express = require("express");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENDPOINT =
  process.env.GEMINI_ENDPOINT ||
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4kb" }));

// Basic security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Static app (the existing VERIFY front end)
app.use(express.static(path.join(__dirname, "public")));

// Simple in-memory rate limit: 20 requests per minute per IP
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || "unknown";
  const recent = (hits.get(ip) || []).filter(t => now - t < 60_000);
  if (recent.length >= 20) return res.status(429).json({ error: "Too many requests" });
  recent.push(now);
  hits.set(ip, recent);
  next();
}
setInterval(() => hits.clear(), 10 * 60_000).unref();

const SYSTEM_PROMPT = `You help a Philippine consumer app called VERIFY, which guides people to check cosmetics and personal-care products against the official FDA Philippines portal.
The user typed a search (a product name, brand, FDA/CPN number, or a natural-language question). Understand it and give short, factual, general information.

Rules:
- NEVER state or imply that a specific product is registered, genuine, fake, safe or unsafe. You cannot verify registration. The FDA Philippines portal is the only final check.
- Do not invent FDA/CPN numbers, expiry dates, ingredients or facts. If you are unsure, say so briefly and leave fields empty.
- Keep it practical: what the product/category is, and what a shopper should look at when checking it (label details, packaging, seller, where to verify).
- Be concise: summary max 2 sentences, at most 4 points of one short sentence each.
- Respond in the requested language ("en" = English, "tl" = Filipino/Tagalog).
- "stores" lists up to 4 shops or sites where this product appears in your search results (brand website, Shopee, Lazada, TikTok Shop, Watsons, etc.). Only include stores you actually found in the results. Never say a store is authentic or fake. In "note" (max 12 words) say only what the results show, e.g. whether it looks like the brand's own/official store, and what to look for (official store badge, seller rating).
- Output ONLY a JSON object, no markdown, with exactly these keys:
{"product": string, "brand": string, "category": string, "fdaSearch": string, "summary": string, "points": string[], "stores": [{"name": string, "type": "official brand site" | "marketplace" | "retailer" | "other", "note": string}]}
"fdaSearch" is a short clean search phrase to type into the FDA portal (product + brand). Use "" or [] for anything you cannot determine.`;

const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

function extractJson(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callGemini(body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

app.post("/api/search", rateLimit, async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: "Smart search is not configured" });

  const query = clip(req.body && req.body.query, 200);
  const lang = req.body && req.body.lang === "tl" ? "tl" : "en";
  if (query.length < 3) return res.status(400).json({ error: "Query too short" });

  const base = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: `Language: ${lang}\nUser search: ${JSON.stringify(query)}` }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } }
  };

  try {
    let data;
    try {
      // Preferred: Gemini with Google Search grounding for up-to-date information + sources
      data = await callGemini({ ...base, tools: [{ google_search: {} }] });
    } catch (e) {
      // Fallback: plain Gemini without grounding
      console.warn("Grounded request failed, retrying without search:", e.message);
      data = await callGemini({
        ...base,
        generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: "application/json" }
      });
    }

    const cand = data.candidates && data.candidates[0];
    const text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || "").join("");
    const parsed = extractJson(text);

    // Web results: real links from Gemini's Google Search grounding, with the text they support
    const gm = (cand && cand.groundingMetadata) || {};
    const chunks = gm.groundingChunks || [];
    const snippets = {};
    for (const sup of gm.groundingSupports || []) {
      const segText = sup.segment && sup.segment.text;
      for (const i of sup.groundingChunkIndices || []) {
        if (segText && !snippets[i]) snippets[i] = segText;
      }
    }
    const sources = [];
    const seen = new Set();
    chunks.forEach((c, i) => {
      const url = c.web && c.web.uri;
      if (url && /^https:\/\//.test(url) && !seen.has(url) && sources.length < 6) {
        seen.add(url);
        sources.push({ title: clip(c.web.title, 80), url, snippet: clip(snippets[i], 220) });
      }
    });

    const stores = (Array.isArray(parsed.stores) ? parsed.stores : []).slice(0, 4).map(x => ({
      name: clip(x && x.name, 60),
      type: clip(x && x.type, 30),
      note: clip(x && x.note, 120)
    })).filter(x => x.name);

    res.json({
      product: clip(parsed.product, 120),
      brand: clip(parsed.brand, 80),
      category: clip(parsed.category, 80),
      fdaSearch: clip(parsed.fdaSearch, 120),
      summary: clip(parsed.summary, 400),
      points: (Array.isArray(parsed.points) ? parsed.points : []).slice(0, 4).map(p => clip(p, 200)).filter(Boolean),
      stores,
      sources
    });
  } catch (err) {
    console.error("Smart search failed:", err.message);
    res.status(502).json({ error: "Smart search unavailable" });
  }
});

const COMPARE_PROMPT = `You help a Philippine consumer app called VERIFY. A shopper pasted a marketplace product link (Shopee, Lazada or TikTok Shop). You cannot open or read that listing. You only get the product name hint found in the link text.
Use web search to identify the product and its OFFICIAL version, then teach the shopper how to tell the authentic product apart from a counterfeit, dupe or mimic.

Rules:
- NEVER say the shopper's specific listing, seller or store is fake, a dupe, authentic or safe. You have not seen it. Describe only what the authentic product looks like and what fake or mimic versions commonly get wrong.
- Use facts you found for the official product (name, size, ingredients, packaging, where it is officially sold). Do not invent ingredients, FDA/CPN numbers or details. If you could not find something, leave it empty ("" or []) and do not guess.
- If the product cannot be identified from the hint, set "identified" to false, keep product/brand empty, and give only general guidance for that kind of product.
- Ingredients: only from official or reliable sources in the results, in the order given. Tell the shopper to compare with the printed label on the physical product.
- Be concise. At most 6 comparison rows, each cell max 18 words.
- Respond in the requested language ("en" or "tl").
- Output ONLY a JSON object, no markdown, with exactly these keys:
{"identified": boolean, "product": string, "brand": string, "size": string, "officialWhere": string, "ingredients": string[], "whyAuthentic": string, "whyMimic": string, "compare": [{"aspect": string, "authentic": string, "mimic": string}]}
"officialWhere" = where the brand officially sells it (brand site, official store names) if found. "whyAuthentic" = 2 sentences on what makes the official product legitimate (registered with FDA, sold via official channels, consistent labelling). "whyMimic" = 2 sentences on why dupes/mimics are not legitimate and the risks. Aspects can include: Packaging and print quality, Label and FDA/CPN number, Batch code and expiry, Price, Seller or store, Smell and texture.`;

app.post("/api/compare", rateLimit, async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: "Not configured" });

  const url = clip(req.body && req.body.url, 300);
  const hint = clip(req.body && req.body.hint, 150);
  const platform = clip(req.body && req.body.platform, 40);
  const lang = req.body && req.body.lang === "tl" ? "tl" : "en";
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "Bad link" });

  const base = {
    systemInstruction: { parts: [{ text: COMPARE_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: `Language: ${lang}\nMarketplace: ${JSON.stringify(platform)}\nProduct name hint from the link: ${JSON.stringify(hint || "(none)")}` }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } }
  };

  try {
    let data;
    try {
      data = await callGemini({ ...base, tools: [{ google_search: {} }] });
    } catch (e) {
      console.warn("Grounded compare failed, retrying without search:", e.message);
      data = await callGemini({
        ...base,
        generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: "application/json" }
      });
    }

    const cand = data.candidates && data.candidates[0];
    const text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || "").join("");
    const d = extractJson(text);

    const sources = [];
    const seen = new Set();
    for (const c of (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || []) {
      const u = c.web && c.web.uri;
      if (u && /^https:\/\//.test(u) && !seen.has(u) && sources.length < 4) {
        seen.add(u);
        sources.push({ title: clip(c.web.title, 80), url: u });
      }
    }

    const list = (v, n, m) => (Array.isArray(v) ? v : []).slice(0, n).map(x => clip(x, m)).filter(Boolean);
    res.json({
      identified: d.identified === true,
      product: clip(d.product, 120),
      brand: clip(d.brand, 80),
      size: clip(d.size, 60),
      officialWhere: clip(d.officialWhere, 200),
      ingredients: list(d.ingredients, 60, 80),
      whyAuthentic: clip(d.whyAuthentic, 500),
      whyMimic: clip(d.whyMimic, 500),
      compare: (Array.isArray(d.compare) ? d.compare : []).slice(0, 6).map(r => ({
        aspect: clip(r && r.aspect, 50),
        authentic: clip(r && r.authentic, 160),
        mimic: clip(r && r.mimic, 160)
      })).filter(r => r.aspect),
      sources
    });
  } catch (err) {
    console.error("Compare failed:", err.message);
    res.status(502).json({ error: "Comparison unavailable" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "VERIFY", geminiConfigured: Boolean(API_KEY), model: MODEL });
});

const fs = require("fs");
const INDEX = path.join(__dirname, "public", "index.html");
if (!fs.existsSync(INDEX)) {
  console.error("ERROR: public/index.html not found. Keep the project folder structure as delivered.");
  process.exit(1);
}
app.get("/", (req, res) => res.sendFile(INDEX));

// Start on PORT; if it is already in use by another program, try the next ports.
function start(port, triesLeft) {
  const server = app.listen(port, () => {
    console.log("");
    console.log("VERIFY is running. Open:  http://localhost:" + port);
    console.log("Health check:            http://localhost:" + port + "/api/health");
    if (!API_KEY) console.warn("GEMINI_API_KEY is missing in .env - smart search is disabled (the rest of the app still works).");
  });
  server.on("error", err => {
    if (err.code === "EADDRINUSE" && triesLeft > 0) {
      console.warn("Port " + port + " is already used by another program, trying " + (port + 1) + "...");
      start(port + 1, triesLeft - 1);
    } else {
      console.error("Could not start server:", err.message);
      process.exit(1);
    }
  });
}
start(Number(PORT), 10);
