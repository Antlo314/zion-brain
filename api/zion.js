/**
 * /api/zion.js — Vercel Serverless Function (Node)
 *
 * Stable JSON Contract:
 * {
 *   "reply": "string",
 *   "next_question": "string",
 *   "capture_intent": "none" | "ask_contact"
 * }
 *
 * v4 patches:
 * - JSON mode + schema retained
 * - Resilient JSON parsing (slice between braces)
 * - One retry on parse failure (temperature 0 + stricter instruction)
 * - Debug headers: X-Zion-Parse, X-Zion-RawLen
 * - Server-side capture gating (forces early capture on business intent)
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const BUILD = "ZION_API_BUILD_2026-01-25_JSON_MODE_SCHEMA_v4_PARSE_RETRY";
const COMMIT =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_GITHUB_COMMIT_SHA ||
  process.env.GIT_COMMIT_SHA ||
  "unknown";

const MODEL = (process.env.GEMINI_MODEL || "gemini-3-pro-preview").trim();
const API_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `
You are ZION — the executive intelligence for Lumen Labs, an AI growth systems studio.

Positioning:
- Lumen Labs builds AI-powered marketing, automation, and growth systems for businesses.

Tone:
- Calm, executive, precise. No hype. No slang.

Hard rules:
1) Ask a maximum of THREE questions total before requesting contact details.
2) Collect contact details EARLY when intent is real. If the user expresses business intent (growth, leads, website, automation, systems, pricing, launching), trigger capture_intent="ask_contact" by question 1–2.
3) Keep questions short and high-signal.
4) Output MUST be valid JSON only. No markdown, no code fences.

You must output exactly this JSON schema:
{
  "reply": "string",
  "next_question": "string",
  "capture_intent": "none | ask_contact"
}
`.trim();

// Compatible response schema for Gemini API (no additionalProperties)
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    next_question: { type: "string" },
    capture_intent: { type: "string", enum: ["none", "ask_contact"] },
  },
  required: ["reply", "next_question", "capture_intent"],
};

// ---------------- CORS ----------------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// -------- Robust Body Reader --------
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  if (req.body && typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }

  const raw = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------- JSON response helper ----------------
function json(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(obj);
}

// ---------------- Contract enforcement ----------------
function coerceToContract(obj) {
  const reply = typeof obj?.reply === "string" ? obj.reply : "Understood.";
  const next_question =
    typeof obj?.next_question === "string"
      ? obj.next_question
      : "What outcome are you trying to achieve?";
  const capture_intent =
    obj?.capture_intent === "ask_contact" ? "ask_contact" : "none";

  return { reply, next_question, capture_intent };
}

// ---------------- Intent Gate (forces early capture) ----------------
function shouldAskContact(message) {
  const m = (message || "").toLowerCase();
  const hits = [
    "website",
    "site",
    "landing",
    "funnel",
    "leads",
    "sales",
    "clients",
    "bookings",
    "automation",
    "crm",
    "ghl",
    "go high level",
    "sms",
    "seo",
    "ads",
    "marketing",
    "launch",
    "pricing",
    "budget",
    "agency",
    "systems",
    "growth",
  ];
  return hits.some((k) => m.includes(k));
}

// ---------------- JSON parse helpers ----------------
function tryParseJson(text) {
  if (!text || typeof text !== "string") return { ok: false, parsed: null, mode: "empty" };

  // 1) direct parse
  try {
    return { ok: true, parsed: JSON.parse(text), mode: "ok" };
  } catch {}

  // 2) slice between braces
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const slice = text.slice(first, last + 1);
    try {
      return { ok: true, parsed: JSON.parse(slice), mode: "sliced" };
    } catch {}
  }

  return { ok: false, parsed: null, mode: "fail" };
}

// ---------------- Gemini call (JSON mode + schema) ----------------
async function generateZion(genAI, userMessage, opts = {}) {
  const temperature = typeof opts.temperature === "number" ? opts.temperature : 0.4;

  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature,
      maxOutputTokens: 500,
    },
  });

  // Extra instruction (helps in edge cases even with JSON mode)
  const prompt = [
    "Return ONLY valid JSON that matches the required schema.",
    "Do not include any extra keys, comments, markdown, or surrounding text.",
    "",
    `User message:\n${userMessage}`,
  ].join("\n");

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() ?? "";
  return text;
}

async function runZionWithRetry(userMessage) {
  if (!API_KEY) {
    return {
      out: {
        reply: "Zion is live, but GEMINI_API_KEY is missing in Vercel env.",
        next_question: "Do you want to run in diagnostic mode?",
        capture_intent: "none",
      },
      parse: "ok",
      rawLen: 0,
    };
  }

  const genAI = new GoogleGenerativeAI(API_KEY);

  // Attempt 1
  const t1 = await generateZion(genAI, userMessage, { temperature: 0.4 });
  const p1 = tryParseJson(t1);
  if (p1.ok) {
    return { out: coerceToContract(p1.parsed), parse: p1.mode, rawLen: t1.length };
  }

  // Attempt 2 (retry): stricter / more deterministic
  const t2 = await generateZion(genAI, userMessage, { temperature: 0.0 });
  const p2 = tryParseJson(t2);
  if (p2.ok) {
    const mode = p2.mode === "ok" ? "retry_ok" : "retry_sliced";
    return { out: coerceToContract(p2.parsed), parse: mode, rawLen: t2.length };
  }

  return {
    out: {
      reply:
        "I received your message, but the model output was not valid JSON. Re-issue your last message.",
      next_question: "What outcome are you trying to achieve?",
      capture_intent: "none",
    },
    parse: "fail",
    rawLen: Math.max(t1?.length || 0, t2?.length || 0),
  };
}

// ---------------- Vercel Serverless Handler ----------------
export default async function handler(req, res) {
  setCors(res);

  res.setHeader("X-Zion-Build", BUILD);
  res.setHeader("X-Zion-Commit", COMMIT);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return json(res, 200, {
      status: "ok",
      message: "Zion API is live. Use POST.",
      model: MODEL,
      build: BUILD,
    });
  }

  if (req.method !== "POST") {
    return json(res, 405, { error: "Method Not Allowed", build: BUILD });
  }

  const body = await readJsonBody(req);

  res.setHeader("X-Zion-HasBody", body ? "1" : "0");
  res.setHeader("X-Zion-HasMessage", body?.message ? "1" : "0");

  if (!body) return json(res, 400, { error: "Invalid JSON body", build: BUILD });

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json(res, 400, { error: "Missing message", build: BUILD });

  const forceCapture = shouldAskContact(message);

  try {
    const { out, parse, rawLen } = await runZionWithRetry(message);

    // Debug headers (no content leakage)
    res.setHeader("X-Zion-Parse", parse);
    res.setHeader("X-Zion-RawLen", String(rawLen));

    // Server-side override for consistency
    if (forceCapture) out.capture_intent = "ask_contact";

    return json(res, 200, { ...out, model: MODEL, build: BUILD });
  } catch (err) {
    return json(res, 500, {
      error: "Zion runtime error",
      build: BUILD,
      details: err?.message || String(err),
    });
  }
}
