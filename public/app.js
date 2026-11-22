(() => {
  const $ = (s) => document.querySelector(s);
  const fa = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const COLORS = ["#111111", "#ef476f", "#118ab2", "#06d6a0", "#ffd166", "#ffa62b", "#7b5ea7", "#8d5524", "#ffffff"];
  const SIZES = [4, 8, 16, 28];
  const W = 800, H = 600;

  let ws = null, code = null, isPublic = false, leaving = false, pingTimer = null;
  let myId = sessionStorage.getItem("nh_pid");
  let myName = "";
  let st = null, clockOff = 0;
  let color = COLORS[0], size = SIZES[1];

  const canvas = $("#canvas");
  const ctx = canvas.getContext("2d");

  /* ---------- صفحهٔ اصلی ---------- */
  $("#nameInput").value = localStorage.getItem("nh_name") || "";
  const hashCode = location.hash.replace("#", "").toUpperCase();
  if (/^[A-Z0-9]{4,12}$/.test(hashCode)) {
    $("#codeInput").value = hashCode;
    $("#joinHint").textContent = "برای ورود به اتاق " + hashCode + " نام خود را بنویس و «ورود با کد» را بزن";
    $("#joinHint").classList.remove("hidden");
  }

  function homeError(msg) {
    const e = $("#homeError");
    e.textContent = msg;
    e.classList.toggle("hidden", !msg);
  }
  function readName() {
    const n = $("#nameInput").value.replace(/\s+/g, " ").trim();
    if (!n) { homeError("اول نام خود را بنویس."); $("#nameInput").focus(); return null; }
    localStorage.setItem("nh_name", n);
    return n;
  }
  function genCode() {
    let s = "";
    for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }

  $("#btnQuick").onclick = async () => {
    homeError("");
    const n = readName(); if (!n) return;
    try {
      const r = await fetch("/api/quickplay");
      const j = await r.json();
      enter(j.code, n, true);
    } catch { homeError("اتصال به سرور برقرار نشد. دوباره تلاش کن."); }
  };
  $("#btnCreate").onclick = () => { homeError(""); const n = readName(); if (n) enter(genCode(), n, false); };
  $("#btnJoin").onclick = () => {
    homeError("");
    const n = readName(); if (!n) return;
    const c = $("#codeInput").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(c)) { homeError("کد اتاق درست نیست."); return; }
    enter(c, n, false);
  };
  $("#nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $(hashCode ? "#btnJoin" : "#btnQuick").click(); });
  $("#codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btnJoin").click(); });

  // when embedded in the cafe site, tell it which screen is showing
  function tellHost(v) { try { if (parent !== window) parent.postMessage({ dg: "screen", v }, "*"); } catch {} }
  tellHost("login");

  function enter(c, name, pub) {
    code = c; isPublic = pub; myName = name; leaving = false;
    location.hash = c;
    $("#home").classList.add("hidden");
    $("#game").classList.remove("hidden");
    tellHost("game");
    $("#roomCode").textContent = c;
    $("#msgs").innerHTML = "";
    clearCanvas();
    st = null;
    fitCanvas();
    renderAll();
    connect();
  }

  function backHome(msg) {
    leaving = true;
    try { ws && ws.close(); } catch {}
    clearInterval(pingTimer);
    st = null;
    history.replaceState(null, "", location.pathname);
    $("#game").classList.add("hidden");
    $("#home").classList.remove("hidden");
    tellHost("login");
    homeError(msg || "");
  }
  $("#btnLeave").onclick = () => backHome();

  /* ---------- اتصال ---------- */
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/${code}${isPublic ? "?public=1" : ""}`);
    ws.onopen = () => {
      send({ t: "join", name: myName, id: myId });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.send("ping"); } catch {} }, 25000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      onMsg(m);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (!leaving) setTimeout(() => { if (!leaving) connect(); }, 1500);
    };
  }
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

  function onMsg(m) {
    switch (m.t) {
      case "init": myId = m.you; sessionStorage.setItem("nh_pid", myId); break;
      case "strokes": clearCanvas(); for (const b of m.list) drawBatch(b); break;
      case "state": st = m; clockOff = m.now - Date.now(); renderAll(); break;
      case "chat": addChat(m); break;
      case "draw": drawBatch(m); break;
      case "clear": clearCanvas(); break;
      case "error": backHome(m.msg || "خطا در ورود به اتاق."); break;
    }
  }

  /* ---------- وضعیت‌ها ---------- */
  const amDrawer = () => !!st && st.drawerId === myId;
  const canDraw = () => amDrawer() && st.phase === "drawing";
  const me = () => st && st.players.find((p) => p.id === myId);
  const nameOf = (id) => (st && st.players.find((p) => p.id === id)?.name) || "";

  function renderAll() {
    renderStatus();
    renderPlayers();
    renderOverlay();
    renderTools();
    renderChatInput();
    tick();
  }

  function renderStatus() {
    const t = $("#turnLabel"), w = $("#wordArea");
    if (!st) { t.textContent = "در حال اتصال..."; w.innerHTML = ""; return; }
    if (st.phase === "lobby") { t.innerHTML = "<b>لابی</b><small>منتظر شروع بازی</small>"; }
    else if (st.phase === "gameEnd") { t.innerHTML = "<b>پایان بازی</b>"; }
    else { t.innerHTML = `نوبت: <b>${esc(nameOf(st.drawerId))}</b><small>دور ${fa(st.round)} از ${fa(st.rounds)}</small>`; }

    if (st.phase === "drawing") {
      if (st.word) w.innerHTML = `<span class="full">${esc(st.word)}</span>`;
      else w.innerHTML = (st.hint || []).map((c) => (c === " " ? '<i class="sp"></i>' : c === "_" ? "<i>&nbsp;</i>" : `<i class="rev">${esc(c)}</i>`)).join("");
    } else if (st.phase === "roundEnd") {
      w.innerHTML = `<span class="full">${esc(st.lastWord || "")}</span>`;
    } else if (st.phase === "choosing") {
      w.innerHTML = `<span class="info">${amDrawer() ? "کلمه را انتخاب کن" : "کلمه در حال انتخاب است"}</span>`;
    } else {
      w.innerHTML = "";
    }
  }

  function renderPlayers() {
    const box = $("#players");
    if (!st) { box.innerHTML = ""; return; }
    const list = st.players.slice().sort((a, b) => b.score - a.score);
    box.innerHTML = list.map((p) => {
      const badges =
        (p.id === st.drawerId && (st.phase === "drawing" || st.phase === "choosing") ? '<span class="badge">نقاش</span>' : "") +
        (p.guessed && st.phase === "drawing" ? '<span class="badge ok">✓</span>' : "") +
        (st.phase === "lobby" && p.id === st.hostId ? '<span class="badge host">میزبان</span>' : "");
      const isMe = p.id === myId ? " <small>(شما)</small>" : "";
      return `<div class="p${p.id === st.drawerId && (st.phase === "drawing" || st.phase === "choosing") ? " drawer" : ""}${p.connected ? "" : " off"}">
        <div class="av" style="background:${p.color}">${esc(Array.from(p.name)[0] || "?")}</div>
        <div class="nm">${esc(p.name)}${isMe}${badges}</div>
        <div class="sc">${fa(p.score)}</div></div>`;
    }).join("");
  }

  function renderOverlay() {
    const o = $("#overlay");
    if (!st) { o.classList.add("hidden"); return; }
    let html = "";
    if (st.phase === "lobby") {
      const connected = st.players.filter((p) => p.connected).length;
      const host = st.hostId === myId;
      html = `<h3>منتظر بازیکنان</h3>
        <p>کد اتاق را برای دوستانت بفرست</p>
        <div class="code">${esc(st.code)}</div>
        <button class="btn" data-act="copy">کپی لینک دعوت</button>`;
      if (host) {
        html += `<div class="set">
          <label>تعداد دور <select data-set="rounds">${[1, 2, 3, 4, 5, 6, 8, 10].map((n) => `<option value="${n}"${n === st.rounds ? " selected" : ""}>${fa(n)}</option>`).join("")}</select></label>
          <label>زمان نقاشی <select data-set="drawTime">${[30, 45, 60, 80, 100, 120, 180].map((n) => `<option value="${n}"${n === st.drawTime ? " selected" : ""}>${fa(n)} ثانیه</option>`).join("")}</select></label>
        </div>
        <button class="btn primary" data-act="start"${connected < 2 ? " disabled" : ""}>شروع بازی</button>
        ${connected < 2 ? "<p>برای شروع حداقل دو بازیکن لازم است</p>" : ""}`;
      } else {
        html += `<p>منتظر میزبان برای شروع بازی...</p>`;
      }
    } else if (st.phase === "choosing") {
      if (amDrawer()) {
        html = `<h3>یک کلمه انتخاب کن</h3><div class="opts">${(st.options || []).map((w, i) => `<button class="btn" data-act="choose" data-i="${i}">${esc(w)}</button>`).join("")}</div>`;
      } else {
        html = `<h3>${esc(nameOf(st.drawerId))} در حال انتخاب کلمه است</h3>`;
      }
    } else if (st.phase === "roundEnd") {
      const rows = st.players.filter((p) => st.gains[p.id]).sort((a, b) => st.gains[b.id] - st.gains[a.id]);
      html = `<h3>کلمه «${esc(st.lastWord || "")}» بود</h3>
        <div class="rank">${rows.length ? rows.map((p) => `<div><span>${esc(p.name)}</span><span class="g">+${fa(st.gains[p.id])}</span></div>`).join("") : "<p>کسی حدس نزد</p>"}</div>`;
    } else if (st.phase === "gameEnd") {
      const list = st.players.slice().sort((a, b) => b.score - a.score);
      html = `<h3>پایان بازی</h3>
        <div class="rank">${list.map((p, i) => `<div class="${i === 0 ? "first" : ""}"><span>${fa(i + 1)}. ${esc(p.name)}</span><span>${fa(p.score)}</span></div>`).join("")}</div>
        <p>چند ثانیه دیگر به لابی برمی‌گردی</p>`;
    }
    o.innerHTML = html;
    o.classList.toggle("hidden", !html);
  }

  $("#overlay").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const a = b.dataset.act;
    if (a === "start") send({ t: "start" });
    else if (a === "choose") send({ t: "chooseWord", index: Number(b.dataset.i) });
    else if (a === "copy") {
      const url = location.origin + "/#" + code;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => { b.textContent = "کپی شد"; }, () => { b.textContent = url; });
    }
  });
  $("#overlay").addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-set]"); if (!sel) return;
    const cur = { t: "settings", rounds: st.rounds, drawTime: st.drawTime };
    cur[sel.dataset.set] = Number(sel.value);
    send(cur);
  });

  function renderTools() {
    const on = canDraw();
    $("#tools").classList.toggle("off", !on);
    canvas.classList.toggle("draw", on);
  }

  function renderChatInput() {
    const inp = $("#chatInput");
    if (!st) return;
    const blocked = st.phase === "drawing" && amDrawer();
    inp.disabled = blocked;
    inp.placeholder = blocked ? "تو نقاشی..." : st.phase === "drawing" && me()?.guessed ? "با بقیهٔ حدس‌زننده‌ها چت کن..." : st.phase === "drawing" ? "حدس بزن..." : "پیام بنویس...";
  }

  /* ---------- زمان ---------- */
  function tick() {
    const tt = $("#timeText"), bar = $("#barFill");
    if (!st || !(st.phase === "drawing" || st.phase === "choosing")) { tt.textContent = ""; bar.style.width = "0"; return; }
    const left = Math.max(0, st.endsAt - (Date.now() + clockOff));
    tt.textContent = fa(Math.ceil(left / 1000)) + " ثانیه";
    const frac = st.total ? Math.min(1, left / st.total) : 0;
    bar.style.width = (frac * 100).toFixed(1) + "%";
    bar.classList.toggle("low", frac < 0.2);
  }
  setInterval(tick, 250);

  /* ---------- چت ---------- */
  function addChat(m) {
    const box = $("#msgs");
    const d = document.createElement("div");
    d.className = "m " + (m.kind === "msg" ? "" : m.kind);
    d.innerHTML = m.name ? `<b>${esc(m.name)}:</b> ${esc(m.text)}` : esc(m.text);
    box.appendChild(d);
    while (box.children.length > 120) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  $("#chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $("#chatInput");
    const text = inp.value.trim();
    if (!text || inp.disabled) return;
    send({ t: "chat", text });
    inp.value = "";
  });

  /* ---------- ابزارها ---------- */
  $("#swatches").innerHTML = COLORS.map((c, i) => `<button class="sw${i === 0 ? " sel" : ""}" data-c="${c}" style="background:${c}" title="${c === "#ffffff" ? "پاک‌کن" : ""}"></button>`).join("");
  $("#sizes").innerHTML = SIZES.map((s, i) => `<button class="ring${i === 1 ? " sel" : ""}" data-s="${s}"><i style="width:${Math.max(6, s * 0.85)}px;height:${Math.max(6, s * 0.85)}px"></i></button>`).join("");
  $("#swatches").addEventListener("click", (e) => {
    const b = e.target.closest(".sw"); if (!b) return;
    color = b.dataset.c;
    document.querySelectorAll(".sw").forEach((x) => x.classList.toggle("sel", x === b));
  });
  $("#sizes").addEventListener("click", (e) => {
    const b = e.target.closest(".ring"); if (!b) return;
    size = Number(b.dataset.s);
    document.querySelectorAll(".ring").forEach((x) => x.classList.toggle("sel", x === b));
  });
  $("#btnClear").onclick = () => { if (!canDraw()) return; clearCanvas(); send({ t: "clear" }); };

  /* ---------- بوم ---------- */
  function clearCanvas() { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); }
  function line(x0, y0, x1, y1, c, w) {
    ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  function drawBatch(b) { for (const s of b.s) line(s[0], s[1], s[2], s[3], b.c, b.w); }

  function fitCanvas() {
    const wrap = $("#canvasWrap");
    const aw = wrap.clientWidth, ah = wrap.clientHeight;
    if (!aw || !ah) return;
    const w = Math.floor(Math.min(aw - 8, (ah - 8) * (W / H)));
    canvas.style.width = w + "px";
    canvas.style.height = Math.floor(w * H / W) + "px";
    $("#overlay").style.fontSize = Math.max(9, w / 56) + "px";
  }
  window.addEventListener("resize", fitCanvas);
  new ResizeObserver(fitCanvas).observe($("#canvasWrap"));

  let drawing = false, last = null, buf = [], flushT = null;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) * W) / r.width), Math.round(((e.clientY - r.top) * H) / r.height)];
  };
  function flush() {
    clearTimeout(flushT); flushT = null;
    if (!buf.length) return;
    send({ t: "draw", s: buf, c: color, w: size });
    buf = [];
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (!canDraw()) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    last = pos(e);
    line(last[0], last[1], last[0], last[1], color, size);
    buf.push([last[0], last[1], last[0], last[1]]);
    if (!flushT) flushT = setTimeout(flush, 40);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    if (p[0] === last[0] && p[1] === last[1]) return;
    line(last[0], last[1], p[0], p[1], color, size);
    buf.push([last[0], last[1], p[0], p[1]]);
    last = p;
    if (buf.length >= 40) flush(); else if (!flushT) flushT = setTimeout(flush, 40);
  });
  const stop = () => { if (!drawing) return; drawing = false; flush(); send({ t: "strokeEnd" }); };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);

  clearCanvas();
  fitCanvas();
})();
