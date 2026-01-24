// /api/zion.js
import { GoogleGenAI } from "@google/genai";

const MODEL_FALLBACKS = [
  process.env.GEMINI_MODEL || "gemini-3-pro-preview",
  // safety fallback if the preview name ever differs on your key:
  "gemini-2.0-flash",
];

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function safeString(v) {
  return typeof v === "string" ? v : "";
}

/**
 * Minimal executive Zion behavior enforcement:
 * - Short replies
 * - Ask <= 1 question per turn
 * - Trigger capture_intent early when confidence is high
 * - Always return strict JSON with { reply, next_question, capture_intent }
 */
function buildSystemInstruction() {
  return `
You are Zion, an executive intelligence for Lumen Labs (AI growth systems studio).
Voice: calm, concise, high-signal. No fluff. No hype.

Hard rules:
- Output MUST be strict JSON ONLY. No markdown. No extra keys.
- reply: max 2 sentences.
- next_question: at most ONE short question. If not needed, return "".
- capture_intent: "none" or "ask_contact".
- After 2 total user messages OR when user expresses clear business intent (automation, leads, website, ads, SEO, ops), set capture_intent to "ask_contact".
- Do NOT ask multiple questions in the reply body; use next_question only.
- If capture_intent is "ask_contact", next_question must ask for name + email in one line.

JSON schema:
{ "reply":"string", "next_question":"string", "capture_intent":"none|ask_contact" }
`.trim();
}

async function generate(ai, model, historyText) {
  const resp = await ai.models.generateContent({
    model,
    contents: historyText,
    config: {
      systemInstruction: buildSystemInstruction(),
      temperature: 0.4,
      maxOutputTokens: 220,
    },
  });

  // SDK returns various shapes depending on version; normalize
  const text =
    resp?.text ??
    resp?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("") ??
    "";

  return safeString(text).trim();
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function coerceToContract(obj) {
  const reply = safeString(obj?.reply);
  const next_question = safeString(obj?.next_question);
  const capture_intent = obj?.capture_intent === "ask_contact" ? "ask_contact" : "none";

  return {
    reply: reply || "Understood. Tell me what you want Zion to improve first—leads, operations, or content?",
    next_question: capture_intent === "ask_contact"
      ? (next_question || "What’s your name and best email?")
      : (next_question || ""),
    capture_intent,
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return json(res, 200, { ok: true, message: "Zion API is live. Use POST JSON: { message, history? }" });
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return json(res, 500, { ok: false, error: "Missing GEMINI_API_KEY (or API_KEY) in Vercel env vars." });
  }

  // Vercel may not auto-parse JSON in all configs; handle both
  let body = req.body;
  if (!body) {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      body = {};
    }
  }

  const message = safeString(body?.message);
  const history = Array.isArray(body?.history) ? body.history : []; // optional: [{role:"USER"|"ZION", content:"..."}]

  if (!message) return json(res, 400, { ok: false, error: "No message provided." });

  // Build a simple text history to keep your serverless lean
  const lines = [];
  for (const h of history.slice(-8)) {
    const r = safeString(h?.role).toUpperCase() === "ZION" ? "ZION" : "USER";
    const c = safeString(h?.content);
    if (c) lines.push(`${r}: ${c}`);
  }
  lines.push(`USER: ${message}`);
  const historyText = lines.join("\n");

  try {
    const ai = new GoogleGenAI({ apiKey });

    let lastErr = null;
    for (const model of MODEL_FALLBACKS) {
      try {
        const raw = await generate(ai, model, historyText);
        const parsed = tryParseJson(raw);

        // If model returned non-JSON, force a compliant fallback response rather than crashing UI
        const contract = parsed
          ? coerceToContract(parsed)
          : coerceToContract({ reply: raw, next_question: "", capture_intent: "none" });

        return json(res, 200, contract);
      } catch (e) {
        lastErr = e;
        // try next model fallback
      }
    }

    return json(res, 500, {
      ok: false,
      error: "Zion failed",
      details: safeString(lastErr?.message || String(lastErr)),
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: "Handler crashed", details: safeString(e?.message || String(e)) });
  }
}
