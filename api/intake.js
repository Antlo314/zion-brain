// /api/intake.js
// Vercel Serverless Function (Node, ESM)
// Intake submission -> create/update contact in GoHighLevel via inbound webhook
// -> generate strict JSON proposal via Gemini -> store in Vercel KV -> return pid + redirect URL
//
// Required env vars:
//   GEMINI_API_KEY
//   GEMINI_MODEL                  (default: gemini-3-pro-preview)
//   GHL_WEBHOOK_URL               (your GHL Inbound Webhook URL)
//   KV_REST_API_URL               (Vercel KV / Upstash REST URL)
//   KV_REST_API_TOKEN             (Vercel KV / Upstash REST token)
//
// Notes:
// - KV uses REST /pipeline with ARRAY-OF-ARRAYS command format.
// - Proposal TTL defaults to 30 minutes (1800s). Change PROPOSAL_TTL_SECONDS if desired.
// - This endpoint expects JSON body with at least: email. Optional: full_name, phone, etc.

import { GoogleGenerativeAI } from "@google/generative-ai";

const PROPOSAL_TTL_SECONDS = 1800;

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
function bad(res, status, msg, extra = {}) {
  return sendJson(res, status, { ok: false, error: msg, ...extra });
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

// -------------------- KV (Vercel KV / Upstash) --------------------
async function kvPipeline(commands) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("KV env not set (KV_REST_API_URL / KV_REST_API_TOKEN)");

  const endpoint = url.replace(/\/$/, "") + "/pipeline";

  // IMPORTANT: Upstash/Vercel KV pipeline expects an ARRAY OF ARRAYS
  // Example: [ ["GET","key"], ["TTL","key"] ]
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });

  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`KV pipeline failed: ${data ? JSON.stringify(data) : `HTTP ${r.status}`}`);
  return data;
}

async function kvSetJson(key, obj, ttlSeconds = PROPOSAL_TTL_SECONDS) {
  const val = JSON.stringify(obj);
  await kvPipeline([
    ["SET", key, val],
    ["EXPIRE", key, String(ttlSeconds)]
  ]);
}

// -------------------- Helpers --------------------
function makePid() {
  const rand = Math.random().toString(16).slice(2, 10).toUpperCase();
  return rand;
}

function splitName(fullName) {
  const full = (fullName || "").trim();
  if (!full) return { first_name: "", last_name: "" };
  const parts = full.split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || "",
    last_name: parts.slice(1).join(" ") || ""
  };
}

function extractFirstJsonObject(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

function validateProposalShape(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.executive_summary !== "string" || !obj.executive_summary.trim()) return false;
  if (!Array.isArray(obj.tiers) || obj.tiers.length !== 3) return false;
  for (const t of obj.tiers) {
    if (!t || typeof t !== "object") return false;
    if (typeof t.name !== "string" || !t.name.trim()) return false;
    const mp =
      (typeof t.monthly_price === "number") ? t.monthly_price :
      (typeof t.price_monthly === "number") ? t.price_monthly :
      null;
    if (mp === null) return false;
    if (!Array.isArray(t.scope)) return false;
  }
  return true;
}

function proposalSchemaText() {
  return `
Return ONLY valid JSON matching this schema. No markdown. No commentary.

{
  "executive_summary": "string (5–8 sentences, executive tone)",
  "pricing_logic": {
    "temperature": "Cold|Warm|Hot",
    "complexity": "Simple|Moderate|Advanced",
    "recommended_focus": "Full System|Hybrid|One-Off First",
    "reasoning": "string (concise)"
  },
  "tiers": [
    {
      "name": "Ignite",
      "monthly_price": 950,
      "activation_fee": 500,
      "ideal_for": "string",
      "scope": ["string", "..."],
      "timeline": "string"
    },
    {
      "name": "Elevate",
      "monthly_price": 1450,
      "activation_fee": 500,
      "ideal_for": "string",
      "scope": ["string", "..."],
      "timeline": "string"
    },
    {
      "name": "Luminary",
      "monthly_price": 2250,
      "activation_fee": 500,
      "ideal_for": "string",
      "scope": ["string", "..."],
      "timeline": "string"
    }
  ],
  "one_off_services": [
    { "name": "Voice Agent", "pricing": "$150+/mo + setup", "use_case": "string" },
    { "name": "Smart Site", "pricing": "$1k–$4k build", "use_case": "string" },
    { "name": "Content Automation", "pricing": "$350–$2k/mo", "use_case": "string" },
    { "name": "Local SEO & Automations", "pricing": "$500–$1,200/mo + build", "use_case": "string" }
  ],
  "next_steps": ["string", "..."]
}
`.trim();
}

function buildProposalPrompt(payload) {
  return `
You are Zion — executive intelligence for Lumen Labs (AI growth systems studio).

TASK:
Generate a structured proposal for the lead using the intake data below.

CRITICAL OUTPUT RULES (MANDATORY):
- Output VALID JSON ONLY.
- No markdown, no code fences, no commentary, no trailing text.
- The response must be directly JSON.parse() compatible.

LUMEN LABS LOCKED PRICING (DO NOT CHANGE):
Activation Fee (one-time): $500
Monthly Plans:
- Ignite: $950/mo
- Elevate: $1,450/mo
- Luminary: $2,250/mo

One-Off / Modular Services (optional alternatives):
- Voice Agent: $150+/mo (+ setup)
- Smart Site: $1,000–$4,000 build
- Content Automation: $350–$2,000/mo
- Local SEO & Automations: $500–$1,200/mo (+ build)

GOAL:
- Write an executive summary tailored to the intake.
- Provide 3 tiers (Ignite/Elevate/Luminary) with clear differentiation.
- Include a pricing_logic block that explains fit succinctly (no hype).
- Include one_off_services options (4 items as in schema).

INTAKE JSON:
${JSON.stringify(payload, null, 2)}

${proposalSchemaText()}
`.trim();
}

async function generateProposalStrict(intakePayload) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || "gemini-3-pro-preview";
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 1600,
      responseMimeType: "application/json"
    }
  });

  const prompt1 = buildProposalPrompt(intakePayload);
  const r1 = await model.generateContent(prompt1);
  const t1 = (r1?.response?.text?.() || "").trim();

  let obj = null;
  try { obj = JSON.parse(t1); } catch { obj = extractFirstJsonObject(t1); }
  if (obj && validateProposalShape(obj)) return { proposal: obj, raw: t1 };

  const repairPrompt = `
You returned invalid JSON.

Return ONLY valid JSON matching the schema exactly. No markdown. No commentary.

Your previous output:
${t1}

${proposalSchemaText()}
`.trim();

  const r2 = await model.generateContent(repairPrompt);
  const t2 = (r2?.response?.text?.() || "").trim();

  try { obj = JSON.parse(t2); } catch { obj = extractFirstJsonObject(t2); }
  if (obj && validateProposalShape(obj)) return { proposal: obj, raw: t2 };

  const err = new Error("Gemini returned non-JSON proposal");
  err.raw1 = t1;
  err.raw2 = t2;
  throw err;
}

async function postToGHLWebhook(intakePayload) {
  const url = process.env.GHL_WEBHOOK_URL;
  if (!url) throw new Error("GHL_WEBHOOK_URL missing");

  const { first_name, last_name } = splitName(intakePayload.full_name || intakePayload.name || "");
  const ghlPayload = {
    first_name,
    last_name,
    email: (intakePayload.email || "").trim(),
    phone: (intakePayload.phone || "").trim(),
    intent: intakePayload.intent || "Zion Activation",
    conversation_summary: intakePayload.conversation_summary || "",
    source: intakePayload.source || "Zion On-Page Intelligence",
    page_url: intakePayload.page_url || intakePayload.url || ""
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ghlPayload)
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`GHL webhook failed: HTTP ${r.status} ${txt}`.trim());
  }
  return { ok: true };
}

// -------------------- Handler --------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
  if (req.method !== "POST") return bad(res, 405, "Use POST");

  const body = await readJson(req);
  if (!body) return bad(res, 400, "Invalid JSON body");

  const email = (body.email || "").trim();
  if (!email) return bad(res, 400, "Missing email");

  const pid = makePid();

  const intake = {
    full_name: body.full_name || body.name || "",
    email,
    phone: body.phone || "",
    business_name: body.business_name || body.business || "",
    website: body.website || "",
    industry: body.industry || "",
    primary_goal: body.primary_goal || body.goal || "",
    budget_range: body.budget_range || body.budget || "",
    timeline: body.timeline || "",
    bottleneck: body.bottleneck || "",
    intent: body.intent || "Zion Activation",
    conversation_summary: body.conversation_summary || "",
    source: body.source || "Zion On-Page Intelligence",
    page_url: body.page_url || "",
    zion_notes: body.zion_notes || body.notes || null
  };

  try {
    await postToGHLWebhook(intake);

    const { proposal } = await generateProposalStrict(intake);

    const record = {
      pid,
      created_at: new Date().toISOString(),
      intake,
      proposal
    };

    await kvSetJson(`proposal:${pid}`, record, PROPOSAL_TTL_SECONDS);

    return sendJson(res, 200, {
      ok: true,
      pid,
      redirect_url: `/summary?pid=${encodeURIComponent(pid)}`
    });

  } catch (e) {
    try {
      await kvSetJson(`proposal_fail:${pid}`, {
        pid,
        created_at: new Date().toISOString(),
        intake,
        error: e?.message || String(e),
        raw1: e?.raw1 || null,
        raw2: e?.raw2 || null
      }, PROPOSAL_TTL_SECONDS);
    } catch {}

    return bad(res, 500, e?.message || "Server error");
  }
}
