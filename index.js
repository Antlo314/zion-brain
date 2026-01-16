import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Health check (kills placeholder)
 */
app.get("/", (req, res) => {
  res.status(200).send("Zion brain online");
});

/**
 * Main chat endpoint
 * Receives: { message, session_id }
 * Returns: { reply }
 */
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
    });

    const result = await model.generateContent(message);
    const reply = result.response.text();

    res.json({
      reply,
    });
  } catch (err) {
    console.error("Zion error:", err);
    res.status(500).json({ error: "Zion failed to respond" });
  }
});

/**
 * Cloud Run REQUIRED listener
 */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Zion listening on port ${PORT}`);
});
