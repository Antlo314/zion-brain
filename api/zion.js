/**
 * Zion API — V5 (Fast Capture / No Loop)
 * Contract:
 *  POST { message, session_id, turn, notes }
 *  -> { reply, next_question, capture_intent, turn, notes, model, build }
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const BUILD = "ZION_API_BUILD_2026-01-25_v5_FAST_CAPTURE_NO_LOOP_v2";
const MODEL = process.env.GEMINI_MODEL || "gemini-3-pro-preview";

// ---- CORS allowlist ----
const ALLOW_ORIGINS = [
  "https://lumenlabsatl.com",
  "https://www.lumenlabsatl.com",
  "https://app.lumenlabsatl.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

function setCors(res, origin) {
  const o = origin || "";
  const allow = ALLOW_ORIGINS.includes(o) ? o : "*";
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function isoNow() { return new Date().toISOString(); }
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
function clampInt(n, min, max) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}
function normalizeStr(s) { return (typeof s === "string" ? s : "").trim(); }

function ensureNotesShape(notesIn) {
  const notes = (notesIn && typeof notesIn === "object") ? notesIn : {};
  if (!Array.isArray(notes.transcript)) notes.transcript = [];
  if (!notes.stage) notes.stage = "primary_goal";
  if (!notes.last_updated_at) notes.last_updated_at = isoNow();
  notes.primary_goal = notes.primary_goal ?? "";
  notes.business_type = notes.business_type ?? "";
  notes.bottleneck = notes.bottleneck ?? "";
  notes.target_metric = notes.target_metric ?? "";
  return notes;
}

function isLowSignalAnswer(msg) {
  const m = normalizeStr(msg).toLowerCase();
  if (!m) return true;
  if (m.length <= 3) return true;
  const low = ["ok","okay","k","cool","sounds good","how","how?","yes","yep","no","nah","idk","not sure"];
  return low.includes(m);
}

function stageNext(stage) {
  const order = ["primary_goal", "business_type", "target_metric", "bottleneck"];
  const i = order.indexOf(stage);
  return order[Math.min(order.length - 1, i + 1)] || "bottleneck";
}

function shouldCapture(turn, notes) {
  if (notes.capture_locked === true) return true;
  if (turn >= 3) return true;

  const goal = normalizeStr(notes.primary_goal);
  const bottleneck = normalizeStr(notes.bottleneck);
  const target = normalizeStr(notes.target_metric);
  if (goal && (bottleneck || target) && turn >= 2) return true;

  return false;
}

function buildNextQuestion(stage) {
  switch (stage) {
    case "primary_goal":
      return "What’s your #1 goal for the next 30 days—leads, booked estimates, or signed contracts?";
    case "business_type":
      return "What type of business is this (industry + who you sell to)?";
    case "target_metric":
      return "What target would make this a win in 30 days (e.g., 20 leads, 10 bookings, $15k revenue)?";
    case "bottleneck":
    default:
      return "What’s the biggest bottleneck right now—traffic, conversion, follow-up, or fulfillment?";
  }
}

function buildReply(stage, message, notes) {
  const goal = normalizeStr(notes.primary_goal);
  const bt = normalizeStr(notes.business_type);
  const target = normalizeStr(notes.target_metric);
  const bottle = normalizeStr(notes.bottleneck);

  switch (stage) {
    case "primary_goal":
      return goal ? `Understood. Goal locked: ${goal}.` : "Understood. Let’s define the target.";
    case "business_type":
      return bt ? `Noted. ${bt}.` : "Understood. Let’s anchor the offer and audience.";
    case "target_metric":
      return target ? `Good. Target locked: ${target}.` : "Understood. We need a measurable target.";
    case "bottleneck":
    default:
      return bottle ? `Understood. Bottleneck noted: ${bottle}.` : "Understood. Identify the constraint so we can design the system.";
  }
}

function updateNotesFromUser(stage, message, notes) {
  const msg = normalizeStr(message);
  if (!msg) return notes;
  if (isLowSignalAnswer(msg)) return notes;

  if (stage === "primary_goal" && !normalizeStr(notes.primary_goal)) {
    notes.primary_goal = msg;
    notes.stage = stageNext(stage);
    return notes;
  }
  if (stage === "business_type" && !normalizeStr(notes.business_type)) {
    notes.business_type = msg;
    notes.stage = stageNext(stage);
    return notes;
  }
  if (stage === "target_metric" && !normalizeStr(notes.target_metric)) {
    notes.target_metric = msg;
    notes.stage = stageNext(stage);
    return notes;
  }
  if (stage === "bottleneck" && !normalizeStr(notes.bottleneck)) {
    notes.bottleneck = msg;
    notes.stage = "bottleneck";
    return notes;
  }

  notes.extra_context = (notes.extra_context ? notes.extra_context + "\n" : "") + msg;
  return notes;
}

async function polishWithGemini({ stage, reply, nextQuestion, notes }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { reply, nextQuestion };

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: MODEL });

  const system = [
    "You are Zion, executive intelligence for Lumen Labs.",
    "Return STRICT JSON only. No markdown. No code fences.",
    "Tone: calm, decisive, concise. Avoid repetitive questions.",
    "Do NOT say 'Received.'",
    "Do NOT re-ask a question that is already answered in notes.",
    "If the user response is low-signal (e.g., 'ok', 'how?'), restate the next_question sharply.",
    "Keep reply <= 2 short sentences."
  ].join(" ");

  const prompt = JSON.stringify({
    system,
    stage,
    raw_reply: reply,
    proposed_next_question: nextQuestion,
    notes_snapshot: {
      stage: notes.stage,
      primary_goal: notes.primary_goal,
      business_type: notes.business_type,
      target_metric: notes.target_metric,
      bottleneck: notes.bottleneck,
      extra_context: notes.extra_context || ""
    }
  });

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || "";
  const parsed = safeJsonParse(text);

  if (parsed && typeof parsed.reply === "string") {
    return {
      reply: (parsed.reply || reply).trim(),
      nextQuestion: (parsed.next_question || nextQuestion).trim()
    };
  }
  return { reply, nextQuestion };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  setCors(res, origin);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", message: "Zion API is live. Use POST.", model: MODEL, build: BUILD });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = (typeof req.body === "string") ? safeJsonParse(req.body) : req.body;
    const message = normalizeStr(body?.message);
    const session_id = normalizeStr(body?.session_id) || "anon";
    const inTurn = clampInt(body?.turn ?? 0, 0, 9999);
    const notes = ensureNotesShape(body?.notes);

    notes.transcript.push({ turn: inTurn, user: message, at: isoNow() });
    if (notes.transcript.length > 30) notes.transcript = notes.transcript.slice(-30);

    const currentStage = notes.stage || "primary_goal";
    updateNotesFromUser(currentStage, message, notes);

    const stage = notes.stage || currentStage;
    let reply = buildReply(stage, message, notes);
    let nextQuestion = buildNextQuestion(stage);

    if (isLowSignalAnswer(message)) {
      reply = "Understood. I need one concrete input to proceed.";
      nextQuestion = buildNextQuestion(stage);
    }

    const outTurn = inTurn + 1;
    let capture_intent = "none";

    if (shouldCapture(outTurn, notes)) {
      capture_intent = "ask_contact";
      notes.capture_locked = true;
      nextQuestion = "Open the intake form so I can generate your executive summary and tiers.";
      reply = "Understood. Open the intake so I can generate your executive summary and service tiers.";
    }

    notes.last_updated_at = isoNow();

    const polished = await polishWithGemini({ stage, reply, nextQuestion, notes });
    reply = polished.reply || reply;
    nextQuestion = polished.nextQuestion || nextQuestion;

    return res.status(200).json({
      reply,
      next_question: nextQuestion,
      capture_intent,
      turn: outTurn,
      notes,
      model: MODEL,
      build: BUILD
    });
  } catch {
    return res.status(500).json({
      reply: "System unstable. Try again in a moment.",
      next_question: "What is your #1 goal for the next 30 days?",
      capture_intent: "none",
      turn: 1,
      notes: { transcript: [], last_updated_at: isoNow(), stage: "primary_goal" },
      model: MODEL,
      build: BUILD
    });
  }
}
