import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL = "gemini-3-pro-preview";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(200).send("Zion API is live. Use POST.");
  }

  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "No message provided" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Missing GEMINI_API_KEY in Vercel environment variables",
      });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: MODEL });

    const result = await model.generateContent(message);
    const text = result?.response?.text?.() || "";

    return res.status(200).json({
      ok: true,
      model: MODEL,
      reply: text,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Zion failed",
      details: err?.message || String(err),
    });
  }
}

