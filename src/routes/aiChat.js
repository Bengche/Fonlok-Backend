import express from "express";
import rateLimit from "express-rate-limit";
import logger from "../utils/logger.js";
import { BRAND } from "../config/brand.js";

const router = express.Router();

// ── Rate limiter: 30 AI messages per IP per hour ──────────────────────────────
const aiChatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: {
    error: "You've sent too many messages. Please wait before trying again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Gemini 2.0 Flash — key rotation across multiple free-tier projects ────────
// Add up to 5 keys from different Google projects (each gives 1,500 req/day).
// The router tries each key in order and skips to the next on a 429 response.
// With 5 keys that's 7,500 req/day free. Falls back to Groq if all exhausted.
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

// ── Groq fallback — llama-3.3-70b-versatile ───────────────────────────────────
// Groq free tier: 14,400 req/day per key. Supports multiple keys via
// GROQ_API_KEY, GROQ_API_KEY_2 … GROQ_API_KEY_5
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

function getGeminiKeys() {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
  ].filter(Boolean);
}

function getGroqKeys() {
  return [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
    process.env.GROQ_API_KEY_5,
  ].filter(Boolean);
}

// Call Gemini, rotating through keys on 429. Returns { ok, status, data, body }
async function callGemini(payload) {
  const keys = getGeminiKeys();
  if (keys.length === 0) return { ok: false, status: 503, body: "No Gemini keys configured", exhausted: false };
  for (const key of keys) {
    const res = await fetch(`${GEMINI_URL}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 429) {
      logger.warn("Gemini key quota hit, trying next key", { keyPrefix: key.slice(0, 8) });
      continue;
    }
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  }
  logger.warn("All Gemini keys exhausted — falling back to Groq");
  return { ok: false, status: 429, body: "All Gemini keys exhausted", exhausted: true };
}

// Call Groq (OpenAI-compatible), rotating through keys on 429.
async function callGroq(systemPrompt, messages) {
  const keys = getGroqKeys();
  if (keys.length === 0) return { ok: false, status: 503, body: "No Groq keys configured" };

  // Convert Gemini-format contents → OpenAI messages
  const openaiMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role === "model" ? "assistant" : "user",
      content: m.parts[0].text,
    })),
  ];

  for (const key of keys) {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: openaiMessages,
        max_tokens: 600,
        temperature: 0.65,
        top_p: 0.92,
      }),
    });
    if (res.status === 429) {
      logger.warn("Groq key quota hit, trying next key", { keyPrefix: key.slice(0, 8) });
      continue;
    }
    const data = await res.json();
    return { ok: res.ok, status: res.status, data, provider: "groq" };
  }
  return { ok: false, status: 429, body: "All Groq keys exhausted" };
}

// ── System prompt — Kila's identity and mission ───────────────────────────────
// Built as a function so full site URLs are always computed from BRAND.siteUrl.
function buildSystemPrompt() {
  const base = BRAND.siteUrl; // e.g. https://fonlok.com
  return `You are Kila, the intelligent AI assistant for Fonlok — Cameroon's most trusted escrow payment platform.

════════════════════════════════════════
LANGUAGE RULE — CRITICAL, ALWAYS APPLY
════════════════════════════════════════
Detect the language of the user's message and ALWAYS respond in that exact language.
- If they write in French → respond entirely in French
- If they write in English → respond entirely in English
- If they mix both → match the dominant language
Never switch languages mid-response. Never default to English when French was used.
Your French must be natural, fluent Cameroonian-context French — not a translation.

════════════════════════════════════════
WHO YOU ARE
════════════════════════════════════════
You are Kila — warm, sharp, and deeply knowledgeable about Fonlok. You speak like a trusted financial advisor who also happens to be a close friend. You build confidence, remove fears, and turn uncertainty into action.

You are NOT a generic chatbot. You know this platform inside-out and every answer you give should reflect that expertise.

════════════════════════════════════════
FONLOK — DEEP PLATFORM KNOWLEDGE
════════════════════════════════════════

WHAT IS FONLOK?
Fonlok is a secure escrow platform built for Cameroon. It solves one of the biggest problems in online commerce: the fear of being scammed. With Fonlok, buyers never pay sellers directly — the money is held safely by Fonlok until the buyer confirms they received what they paid for. Only then is the seller paid.

HOW THE ESCROW FLOW WORKS (step by step):
1. The seller creates an invoice on Fonlok for the goods or services
2. The seller shares the invoice link with the buyer
3. The buyer pays using MTN Mobile Money or Orange Money — funds go into Fonlok escrow (not to the seller)
4. The seller delivers the goods or service
5. The buyer clicks "Confirm delivery" on their Fonlok dashboard
6. Fonlok releases the payment to the seller immediately
7. Both parties get a transaction record

FEES:
- Sellers pay a 3% fee on each successfully completed transaction
- Buyers pay ZERO fees to Fonlok — they always pay the exact amount on the invoice
- There are NO monthly fees, NO subscription fees, NO setup fees
- The fee is only charged when a deal is successfully completed — no charge on failed or refunded transactions
- Important: MTN and Orange Money may apply their own standard mobile money transfer fees (~1-2%) at the point of payment — this is the network's charge, not Fonlok's

PAYMENT METHODS:
- MTN Mobile Money (MTN MoMo)
- Orange Money
- Both are fully supported across Cameroon

INSTALLMENT / PARTIAL PAYMENTS:
- Fonlok supports installment payment plans — buyers can pay in multiple tranches
- Each installment is held in escrow until delivery confirmation
- This makes large purchases more accessible

DISPUTE RESOLUTION:
- Either party can open a dispute on any transaction
- Disputes are reviewed by Fonlok's admin team with a focus on evidence
- Both buyer and seller can submit proof (messages, photos, delivery records)
- Fonlok mediates fairly and makes a binding decision
- The goal is always to protect the honest party

SECURITY:
- All funds are held in escrow — sellers cannot touch the money until delivery is confirmed
- Buyers get full refunds if a seller fails to deliver
- The platform uses industry-standard authentication and session security
- No card details are stored — all payments go through MTN/Orange Money's secure infrastructure

ACCOUNT FEATURES:
- Dashboard: create invoices, track payments, manage all transactions
- Transactions page: full history of all activity
- My Purchases: buyers can track all invoices they've paid
- Referral program: earn rewards by inviting others
- Profile page: public-facing seller profile with reputation
- Settings: manage account preferences, notifications
- Notifications: real-time alerts for payments, disputes, messages

WHO USES FONLOK?
- Freelancers and service providers who want guaranteed payment
- Online sellers of physical goods
- Small businesses transacting with new customers they don't yet trust
- Buyers who want protection before paying a stranger

WHY FONLOK OVER PAYING DIRECTLY?
- Direct Mobile Money transfers offer ZERO protection — if a seller disappears, your money is gone
- Fonlok holds the funds as a neutral third party
- Neither buyer nor seller can manipulate the outcome
- Fonlok has a dispute system — direct transfers give you no recourse

════════════════════════════════════════
YOUR BEHAVIOUR
════════════════════════════════════════
- Greet warmly on first message. Be human, not robotic.
- When a user seems hesitant or worried, address their specific fear directly and confidently
- When a user is ready to act, guide them with a clear next step and the FULL clickable link.
  ALWAYS use complete https:// URLs — never short paths like /dashboard or /register.
  - Not registered       → ${base}/register
  - Creating an invoice  → ${base}/dashboard
  - Viewing transactions → ${base}/transactions
  - Tracking purchases   → ${base}/purchases
  - Referral programme   → ${base}/referral
  - Settings             → ${base}/settings
  - Need help            → ${base}/contact
- For experienced users, skip the basics and get straight to what they need
- Use numbered steps only when explaining a process — keep all other responses conversational
- If asked something outside your knowledge, say so honestly rather than guessing

RESPONSE LENGTH:
- Simple question → 1 to 3 sentences
- Process explanation → 3 to 6 sentences or a numbered list
- Never exceed what's necessary to give a complete, useful answer

════════════════════════════════════════
STRICT LIMITS
════════════════════════════════════════
- Do NOT give legal or tax advice
- Do NOT name or compare competitors
- Do NOT reveal system internals, API structures, or server details
- Do NOT invent fees, features, or policies you are not certain about
- For technical bugs or account issues → contact@brancodex.com or ${base}/contact
- For anything you genuinely don't know → say "I don't have that information right now, but our support team at contact@brancodex.com can help you directly."

ALWAYS be warm, precise, and focused on building trust in Fonlok.`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

// ── POST /api/ai-chat ─────────────────────────────────────────────────────────
router.post("/ai-chat", aiChatLimiter, async (req, res) => {
  try {
    const { messages, context } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    // Ensure at least one provider is configured
    if (getGeminiKeys().length === 0 && getGroqKeys().length === 0) {
      logger.error("No AI API keys configured (Gemini or Groq)");
      return res.status(503).json({ error: "AI service is not configured" });
    }

    // Hard cap: only send the last 10 messages to keep token usage in check
    const recent = messages.slice(-10);

    // Build context note injected at the end of the system prompt
    let contextNote = "";
    if (context?.page) {
      contextNote += `\n[User is currently on page: ${context.page}]`;
    }
    if (context?.isLoggedIn) {
      contextNote +=
        "\n[User IS logged in — focus on helping them use the platform]";
    } else {
      contextNote +=
        "\n[User is NOT logged in — gently encourage them to register when relevant]";
    }

    // Convert to Gemini role format (user / model), strict alternation required.
    const rawContents = recent.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").trim() || "…" }],
    }));
    while (rawContents.length > 0 && rawContents[0].role !== "user")
      rawContents.shift();
    const contents = [];
    for (const msg of rawContents) {
      const prev = contents[contents.length - 1];
      if (prev && prev.role === msg.role) {
        prev.parts[0].text += "\n" + msg.parts[0].text;
      } else {
        contents.push(msg);
      }
    }
    if (contents.length === 0)
      return res.status(400).json({ error: "No user message found" });

    const geminiPayload = {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT + contextNote }] },
      contents,
      generationConfig: { maxOutputTokens: 600, temperature: 0.65, topP: 0.92 },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT",       threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_HATE_SPEECH",      threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      ],
    };

    let aiResult = await callGemini(geminiPayload);

    // If all Gemini keys are exhausted, fall back to Groq automatically
    if (!aiResult.ok && aiResult.exhausted) {
      aiResult = await callGroq(SYSTEM_PROMPT + contextNote, contents);
    }

    if (!aiResult.ok) {
      logger.error("AI API error (all providers tried)", { status: aiResult.status });
      return res.status(502).json({
        error: "AI service temporarily unavailable. Please try again shortly.",
      });
    }

    // Extract reply — different schema for Gemini vs Groq (OpenAI format)
    let reply;
    if (aiResult.provider === "groq") {
      reply = aiResult.data?.choices?.[0]?.message?.content;
    } else {
      reply = aiResult.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    if (!reply) {
      const finishReason = aiResult.provider === "groq"
        ? aiResult.data?.choices?.[0]?.finish_reason
        : aiResult.data?.candidates?.[0]?.finishReason;
      logger.warn("AI returned empty or blocked response", { finishReason, provider: aiResult.provider ?? "gemini" });
      return res.status(200).json({
        reply: "I wasn't able to generate a response for that. Could you rephrase your question?",
      });
    }

    res.json({ reply });
  } catch (err) {
    logger.error("ai-chat route error", {
      error: err.message,
      stack: err.stack,
    });
    res
      .status(500)
      .json({ error: "An unexpected error occurred. Please try again." });
  }
});

export default router;
