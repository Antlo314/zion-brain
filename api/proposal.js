// /api/proposal.js
// Vercel Serverless Function (Node) — fetches stored proposal by pid.
//
// Required env:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
function bad(res, status, msg) {
  return json(res, status, { ok: false, error: msg });
}

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

async function kvGetJson(key) {
  const data = await kvPipeline([{ command: ["GET", key] }]);
  // Vercel KV REST pipeline returns array; each entry has result
  const result = Array.isArray(data) && data[0] ? data[0].result : null;
  if (!result) return null;
  try { return JSON.parse(result); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  if (req.method !== "GET") return bad(res, 405, "Use GET");

  try {
    const url = new URL(req.url, "http://localhost");
    const pid = (url.searchParams.get("pid") || "").trim();
    if (!pid) return bad(res, 400, "Missing pid");

    const record = await kvGetJson(`proposal:${pid}`);
    if (!record) return bad(res, 404, "Proposal not found (expired or invalid pid)");

    return json(res, 200, { ok: true, record });
  } catch (e) {
    return bad(res, 500, e?.message || "Server error");
  }
}