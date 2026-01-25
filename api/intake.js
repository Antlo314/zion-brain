// /api/intake.js
// Intake -> GHL webhook -> Gemini proposal (strict JSON) -> KV store -> return pid + redirect
//
// Required env:
//   GEMINI_API_KEY
//   GEMINI_MODEL (e.g. gemini-3-pro-preview)
//   GHL_WEBHOOK_URL
//   KV_REST_API_URL
//   KV_REST_API_TOKEN

import { GoogleGenerativeAI } from "@google/generative-ai";

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
function bad(res, status, msg, extra = {}) {
  return json(res, status, { ok: false, error: msg, ...extra });
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

async function kvPipeline(cmds) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("KV env not set");
  const endpoint = url.replace(/\/$/, "") + "/pipeline";
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds)
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`KV pipeline failed: ${data ? JSON.stringify(data) : `HTTP ${r.status}`}`);
  return data;
}

async function kvSetJson(key, obj, ttlSeconds = 1800) {
  const val = JSON.stringify(obj);
  await kvPipeline([
    { command: ["SET", key, val] },
    { command: ["EXPIRE", key, String(ttlSeconds)] }
  ]);
}

function makePid() {
  // short-ish pid, good enough
  return Math.random().toString(16).slice(2, 10).toUpperCase();
}

// --- JSON hardening helpers ---
function extractFirstJsonObject(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

function validateProposalShape(obj) {
  // Minimal validation so bad shapes don’t silently pass.
  if (!obj || typeof obj !== "object") return false;
  if (!obj.executive_summary || typeof obj.executive_summary !== "string") return false;
  if (!Array.isArray(obj.tiers) || obj.tiers.length !== 3) return false;
  for (const t of obj.tiers) {
    if (!t || typeof t !== "object") return false;
    if (!t.name || typeof t.name !== "string") return false;
    if (typeof t.price_monthly !== "number") return false;
    if (!Array.isArray(t.scope)) return false;
  }
  return true;
}

function proposalSchemaText() {
  // Keep it as plain text schema; Gemini follows this well when reinforced.
  return `
Return ONLY a valid JSON object matching this schema. No markdown. No commentary.

{
  "executive_summary": "string (5-10 sentences, executive tone)",
  "pricing_logic": {
    "temperature": "Cold|Warm|Hot",
    "recommended_plan": "Ignite|Elevate|Luminary|None",
    "reasoning": ["string", "..."]
  },
  "tiers": [
    {
      "name": "Ignite",
      "price_monthly": 950,
      "activation_fee": 500,
      "why_fit": "string",
      "scope": ["string", "..."],
      "timeline": "string"
    },
    {
      "name": "Elevate",
      "price_monthly": 1450,
      "activation_fee": 500,
      "why_fit": "string",
      "scope": ["string", "..."],
      "timeline": "string"
    },
    {
      "name": "Luminary",
      "price_monthly": 2250,
      "activation_fee": 500,
      "why_fit": "string",
      "scope": ["string", "..."],
      "timeline": "string"
    }
  ],
  "one_offs": [
    { "name": "Voice Agent", "from_monthly": 150, "setup_from": 497, "notes": "string" },
    { "name": "Content Automation", "from_monthly": 350, "setup_from": 500, "notes": "string" },
    { "name": "Smart Site", "from_monthly": 0, "setup_from": 1000, "notes": "string" },
    { "name": "Local SEO", "from_monthly": 500, "setup_from": 750, "notes": "string" }
  ],
  "next_steps": ["string", "..."]
}
`.trim();
}

function buildProposalPrompt(payload) {
  const {
    full_name, email, phone, business_name, website,
    industry, primary_goal, budget_range, timeline, bottleneck,
    intent, page_url, conversation_summary
  } = payload;

  return `
You are Zion, executive intelligence for Lumen Labs (AI growth systems studio).
Your task: generate a pricing-aware executive summary and 3-tier proposal for the lead.

Hard rules:
- Output must be JSON only. No markdown. No code fences. No extra keys.
- Use Lumen Labs locked pricing:
  Ignite $950/mo, Elevate $1,450/mo, Luminary $2,250/mo
  Activation Fee: $500 (one-time)
- Always return exactly 3 tiers (Ignite/Elevate/Luminary) and include one_offs options.
- Write like an executive operator: concise, specific, no hype.

Lead intake:
full_name: ${full_name || ""}
email: ${email || ""}
phone: ${phone || ""}
business_name: ${business_name || ""}
website: ${website || ""}
industry: ${industry || ""}
primary_goal: ${primary_goal || ""}
budget_range: ${budget_range || ""}
timeline: ${timeline || ""}
bottleneck: ${bottleneck || ""}
intent: ${intent || ""}
page_url: ${page_url || ""}
conversation_summary: ${conversation_summary || ""}

${proposalSchemaText()}
`.trim();
}

async function generateProposalStrict(payload) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || "gemini-3-pro-preview";
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    // If this SDK/version supports it, it helps; if ignored, no harm.
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 1400,
      // Some Gemini endpoints honor this (forces JSON). If not honored, our parser still handles it.
      responseMimeType: "application/json"
    }
  });

  // Attempt 1
  const prompt = buildProposalPrompt(payload);
  const r1 = await model.generateContent(prompt);
  const t1 = (r1?.response?.text?.() || "").trim();

  // Try strict parse
  let obj = null;
  try { obj = JSON.parse(t1); } catch { obj = extractFirstJsonObject(t1); }
  if (obj && validateProposalShape(obj)) return { obj, raw: t1 };

  // Attempt 2 (repair): feed the bad output back and demand corrected JSON only
  const repairPrompt = `
You produced invalid JSON.

Return ONLY valid JSON matching the schema exactly. No markdown. No commentary.
Here is your previous output:
${t1}

${proposalSchemaText()}
`.trim();

  const r2 = await model.generateContent(repairPrompt);
  const t2 = (r2?.response?.text?.() || "").trim();

  try { obj = JSON.parse(t2); } catch { obj = extractFirstJsonObject(t2); }
  if (obj && validateProposalShape(obj)) return { obj, raw: t2 };

  // Give caller both raw outputs for debugging
  const err = new Error("Gemini returned non-JSON proposal");
  err.raw1 = t1;
  err.raw2 = t2;
  throw err;
}

async function sendToGHL(payload) {
  const url = process.env.GHL_WEBHOOK_URL;
  if (!url) throw new Error("GHL_WEBHOOK_URL missing");

  // Your workflow mapping expects first_name/last_name/email/phone + extras (as seen in your mapping reference).
  const full = (payload.full_name || "").trim();
  const parts = full.split(/\s+/).filter(Boolean);
  const first_name = parts[0] || "";
  const last_name = parts.slice(1).join(" ") || "";

  const ghlPayload = {
    first_name,
    last_name,
    email: (payload.email || "").trim(),
    phone: (payload.phone || "").trim(),
    intent: payload.intent || "Zion Activation",
    conversation_summary: payload.conversation_summary || "",
    source: "Zion On-Page Intelligence",
    page_url: payload.page_url || ""
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ghlPayload)
  });

  // Even if workflow runs async, we just need a successful POST.
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`GHL webhook failed: HTTP ${r.status} ${txt}`.trim());
  }
  return { ok: true };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return json(res, 200, { ok: true });
  if (req.method !== "POST") return bad(res, 405, "Use POST");

  const body = await readJson(req);
  if (!body) return bad(res, 400, "Invalid JSON body");

  const email = (body.email || "").trim();
  if (!email) return bad(res, 400, "Missing email");

  const pid = makePid();

  try {
    // 1) Create/update contact in GHL immediately
    await sendToGHL(body);

    // 2) Generate proposal JSON (strict)
    const { obj: proposal, raw } = await generateProposalStrict(body);

    // 3) Store record in KV (30 min TTL typical; adjust as needed)
    const record = {
      pid,
      created_at: new Date().toISOString(),
      intake: body,
      proposal
    };
    await kvSetJson(`proposal:${pid}`, record, 1800);

    return json(res, 200, {
      ok: true,
      pid,
      redirect_url: `/summary?pid=${encodeURIComponent(pid)}`,
      // helpful in development; safe to remove later
      debug: { stored: true }
    });
  } catch (e) {
    // Optional: store failure debug to KV so you can inspect what Gemini returned
    try {
      await kvSetJson(
        `proposal_fail:${pid}`,
        {
          pid,
          created_at: new Date().toISOString(),
          intake: body,
          error: e?.message || String(e),
          raw1: e?.raw1 || null,
          raw2: e?.raw2 || null
        },
        1800
      );
    } catch {}

    return bad(res, 500, e?.message || "Server error");
  }
}

