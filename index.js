import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

// Cloud Run + browsers
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.status(200).send("Zion Brain is online.");
});

// Health endpoint (nice for debugging)
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * POST /chat
 * Body: { "message": "..." }
 * Uses Cloud Run env vars:
 * - GEMINI_API_KEY
 * - GEMINI_MODEL (optional, default: gemini-1.5-flash)
 */
app.post("/chat", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const modelName = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    const message = (req.body?.message || "").toString().trim();

    if (!apiKey) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY env var in Cloud Run." });
    }
    if (!message) {
      return res.status(400).json({ error: "Missing message." });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = [
      "You are Zion, the Lumen Labs Autonomous Growth Engine.",
      "Be concise, confident, and practical.",
      "If the user asks what services you provide, answer with Lumen Labs offerings and suggest the best next step.",
      "",
      `User: ${message}`,
      "Zion:"
    ].join("\n");

    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.() || "";

    return res.status(200).json({ reply: text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
});

// IMPORTANT: must listen on Cloud Run's PORT
const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`Zion Brain listening on port ${port}`);
});
