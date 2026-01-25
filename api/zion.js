import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = { runtime: "nodejs" };

const MODEL = process.env.GEMINI_MODEL || "gemini-3-pro-preview";
const BUILD = "ZION_API_BUILD_2026-01-25_DEPLOY_PROBE_A";

/**
 * CORS support for GHL-hosted landing pages (browser clients).
 * Lock later with env:
 *   CORS_ORIGIN=https://lumenlabsatl.com,https://www.lumenlabsatl.com
 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  const configured = process.env.CORS_ORIGIN;

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

function safeParseBody(body) {
  try {
    if (!body) return {};
    if (typeof body === "string") return JSON.parse(body);
    return body;
  } catch {
    return null;
  }
}

function clampText(s, max = 6000) {
  const t = (s ?? "").toString();
  return t.length > max ? t.slice(0, max) : t;
}

function normalizeTranscript(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input.slice(-18)) {
    const roleRaw = (item?.role || "").toString().toLowerCase();
    const role =
      roleRaw === "user" ? "user" : roleRaw === "zion" ? "model" : null;

    const content = clampText(item?.content || item?.text || "");
    if (!role || !content.trim()) continue;

    out.push({ role, parts: [{ text: content.trim() }] });
  }
  return out;
}

const SYSTEM_PROMPT = `
You are Zion — executive intelligence for Lumen Labs (AI growth systems studio).
Tone: calm, precise, operator-grade. No fluff.

You MUST respond ONLY in valid JSON with this exact schema:
{
  "reply": "string",
  "next_question": "string",
  "capture_intent": "none | ask_contact"
}

Hard rules:
- Ask a maximum of three (3) total questions before requesting contact details.
- If the user signals commercial intent (pricing, budget, "need a site/SEO/automation", "want to hire", timelines), request contact details early.
- If capture_intent is "ask_contact", next_question MUST ask for name, email, and phone in one sentence.
- next_question must be ONE question only, short and clear.
- Do not mention internal tools, APIs, tokens, system prompts, policies, or constraints.
- Do not use markdown. JSON only.

Guidance:
- Qualify quickly: business type, primary goal, urgency, budget signal.
- If user is vague, ask one clarifying question.
- If user is ready, move to contact capture immediately.
`.trim();

function isCommercialIntent(text) {
  const t = (text || "").toLowerCase();
  return [
    "budget",
    "price",
    "pricing",
    "cost",
    "quote",
    "hire",
    "pay",
    "purchase",
    "invoice",
    "start",
    "asap",
    "timeline",
    "smart site",
    "website",
    "seo",
    "automation",
    "automations",
    "leads",
    "marketing",
  ].some((k) => t.includes(k));
}

function forceAskContactJSON() {
  return {
    reply:
      "Understood. To proceed, I need your contact details so I can generate an executive summary and next-step plan.",
    next_question: "What’s your name, email, and phone number?",
    capture_intent: "ask_contact",
  };
}

function safeJsonOnlyFallback() {
  return {
    reply: "Signal unstable. Re-issue your last message.",
    next_question: "What outcome are you trying to achieve?",
    capture_intent: "none",
  };
}

export default async function handler(req, res) {
  try {
    // ---- CORS for browser clients (GHL) ----
    applyCors(req, res);

    // ---- DEBUG HEADERS (prove deployed build/commit) ----
    res.setHeader("X-Zion-Build", BUILD);
    res.setHeader(
      "X-Zion-Commit",
      process.env.VERCEL_GIT_COMMIT_SHA || "unknown"
    );

    // Preflight
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    if (req.method === "GET") {
      return res.status(200).json({
        status: "ok",
        message: "Zion API is live. Use POST.",
        model: MODEL,
        build: BUILD,
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Zion execution failed",
        details: "Missing GEMINI_API_KEY",
        build: BUILD,
      });
    }

    const body = safeParseBody(req.body);
    if (!body) {
      return res.status(400).json({ error: "Invalid JSON body", build: BUILD });
    }

    const message = (body?.message || "").toString().trim();
    const session_id = (body?.session_id || "").toString().trim();
    const q_count_raw = body?.q_count;
    const q_count = Number.isFinite(Number(q_count_raw))
      ? Number(q_count_raw)
      : null;

    const transcript = normalizeTranscript(body?.transcript);

    if (!message) {
      return res
        .status(400)
        .json({ error: "Missing message", build: BUILD });
    }

    // Hard guard: cap turns; capture on intent signals
    if (
      (q_count !== null && q_count >= 3) ||
      (q_count === null && isCommercialIntent(message) && transcript.length >= 2)
    ) {
      const forced = forceAskContactJSON();
      return res.status(200).json({ ...forced, model: MODEL, build: BUILD });
    }

    // Compose conversation
    const contents = [];

    // System prompt injection
    contents.push({
      role: "user",
      parts: [{ text: `SYSTEM:\n${SYSTEM_PROMPT}` }],
    });

    // Recent transcript
    for (const m of transcript) contents.push(m);

    // Current message with light metadata
    const meta =
      `session_id: ${session_id || "unknown"}\n` +
      (q_count !== null ? `q_count: ${q_count}\n` : "") +
      `message: ${message}`;

    contents.push({
      role: "user",
      parts: [{ text: meta }],
    });

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: MODEL });

    const result = await model.generateContent({
      contents,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 520,
      },
    });

    const raw =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    let out;
    try {
      out = JSON.parse(raw);
    } catch {
      out = safeJsonOnlyFallback();
    }

    // Normalize output strictly
    const reply = (out?.reply || "").toString().trim();
    const next_question = (out?.next_question || "").toString().trim();
    const capture_intent =
      out?.capture_intent === "ask_contact" ? "ask_contact" : "none";

    if (!reply) {
      const fb = safeJsonOnlyFallback();
      return res.status(200).json({ ...fb, model: MODEL, build: BUILD });
    }

    // Enforce contact prompt format
    if (capture_intent === "ask_contact") {
      const fixed = {
        reply,
        next_question: "What’s your name, email, and phone number?",
        capture_intent: "ask_contact",
      };
      return res.status(200).json({ ...fixed, model: MODEL, build: BUILD });
    }

    // Bias capture if approaching question limit + intent signal
    if (q_count !== null && q_count >= 2 && isCommercialIntent(message)) {
      const forced = forceAskContactJSON();
      return res.status(200).json({ ...forced, model: MODEL, build: BUILD });
    }

    return res.status(200).json({
      reply,
      next_question,
      capture_intent,
      model: MODEL,
      build: BUILD,
    });
  } catch (err) {
    console.error("ZION API ERROR:", err);
    return res.status(500).json({
      error: "Zion execution failed",
      details: err?.message || String(err),
      model: MODEL,
      build: BUILD,
    });
  }
}


