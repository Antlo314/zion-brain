/**
 * /api/zion.js — Vercel Serverless Function
 * Contract:
 * {
 *   reply: "string",
 *   next_question: "string",
 *   capture_intent: "none" | "ask_contact"
 * }
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const BUILD = "ZION_API_BUILD_2026-01-25_JSON_MODE_SCHEMA_v2_COMPAT";
const COMMIT =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_GITHUB_COMMIT_SHA ||
  "unknown";

const MODEL = (process.env.GEMINI_MODEL || "gemini-3-pro-preview").trim();
const API_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `
You are ZION — the executive intelligence for Lumen Labs, an AI growth systems studio.

Positioning:
- Lumen Labs builds AI-powered marketing, automation, and growth systems.
Tone:
- Calm, executive, precise. No hype.

Hard rules:
1) Ask a maximum of THREE questions total before requesting contact details.
2) If the user expresses business intent (growth, leads, website, automation, systems, pricing, launching), trigger capture_intent="ask_contact" by question 1–2.
3) Questions must be short and high-signal.

Output MUST be JSON only. No markdown, no code fences.

You must output exactly this schema:
{
  "reply": "string",
  "next_question": "string",
  "capture_intent": "none | ask_contact"
}
`.trim();

// Compatible JSON schema for responseSchema (no additionalProperties)
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    next_question: { type: "string" },
    capture_intent: { type: "string", enum: ["none", "ask_contact"] },
  },
  required: ["reply", "next_question", "capture_intent"],
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  if (req.body && typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }

  const raw = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function json(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(obj);
}

function coerceToContract(obj) {
  const reply = typeof obj?.reply === "string" ? obj.reply : "Understood.";
  const next_question =
    typeof obj?.next_question === "string"
      ? obj.next_question
      : "What outcome are you trying to achieve?";
  const capture_intent =
    obj?.capture_intent === "ask_contact" ? "ask_contact" : "none";

  return { reply, next_question, capture_intent };
}

async function runZion(userMessage) {
  if (!API_KEY) {
    return {
      reply: "Zion is live, but GEMINI_API_KEY is missing in Vercel env.",
      next_question: "Do you want to run in diagnostic mode?",
      capture_intent: "none",
    };
  }

  const genAI = new GoogleGenerativeAI(API_KEY);

  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.4,
      maxOutputTokens: 500,
    },
  });

  const prompt = `User message:\n${userMessage}`;

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() ?? "";

  try {
    const parsed = JSON.parse(text);
    return coerceToContract(parsed);
  } catch {
    return {
      reply:
        "I received your message, but the model output was not valid JSON. Re-issue your last message.",
      next_question: "What outcome are you trying to achieve?",
      capture_intent: "none",
    };
  }
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

  res.setHeader("X-Zion-HasBody", body ? "1" : "0");
  res.setHeader("X-Zion-HasMessage", body?.message ? "1" : "0");

  if (!body) return json(res, 400, { error: "Invalid JSON body", build: BUILD });

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json(res, 400, { error: "Missing message", build: BUILD });

  try {
    const out = await runZion(message);
    return json(res, 200, { ...out, model: MODEL, build: BUILD });
  } catch (err) {
    return json(res, 500, {
      error: "Zion runtime error",
      build: BUILD,
      details: err?.message || String(err),
    });
  }
}


