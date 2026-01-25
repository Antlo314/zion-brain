// /api/intake.js
// Vercel Serverless Function (Node, ESM)
// Flow:
// 1) Receive intake payload from landing page
// 2) Generate proposal JSON via Gemini (Zion brain rules in ZION_SYSTEM_PROMPT)
// 3) Save proposal to Vercel KV as proposal:<pid> with TTL
// 4) POST lead data to GHL inbound webhook (optional but recommended)
// 5) Return { ok:true, pid, redirect_url } so frontend can navigate to /summary?pid=...

import { GoogleGenerativeAI } from "@google/generative-ai";

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
function bad(res, status, msg, extra = {}) {
  return json(res, status, { ok: false, error: msg, ...extra });
}

function safeTrim(v) {
  return typeof v === "string" ? v.trim() : "";
}

function splitFullName(fullName) {
  const s = safeTrim(fullName).replace(/\s+/g, " ");
  if (!s) return { first_name: "", last_name: "" };
  const parts = s.split(" ");
  if (parts.length === 1) return { first_name: parts[0], last_name: "" };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

function makePid() {
  // short, URL-safe id
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

async function kvPipeline(cmds) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("KV env not set (KV_REST_API_URL / KV_REST_API_TOKEN)");
  const endpoint = url.replace(/\/$/, "") + "/pipeline";

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmds),
  });

  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = data ? JSON.stringify(data) : `HTTP ${r.status}`;
    throw new Error(`KV pipeline failed: ${err}`);
  }
  return data;
}

async function kvSetJsonWithTTL(key, obj, ttlSeconds) {
  const val = JSON.stringify(obj);
  // Use SETEX so we get predictable TTL behavior.
  // Upstash REST supports Redis commands; Vercel KV REST pipeline passes them through.
  await kvPipeline([{ command: ["SETEX", key, String(ttlSeconds), val] }]);
}

async function callGeminiProposal({ modelName, apiKey, systemPrompt, payload }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  // Hard rule: JSON only (no markdown). The summary page expects structured fields.
  const instruction = `
Return ONLY valid JSON. No markdown. No code fences.

You must output an object shaped like:
{
  "executive_summary": "string",
  "tiers": [
    { "name": "Ignite", "monthly": 950, "activation_fee": 500, "includes": ["..."], "ideal_for": "..." },
    { "name": "Elevate", "monthly": 1450, "activation_fee": 500, "includes": ["..."], "ideal_for": "..." },
    { "name": "Luminary", "monthly": 2250, "activation_fee": 500, "includes": ["..."], "ideal_for": "..." }
  ],
  "one_off_services": [
    { "name": "Voice Agent", "range": "$49–$150/mo + setup", "notes": "..." },
    { "name": "Smart Site", "range": "$1k–$4k", "notes": "..." },
    { "name": "Content Automation", "range": "$350–$2k/mo", "notes": "..." },
    { "name": "Local SEO & Automations", "range": "$500–$1,200/mo (+ build $750–$4k)", "notes": "..." }
  ],
  "pricing_reasoning": "string",
  "next_steps": ["...","..."]
}
`;

  const prompt = [
    { role: "user", parts: [{ text: `${systemPrompt || ""}\n\n${instruction}\n\nINTAKE_PAYLOAD:\n${JSON.stringify(payload, null, 2)}` }] },
  ];

  const result = await model.generateContent({
    contents: prompt,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1200,
    },
  });

  const text = result?.response?.text?.() || "";
  const raw = text.trim();

  // Defensive parse
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to recover if model accidentally wrapped with extra text
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try {
        parsed = JSON.parse(raw.slice(first, last + 1));
      } catch {}
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Gemini returned non-JSON proposal");
  }

  return { parsed, raw };
}

async function postToGHL(webhookUrl, leadPayload) {
  if (!webhookUrl) return { skipped: true };
  const r = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(leadPayload),
  });
  const text = await r.text().catch(() => "");
  return { ok: r.ok, status: r.status, body: text.slice(0, 2000) };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  if (req.method !== "POST") return bad(res, 405, "Use POST");

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const modelName = process.env.GEMINI_MODEL || "gemini-3-pro-preview";
    const systemPrompt = process.env.ZION_SYSTEM_PROMPT || "";
    const ghlWebhookUrl = process.env.GHL_WEBHOOK_URL || "";

    if (!apiKey) return bad(res, 500, "Missing GEMINI_API_KEY");
    // KV env checked inside kvPipeline

    // Vercel parses JSON body automatically in many cases,
    // but we also handle raw string body safely.
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === "object" ? body : {};

    // Normalize fields coming from your intake modal
    const full_name = safeTrim(body.full_name || body.name || body.fullName || "");
    const email = safeTrim(body.email || "");
    const phone = safeTrim(body.phone || "");
    const business_name = safeTrim(body.business_name || body.businessName || "");
    const website = safeTrim(body.website || "");
    const industry = safeTrim(body.industry || "");
    const primary_goal = safeTrim(body.primary_goal || body.primaryGoal || "");
    const budget_range = safeTrim(body.budget_range || body.budgetRange || "");
    const timeline = safeTrim(body.timeline || "");
    const bottleneck = safeTrim(body.bottleneck || body.primary_bottleneck || "");
    const intent = safeTrim(body.intent || "Zion Activation");
    const page_url = safeTrim(body.page_url || body.pageUrl || "");
    const conversation_summary = safeTrim(body.conversation_summary || body.conversationSummary || "");
    const session_id = safeTrim(body.session_id || body.sessionId || "");

    if (!email) return bad(res, 400, "Missing email (required)");

    const { first_name, last_name } = splitFullName(full_name);

    const pid = makePid();
    const created_at = new Date().toISOString();

    const intakeRecord = {
      pid,
      created_at,
      full_name,
      first_name,
      last_name,
      email,
      phone,
      business_name,
      website,
      industry,
      primary_goal,
      budget_range,
      timeline,
      bottleneck,
      intent,
      page_url,
      conversation_summary,
      session_id,
      source: "Zion On-Page Intelligence",
    };

    // 1) Generate proposal via Gemini
    const { parsed: proposal, raw: proposal_raw } = await callGeminiProposal({
      modelName,
      apiKey,
      systemPrompt,
      payload: intakeRecord,
    });

    // 2) Save to KV (TTL)
    // Recommended: 7 days. You can change this later.
    const TTL_SECONDS = 60 * 60 * 24 * 7;

    const kvRecord = {
      pid,
      created_at,
      model: modelName,
      intake: intakeRecord,
      proposal,
      // keep raw for debugging (optional)
      proposal_raw,
    };

    await kvSetJsonWithTTL(`proposal:${pid}`, kvRecord, TTL_SECONDS);

    // 3) Send lead to GHL (so your workflow can create/update contact + opportunity)
    const ghlPayload = {
      first_name,
      last_name,
      email,
      phone,
      intent,
      conversation_summary: conversation_summary || proposal?.pricing_reasoning || "",
      source: "Zion On-Page Intelligence",
      page_url,
      proposal_id: pid,

      // include full intake details for mapping or notes
      business_name,
      website,
      industry,
      primary_goal,
      budget_range,
      timeline,
      bottleneck,
      session_id,
    };

    const ghlResult = await postToGHL(ghlWebhookUrl, ghlPayload);

    // 4) Respond with pid + redirect target
    return json(res, 200, {
      ok: true,
      pid,
      redirect_url: `/summary?pid=${encodeURIComponent(pid)}`,
      ghl: ghlResult,
    });
  } catch (e) {
    return bad(res, 500, e?.message || "Server error");
  }
}
