// api/zion.js
// ZION — Deterministic Intake Gate (fast 3 questions → intake)
// Objective:
// - Ask 3 questions max before triggering intake modal
// - Persist notes + transcript to feed summary
// - Hard cap conversation so it never drifts/repeats
// - NO model call (instant server response)

const BUILD = "ZION_API_BUILD_2026-01-25_v7_DETERMINISTIC_3Q_INTAKE_HARDCAP";

// ----------------------------
// Response + CORS
// ----------------------------
function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function allowCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten later
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function safeObj(x, fallback = {}) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function clampStr(s, max = 320) {
  return String(s ?? "").trim().slice(0, max);
}

function normalize(s) {
  return String(s ?? "").trim();
}

function ensureTranscript(notes) {
  if (!Array.isArray(notes.transcript)) notes.transcript = [];
  return notes;
}

function isNonAnswer(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return true;
  return [
    "idk",
    "i dont know",
    "not sure",
    "help",
    "how",
    "ok",
    "okay",
    "sounds good",
    "yes",
    "yep",
    "yeah",
    "cool",
  ].includes(t);
}

// ----------------------------
// Lightweight inference (stored; not enforced)
// ----------------------------
function inferGoal(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "";
  if (t.includes("lead")) return "Leads";
  if (t.includes("sale") || t.includes("revenue")) return "Sales";
  if (t.includes("book") || t.includes("estimate") || t.includes("appointment")) return "Bookings";
  if (t.includes("follow") || t.includes("nurture") || t.includes("automation")) return "Follow-up";
  if (t.includes("seo") || t.includes("rank") || t.includes("google")) return "SEO / Visibility";
  if (t.includes("content") || t.includes("post") || t.includes("social")) return "Content";
  return "";
}

function inferBusinessType(text) {
  const raw = clampStr(text, 240);
  const t = raw.toLowerCase();

  let label = "";
  if (t.includes("landscap")) label = "Landscaping / Outdoor";
  else if (t.includes("home service") || t.includes("roof") || t.includes("hvac") || t.includes("plumb") || t.includes("electric") || t.includes("contract"))
    label = "Home Services";
  else if (t.includes("real estate") || t.includes("realtor")) label = "Real Estate";
  else if (t.includes("law") || t.includes("attorney")) label = "Legal";
  else if (t.includes("clinic") || t.includes("med") || t.includes("dental")) label = "Healthcare";
  else if (t.includes("ecom") || t.includes("shopify") || t.includes("store")) label = "E-Commerce";

  let buyer = "";
  if (t.includes("homeowner")) buyer = "Homeowners";
  else if (t.includes("b2b") || t.includes("business")) buyer = "Businesses";
  else if (t.includes("consumer") || t.includes("customer")) buyer = "Consumers";

  return { raw, label, buyer };
}

function inferTargetMetric(text) {
  const raw = clampStr(text, 220);
  const m = raw.match(/(\d+)\s*(lead|leads|booking|bookings|estimate|estimates|calls|appointments|jobs|customers)/i);
  const num = m ? Number(m[1]) : null;
  const unit = m ? m[2].toLowerCase() : "";
  return { raw, num, unit };
}

// ----------------------------
// Gate configuration
// ----------------------------
const MAX_USER_INPUTS_TOTAL = 10;     // absolute ceiling
const MAX_USER_INPUTS_BEFORE_INTAKE = 6; // safety cap (even if answers are vague)
const STAGES = {
  START: "start",
  GOAL: "goal",
  BUSINESS: "business",
  METRIC: "metric",
  CAPTURE: "capture",
};

// ----------------------------
// Deterministic prompts (short for speed)
// ----------------------------
function promptGoal() {
  return {
    reply: "Zion online. What is your #1 goal for the next 30 days—leads, booked estimates, or revenue?",
    next_question: "What is your #1 goal for the next 30 days (leads, booked estimates, or revenue)?",
    capture_intent: "none",
    stage: STAGES.GOAL,
  };
}

function promptBusiness() {
  return {
    reply: "Understood. What do you do, and who do you sell to?",
    next_question: "What do you do, and who is the primary buyer?",
    capture_intent: "none",
    stage: STAGES.BUSINESS,
  };
}

function promptMetric() {
  return {
    reply: "Good. Now set a measurable target. What would make the next 30 days a win—give me a number.",
    next_question: "What would make the next 30 days a win (e.g., 20 leads, 10 bookings, $15k revenue)?",
    capture_intent: "none",
    stage: STAGES.METRIC,
  };
}

function triggerIntake() {
  return {
    reply: "Perfect. I have enough to generate your executive summary + tiers. Open the intake—two minutes—and I’ll output the plan.",
    next_question: "Open the intake so I can generate your executive summary and tiers.",
    capture_intent: "ask_contact",
    stage: STAGES.CAPTURE,
  };
}

// ----------------------------
// Handler
// ----------------------------
export default async function handler(req, res) {
  if (allowCors(req, res)) return;

  if (req.method === "GET") {
    return json(res, 200, {
      status: "ok",
      message: "Zion API is live. Use POST.",
      model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
      build: BUILD,
    });
  }

  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed", build: BUILD });
  }

  // Parse body safely for Vercel
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = safeObj(body, {});

  const message = normalize(body.message);
  const session_id = normalize(body.session_id) || "anon";
  const turnIn = Number.isFinite(Number(body.turn)) ? Number(body.turn) : 0;

  let notes = ensureTranscript(safeObj(body.notes, {}));
  notes.session_id = session_id;
  notes.last_updated_at = nowIso();
  if (!notes.stage) notes.stage = STAGES.START;

  // Count user inputs so we can hard-cap
  const userInputsSoFar = Number(notes.user_inputs || 0);
  const userInputsNow = userInputsSoFar + 1;
  notes.user_inputs = userInputsNow;

  // Append transcript user entry
  notes.transcript.push({
    turn: turnIn,
    user: clampStr(message, 500),
    at: nowIso(),
  });

  // Always keep the first meaningful message as business_offer (seed)
  if (!notes.business_offer && message) notes.business_offer = clampStr(message, 240);

  // HARD CAPS: never drift
  const captureLocked = notes.capture_locked === true || notes.stage === STAGES.CAPTURE;

  // If they already crossed the cap, force intake
  if (!captureLocked) {
    if (userInputsNow >= MAX_USER_INPUTS_BEFORE_INTAKE) {
      notes.capture_locked = true;
      notes.stage = STAGES.CAPTURE;
      const out = triggerIntake();
      notes.transcript.push({ turn: turnIn + 1, zion: out.reply, at: nowIso() });
      return json(res, 200, {
        reply: out.reply,
        next_question: out.next_question,
        capture_intent: out.capture_intent,
        turn: turnIn + 1,
        notes,
        model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
        build: BUILD,
      });
    }
  }

  // Absolute ceiling fallback (safety)
  if (!captureLocked && userInputsNow >= MAX_USER_INPUTS_TOTAL) {
    notes.capture_locked = true;
    notes.stage = STAGES.CAPTURE;
    const out = triggerIntake();
    notes.transcript.push({ turn: turnIn + 1, zion: out.reply, at: nowIso() });
    return json(res, 200, {
      reply: out.reply,
      next_question: out.next_question,
      capture_intent: out.capture_intent,
      turn: turnIn + 1,
      notes,
      model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
      build: BUILD,
    });
  }

  // ----------------------------
  // Deterministic stage machine
  // ----------------------------
  if (!captureLocked) {
    // START → ask goal
    if (notes.stage === STAGES.START) {
      // If the very first message contains a goal hint, store it but still ask once.
      const g = inferGoal(message);
      if (g) notes.primary_goal = g;
      else if (message && !isNonAnswer(message)) notes.primary_goal_raw = clampStr(message, 240);

      const out = promptGoal();
      notes.stage = out.stage;

      notes.transcript.push({ turn: turnIn + 1, zion: out.reply, at: nowIso() });

      return json(res, 200, {
        reply: out.reply,
        next_question: out.next_question,
        capture_intent: out.capture_intent,
        turn: turnIn + 1,
        notes,
        model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
        build: BUILD,
      });
    }

    // GOAL → store + ask business/buyer
    if (notes.stage === STAGES.GOAL) {
      const g = inferGoal(message);
      if (g) notes.primary_goal = g;
      else if (message && !isNonAnswer(message)) notes.primary_goal_raw = clampStr(message, 240);

      const out = promptBusiness();
      notes.stage = out.stage;

      notes.transcript.push({ turn: turnIn + 1, zion: out.reply, at: nowIso() });

      return json(res, 200, {
        reply: out.reply,
        next_question: out.next_question,
        capture_intent: out.capture_intent,
        turn: turnIn + 1,
        notes,
        model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
        build: BUILD,
      });
    }

    // BUSINESS → store + ask metric
    if (notes.stage === STAGES.BUSINESS) {
      const bt = inferBusinessType(message);
      if (bt.raw) notes.business_type = bt.raw;
      if (bt.label) notes.industry = bt.label;
      if (bt.buyer) notes.buyer = bt.buyer;

      const out = promptMetric();
      notes.stage = out.stage;

      notes.transcript.push({ turn: turnIn + 1, zion: out.reply, at: nowIso() });

      return json(res, 200, {
        reply: out.reply,
        next_question: out.next_question,
        capture_intent: out.capture_intent,
        turn: turnIn + 1,
        notes,
        model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
        build: BUILD,
      });
    }

    // METRIC → store + trigger intake
    if (notes.stage === STAGES.METRIC) {
      const tm = inferTargetMetric(message);
      if (tm.raw) notes.target_metric = tm.raw;
      if (tm.num != null) notes.target_metric_number = tm.num;
      if (tm.unit) notes.target_metric_unit = tm.unit;

      notes.capture_locked = true;
      const out = triggerIntake();
      notes.stage = out.stage;

      notes.transcript.push({ turn: turnIn + 1, zion: out.reply, at: nowIso() });

      return json(res, 200, {
        reply: out.reply,
        next_question: out.next_question,
        capture_intent: out.capture_intent,
        turn: turnIn + 1,
        notes,
        model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
        build: BUILD,
      });
    }

    // Any unexpected stage → trigger intake
    notes.capture_locked = true;
    notes.stage = STAGES.CAPTURE;
    const out = triggerIntake();
    notes.transcript.push({ turn: turnIn + 1, zion: out.reply, at: nowIso() });
    return json(res, 200, {
      reply: out.reply,
      next_question: out.next_question,
      capture_intent: out.capture_intent,
      turn: turnIn + 1,
      notes,
      model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
      build: BUILD,
    });
  }

  // After capture is locked: keep it short and directive (fast)
  const out = {
    reply: "I’m ready. Complete the intake and I’ll generate your executive summary and tiers.",
    next_question: "Complete the intake so I can generate your executive summary and tiers.",
    capture_intent: "ask_contact",
  };
  notes.stage = STAGES.CAPTURE;
  notes.capture_locked = true;
  notes.transcript.push({ turn: turnIn + 1, zion: out.reply, at: nowIso() });

  return json(res, 200, {
    reply: out.reply,
    next_question: out.next_question,
    capture_intent: out.capture_intent,
    turn: turnIn + 1,
    notes,
    model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
    build: BUILD,
  });
}
