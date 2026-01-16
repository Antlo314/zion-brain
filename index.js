import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json());

// Health check / test route
app.get("/", (req, res) => {
  res.send("Zion Brain is online.");
});

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post("/ask", async (req, res) => {
  try {
    const { prompt } = req.body;

    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
    });

    const result = await model.generateContent(prompt);
    const response = result.response.text();

    res.json({ reply: response });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Zion encountered an error" });
  }
});

// IMPORTANT PART (this is what was missing)
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Zion Brain listening on port ${PORT}`);
});
