// /api/intake.js  (V2 — GHL-first, KV-optional)
// Fixes "Something went wrong" when KV env vars are not set.
// Behavior:
// 1) Always attempts to forward intake to GoHighLevel via GHL_WEBHOOK_URL (required for your use-case).
// 2) Stores to Vercel KV ONLY if KV_REST_API_URL + KV_REST_API_TOKEN are set.
// 3) Returns { ok:true, proposal_id } on success so the landing page can redirect to summary.
//
// Required env:
//   GHL_WEBHOOK_URL
//
// Optional env (for durable summary fetch by pid):
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
//   PROPOSAL_TTL_SECONDS (default 604800 = 7 days)

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function safeString(x, max = 4000) {
  const s = (x == null ? "" : String(x));
  return s.length > max ? s.slice(0, max) : s;
}

function makeId() {
  try {
    return (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  } catch {
    return `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

// ---- KV helpers (Upstash/Vercel KV REST) ----
async function kvPipeline(cmds) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("KV env not set");

  const endpoint = url.replace(/\/$/, "") + "/pipeline";
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(cmds)
  });

  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = data ? JSON.stringify(data) : `HTTP ${r.status}`;
    throw new Error(`KV pipeline failed: ${err}`);
  }
  return data;
}

async function kvSetJson(key, obj, ttlSeconds) {
  const value = JSON.stringify(obj);
  const cmds = ttlSeconds
    ? [{ command: ["SET", key, value, "EX", String(ttlSeconds)] }]
    : [{ command: ["SET", key, value] }];
  await kvPipeline(cmds);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Use POST" });

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const payload = body ? JSON.parse(body) : {};
      if (!payload || typeof payload !== "object") {
        return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      }

      // Intake fields (front-end currently posts: name/email/business/website/industry/goal/budget/timeline/bottleneck)
      const name = safeString(payload.name, 180);
      const email = safeString(payload.email, 180);
      const business = safeString(payload.business, 220);

      if (!name || !email || !business) {
        return sendJson(res, 422, { ok: false, error: "Missing required fields: name, email, business" });
      }

      const proposal_id = makeId();
      const created_at = new Date().toISOString();

      // Canonical record
      const record = {
        proposal_id,
        created_at,
        session_id: safeString(payload.session_id, 120),
        source: safeString(payload.source, 220) || "Zion Intake",
        intake: {
          name,
          email,
          business,
          website: safeString(payload.website, 220),
          industry: safeString(payload.industry, 120),
          goal: safeString(payload.goal, 120),
          budget: safeString(payload.budget, 60),
          timeline: safeString(payload.timeline, 60),
          bottleneck: safeString(payload.bottleneck, 1500)
        },
        zion_notes: payload.zion_notes || null,
        executive_intake_summary: safeString(payload.executive_intake_summary, 12000),
        proposal: payload.proposal || null
      };

      // 1) REQUIRED: forward to GHL webhook
      const ghUrl = process.env.GHL_WEBHOOK_URL;
      if (!ghUrl) {
        return sendJson(res, 500, { ok: false, error: "Missing env var: GHL_WEBHOOK_URL" });
      }

      const ghPayload = {
        // Flatten for easy mapping in GHL
        name: record.intake.name,
        email: record.intake.email,
        business: record.intake.business,
        website: record.intake.website,
        industry: record.intake.industry,
        goal: record.intake.goal,
        budget: record.intake.budget,
        timeline: record.intake.timeline,
        bottleneck: record.intake.bottleneck,

        proposal_id: record.proposal_id,
        session_id: record.session_id,
        source: record.source,
        submitted_at: record.created_at,

        executive_intake_summary: record.executive_intake_summary,
        zion_notes: record.zion_notes,

        tags: ["Zion Intake", "Zion Proposal"]
      };

      const ghRes = await fetch(ghUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ghPayload)
      });

      if (!ghRes.ok) {
        const ghText = await ghRes.text().catch(() => "");
        return sendJson(res, 502, {
          ok: false,
          error: "GHL webhook rejected the request",
          details: safeString(ghText, 600)
        });
      }

      // 2) OPTIONAL: KV store for summary page fetch by pid
      const hasKV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
      if (hasKV) {
        const ttl = Number(process.env.PROPOSAL_TTL_SECONDS || "604800");
        try {
          await kvSetJson(`proposal:${proposal_id}`, record, ttl);
        } catch {
          // Do not fail the user if KV is down; GHL already received the payload.
        }
      }

      // Return success
      return sendJson(res, 200, { ok: true, proposal_id });

    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e?.message || "Server error" });
    }
  });
}