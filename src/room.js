import { DurableObject } from "cloudflare:workers";
import { WORDS } from "./words.js";

const MAX_PLAYERS = 8;
const CHOOSE_MS = 15000;
const ROUND_END_MS = 6000;
const GAME_END_MS = 20000;
const MAX_STROKES = 3000;
const COLORS = ["#ef476f", "#118ab2", "#ffa62b", "#7b5ea7", "#06d6a0", "#e76f51", "#2a9d8f", "#b5179e"];

const fa = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
const isGap = (c) => c === " " || c === "‌";

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function norm(s) {
  return String(s)
    .normalize("NFKC")
    .replace(/[ً-ٰٟ‌‍ـ\s]/g, "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ۀة]/g, "ه")
    .replace(/[أإآ]/g, "ا")
    .toLowerCase();
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 1) return 2;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function fresh(code = null) {
  return {
    code,
    public: false,
    phase: "lobby", // lobby | choosing | drawing | roundEnd | gameEnd
    hostId: null,
    players: {},
    settings: { rounds: 3, drawTime: 80 },
    round: 0,
    queue: [],
    drawerId: null,
    word: null,
    options: [],
    revealed: [],
    hintSchedule: [],
    endsAt: 0,
    turnTotal: 0,
    guessedOrder: [],
    lastWord: null,
    gains: {},
    used: [],
  };
}

// هر اتاق = یک Durable Object. وضعیت بازی در storage ذخیره می‌شود تا با Hibernation از بین نرود.
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = fresh();
    this.strokes = [];
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get("s")) ?? fresh();
      this.strokes = (await ctx.storage.get("strokes")) ?? [];
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------- ورودی‌ها ----------
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const url = new URL(request.url);
    const s = this.s;
    let dirty = false;
    if (!s.code) { s.code = url.pathname.split("/").pop().toUpperCase(); dirty = true; }
    if (url.searchParams.get("public") === "1" && !Object.keys(s.players).length && !s.public) {
      s.public = true; dirty = true;
    }
    if (dirty) await this.save();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 8192) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== "string") return;
    if (m.t === "join") return this.onJoin(ws, m);

    const id = ws.deserializeAttachment()?.id;
    const s = this.s;
    const p = id && s.players[id];
    if (!p) return;

    switch (m.t) {
      case "settings": return this.onSettings(id, m);
      case "start": return this.onStart(id);
      case "chooseWord": return this.onChoose(id, m);
      case "draw": return this.onDraw(ws, id, m);
      case "strokeEnd": return this.onStrokeEnd(id);
      case "clear": return this.onClear(ws, id);
      case "chat": return this.onChat(ws, id, m);
    }
  }

  async webSocketClose(ws) { await this.onDisconnect(ws); try { ws.close(1000, "bye"); } catch {} }
  async webSocketError(ws) { await this.onDisconnect(ws); }

  async alarm() {
    const s = this.s;
    const now = Date.now();
    if (s.phase === "choosing") {
      if (now >= s.endsAt) { s.word = s.options[0]; await this.startDrawing(); return; }
    } else if (s.phase === "drawing") {
      let changed = false;
      while (s.hintSchedule.length && s.hintSchedule[0] <= now) {
        s.hintSchedule.shift();
        changed = this.revealOne() || changed;
      }
      if (now >= s.endsAt) { await this.endTurn(); return; }
      if (changed) { await this.save(); this.broadcastState(); }
    } else if (s.phase === "roundEnd") {
      if (now >= s.endsAt) { await this.nextTurn(); return; }
    } else if (s.phase === "gameEnd") {
      if (now >= s.endsAt) { await this.toLobby(); await this.save(); this.broadcastState(); await this.report(); return; }
    }
    await this.scheduleAlarm();
  }

  // ---------- ورود و خروج ----------
  async onJoin(ws, m) {
    const s = this.s;
    let name = String(m.name ?? "").replace(/\s+/g, " ").trim().slice(0, 16) || "بازیکن";
    let id = typeof m.id === "string" && /^[a-z0-9]{8}$/.test(m.id) ? m.id : null;
    let p = id && s.players[id];
    let isNew = false;

    if (!p) {
      if (Object.keys(s.players).length >= MAX_PLAYERS) {
        this.send(ws, { t: "error", code: "full", msg: "اتاق پر است." });
        try { ws.close(1000, "full"); } catch {}
        return;
      }
      id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      const usedColors = new Set(Object.values(s.players).map((x) => x.color));
      const color = COLORS.find((c) => !usedColors.has(c)) ?? COLORS[0];
      p = { id, name, color, score: 0, connected: true, guessed: false };
      s.players[id] = p;
      isNew = true;
    } else {
      p.connected = true;
      p.name = name;
    }

    ws.serializeAttachment({ id });
    for (const w of this.ctx.getWebSockets()) {
      if (w !== ws && w.deserializeAttachment()?.id === id) { try { w.close(1000, "replaced"); } catch {} }
    }
    if (!s.hostId || !s.players[s.hostId]?.connected) s.hostId = id;

    this.send(ws, { t: "init", you: id });
    this.send(ws, { t: "strokes", list: this.strokes });
    if (isNew) this.chatAll({ kind: "sys", text: `${p.name} وارد اتاق شد` });
    await this.save();
    this.broadcastState();
    await this.report();
  }

  async onDisconnect(ws) {
    const s = this.s;
    const id = ws.deserializeAttachment()?.id;
    const p = id && s.players[id];
    if (!p) return;
    const stillHere = this.ctx.getWebSockets().some(
      (w) => w !== ws && w.readyState === 1 && w.deserializeAttachment()?.id === id
    );
    if (stillHere) return;

    p.connected = false;
    this.chatAll({ kind: "sys", text: `${p.name} از اتاق خارج شد` });
    const connected = Object.values(s.players).filter((x) => x.connected);

    if (connected.length === 0) { await this.resetRoom(); return; }
    if (s.hostId === id) s.hostId = connected[0].id;

    if (s.phase === "lobby") {
      delete s.players[id];
    } else if (connected.length < 2) {
      await this.toLobby();
    } else if (id === s.drawerId) {
      if (s.phase === "drawing") { await this.endTurn(); await this.report(); return; }
      if (s.phase === "choosing") { await this.nextTurn(); await this.report(); return; }
    } else if (s.phase === "drawing" && this.allGuessed()) {
      await this.endTurn(); await this.report(); return;
    }
    await this.save();
    this.broadcastState();
    await this.report();
  }

  async resetRoom() {
    const code = this.s.code;
    const wasPublic = this.s.public;
    this.s = fresh(code);
    this.s.public = wasPublic;
    this.strokes = [];
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put("strokes", []);
    await this.save();
    await this.report();
  }

  // ---------- تنظیمات و شروع ----------
  async onSettings(id, m) {
    const s = this.s;
    if (id !== s.hostId || s.phase !== "lobby") return;
    const rounds = Math.min(10, Math.max(1, Number(m.rounds) | 0 || s.settings.rounds));
    const drawTime = Math.min(180, Math.max(30, Number(m.drawTime) | 0 || s.settings.drawTime));
    s.settings = { rounds, drawTime };
    await this.save();
    this.broadcastState();
  }

  async onStart(id) {
    const s = this.s;
    if (id !== s.hostId || s.phase !== "lobby") return;
    const connected = Object.values(s.players).filter((p) => p.connected);
    if (connected.length < 2) return;
    for (const p of Object.values(s.players)) { p.score = 0; p.guessed = false; }
    s.round = 1;
    s.queue = shuffle(connected.map((p) => p.id));
    s.used = [];
    await this.nextTurn();
    await this.report();
  }

  // ---------- چرخهٔ بازی ----------
  async nextTurn() {
    const s = this.s;
    s.queue = s.queue.filter((id) => s.players[id]?.connected);
    if (s.queue.length === 0) {
      if (s.round >= s.settings.rounds) { await this.endGame(); return; }
      s.round += 1;
      s.queue = shuffle(Object.values(s.players).filter((p) => p.connected).map((p) => p.id));
    }
    s.drawerId = s.queue.shift();
    for (const p of Object.values(s.players)) p.guessed = false;
    s.word = null;
    s.lastWord = null;
    s.gains = {};
    s.guessedOrder = [];
    s.revealed = [];
    s.hintSchedule = [];
    s.options = this.pickWords(3);
    s.phase = "choosing";
    s.turnTotal = CHOOSE_MS;
    s.endsAt = Date.now() + CHOOSE_MS;
    this.strokes = [];
    await this.ctx.storage.put("strokes", this.strokes);
    await this.save();
    this.broadcast({ t: "clear" });
    this.broadcastState();
    await this.scheduleAlarm();
  }

  pickWords(n) {
    const s = this.s;
    let pool = WORDS.filter((w) => !s.used.includes(w));
    if (pool.length < n) { s.used = []; pool = WORDS.slice(); }
    return shuffle(pool).slice(0, n);
  }

  async onChoose(id, m) {
    const s = this.s;
    if (s.phase !== "choosing" || id !== s.drawerId) return;
    const idx = Number(m.index) | 0;
    if (idx < 0 || idx >= s.options.length) return;
    s.word = s.options[idx];
    await this.startDrawing();
  }

  async startDrawing() {
    const s = this.s;
    const now = Date.now();
    const total = s.settings.drawTime * 1000;
    s.used.push(s.word);
    s.phase = "drawing";
    s.turnTotal = total;
    s.endsAt = now + total;
    s.options = [];
    s.revealed = [];
    const letters = Array.from(s.word).filter((c) => !isGap(c)).length;
    const fracs = letters >= 6 ? [0.45, 0.65, 0.85] : letters >= 3 ? [0.5, 0.75] : [];
    s.hintSchedule = fracs.map((f) => now + total * f);
    await this.save();
    this.broadcastState();
    await this.scheduleAlarm();
  }

  revealOne() {
    const s = this.s;
    const chars = Array.from(s.word);
    const hidden = chars.map((c, i) => i).filter((i) => !isGap(chars[i]) && !s.revealed.includes(i));
    if (hidden.length <= 1) return false;
    s.revealed.push(hidden[Math.floor(Math.random() * hidden.length)]);
    return true;
  }

  allGuessed() {
    const s = this.s;
    const guessers = Object.values(s.players).filter((p) => p.connected && p.id !== s.drawerId);
    return guessers.length > 0 && guessers.every((p) => p.guessed);
  }

  async endTurn() {
    const s = this.s;
    s.phase = "roundEnd";
    s.lastWord = s.word;
    s.turnTotal = ROUND_END_MS;
    s.endsAt = Date.now() + ROUND_END_MS;
    this.chatAll({ kind: "sys", text: `کلمه «${s.word}» بود` });
    await this.save();
    this.broadcastState();
    await this.scheduleAlarm();
  }

  async endGame() {
    const s = this.s;
    s.phase = "gameEnd";
    s.drawerId = null;
    s.word = null;
    s.turnTotal = GAME_END_MS;
    s.endsAt = Date.now() + GAME_END_MS;
    await this.save();
    this.broadcast({ t: "clear" });
    this.broadcastState();
    await this.scheduleAlarm();
  }

  async toLobby() {
    const s = this.s;
    for (const [id, p] of Object.entries(s.players)) {
      if (!p.connected) delete s.players[id];
      else { p.score = 0; p.guessed = false; }
    }
    const connected = Object.values(s.players).filter((p) => p.connected);
    if (!s.players[s.hostId]?.connected) s.hostId = connected[0]?.id ?? null;
    s.phase = "lobby";
    s.round = 0;
    s.queue = [];
    s.drawerId = null;
    s.word = null;
    s.lastWord = null;
    s.options = [];
    s.gains = {};
    s.endsAt = 0;
    this.strokes = [];
    await this.ctx.storage.put("strokes", this.strokes);
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ t: "clear" });
  }

  async scheduleAlarm() {
    const s = this.s;
    let t = null;
    if (s.phase === "choosing" || s.phase === "roundEnd" || s.phase === "gameEnd") t = s.endsAt;
    else if (s.phase === "drawing") t = Math.min(s.endsAt, s.hintSchedule[0] ?? Infinity);
    if (t === null) { await this.ctx.storage.deleteAlarm(); return; }
    await this.ctx.storage.setAlarm(Math.max(t, Date.now() + 50));
  }

  // ---------- نقاشی ----------
  async onDraw(ws, id, m) {
    const s = this.s;
    if (s.phase !== "drawing" || id !== s.drawerId) return;
    if (!Array.isArray(m.s) || m.s.length === 0 || m.s.length > 200) return;
    if (typeof m.c !== "string" || !/^#[0-9a-fA-F]{6}$/.test(m.c)) return;
    const w = Number(m.w);
    if (!(w >= 1 && w <= 60)) return;
    const segs = [];
    for (const q of m.s) {
      if (!Array.isArray(q) || q.length !== 4) return;
      const [a, b, c, d] = q.map((n) => Math.round(Number(n)));
      if (![a, b, c, d].every((n) => Number.isFinite(n) && n >= -20 && n <= 820)) return;
      segs.push([a, b, c, d]);
    }
    const batch = { t: "draw", s: segs, c: m.c, w };
    if (this.strokes.length < MAX_STROKES) this.strokes.push({ s: segs, c: m.c, w });
    this.broadcast(batch, ws);
  }

  async onStrokeEnd(id) {
    if (id !== this.s.drawerId || this.s.phase !== "drawing") return;
    await this.ctx.storage.put("strokes", this.strokes);
  }

  async onClear(ws, id) {
    if (id !== this.s.drawerId || this.s.phase !== "drawing") return;
    this.strokes = [];
    await this.ctx.storage.put("strokes", this.strokes);
    this.broadcast({ t: "clear" }, ws);
  }

  // ---------- چت و حدس ----------
  async onChat(ws, id, m) {
    const s = this.s;
    const p = s.players[id];
    const text = String(m.text ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
    if (!text) return;

    if (s.phase !== "drawing") {
      this.chatAll({ kind: "msg", name: p.name, text });
      return;
    }

    // نقاش و کسانی که درست حدس زده‌اند فقط با هم گفتگو می‌کنند
    if (id === s.drawerId || p.guessed) {
      this.chatTo((pid) => pid === s.drawerId || s.players[pid]?.guessed, { kind: "private", name: p.name, text });
      return;
    }

    const guess = norm(text);
    const answer = norm(s.word);
    if (guess === answer) {
      const remaining = Math.max(0, s.endsAt - Date.now());
      const gain = Math.max(50, Math.round(100 + 400 * (remaining / s.turnTotal)) - 25 * s.guessedOrder.length);
      p.score += gain;
      p.guessed = true;
      s.guessedOrder.push(id);
      s.gains[id] = gain;
      const drawer = s.players[s.drawerId];
      if (drawer) { drawer.score += 50; s.gains[drawer.id] = (s.gains[drawer.id] || 0) + 50; }
      this.chatAll({ kind: "ok", text: `${p.name} به کلمه درست رسید! (+${fa(gain)})` });
      if (this.allGuessed()) { await this.endTurn(); return; }
      await this.save();
      this.broadcastState();
      return;
    }

    this.chatAll({ kind: "msg", name: p.name, text });
    if (guess.length >= 3 && lev(guess, answer) === 1) {
      this.send(ws, { t: "chat", kind: "close", text: "نزدیک شدی!" });
    }
  }

  // ---------- ارسال ----------
  view(id) {
    const s = this.s;
    const me = s.players[id];
    const isDrawer = id === s.drawerId;
    const knows = !!s.word && s.phase === "drawing" && (isDrawer || me?.guessed);
    let hint = null;
    if (s.phase === "drawing" && s.word) {
      hint = Array.from(s.word).map((c, i) => (isGap(c) ? " " : s.revealed.includes(i) ? c : "_"));
    }
    return {
      t: "state",
      code: s.code,
      phase: s.phase,
      hostId: s.hostId,
      round: s.round,
      rounds: s.settings.rounds,
      drawTime: s.settings.drawTime,
      drawerId: s.drawerId,
      endsAt: s.endsAt,
      total: s.turnTotal,
      now: Date.now(),
      hint,
      word: knows ? s.word : null,
      lastWord: s.phase === "roundEnd" ? s.lastWord : null,
      options: isDrawer && s.phase === "choosing" ? s.options : null,
      gains: s.phase === "roundEnd" || s.phase === "gameEnd" ? s.gains : {},
      players: Object.values(s.players).map((p) => ({
        id: p.id, name: p.name, color: p.color, score: p.score, connected: p.connected, guessed: p.guessed,
      })),
    };
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except || w.readyState !== 1) continue;
      try { w.send(data); } catch {}
    }
  }

  broadcastState() {
    for (const w of this.ctx.getWebSockets()) {
      if (w.readyState !== 1) continue;
      const id = w.deserializeAttachment()?.id;
      if (!id || !this.s.players[id]) continue;
      this.send(w, this.view(id));
    }
  }

  chatAll(msg) { this.broadcast({ t: "chat", ...msg }); }

  chatTo(pred, msg) {
    for (const w of this.ctx.getWebSockets()) {
      const id = w.deserializeAttachment()?.id;
      if (id && w.readyState === 1 && pred(id)) this.send(w, { t: "chat", ...msg });
    }
  }

  async save() { await this.ctx.storage.put("s", this.s); }

  async report() {
    const s = this.s;
    if (!s.public || !s.code) return;
    const count = Object.values(s.players).filter((p) => p.connected).length;
    try { await this.env.MATCHMAKER.getByName("main").report(s.code, count, s.phase); } catch {}
  }
}
