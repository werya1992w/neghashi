// تست سرتاسری: سه بازیکن، یک دور کامل. اجرا: node test/e2e.mjs [http://127.0.0.1:8787]
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const code = "T" + Math.random().toString(36).slice(2, 6).toUpperCase();

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const c = { name, id: null, st: null, chats: [], draws: [], clears: 0, strokes: null, errors: [] };
  c.ws = new WebSocket(`${WS}/ws/${code}`);
  c.ready = new Promise((res) => (c.ws.onopen = res));
  c.ws.onmessage = (e) => {
    if (e.data === "pong") return;
    const m = JSON.parse(e.data);
    if (m.t === "init") c.id = m.you;
    else if (m.t === "state") c.st = m;
    else if (m.t === "chat") c.chats.push(m);
    else if (m.t === "draw") c.draws.push(m);
    else if (m.t === "clear") c.clears++;
    else if (m.t === "strokes") c.strokes = m.list;
    else if (m.t === "error") c.errors.push(m);
  };
  c.send = (o) => c.ws.send(JSON.stringify(o));
  return c;
}
async function until(fn, ms = 15000, label = "") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); }
  throw new Error("timeout waiting for: " + label);
}

const A = client("رضا"), B = client("نیلوفر"), C = client("علی");
await Promise.all([A.ready, B.ready]);
A.send({ t: "join", name: A.name });
await until(() => A.id, 5000, "A init");
B.send({ t: "join", name: B.name });
await until(() => B.id && B.st?.players.length === 2, 5000, "B joined");
ok(A.st.hostId === A.id, "اولین بازیکن میزبان است");

// بازیکن سوم و ورود بدون id معتبر
await C.ready; C.send({ t: "join", name: C.name });
await until(() => C.st?.players.length === 3, 5000, "C joined");
ok(C.st.players.length === 3, "سه بازیکن در اتاق");

// فقط میزبان می‌تواند شروع کند
B.send({ t: "start" }); await sleep(300);
ok(A.st.phase === "lobby", "غیرمیزبان نمی‌تواند شروع کند");

A.send({ t: "settings", rounds: 1, drawTime: 30 });
await until(() => A.st.rounds === 1 && A.st.drawTime === 30, 3000, "settings");
A.send({ t: "start" });
await until(() => A.st.phase === "choosing", 5000, "choosing");
ok(true, "بازی شروع شد (مرحلهٔ انتخاب کلمه)");

const all = [A, B, C];
const seenDrawers = new Set();
for (let turn = 1; turn <= 3; turn++) {
  await until(() => all.every((p) => p.st.phase === "choosing" && p.st.drawerId && !seenDrawers.has(p.st.drawerId)) || all.every((p)=>p.st.phase==="choosing"), 10000, `choosing turn ${turn}`);
  const drawer = all.find((p) => p.id === A.st.drawerId);
  const guessers = all.filter((p) => p !== drawer);
  seenDrawers.add(drawer.id);
  ok(Array.isArray(drawer.st.options) && drawer.st.options.length === 3, `نوبت ${turn}: نقاش سه گزینه می‌بیند`);
  ok(guessers.every((g) => g.st.options === null), `نوبت ${turn}: دیگران گزینه‌ها را نمی‌بینند`);

  drawer.send({ t: "chooseWord", index: 0 });
  await until(() => all.every((p) => p.st.phase === "drawing"), 5000, "drawing");
  const word = drawer.st.word;
  ok(!!word, `نوبت ${turn}: نقاش کلمه را می‌بیند (${word})`);
  ok(guessers.every((g) => g.st.word === null && Array.isArray(g.st.hint) && g.st.hint.length === Array.from(word).length), `نوبت ${turn}: دیگران فقط راهنما می‌بینند`);
  ok(guessers.every((g) => !JSON.stringify(g.st).includes(word)), `نوبت ${turn}: کلمه در پیام دیگران نشت نمی‌کند`);

  // نقاشی
  const before = guessers.map((g) => g.draws.length);
  drawer.send({ t: "draw", s: [[10, 10, 50, 50], [50, 50, 90, 20]], c: "#ef476f", w: 8 });
  await until(() => guessers.every((g, i) => g.draws.length > before[i]), 3000, "draw relay");
  ok(true, `نوبت ${turn}: خطوط به بقیه رسید`);
  drawer.send({ t: "draw", s: [[1, 1, 2, 2]], c: "bad", w: 8 }); // نامعتبر
  drawer.send({ t: "strokeEnd" });
  guessers[0].send({ t: "draw", s: [[1, 1, 2, 2]], c: "#000000", w: 8 }); // غیرنقاش
  await sleep(200);
  ok(guessers[1].draws.length === before[1] + 1, `نوبت ${turn}: نقاشی نامعتبر/غیرنقاش نادیده گرفته شد`);

  // حدس
  const g1 = guessers[0], g2 = guessers[1];
  g1.send({ t: "chat", text: "اشتباه" });
  await until(() => g2.chats.some((c) => c.kind === "msg" && c.text === "اشتباه"), 3000, "wrong guess broadcast");
  ok(true, `نوبت ${turn}: حدس اشتباه برای همه پخش شد`);

  const scoreBefore = g1.st.players.find((p) => p.id === g1.id).score;
  g1.send({ t: "chat", text: word });
  await until(() => g2.chats.some((c) => c.kind === "ok" && c.text.includes(g1.name)), 3000, "correct guess msg");
  ok(!g2.chats.some((c) => c.kind === "msg" && c.text === word), `نوبت ${turn}: متن حدس درست پخش نمی‌شود`);
  await until(() => g1.st.players.find((p) => p.id === g1.id).score > scoreBefore, 3000, "score");
  ok(g1.st.word === word, `نوبت ${turn}: حدس‌زننده بعد از حدس کلمه را می‌بیند`);

  // حدس نفر دوم → پایان زودهنگام نوبت
  g2.send({ t: "chat", text: word });
  await until(() => all.every((p) => p.st.phase === "roundEnd"), 5000, "roundEnd");
  ok(all.every((p) => p.st.lastWord === word), `نوبت ${turn}: وقتی همه حدس زدند نوبت زود تمام شد`);
  ok(Object.keys(A.st.gains).length >= 2, `نوبت ${turn}: امتیاز نوبت اعلام شد`);

  if (turn < 3) await until(() => all.every((p) => p.st.phase === "choosing"), 12000, "next choosing");
}

await until(() => all.every((p) => p.st.phase === "gameEnd"), 12000, "gameEnd");
ok(seenDrawers.size === 3, "هر سه نفر نقاش شدند");
const scores = A.st.players.map((p) => p.score);
ok(scores.every((s) => s > 0), "همه امتیاز گرفتند: " + scores.join(","));

// اتصال مجدد با همان id
const A2 = client("رضا");
await A2.ready;
A2.send({ t: "join", name: "رضا", id: A.id });
await until(() => A2.id === A.id && A2.st, 3000, "rejoin");
ok(A2.st.players.length === 3, "اتصال مجدد با همان شناسه بازیکن تکراری نمی‌سازد");

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
