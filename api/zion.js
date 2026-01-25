import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = { runtime: "nodejs" };

const MODEL = "gemini-3-pro-preview";

// Hard contract validator: never allow anything else back to the client
function coerceToContract(raw) {
  const out = {
    reply: "",
    next_question: "",
    capture_intent: "none",
  };

  try {
    if (typeof raw === "string") {
      // try parse if it's JSON string
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
  if (!out.capture_intent) out.capture_intent = "none";

  return out;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        status: "ok",
        message: "Zion API is live. Use POST.",
        model: MODEL,
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
      try { body = JSON.parse(body); } catch {}
    }

    const message = body?.message || "";
    const session_id = body?.session_id || "anon";
    const transcript = body?.transcript || ""; // optional: pass prior turns if you want

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
- Prefer early capture when intent is commercial (business, brand, website, automation, SEO, leads, ads, CRM, operations).
- Keep tone calm, executive, concise.
- If you set capture_intent to "ask_contact", next_question should ask for name + email + phone in one prompt.
- Never output markdown. Never add extra keys. Never wrap in code fences.
`;

    const userPayload = `
session_id: ${session_id}
prior_context: ${transcript ? transcript : "(none)"}
user_message: ${message}
`;

    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
        { role: "user", parts: [{ text: userPayload }] },
      ],
    });

    const text =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      result?.response?.text?.() ||
      "";

    // Enforce JSON-only
    let parsed;
    try {
      // strip accidental leading/trailing text
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const jsonSlice = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;
      parsed = JSON.parse(jsonSlice);
    } catch {
      parsed = { reply: text || "Understood.", next_question: "What are you trying to achieve in the next 30 days?", capture_intent: "none" };
    }

    const contract = coerceToContract(parsed);
    return res.status(200).json(contract);
  } catch (err) {
    console.error("ZION API ERROR:", err);
    return res.status(500).json({
      error: "Zion execution failed",
      details: err?.message ? err.message : String(err),
    });
  }
}
