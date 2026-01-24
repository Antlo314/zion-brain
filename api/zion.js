import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
  runtime: "nodejs",
};

const MODEL = "gemini-3-pro-preview";

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
      throw new Error("Missing GEMINI_API_KEY");
    }

    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const userMessage = body?.message;
    if (!userMessage) {
      return res.status(400).json({ error: "Missing message" });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const model = genAI.getGenerativeModel({
      model: MODEL,
    });

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: userMessage }],
        },
      ],
    });

    const text =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No response generated.";

    return res.status(200).json({
      reply: text,
      model: MODEL,
    });
  } catch (err) {
    console.error("ZION API ERROR:", err);

    return res.status(500).json({
      error: "Zion execution failed",
      details: err.message,
    });
  }
}
