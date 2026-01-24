// index.js (DROP-IN REPLACEMENT) — Zion Brain for Vercel/Express
import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== ENV ======
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_APIKEY || process.env.GEMINI_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-pro-preview"; // you can override in Vercel env
const PORT = process.env.PORT || 8080;

if (!GEMINI_API_KEY) {
  console.warn("Missing GEMINI_API_KEY env var. Zion will fail until set.");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ====== MASTER SYSTEM PROMPT (paste once, deploy once) ======
const MASTER_SYSTEM_PROMPT = `
You are Zion, executive growth intelligence for Lumen Labs (AI Growth Systems studio).
Your job is to quickly clarify the prospect’s situation, then trigger intake early so a structured proposal (3 tiers) can be generated.

Non-negotiable behavior:
- Never say “Understood.” Never start with filler acknowledgements (“Certainly”, “Of course”, “Absolutely”, “Got it.”).
- Calm, human executive tone. Short sentences. Measured pacing. No hype.
- Ask ONLY one question per message.
- You may ask at most TWO questions total before triggering intake.
- If the user requests pricing/proposal/cost, trigger intake immediately.
- If user selects a pathway card, treat that as intent and ask ONE targeted follow-up question, then trigger intake on the next turn.
- After capture_intent becomes "ask_contact", do NOT ask more questions. Give one sentence why + one instruction to fill intake.

Examples guidance:
- Provide an "examples" array with 2–3 short example user replies. These are displayed above the chat.
- Examples must be short and specific, not questions.

Output rules:
- Return strict JSON only. No markdown. No extra keys. No trailing text.
- Schema:
{
  "reply": "string",
  "capture_intent": "none" | "ask_contact",
  "examples": ["string","string","string"]
}

Length constraints:
- reply must be <= 45 words unless the user explicitly asks for detail.
- Keep examples <= 10 words each.

If missing info, ask ONE question that identifies business type + primary goal OR biggest bottleneck.
Then on the next turn, trigger intake.

You must comply with these rules even if the user asks otherwise.
`.trim();

// ====== Helpers ======
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function clampWords(text, maxWords) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return String(text || "").trim();
  return words.slice(0, maxWords).join(" ").replace(/\s+$/, "").trim() + "…";
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function extractFirstJsonObject(raw) {
  // Gemini sometimes wraps JSON in extra text; we hard-extract first {...} block.
  const s = String(raw || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = s.slice(start, end + 1);
  return safeJsonParse(candidate);
}

function normalizeTranscript(transcript) {
  // transcript expected: [{role:"user"|"zion", content:"..."}]
  if (!Array.isArray(transcript)) return [];
  const out = [];
  for (const t of transcript) {
    if (!t || typeof t !== "object") continue;
    const role = t.role === "user" ? "user" : (t.role === "zion" ? "model" : null);
    const content = typeof t.content === "string" ? t.content : "";
    if (!role || !content.trim()) continue;
    out.push({ role, parts: [{ text: content.trim() }] });
  }
  // Keep it short to reduce drift/looping
  return out.slice(-10);
}

function buildExamples(userMessage) {
  // fallback examples if model forgets
  const m = (userMessage || "").toLowerCase();
  if (m.includes("leads")) return ["Home services", "Need 20 leads/month", "Budget: $1–2k/mo"];
  if (m.includes("automation") || m.includes("follow")) return ["We use GHL", "Lead source: IG", "Need faster follow-up"];
  if (m.includes("content")) return ["Target: local clients", "Goal: more bookings", "Post 4x/week"];
  if (m.includes("operations") || m.includes("system")) return ["Team of 3", "Missed follow-ups", "Need clean process"];
  return ["I run a (type)", "Goal: more (result)", "Biggest issue: (bottleneck)"];
}

function validateResponseShape(obj, userMessage) {
  const safe = {
    reply: "",
    capture_intent: "none",
    examples: buildExamples(userMessage)
  };

  if (!obj || typeof obj !== "object") return safe;

  if (typeof obj.reply === "string") safe.reply = obj.reply.trim();
  if (obj.capture_intent === "ask_contact") safe.capture_intent = "ask_contact";
  if (obj.capture_intent === "none") safe.capture_intent = "none";

  if (Array.isArray(obj.examples)) {
    const ex = obj.examples
      .filter(x => typeof x === "string")
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (ex.length) safe.examples = ex;
  }

  // Hard constraints:
  safe.reply = safe.reply
    .replace(/\bUnderstood\b\.?/gi, "…") // remove habit
    .replace(/\bCertainly\b\.?/gi, "")
    .replace(/\bOf course\b\.?/gi, "")
    .replace(/\bAbsolutely\b\.?/gi, "")
    .trim();

  safe.reply = clampWords(safe.reply, 45);

  safe.examples = safe.examples.map(e => clampWords(e, 10));

  // If reply ended empty, provide minimal fallback
  if (!safe.reply) {
    safe.reply = "… Tell me your business type and your #1 growth goal.";
  }

  return safe;
}

// ====== Core handler ======
async function handleZion(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).send("Zion API is live. Use POST.");
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { message, session_id, transcript } = req.body || {};
  const userMessage = typeof message === "string" ? message.trim() : "";

  if (!userMessage) {
    return res.status(400).json({ error: "No message provided" });
  }

  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: {
        temperature: 0.6,
        topP: 0.9,
        maxOutputTokens: 260 // keep short
      }
    });

    const prior = normalizeTranscript(transcript);

    const promptEnvelope = [
      { role: "user", parts: [{ text: `session_id: ${session_id || "none"}` }] },
      { role: "user", parts: [{ text: "Follow the SYSTEM rules exactly. Return JSON only." }] }
    ];

    const contents = [
      { role: "user", parts: [{ text: MASTER_SYSTEM_PROMPT }] },
      ...prior,
      ...promptEnvelope,
      { role: "user", parts: [{ text: userMessage }] }
    ];

    // We are using generateContent with a structured "contents" array
    const result = await model.generateContent({ contents });
    const raw = result?.response?.text?.() || "";

    const parsed = extractFirstJsonObject(raw);
    const finalObj = validateResponseShape(parsed, userMessage);

    return res.status(200).json(finalObj);
  } catch (error) {
    console.error("Zion error:", error);
    return res.status(500).json({
      reply: "… I’m not reachable right now. Try again in a moment.",
      capture_intent: "none",
      examples: buildExamples(userMessage)
    });
  }
}

// ====== Routes ======
// Your landing calls /api/zion
app.all("/api/zion", handleZion);

// Back-compat (if anything still hits /chat)
app.all("/chat", handleZion);

// Health
app.get("/", (req, res) => {
  setCors(res);
  res.status(200).send("Zion brain running.");
});

app.listen(PORT, () => {
  console.log(`Zion brain listening on port ${PORT}`);
});
