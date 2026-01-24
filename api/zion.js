import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(200).send("Zion API is live. Use POST.");
  }

  try {
    const { message, turns = 0 } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: "No message provided" });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-3-pro-preview
",
      systemInstruction: process.env.ZION_SYSTEM_PROMPT
    });

    const result = await model.generateContent(message);
    const text = result?.response?.text?.() || "";

    // Default UI behavior
    let ui_action = "none";

    // Deterministic intake trigger after 2–3 turns
    if (turns >= 2) {
      ui_action = "open_intake";
    }

    return res.status(200).json({
      reply: text,
      placeholder: "",
      ui_action
    });

  } catch (err) {
    return res.status(500).json({
      error: "Zion failed",
      details: err.message
    });
  }
}
