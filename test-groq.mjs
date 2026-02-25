import dotenv from "dotenv";
dotenv.config();
const key = process.env.GROQ_API_KEY;
console.log(
  "Key prefix:",
  key ? key.slice(0, 12) + "... length=" + key.length : "MISSING",
);
const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10,
  }),
});
const d = await r.json();
console.log("HTTP Status:", r.status);
console.log(
  "Response:",
  JSON.stringify(d.choices?.[0]?.message ?? d.error, null, 2),
);
