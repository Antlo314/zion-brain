/**
 * /api/zion.js  (Vercel Serverless Function)
 *
 * Zion v5 — deterministic QA gate + Gemini 3 Pro preview
 * Contract:
 *   Request: { message, session_id, turn, notes }
 *   Response: {
 *     reply, next_question, capture_intent, turn, notes,
 *     model, build
 *   }
 *
 * Notes are an OBJECT (not an array), persisted client-side in localStorage and round-tripped.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const BUILD = "ZION_API_BUILD_2026-01-25_v5_DETERMINISTIC_QA_GATE";
const MODEL = process.env.GEMINI_MODEL || "gemini-3-pro-preview";
const API_KEY = process.env.GEMINI_API_KEY;

// CORS: allow all origins for now (tighten later if needed)
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// Safe JSON helper
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Normalize notes object shape
function normalizeNotes(notes) {
  let n = notes;
  if (!n || typeof n !== "object" || Array.isArray(n)) n = {};
  if (!Array.isArray(n.transcript)) n.transcript = [];
  if (typeof n.last_updated_at !== "string") n.last_updated_at = new Date().toISOString();
  if (typeof n.stage !== "string") n.stage = ""; // optional “state machine” stage
  // optional slots
  if (typeof n.business_offer !== "string") n.business_offer = "";
  if (typeof n.primary_goal !== "string") n.primary_goal = "";
  if (typeof n.bottleneck !== "string") n.bottleneck = "";
  return n;
}

// Condense transcript if it gets too large
function pruneTranscript(t, maxItems = 18) {
  if (!Array.isArray(t)) return [];
  return t.slice(-maxItems);
}

// Basic heuristic extraction (keeps system deterministic even if model is flaky)
function maybeExtractSlots(notes, userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return notes;

  // Simple slot fills if empty:
  // - If user clearly answers goal question
  const lower = msg.toLowerCase();

  if (!notes.business_offer) {
    // If first message, treat as business/offer seed
    notes.business_offer = msg.slice(0, 280);
  } else if (!notes.primary_goal) {
    // If they mention leads/sales/bookings/brand explicitly, capture as goal
    if (/(lead|leads|sale|sales|book|booking|appointments|brand|visibility|seo)/i.test(msg)) {
      notes.primary_goal = msg.slice(0, 240);
    }
  } else if (!notes.bottleneck) {
    // Common bottleneck markers
    if (/(no time|inconsistent|follow[- ]?up|automation|content|traffic|ads|website|system|process|crm|pipeline)/i.test(lower) || msg.length >= 8) {
      notes.bottleneck = msg.slice(0, 300);
    }
  }

  return notes;
}

// Determine next question + capture intent
function nextStep(notes) {
  // Ask only a few questions, then capture.
  // Stage order: business_offer -> primary_goal -> bottleneck -> capture
  if (!notes.business_offer || notes.business_offer.trim().length < 3) {
    return {
      capture_intent: "none",
      next_question: "What do you sell, and who do you sell it to? (One sentence.)",
      stage: "business_offer"
    };
  }

  if (!notes.primary_goal || notes.primary_goal.trim().length < 3) {
    return {
      capture_intent: "none",
      next_question: "What’s the #1 goal for the next 30 days (leads, sales, bookings, brand)?",
      stage: "primary_goal"
    };
  }

  if (!notes.bottleneck || notes.bottleneck.trim().length < 3) {
    return {
      capture_intent: "none",
      next_question: "What’s the main constraint right now—traffic, conversion, follow-up, or delivery?",
      stage: "bottleneck"
    };
  }

  // After 3 questions (or once we have enough), trigger intake capture
  return {
    capture_intent: "ask_contact",
    next_question: "I can price this precisely. Open the intake so I can generate your executive summary and tiers?",
    stage: "capture"
  };
}

// System prompt for Gemini — JSON only, executive tone, no marketing fluff
function systemPrompt() {
  return [
    "You are Zion — an executive intelligence for Lumen Labs (AI growth systems studio).",
    "You speak with calm, concise, high-agency executive tone.",
    "Primary task: guide a prospect to clarify business_offer, primary_goal (30 days), and bottleneck.",
    "Ask at most ONE question per turn. No multi-question lists.",
    "After you have enough, set capture_intent to ask_contact.",
    "",
    "Output STRICT JSON ONLY with keys:",
    `{"reply":"string","next_question":"string","capture_intent":"none|ask_contact"}`,
    "No markdown. No code fences. No extra keys."
  ].join("\n");
}

async function geminiRespond({ message, notes, step }) {
  if (!API_KEY) {
    // Hard fallback if key is missing
    return {
      reply: "I’m online, but the model key is missing. I can still run deterministic intake.",
      next_question: step.next_question,
      capture_intent: step.capture_intent
    };
  }

  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: systemPrompt()
  });

  // Keep it tight: provide state + user message + the intended next question
  const state = {
    business_offer: notes.business_offer || "",
    primary_goal: notes.primary_goal || "",
    bottleneck: notes.bottleneck || "",
    transcript_tail: (notes.transcript || []).slice(-6)
  };

  const user = String(message || "").trim();

  const prompt = [
    "STATE (authoritative):",
    JSON.stringify(state),
    "",
    "USER MESSAGE:",
    user,
    "",
    "INTENDED NEXT QUESTION (must be consistent unless user already answered it):",
    step.next_question,
    "",
    "Respond with JSON only."
  ].join("\n");

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || "";
  const parsed = safeJsonParse(text);

  if (!parsed || typeof parsed.reply !== "string") {
    // If Gemini fails JSON, fall back deterministically
    return {
      reply: "Understood.",
      next_question: step.next_question,
      capture_intent: step.capture_intent
    };
  }

  // Coerce contract
  const reply = String(parsed.reply || "").trim();
  const next_question = String(parsed.next_question || "").trim() || step.next_question;
  const capture_intent =
    parsed.capture_intent === "ask_contact" ? "ask_contact" : step.capture_intent;

  return { reply, next_question, capture_intent };
}

// IMPORTANT FIX: never allow "Received." to be the visible reply
function normalizeAckReply(reply, next_question) {
  const ackRe = /^(received\.?|ok\.?|noted\.?|got it\.?|roger\.?)$/i;
  const r = String(reply || "").trim();
  const nq = String(next_question || "").trim();
  if (ackRe.test(r) && nq) return `Understood.\n\n${nq}`;
  return r || nq || "Understood.";
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed", build: BUILD });
  }

  const body = req.body || {};
  const message = String(body.message || "").trim();
  const session_id = String(body.session_id || "").trim();
  const turnIn = Number(body.turn || 0);

  // notes is an object, round-tripped
  let notes = normalizeNotes(body.notes);

  // Transcript append (always)
  if (message) {
    notes.transcript = pruneTranscript([
      ...notes.transcript,
      { turn: Math.max(0, turnIn), user: message, at: new Date().toISOString() }
    ]);
  }

  // Deterministic slot fill (helps keep the flow stable)
  notes = maybeExtractSlots(notes, message);
  notes.last_updated_at = new Date().toISOString();

  // Decide next step
  const step = nextStep(notes);
  notes.stage = step.stage;

  // Generate response (Gemini, with deterministic fallback)
  let out;
  try {
    out = await geminiRespond({ message, notes, step });
  } catch {
    out = {
      reply: "Understood.",
      next_question: step.next_question,
      capture_intent: step.capture_intent
    };
  }

  // Apply the ACK normalization fix (this is the key for your issue)
  const fixedReply = normalizeAckReply(out.reply, out.next_question);

  // turn increments server-side for returned state
  const turnOut = Math.max(0, Math.floor(Number.isFinite(turnIn) ? turnIn : 0)) + 1;

  return res.status(200).json({
    reply: fixedReply,
    next_question: String(out.next_question || "").trim(),
    capture_intent: out.capture_intent === "ask_contact" ? "ask_contact" : "none",
    turn: turnOut,
    notes,
    model: MODEL,
    build: BUILD
  });
}

