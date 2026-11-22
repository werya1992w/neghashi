import { GameRoom } from "./room.js";
import { Matchmaker } from "./matchmaker.js";
import { Config } from "./config.js";
import { WORDS } from "./words.js";

export { GameRoom, Matchmaker, Config };

// ادمین = هر کسی که روی این مخزن GitHub اجازهٔ نوشتن دارد (همان توکنی که پنل ادمین سایت کافه استفاده می‌کند).
// اگر متغیر ADMIN_KEY هم در کلودفلر تعریف شود، با آن هم می‌شود وارد شد.
const ADMIN_REPO = "Argacafe/Arga";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400",
};
const json = (o, status = 200) =>
  Response.json(o, { status, headers: { ...CORS, "cache-control": "no-store" } });

const authCache = new Map();
async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAdmin(request, env) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(\S{8,255})$/i);
  if (!m) return false;
  const token = m[1];
  if (env.ADMIN_KEY && token === env.ADMIN_KEY) return true;
  const h = await sha(token);
  const hit = authCache.get(h);
  if (hit && hit > Date.now()) return true;
  try {
    const r = await fetch(`https://api.github.com/repos/${ADMIN_REPO}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "neghashi-worker",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!r.ok) return false;
    const j = await r.json();
    if (j.permissions && j.permissions.push === true) {
      if (authCache.size > 50) authCache.clear();
      authCache.set(h, Date.now() + 5 * 60 * 1000);
      return true;
    }
  } catch {}
  return false;
}

function cleanWords(arr) {
  if (!Array.isArray(arr)) return null;
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (typeof x !== "string") continue;
    const w = x.normalize("NFC").replace(/[\u0000-\u001f<>&"]/g, "").replace(/\s+/g, " ").trim();
    if (w.length < 2 || w.length > 24 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 3000) break;
  }
  return out;
}

async function words(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const cfg = env.CONFIG.getByName("main");
  if (request.method === "GET") {
    const r = await cfg.getWords();
    return json(r.custom ? { custom: true, words: r.words } : { custom: false, words: WORDS });
  }
  if (!["PUT", "DELETE"].includes(request.method)) return json({ error: "method" }, 405);
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  if (request.method === "DELETE") {
    await cfg.reset();
    return json({ custom: false, count: WORDS.length });
  }
  const text = await request.text();
  if (text.length > 300000) return json({ error: "too large" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }
  const list = cleanWords(body && body.words);
  if (!list || list.length < 10) return json({ error: "need at least 10 words" }, 400);
  await cfg.setWords(list);
  return json({ custom: true, count: list.length });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/words") return words(request, env);

    // بازی سریع: یک اتاق عمومی که جا دارد (یا اتاق جدید) برمی‌گرداند
    if (url.pathname === "/api/quickplay") {
      const code = await env.MATCHMAKER.getByName("main").findOrCreate();
      return Response.json({ code }, { headers: { "cache-control": "no-store" } });
    }

    // اتصال WebSocket به اتاق: /ws/ABCDE
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4,12})$/);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      return env.ROOMS.getByName(m[1].toUpperCase()).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
