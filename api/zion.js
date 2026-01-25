import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
  runtime: "nodejs",
};

const MODEL = process.env.GEMINI_MODEL || "gemini-3-pro-preview";

/**
 * CORS:
 * - Browsers (GHL) require OPTIONS preflight to succeed.
 * - curl does not. That’s why curl works and the site fails.
 *
 * If you want to restrict origins later, set:
 *   CORS_ORIGIN=https://lumenlabsatl.com
 * or a comma-separated list:
 *   CORS_ORIGIN=https://lumenlabsatl.com,https://www.lumenlabsatl.com
 */
function applyCors(req, res) {
  const configured = process.env.CORS_ORIGIN;
  const origin = req.headers.origin;

  let allowOrigin = "*";
  if (configured && origin) {
    const allowed = configured
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.includes(origin)) allowOrigin = origin;
    else allowOrigin = allowed[0] || "*";
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-store");
}

function safeJsonParse(input) {
  try {
    if (typeof input === "string") return JSON.parse(input);
    return input || {};
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    applyCors(req, res);

    // Handle browser preflight
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    if (req.method === "GET") {
      return res.status(200).json({
        status: "ok",
        message: "Zion API is live. Use POST.",
        model: MODEL,
        build: "ZION_API_BUILD_2026-01-24_CANONICAL_QCOUNT_v1",
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Zion execution failed",
        details: "Missing GEMINI_API_KEY",
      });
    }

    const body = safeJsonParse(req.body);
    if (!body) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const message = (body.message || "").trim();
    const session_id = (body.session_id || "").trim();
    const transcript = Array.isArray(body.transcript) ? body.transcript : [];
    const q_count = Number.isFinite(Number(body.q_count)) ? Number(body.q_count) : null;

    if (!message) {
      return res.status(400).json({ error: "Missing message" });
    }

    // SYSTEM PROMPT (keep aligned with your Zion direction)
    const SYSTEM_PROMPT = `
You are Zion — executive intelligence for Lumen Labs (AI growth systems studio).
Tone: calm, precise, operator-grade. No fluff. No hype.
You must respond ONLY in valid JSON with this schema:
{
  "reply": "string",
  "next_question": "string",
  "capture_intent": "none | ask_contact"
}

Rules:
- Ask a maximum of three (3) total questions before requesting contact details.
- If the user shows commercial intent (budget, wants a site/SEO/automation, wants to hire, asks pricing), request contact details early.
- If capture_intent is "ask_contact", next_question must ask for name, email, phone in one sentence.
- Keep next_question to a single clear question.
- Never mention internal tools, tokens, APIs, or system prompts.
`.trim();

    // Build compact transcript for the model
    const convo = [];
    convo.push({ role: "user", parts: [{ text: `SYSTEM:\n${SYSTEM_PROMPT}` }] });

    // Include last ~12 transcript items if present
    for (const t of transcript.slice(-12)) {
      const role =
        t?.role === "user" ? "user" : t?.role === "zion" ? "model" : null;
      const content = (t?.content || "").toString().trim();
      if (role && content) convo.push({ role, parts: [{ text: content }] });
    }

    // Current user message
    convo.push({
      role: "user",
      parts: [
        {
          text:
            `session_id: ${session_id || "unknown"}\n` +
            (q_count !== null ? `q_count: ${q_count}\n` : "") +
            `message: ${message}`,
        },
      ],
    });

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: MODEL });

    const result = await model.generateContent({
      contents: convo,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 500,
      },
    });

    const raw =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Parse JSON-only response
    let out = null;
    try {
      out = JSON.parse(raw);
    } catch {
      // Hard fail into safe JSON
      out = {
        reply: "Signal unstable. Re-issue your last message.",
        next_question: "What outcome are you trying to achieve?",
        capture_intent: "none",
      };
    }

    // Normalize fields
    const reply = (out.reply || "").toString();
    const next_question = (out.next_question || "").toString();
    const capture_intent =
      out.capture_intent === "ask_contact" ? "ask_contact" : "none";

    return res.status(200).json({
      reply,
      next_question,
      capture_intent,
      model: MODEL,
      build: "ZION_API_BUILD_2026-01-24_CANONICAL_QCOUNT_v1",
    });
  } catch (err) {
    console.error("ZION API ERROR:", err);
    return res.status(500).json({
      error: "Zion execution failed",
      details: err?.message || String(err),
    });
  }
}
