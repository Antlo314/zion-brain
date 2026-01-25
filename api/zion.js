// /api/zion.js
import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = { runtime: "nodejs" };

const MODEL = "gemini-3-pro-preview";
const BUILD = "ZION_API_BUILD_2026-01-24_CANONICAL_QCOUNT_v1";

// Hard contract validator: never allow anything else back to the client
function coerceToContract(raw) {
  const out = {
    reply: "",
    next_question: "",
    capture_intent: "none",
  };

  try {
    if (typeof raw === "string") {
      const maybe = JSON.parse(raw);
      raw = maybe;
    }
  } catch {
    // ignore
  }

  if (raw && typeof raw === "object") {
    if (typeof raw.reply === "string") out.reply = raw.reply.trim();
    if (typeof raw.next_question === "string") out.next_question = raw.next_question.trim();

    if (raw.capture_intent === "ask_contact" || raw.capture_intent === "none") {
      out.capture_intent = raw.capture_intent;
    }
  }

  // Failsafes
  if (!out.reply) out.reply = "Understood. Tell me a bit more so I can point you in the right direction.";
  if (!out.next_question) out.next_question = "What are you trying to achieve in the next 30 days?";
  if (out.capture_intent !== "ask_contact" && out.capture_intent !== "none") out.capture_intent = "none";

  return out;
}

function shouldForceCapture(qCount) {
  // qCount = number of questions already asked so far (tracked client-side)
  // Force capture once they've hit 2 questions (the next step would exceed 3 total).
  return Number.isFinite(qCount) && qCount >= 2;
}

function isCommercialIntent(text = "") {
  const t = String(text).toLowerCase();
  const keys = [
    "website",
    "site",
    "smart site",
    "seo",
    "automation",
    "automations",
    "leads",
    "lead",
    "ads",
    "marketing",
    "crm",
    "pipeline",
    "booking",
    "appointment",
    "ai agent",
    "voice agent",
    "go high level",
    "gohighlevel",
    "ghl",
    "funnel",
    "sales",
    "growth",
    "operations",
    "workflow",
    "sms",
    "campaign",
    "budget",
    "$",
  ];
  return keys.some((k) => t.includes(k));
}

export default async function handler(req, res) {
  try {
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
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    // Parse body safely
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // ignore
      }
    }

    const message = String(body?.message ?? "");
    const session_id = String(body?.session_id ?? "anon");
    const transcript = String(body?.transcript ?? "");
    const q_count = Number(body?.q_count ?? 0);

    if (!message.trim()) {
      return res.status(400).json({ error: "Missing message" });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: MODEL });

    const SYSTEM_PROMPT = `
You are Zion, the executive intelligence for Lumen Labs (AI growth systems studio).
You are not “Gemini,” not “Google,” not a chatbot. Do not mention model/provider identity.

Output MUST be valid JSON only, with EXACT keys:
{
  "reply": "string",
  "next_question": "string",
  "capture_intent": "none | ask_contact"
}

Rules:
- Ask at most 3 questions total before triggering lead capture.
- The user's current question count is provided as q_count (questions already asked). If q_count >= 2, you MUST set capture_intent to "ask_contact" now.
- If the user's message shows commercial intent, you SHOULD set capture_intent to "ask_contact" by q_count 1 at the latest.
- Prefer early capture when intent is commercial (business, brand, website, automation, SEO, leads, ads, CRM, operations).
- Keep tone calm, executive, concise.
- If you set capture_intent to "ask_contact", next_question MUST ask for name + email + phone in one prompt.
- Never output markdown. Never add extra keys. Never wrap in code fences.
`.trim();

    const userPayload = `
session_id: ${session_id}
q_count: ${Number.isFinite(q_count) ? q_count : 0}
prior_context: ${transcript ? transcript : "(none)"}
user_message: ${message}
`.trim();

    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
        { role: "user", parts: [{ text: userPayload }] },
      ],
    });

    const text =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      (typeof result?.response?.text === "function" ? result.response.text() : "") ||
      "";

    // Enforce JSON-only
    let parsed;
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const jsonSlice = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;
      parsed = JSON.parse(jsonSlice);
    } catch {
      parsed = {
        reply: text || "Understood.",
        next_question: "What are you trying to achieve in the next 30 days?",
        capture_intent: "none",
      };
    }

    const contract = coerceToContract(parsed);

    // Hard enforcement (server-side): max 3 questions + earlier capture for commercial intent
    const forceCaptureNow = shouldForceCapture(q_count);
    const commercial = isCommercialIntent(message);

    if (forceCaptureNow || (commercial && Number.isFinite(q_count) && q_count >= 1)) {
      contract.capture_intent = "ask_contact";
      contract.next_question = "What’s your name, email, and phone number?";
    }

    return res.status(200).json(contract);
  } catch (err) {
    console.error("ZION API ERROR:", err);
    return res.status(500).json({
      error: "Zion execution failed",
      details: err?.message ? err.message : String(err),
    });
  }
}
