/**
 * /api/zion.js — Vercel Serverless Function (Node)
 *
 * Deterministic 2–3 Question Gate (no model JSON parsing).
 * Server controls capture timing based on turn count.
 *
 * Expected POST body:
 * {
 *   "message": "string",
 *   "session_id": "string",
 *   "turn": number,              // 0,1,2,3...
 *   "notes": { ... }             // persisted by client between calls
 * }
 *
 * Response:
 * {
 *   "reply": "string",
 *   "next_question": "string",
 *   "capture_intent": "none" | "ask_contact",
 *   "turn": number,
 *   "notes": { ... },            // updated notes to store client-side
 *   "model": "string",
 *   "build": "string"
 * }
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const BUILD = "ZION_API_BUILD_2026-01-25_v5_DETERMINISTIC_QA_GATE";
const COMMIT =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_GITHUB_COMMIT_SHA ||
  "unknown";

const MODEL = (process.env.GEMINI_MODEL || "gemini-3-pro-preview").trim();
const API_KEY = process.env.GEMINI_API_KEY;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  if (req.body && typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }

  const raw = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function json(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(obj);
}

/**
 * Deterministic questions (high-signal, minimal).
 * You can swap these without touching other logic.
 */
const QUESTIONS = [
  "What’s the business and primary offer?",
  "What’s the #1 goal for the next 30 days (leads, sales, bookings, brand)?",
  "What’s your current setup—website/CRM/ads—and what’s the main bottleneck?",
];

/**
 * Update notes deterministically by turn.
 * This is what you will save into GHL Notes before capture.
 */
function updateNotes(notes, turn, userMessage) {
  const n = notes && typeof notes === "object" ? { ...notes } : {};
  const ts = new Date().toISOString();

  n.transcript = Array.isArray(n.transcript) ? n.transcript : [];
  n.transcript.push({ turn, user: userMessage, at: ts });

  // Store answers mapped to the question asked at that turn (0->Q1, 1->Q2, 2->Q3)
  if (turn === 0) n.business_offer = userMessage;
  if (turn === 1) n.goal_30_days = userMessage;
  if (turn === 2) n.current_stack_bottleneck = userMessage;

  n.last_updated_at = ts;
  return n;
}

/**
 * Optional: use Gemini for the "reply" only (not for structure).
 * This avoids JSON parsing failures entirely.
 */
async function generateReply(userMessage, nextQuestion) {
  if (!API_KEY) {
    return `Received. ${nextQuestion}`;
  }

  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: `
You are Zion, executive intelligence for Lumen Labs.
Write a brief, calm acknowledgment (1 sentence max) and DO NOT ask any question.
No markdown.
`.trim(),
    generationConfig: { temperature: 0.4, maxOutputTokens: 80 },
  });

  const prompt = `User said: "${userMessage}"\nReturn ONE short acknowledgment sentence.`;
  const result = await model.generateContent(prompt);
  const ack = (result?.response?.text?.() || "Received.").trim();

  // Ensure it doesn't ask a question
  const cleaned = ack.replace(/\?+$/g, ".").trim();
  return cleaned;
}

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
  if (!body) return json(res, 400, { error: "Invalid JSON body", build: BUILD });

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const session_id =
    typeof body.session_id === "string" && body.session_id.trim()
      ? body.session_id.trim()
      : null;
  const turn = Number.isFinite(body.turn) ? Number(body.turn) : 0;
  const notesIn = body.notes;

  if (!message) return json(res, 400, { error: "Missing message", build: BUILD });
  if (!session_id)
    return json(res, 400, { error: "Missing session_id", build: BUILD });

  // Update notes with the user's answer for the current turn
  const notes = updateNotes(notesIn, turn, message);

  // Determine next question + capture timing deterministically
  const nextTurn = turn + 1;

  // Gate: ask 2–3 questions before capture
  // - Ask Q1 at start (turn 0 answer received -> serve Q2)
  // - Ask Q2 (turn 1 -> serve Q3)
  // - After Q3 answer (turn 2), trigger capture
  const shouldCapture = nextTurn >= 3;

  const next_question = shouldCapture
    ? "Understood. What’s the best email and phone number to reach you?"
    : QUESTIONS[Math.min(nextTurn, QUESTIONS.length - 1)];

  const replyAck = await generateReply(message, next_question);

  return json(res, 200, {
    reply: replyAck,
    next_question,
    capture_intent: shouldCapture ? "ask_contact" : "none",
    // pass state back to client
    turn: nextTurn,
    notes,
    model: MODEL,
    build: BUILD,
  });
}
