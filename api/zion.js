// /api/zion.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();

  // Simple health message for browser hits
  if (req.method !== "POST") {
    return res.status(200).send("Zion API is live. Use POST.");
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Missing GEMINI_API_KEY in Vercel Environment Variables (Production)."
      });
    }

    const { message, session_id, transcript, system_prompt } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "No message provided" });
    }

    const SYSTEM_PROMPT =
      (typeof system_prompt === "string" && system_prompt.trim()) ||
      process.env.ZION_SYSTEM_PROMPT ||
      `You are Zion, executive intelligence for Lumen Labs.
Return STRICT JSON ONLY (no markdown, no fences) in the format:
{"reply":"string","next_question":"string","capture_intent":"none|ask_contact"}

Rules:
- Keep replies concise (1–2 sentences).
- Ask at most ONE question at a time.
- If the user shows buying intent or needs help, ask for contact early (capture_intent:"ask_contact").
`;

    const genAI = new GoogleGenerativeAI(apiKey);

    // Canonical model: gemini-3-pro-preview
    const model = genAI.getGenerativeModel({
      model: "gemini-3-pro-preview",
      systemInstruction: SYSTEM_PROMPT
    });

    // Build a compact context string (optional)
    const contextBits = [];
    if (session_id) contextBits.push(`session_id: ${session_id}`);
    if (Array.isArray(transcript) && transcript.length) {
      // keep it short to avoid token bloat
      const last = transcript.slice(-8).map((t) => {
        const role = t?.role || "user";
        const content = (t?.content || "").toString().slice(0, 600);
        return `${role.toUpperCase()}: ${content}`;
      });
      contextBits.push(last.join("\n"));
    }

    const prompt = contextBits.length
      ? `${contextBits.join("\n\n")}\n\nUSER: ${message}`
      : `USER: ${message}`;

    const result = await model.generateContent(prompt);
    const raw = result?.response?.text?.() || "";

    // Enforce JSON-only: try to parse; if model returns extra text, extract JSON
    let parsed = safeJsonParse(raw);

    if (!parsed) {
      // Attempt to extract first {...} block
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = safeJsonParse(m[0]);
    }

    if (!parsed || typeof parsed !== "object") {
      return res.status(200).json({
        reply: raw.trim().slice(0, 1200) || "Understood. What are you trying to improve first?",
        next_question: "What’s the main bottleneck right now—leads, follow-up, or operations?",
        capture_intent: "none",
        _warn: "Model did not return valid JSON; returned fallback structure."
      });
    }

    // Normalize shape
    const reply = typeof parsed.reply === "string" ? parsed.reply : "";
    const next_question = typeof parsed.next_question === "string" ? parsed.next_question : "";
    const capture_intent =
      parsed.capture_intent === "ask_contact" ? "ask_contact" : "none";

    return res.status(200).json({ reply, next_question, capture_intent });
  } catch (err) {
    console.error("Zion function crash:", err);
    return res.status(500).json({
      error: "Zion serverless crashed",
      details: err?.message || String(err)
    });
  }
};
