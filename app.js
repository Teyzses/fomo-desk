// Grok Bot desk app (STEP 10). Plain JS, no build step.
// Plan B (live): GitHub Pages serves this shell; the desk publishes AES-256-GCM files under d/<path>/<name>.enc
// (file = iv(12) || ciphertext+tag, AAD = the file name). The phone opens the private link once
// (<base>#d=<path>&k=<key>); both stay in localStorage, the fragment is wiped. Plan A: same shapes from /api with #t=.
// Every FOMO link shown here is the exact string links.py wrote into the data (field "link", "profileUrl",
// "inviteUrl"); this file never builds, edits or shortens one.
(function () {
  "use strict";
  const POLL_S = 15, STALE_S = 240, PLANB_LIVE_S = 150;  // plan B: publish gap 60 s + deploy ~25 s; frames reach the phone with it
  const BOTS = ["scanner", "analyst", "brain", "executor", "risk"];
  const COLOR = { scanner: "#64d2ff", analyst: "#ffd60a", brain: "#bf5af2", executor: "#00d35a", risk: "#ff6b9a" };
  const NAME = { scanner: "Scanner", analyst: "Analyst", brain: "Brain", executor: "Executor", risk: "Risk" };
  const RANGES = ["LIVE", "1H", "4H", "1D", "1W", "ALL"];
  const RM = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- 1. keys from the fragment, once ----------
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get("d") && frag.get("k")) { localStorage.setItem("desk.d", frag.get("d")); localStorage.setItem("desk.k", frag.get("k")); }
  if (frag.get("t")) localStorage.setItem("desk.t", frag.get("t"));
  if (frag.get("d") || frag.get("k") || frag.get("t")) history.replaceState(null, "", location.pathname + location.search + "#/home");
  const DP = localStorage.getItem("desk.d"), KEY = localStorage.getItem("desk.k"), TOK = localStorage.getItem("desk.t");
  const PLAN = DP && KEY ? "B" : TOK ? "A" : null;

  // ---------- 2. data ----------
  const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const keyP = PLAN === "B" && crypto.subtle ? crypto.subtle.importKey("raw", b64u(KEY), { name: "AES-GCM" }, false, ["decrypt"]) : null;

  async function raw(name) {                       // plan B: decrypted bytes of d/<path>/<name>.enc
    const r = await fetch(`d/${DP}/${name}.enc?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    const buf = new Uint8Array(await r.arrayBuffer());
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: new TextEncoder().encode(name) }, await keyP, buf.slice(12)));
  }
  async function api(path, opt) {                   // plan A
    const r = await fetch(path, { cache: "no-store", ...(opt || {}), headers: { Authorization: "Bearer " + TOK, "Content-Type": "application/json" } });
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    return (r.headers.get("content-type") || "").includes("json") ? r.json() : r.blob();
  }
  const J = (u8) => JSON.parse(new TextDecoder().decode(u8));
  const D = {
    async state() { return PLAN === "B" ? J(await raw("state.json")) : api("/api/state"); },
    async chart() {
      if (PLAN === "B") return J(await raw("chart.json"));
      const o = {}; o[S.range] = await api("/api/chart?range=" + S.range); return o;
    },
    async activity() { return PLAN === "B" ? J(await raw("activity.json")) : api("/api/activity"); },
    async bots() {
      if (PLAN === "B") return J(await raw("bots.json"));
      const o = {}; for (const b of BOTS) o[b] = await api(`/api/bots/${b}/decisions`); return o;
    },
    async account() { return PLAN === "B" ? J(await raw("account.json")) : api("/api/account"); },
    async coin(m) { return PLAN === "B" ? J(await raw(`coin/${m}.json`)) : api("/api/coin/" + encodeURIComponent(m)); },
    async screen() {
      if (PLAN === "B") return new Blob([await raw("screen.jpg")], { type: "image/jpeg" });
      return api("/api/screen.jpg");
    },
  };

  // ---------- 3. store: last good numbers survive errors and reloads ----------
  const S = { state: null, chart: null, activity: null, bots: null, account: null, coins: {}, range: "LIVE",
              err: null, lastOk: null, retryAt: 0, screenUrl: null, screenTs: null };
  for (const k of ["state", "chart", "activity", "bots", "account"]) {
    try { const v = localStorage.getItem("desk.cache." + k); if (v) S[k] = JSON.parse(v); } catch (e) { /* ignore */ }
  }
  const save = (k, v) => { S[k] = v; try { localStorage.setItem("desk.cache." + k, JSON.stringify(v)); } catch (e) { /* full */ } };

  // A single failed read is not "offline": phones blip, Pages swaps its CDN copy during a deploy (~25 s).
  // Offline = 3 failed reads in a row or no good read for 60 s. Retries come fast (3 s, 6 s), then every 15 s.
  // The last good numbers always stay on screen. "stale" = reads work but the desk has not published lately.
  const RETRY_S = [3, 6], OFFLINE_FAILS = 3, OFFLINE_S = 60;
  const T0 = Date.now();
  let fails = 0, timer = null, busy = false, lastRead = null;
  function schedule(s) { clearTimeout(timer); S.retryAt = Date.now() + s * 1000; timer = setTimeout(tick, s * 1000); }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (!PLAN) { S.err = "nolink"; return; }
      try {
        const st = await D.state();
        save("state", st);
        fails = 0; lastRead = Date.now();
        const age = Date.now() / 1000 - (st.ts || 0);
        S.err = age > STALE_S ? "stale" : null;
        S.lastOk = st.ts;
        const [c, a, b, ac] = await Promise.allSettled([D.chart(), D.activity(), D.bots(), D.account()]);
        if (c.status === "fulfilled") save("chart", { ...(S.chart || {}), ...c.value });
        if (a.status === "fulfilled") save("activity", a.value);
        if (b.status === "fulfilled") save("bots", b.value);
        if (ac.status === "fulfilled") save("account", ac.value);
        if (st.screenTs && st.screenTs !== S.screenTs) loadScreen(st.screenTs);
      } catch (e) {
        fails++;
        if (S.state) S.lastOk = S.state.ts;
        if (fails >= OFFLINE_FAILS || Date.now() - (lastRead || T0) > OFFLINE_S * 1000)
          S.err = e.name === "OperationError" ? "key" : "offline";
      }
    } finally {
      busy = false;
      if (PLAN) schedule(fails ? (RETRY_S[fails - 1] || POLL_S) : POLL_S);
      render();
    }
  }

  async function loadScreen(ts) {
    try {
      const blob = await D.screen();
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const old = S.screenUrl; S.screenUrl = url; S.screenTs = ts; paintScreen();
        if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
      };
      img.src = url;
    } catch (e) { /* keep the last frame */ }
  }

  // ---------- 4. formatting (never a made-up number: null shows "—") ----------
  const money = (v, sign) => v == null ? "—" : (sign && v > 0 ? "+" : v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v, d = 2) => v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(d) + "%";
  const big = (v) => v == null ? "—" : v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : "$" + v.toFixed(0);
  const intf = (v) => v == null ? "—" : Number(v).toLocaleString("en-US");
  function price(v) {
    if (v == null) return "—";
    if (v >= 1) return "$" + v.toFixed(4);
    const s = v.toPrecision(4);                      // 0.0003653
    return "$" + (s.includes("e") ? Number(s).toFixed(12).replace(/0+$/, "") : s);
  }
  const hhmm = (ts) => ts == null ? "—" : new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const hhmmss = (ts) => ts == null ? "—" : new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const age = (h) => h == null ? null : h < 1 ? Math.round(h * 60) + "m old" : h < 48 ? Math.round(h) + "h old" : Math.round(h / 24) + "d old";
  const symOf = (o) => o && (o.symbol || o.name || (o.mint ? o.mint.slice(0, 6) : "?"));
  const isFomo = (u) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === "fomo.family"; } catch (e) { return false; } };

  function agoCp(ts) {
    if (!ts) return "—";
    const sec = Date.now() / 1000 - ts;
    if (sec < 60) return "just now";
    if (sec < 3600) return Math.floor(sec / 60) + "m ago";
    if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
    return Math.floor(sec / 86400) + "d ago";
  }
  function copyPicksHtml(ac) {
    const cp = ac.copyPicks || {}, every = cp.every || "off", time = cp.time || "21:30";
    const slots = (cp.slots || []).join(", ");
    const mode = cp.tradeMode || cp.copyMode || "PAPER";
    const traders = cp.traders || [], hist = cp.history || [];
    const everySel = ["off", "24h", "12h", "6h"].map(o => `<option ${every === o ? "selected" : ""}>${o}</option>`).join("");
    const cards = traders.map(t => {
      const buy = t.lastBuy, prof = t.profileUrl, on = !!t.copyOnDesk;
      const buyRow = buy
        ? (isFomo(buy.url)
            ? `<a class="row tap" href="${esc(buy.url)}" target="_blank" rel="noopener noreferrer"><div class="rmain"><div class="rt">${esc(buy.plain ? (buy.symbol || "Last buy") : ("Last buy · " + (buy.symbol || "")))}${buy.mcap != null ? " · " + money(buy.mcap) : ""}</div></div><span class="ter">›</span></a>`
            : `<div class="row"><div class="rmain"><div class="rt">${esc(buy.symbol || "Last buy")}</div></div></div>`)
        : "";
      const profile = isFomo(prof)
        ? `<a class="row tap" href="${esc(prof)}" target="_blank" rel="noopener noreferrer"><div class="rmain"><div class="rt">Profile</div><div class="rs">@${esc(t.handle)}</div></div><span class="ter">›</span></a>`
        : "";
      return `<div class="card" style="background:#1c1c1e;margin-top:10px">
        <div class="setrow"><span class="rt">#${t.rank || ""} @${esc(t.handle)}</span><span class="sec" style="color:var(--green)">7d ${money(t.pnl7d, true)} · 30d ${money(t.pnl30d, true)}</span></div>
        <div class="rs" style="margin-top:4px">${t.trades || 0} trades · last trade ${esc(agoCp(t.lastTradeTs))}</div>
        <div class="rs">${esc(t.why || "")}</div>
        <div class="list plain" style="margin-top:8px">${profile}${buyRow}
          <button class="row tap" data-copy="${esc(t.handle)}" data-on="${on ? "1" : "0"}" style="width:100%;text-align:left"><div class="rmain"><div class="rt">Copy on desk</div><div class="rs">${on ? "On" : "Off"}</div></div><span class="sdot" style="background:${on ? "var(--green)" : "#636366"}"></span></button>
        </div></div>`;
    }).join("");
    const histHtml = hist.length
      ? `<div class="grp">Last 7 lists</div><div class="card">${hist.map(h => `<div class="setrow"><span class="sec">${h.ts ? new Date(h.ts * 1000).toLocaleString() : "—"}</span><span class="rs">${esc((h.handles || []).map(x => "@" + x).join(" · ") || "—")}</span></div>`).join("")}</div>`
      : "";
    return `<div class="card"><div class="setrow"><span class="rt">Every</span><select id="cp">${everySel}</select></div>
      <div class="setrow" style="margin-top:8px"><span class="sec">Time</span><input type="text" id="cpt" value="${esc(time)}" inputmode="numeric" style="width:96px;background:var(--c2);border:0;border-radius:8px;color:#fff;font:500 15px var(--mono);padding:8px;text-align:right"></div>
      <div class="rs" style="margin-top:8px">${every !== "off" && slots ? every + " at " + slots + " · " : ""}${esc(mode)} copy${cp.liveReady ? " · paper test passed" : ""}</div></div>
      ${cards || `<div class="card" style="margin-top:10px"><div class="rs">No list yet. The desk sends one at the next slot, or send picks.</div></div>`}
      ${histHtml}`;
  }

  const fomoBtn = (u, label) => isFomo(u) ? `<a class="fomo" href="${esc(u)}" target="_blank" rel="noopener noreferrer" data-stop>${esc(label || "Open on FOMO")}</a>` : "";
  const paperPill = () => (S.state && S.state.mode === "LIVE") ? "" : `<span class="pill paper">PAPER</span>`;

  // odometer: changed digits roll 600 ms ease-out, 30 ms stagger; reduced motion swaps values
  function odo(el, text) {
    const old = el.dataset.v;
    if (old === text) return;
    el.dataset.v = text;
    const sameShape = old != null && old.length === text.length && [...old].every((c, i) => /\d/.test(c) === /\d/.test(text[i]) && (/\d/.test(c) || c === text[i]));
    if (!sameShape) {
      el.innerHTML = [...text].map(c => /\d/.test(c)
        ? `<span class="d"><span class="strip" style="transform:translateY(-${c}em)">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<span>${n}</span>`).join("")}</span></span>`
        : `<span class="c">${esc(c)}</span>`).join("");
      return;
    }
    const strips = $$(".strip", el); let k = 0, di = 0;
    [...text].forEach((c, i) => {
      if (!/\d/.test(c)) return;
      const st = strips[di++];
      if (old[i] !== c) { st.style.transitionDelay = RM() ? "0ms" : (k++ * 30) + "ms"; st.style.transform = `translateY(-${c}em)`; }
    });
  }

  // ---------- 5. router + chrome ----------
  const view = $("#view");
  let cur = null;
  function route() {
    const h = location.hash.replace(/^#\/?/, "") || "home";
    const [name, arg] = h.split("/");
    return { name: ["home", "bots", "activity", "account", "coin", "audit", "search"].includes(name) ? name : "home", arg: arg && decodeURIComponent(arg) };
  }
  window.addEventListener("hashchange", () => { $("#sheet").hidden = true; const f = $("#full"); if (f) f.remove(); cur = null; window.scrollTo(0, 0); render(true); });
  $$("#tabbar button").forEach(b => b.addEventListener("click", () => { location.hash = "#/" + b.dataset.tab; }));

  function errRow() {
    const el = $("#errrow");
    if (!S.err) { el.hidden = true; return; }
    el.hidden = false;
    const n = Math.max(0, Math.ceil((S.retryAt - Date.now()) / 1000));
    if (S.err === "nolink") el.textContent = "Open the private desk link once on this phone";
    else if (S.err === "key") el.textContent = `Desk offline · key refused, open the desk link again · retrying in ${n}s`;
    else if (S.err === "stale") {
      const m = S.lastOk ? Math.max(1, Math.round((Date.now() / 1000 - S.lastOk) / 60)) : null;
      el.textContent = `Desk not publishing · no new data for ${m ? m + " min" : "a while"} · last update ${S.lastOk ? hhmmss(S.lastOk) : "never"}`;
    }
    else el.textContent = `Desk offline · retrying in ${n}s · last update ${S.lastOk ? hhmmss(S.lastOk) : "never"}`;
  }
  setInterval(errRow, 1000);

  function render(force) {
    errRow();
    const r = route();
    $$("#tabbar button").forEach(b => b.classList.toggle("on", b.dataset.tab === (["coin", "audit", "search"].includes(r.name) ? "" : r.name)));
    const key = r.name + "/" + (r.arg || "");
    if (force || cur !== key) { cur = key; VIEWS[r.name].mount(r.arg); }
    VIEWS[r.name].update(r.arg);
  }

  // ---------- 6. sheets ----------
  function sheet(html, bind) {
    const w = $("#sheet"), s = $(".sheet", w);
    s.innerHTML = `<div class="grab"></div>` + html;
    w.hidden = false;
    const close = () => { w.hidden = true; s.innerHTML = ""; };
    $(".sheet-bg", w).onclick = close;
    $$("[data-close]", s).forEach(b => b.onclick = close);
    if (bind) bind(s, close);
  }
  function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(el.__t); el.__t = setTimeout(() => el.hidden = true, 1800); }
  async function copy(t) {
    try { await navigator.clipboard.writeText(t); return true; }
    catch (e) { const a = document.createElement("textarea"); a.value = t; document.body.appendChild(a); a.select(); const ok = document.execCommand("copy"); a.remove(); return ok; }
  }
  // plan B has no way back to the desk from a static page: actions become the STEP 11 Telegram command
  function planBCommand(title, cmd, why, tgStart) {
    const bot = S.account && S.account.telegramBot;
    const tg = bot && tgStart && /^[A-Za-z0-9_-]{1,64}$/.test(tgStart) && /^[A-Za-z0-9_]{5,32}$/.test(bot) ? `https://t.me/${bot}?start=${tgStart}` : null;
    sheet(`<h3>${esc(title)}</h3>
      <p class="note">Plan B: the app is read-only (GitHub Pages can't reach the desk). ${esc(why || "Send this to the desk on Telegram (STEP 11):")}</p>
      <div class="cmd">${esc(cmd)}</div>
      ${tg ? `<p class="note">Or open Telegram: the desk asks you Yes or No before it changes anything.</p>` : ""}
      <div class="btns"><button class="btn" data-close>Close</button><button class="btn${tg ? "" : " primary"}" id="cp">Copy</button>${tg ? `<a class="btn primary" id="tg" href="${esc(tg)}" target="_blank" rel="noopener noreferrer">Telegram</a>` : ""}</div>`,
      (s, close) => { $("#cp", s).onclick = async () => { if (await copy(cmd)) toast("Copied"); close(); }; if (tg) $("#tg", s).onclick = () => setTimeout(close, 300); });
  }
  // STEP 12: same payload as commands.encode_set (set-<group>-<name>-<value>; . -> d, leading - -> m, : -> c)
  function encodeSet(key, v) {
    let t = v === true ? "on" : v === false ? "off" : String(v);
    if (t.startsWith("-")) t = "m" + t.slice(1);
    t = t.replace(/\./g, "d").replace(/:/g, "c");
    const out = "set-" + key.replace(".", "-") + "-" + t;
    return /^[A-Za-z0-9_-]{1,64}$/.test(out) ? out : null;
  }

  // ---------- 7. shared pieces ----------
  function nav(opts) {
    const st = S.state, a = S.activity, seen = Number(localStorage.getItem("desk.seen") || 0);
    const newest = a && a.items && a.items[0] ? a.items[0].id : 0;
    return `<div class="nav">
      <button class="avatar" data-go="account" aria-label="Account">K</button>
      <button class="navtitle" data-go="bots">Grok Bot <span class="chev">›</span></button>
      <span class="navsp"></span>
      <button class="iconbtn" data-go="search" aria-label="Search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></button>
      <button class="iconbtn" data-go="activity" aria-label="Notifications"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>${newest > seen ? '<span class="dot"></span>' : ""}</button>
    </div>`;
  }
  function backBar(title) {
    return `<div class="nav"><button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"/></svg>${esc(title || "Back")}</button><span class="navsp"></span></div>`;
  }
  function wire(root) {
    $$("[data-go]", root).forEach(b => b.onclick = () => { location.hash = "#/" + b.dataset.go; });
    $$("[data-back]", root).forEach(b => b.onclick = () => history.length > 1 ? history.back() : (location.hash = "#/home"));
    $$("[data-stop]", root).forEach(b => b.addEventListener("click", e => e.stopPropagation()));
  }
  const skel = (h, w, mt) => `<div class="skel" style="height:${h}px;${w ? "width:" + w + ";" : ""}margin-top:${mt || 0}px"></div>`;

  function actRow(it) {
    const bot = it.bot || "executor", col = COLOR[bot] || "#8e8e93";
    const val = it.kind === "rejected" ? `<span class="sec">${esc(it.value || "Skipped")}</span>` :
      `<span class="${it.kind === "sold" ? "up" : it.kind === "stopped" ? "down" : ""}">${esc(it.value || "")}</span>`;
    return `<div class="row tap" data-open="${it.opens === "audit" ? "audit" : "coin"}" data-mint="${esc(it.mint)}">
      <div class="ricon" style="background:${col}22;color:${col}">${esc(symOf(it).slice(0, 2).toUpperCase())}</div>
      <div class="rmain"><div class="rt">${esc(it.title)}</div><div class="rs">${esc(it.subtitle)} · ${hhmm(it.ts)}</div></div>
      <div class="rv">${val}<br>${fomoBtn(it.link)}</div></div>`;
  }
  function wireRows(root) {
    $$("[data-open]", root).forEach(r => r.onclick = () => { location.hash = `#/${r.dataset.open}/${encodeURIComponent(r.dataset.mint)}`; });
  }

  function botCard(b) {
    const col = b.color || COLOR[b.bot], dot = `<span class="sdot" style="background:${b.status === "running" ? col : "#636366"}"></span>`;
    let body = "";
    if (b.bot === "scanner") {
      body = `<div class="bhl" style="color:${col}">${esc(b.headline)}</div><ul class="feed">${(b.feed || []).slice(0, 4).map(f =>
        `<li class="${f.verdict === "kill" ? "kill" : ""}"><span class="sym">${esc(symOf(f))}</span><span class="${f.verdict === "pass" ? "" : "sec"}">${esc(f.line)}</span></li>`).join("") || '<li class="sec">No pool yet</li>'}</ul>`;
    } else if (b.bot === "analyst") {
      const l = b.last;
      body = `<div class="bhl" style="color:${col}">${esc(b.headline)}</div>` + (l ? `
        <div style="display:flex;gap:12px;align-items:center"><canvas class="ring" data-score="${l.score == null ? "" : l.score}"></canvas>
        <div style="flex:1;min-width:0"><div class="rt">${esc(symOf(l))}</div>
        <div class="strips">${(l.layers || []).slice(0, 8).map(x => `<span class="${x.pass === true ? "ok" : x.pass === false ? "no" : ""}"></span>`).join("")}</div>
        <div class="rs">${l.social === "off" ? "Social: off" : "Social +" + esc(l.socialPts)}</div></div></div>` : '<div class="sec">Nothing taken apart yet</div>');
    } else if (b.bot === "brain") {
      body = `<div class="bhl" style="color:${col}">${esc(b.headline)}</div>
        <div class="rt">${b.last ? esc(symOf(b.last)) + " · " + esc(b.last.line) : '<span class="sec">No size yet</span>'}</div>
        <div class="pills"><span class="pill mono green">${esc(b.rule)}</span><span class="pill mono grey">${esc(b.ruleHalf)}</span></div>`;
    } else if (b.bot === "executor") {
      body = `<div class="bhl" style="color:${col}">${esc(b.headline)}</div>
        <div class="bar">${b.bar ? esc((b.bar.symbol ? b.bar.symbol + " · " : "") + b.bar.text) : '<span class="sec">Waiting for Brain</span>'}</div>`;
    } else if (b.bot === "risk") {
      body = `<div class="bhl" style="color:${col}">${esc(b.headline)}</div><div class="rs">${b.count ? b.count + " open position" + (b.count > 1 ? "s" : "") : "No open position"}</div>
        <div class="pills">${(b.pills || []).map(p => `<span class="pill mono ${p.color === "red" ? "red" : "green"}">${esc(p.text)}</span>`).join("")}</div>`;
    }
    return `<div class="bcard" data-go="bots"><div class="bhead">${dot}<span class="bname">${NAME[b.bot]}</span><span class="navsp"></span><span class="ter" style="font-size:12px">${esc(b.status)}</span></div>${body}</div>`;
  }
  function paintRings(root) { $$("canvas.ring", root).forEach(c => DeskChart.ring(c, c.dataset.score === "" ? null : Number(c.dataset.score))); }

  // ---------- 8. live screen ----------
  function screenTags() {
    const st = S.state; if (!st) return { l: "", r: "" };
    const ts = st.screenTs, a = ts ? Date.now() / 1000 - ts : Infinity;
    const liveS = PLAN === "B" ? PLANB_LIVE_S : 5;
    let l;
    if (st.screenLabel) l = `<span class="ldot grey"></span>${esc(st.screenLabel)}`;
    else if (!ts) l = `<span class="ldot grey"></span>No frame yet`;
    else if (a < liveS) l = `<span class="ldot"></span>Live · Bot's computer${PLAN === "B" ? " · ~1 min delay" : ""}`;
    else l = `<span class="ldot grey"></span>Last frame ${hhmm(ts)}`;
    const h = (st.lane && st.lane.holder) || "Idle", who = h.split(" ")[0].toLowerCase();
    const r = h === "Idle" ? `<span class="sec">Idle</span>` : `<span style="color:${COLOR[who] || "#fff"}">${esc(h)}</span>`;
    return { l, r };
  }
  function paintScreen() {
    const box = $("#scr"); if (!box) return;
    const imgs = $$("img", box), t = screenTags();
    $(".tl", box).innerHTML = t.l; $(".tr", box).innerHTML = t.r;
    if (!S.screenUrl) return;
    const front = imgs.find(i => i.style.opacity !== "0" && i.getAttribute("src")), back = imgs.find(i => i !== front) || imgs[1];
    if (front && front.getAttribute("src") === S.screenUrl) return;
    back.onload = () => { back.style.opacity = "1"; if (front) front.style.opacity = "0"; };   // double buffer: never flashes
    back.src = S.screenUrl;
    const fi = $("#full img"); if (fi) fi.src = S.screenUrl;
  }
  function checks(c) {
    const one = (k, n) => `<span class="chk"><i class="${c && c[k] === true ? "ok" : c && c[k] === false ? "no" : ""}">${c && c[k] === true ? "✓" : c && c[k] === false ? "✕" : "·"}</i>${n}</span>`;
    return `<span class="checks">${one("screen", "screen")}${one("api", "api")}${one("chain", "chain")}</span>`;
  }
  function lastOrderLine() {
    const o = S.state && S.state.lastOrder;
    if (!o) return `<div class="lastorder"><span class="sec">No order yet tonight</span></div>`;
    const verb = o.side === "sell" ? "Sold" : "Bought";
    const done = o.status === "done";
    const txt = done ? `${verb} ${symOf(o)} · ${money(o.fillUsd || o.usd)} · ${S.state.mode === "LIVE" ? "verified" : "paper"}` :
      `${o.side === "sell" ? "Sell" : "Buy"} ${symOf(o)} · ${money(o.usd)} · ${o.status}${o.error ? " · " + o.error : ""}`;
    return `<div class="lastorder"><span class="rt" style="flex:1">${esc(txt)}</span>${checks(o.checks)}</div>`;
  }
  function screenCoinLink() {
    const st = S.state; if (!st) return null;
    const ex = (st.bots || []).find(b => b.bot === "executor");
    return (ex && ex.bar && ex.bar.link) || (st.lastOrder && st.lastOrder.link) || null;
  }
  function openFull() {
    if (!S.screenUrl) return;
    const d = document.createElement("div"); d.className = "full"; d.id = "full";
    const t = screenTags();
    d.innerHTML = `<div class="bar2"><span class="tag" style="display:flex;gap:6px;align-items:center;font:600 13px var(--txt)">${t.l}</span>
      <button class="iconbtn" id="fx" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      <div class="stage"><img alt="Bot's computer" src="${S.screenUrl}"></div>
      <div class="bot">${screenCoinLink() ? `<a class="btn primary" href="${esc(screenCoinLink())}" target="_blank" rel="noopener noreferrer">Open on FOMO</a>` : '<div class="note" style="text-align:center">No coin on screen</div>'}</div>`;
    document.body.appendChild(d);
    const img = $("img", d), stage = $(".stage", d);
    let sc = 1, tx = 0, ty = 0; const pts = new Map(); let d0 = 0, s0 = 1, last = null;
    const apply = () => img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${sc})`;
    stage.addEventListener("pointerdown", e => { pts.set(e.pointerId, [e.clientX, e.clientY]); stage.setPointerCapture(e.pointerId); if (pts.size === 2) { const [a, b] = [...pts.values()]; d0 = Math.hypot(a[0] - b[0], a[1] - b[1]); s0 = sc; } last = [e.clientX, e.clientY]; });
    stage.addEventListener("pointermove", e => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) { const [a, b] = [...pts.values()]; sc = Math.max(1, Math.min(5, s0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / (d0 || 1))); }
      else if (sc > 1 && last) { tx += e.clientX - last[0]; ty += e.clientY - last[1]; }
      last = [e.clientX, e.clientY]; apply();
    });
    const up = e => { pts.delete(e.pointerId); if (sc <= 1) { sc = 1; tx = ty = 0; apply(); } };
    stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
    stage.addEventListener("dblclick", () => { sc = sc > 1 ? 1 : 2.5; tx = ty = 0; apply(); });
    const close = () => { d.remove(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
    $("#fx", d).onclick = close;
    if (d.requestFullscreen) d.requestFullscreen().then(() => screen.orientation && screen.orientation.unlock && screen.orientation.unlock()).catch(() => {});
  }

  // ---------- 9. views ----------
  const VIEWS = {};

  VIEWS.home = {
    mount() {
      view.innerHTML = nav() + `
        <div class="bal"><span class="big odo" id="balance"></span><span id="pp"></span></div>
        <div class="today" id="today"></div>
        <div class="chartbox"><canvas id="chart"></canvas><div id="chartSkel" class="skel" style="position:absolute;inset:24px 16px 12px"></div><div id="chartEmpty" class="empty" style="position:absolute;left:0;right:0;bottom:6px;padding:0" hidden>Waiting for the first trade</div></div>
        <div class="ranges" id="ranges">${RANGES.map(r => `<button data-r="${r}">${r}</button>`).join("")}</div>
        <div class="screen" id="scr"><img alt="" style="opacity:0"><img alt="" style="opacity:0"><span class="tag tl"></span><span class="tag tr"></span></div>
        <div id="lo"></div>
        <div class="sect"><h2 id="botsTitle">Bots</h2></div>
        <div class="carousel" id="car"></div>
        <div class="sect"><h2>Activity</h2><a href="#/activity">See all</a></div>
        <div id="act5"></div>`;
      wire(view);
      $$("#ranges button").forEach(b => b.onclick = () => { S.range = b.dataset.r; if (PLAN === "A") tick(); this.update(); });
      $("#scr").onclick = openFull;
      if (S.screenUrl) { $$("#scr img")[0].src = S.screenUrl; $$("#scr img")[0].style.opacity = "1"; }
    },
    update() {
      const st = S.state;
      if (!st) {
        $("#balance").innerHTML = skel(60, "220px"); $("#today").innerHTML = skel(18, "160px");
        $("#lo").innerHTML = skel(18); $("#car").innerHTML = [1, 2, 3].map(() => `<div class="bcard skel"></div>`).join("");
        $("#act5").innerHTML = `<div class="list">${[1, 2, 3].map(() => `<div class="row">${skel(36, "36px")}<div class="rmain">${skel(14, "60%")}${skel(12, "40%", 6)}</div></div>`).join("")}</div>`;
        return;
      }
      if ($("#balance .skel")) $("#balance").innerHTML = "";
      $("#chartSkel").hidden = true;
      odo($("#balance"), money(st.balance));
      $("#pp").innerHTML = paperPill();
      const up = (st.todayPct || 0) >= 0;
      $("#today").innerHTML = `<span class="${st.todayPct == null ? "sec" : up ? "up" : "down"}">${pct(st.todayPct)}</span><span class="sec">today</span>${st.multiplier != null ? `<span class="pill mult">${st.multiplier.toFixed(2)}×</span>` : ""}`;
      $$("#ranges button").forEach(b => b.classList.toggle("on", b.dataset.r === S.range));
      const ch = S.chart && S.chart[S.range];
      if (ch) DeskChart.line($("#chart"), ch.points || [], { start: ch.start, marks: ch.marks, range: S.range, color: "#00d35a" });
      const trades = (S.activity && S.activity.items || []).some(i => i.kind !== "rejected");
      $("#chartEmpty").hidden = trades || (ch && (ch.marks || []).length > 0);
      paintScreen();
      $("#lo").innerHTML = lastOrderLine();
      $("#botsTitle").textContent = `Bots · ${st.running != null ? st.running : 0} running`;
      const sx = $("#car").scrollLeft;
      $("#car").innerHTML = (st.bots || []).map(botCard).join("");
      $("#car").scrollLeft = sx; wire($("#car")); paintRings($("#car"));
      const items = (S.activity && S.activity.items || []).slice(0, 5);
      $("#act5").innerHTML = items.length ? `<div class="list">${items.map(actRow).join("")}</div>` : `<div class="card empty">Waiting for the first trade</div>`;
      wire($("#act5")); wireRows($("#act5"));
    },
  };

  VIEWS.activity = {
    mount() { view.innerHTML = nav() + `<h1 class="title">Activity</h1><div id="al"></div>`; wire(view); },
    update() {
      const a = S.activity;
      if (!a) { $("#al").innerHTML = `<div class="list">${[1, 2, 3, 4].map(() => `<div class="row">${skel(36, "36px")}<div class="rmain">${skel(14, "60%")}${skel(12, "40%", 6)}</div></div>`).join("")}</div>`; return; }
      const items = a.items || [];
      if (items[0]) { localStorage.setItem("desk.seen", items[0].id); $$(".iconbtn .dot").forEach(d => d.remove()); }
      $("#al").innerHTML = items.length ? `<div class="list">${items.map(actRow).join("")}</div>` +
        (a.next ? `<p class="note">Showing the newest ${items.length}. Plan B publishes 1 page.</p>` : "") : `<div class="card empty">Nothing yet tonight</div>`;
      wire($("#al")); wireRows($("#al"));
    },
  };

  VIEWS.bots = {
    mount() { view.innerHTML = nav() + `<h1 class="title">Bots</h1><div id="bl"></div>`; wire(view); },
    update() {
      const st = S.state, dec = S.bots || {};
      if (!st) { $("#bl").innerHTML = BOTS.map(() => `<div class="card skel" style="height:180px"></div>`).join(""); return; }
      $("#bl").innerHTML = (st.bots || []).map(b => {
        const col = b.color || COLOR[b.bot], paused = b.status === "paused", locked = b.bot === "risk" && b.pauseLocked;
        const items = ((dec[b.bot] || {}).items || []).slice(0, 20);
        return `<div class="card" id="bot-${b.bot}">
          <div class="setrow"><div style="display:flex;align-items:center;gap:8px"><span class="sdot" style="background:${b.status === "running" ? col : "#636366"}"></span>
            <span class="bname" style="font-size:17px">${NAME[b.bot]}</span></div>
            <button class="swwrap" data-pause="${b.bot}" aria-label="Pause ${NAME[b.bot]}" ${locked ? "data-locked" : ""}><span class="sw ${paused ? "" : "on"} ${locked ? "locked" : ""}"></span></button></div>
          <div class="rs" style="margin:2px 0 8px">${esc(b.status)} · ${esc(b.headline)}${b.count != null && b.bot !== "brain" ? "" : ""}${locked ? " · locked while a position is open" : ""}</div>
          <div class="list plain" style="background:var(--c2)">${items.length ? items.map(it => `
            <div class="row" style="min-height:52px"><div class="rmain"><div class="rt">${esc(symOf(it))}</div><div class="rs">${esc(it.line)} · ${hhmm(it.ts)}</div></div>${fomoBtn(it.link)}</div>`).join("") : `<div class="empty" style="padding:16px">No decision yet</div>`}</div>
          <div class="btns" style="margin-bottom:0"><a class="btn" href="#/account/${b.bot}">Settings</a></div></div>`;
      }).join("");
      wire($("#bl"));
      $$("[data-pause]", $("#bl")).forEach(btn => btn.onclick = async () => {
        const bot = btn.dataset.pause, card = (S.state.bots || []).find(x => x.bot === bot), paused = card.status === "paused";
        if (btn.hasAttribute("data-locked")) return toast("Risk can't pause while a position is open");
        if (PLAN === "B") return planBCommand(`${paused ? "Resume" : "Pause"} ${NAME[bot]}`, `${paused ? "resume" : "pause"} ${NAME[bot]}`);
        try { await api(`/api/bots/${bot}/${paused ? "resume" : "pause"}`, { method: "POST", body: "{}" }); tick(); } catch (e) { toast("Failed: " + e.message); }
      });
    },
  };

  VIEWS.search = {
    mount() {
      view.innerHTML = backBar("Home") + `<input class="search" id="q" placeholder="Name, symbol or mint" autocomplete="off" autocapitalize="off" spellcheck="false"><div id="sr" style="margin-top:12px"></div>`;
      wire(view); $("#q").oninput = () => this.update(); setTimeout(() => $("#q").focus(), 50);
    },
    update() {
      const q = ($("#q").value || "").trim().toLowerCase();
      const coins = new Map();
      const add = (o) => { if (o && o.mint && !coins.has(o.mint)) coins.set(o.mint, o); };
      ((S.state || {}).positions || []).forEach(add);
      ((S.activity || {}).items || []).forEach(add);
      ((S.state || {}).bots || []).forEach(b => (b.feed || []).forEach(add));
      Object.values(S.bots || {}).forEach(b => (b.items || []).forEach(add));
      const hits = [...coins.values()].filter(c => !q || [c.name, c.symbol, c.mint].some(v => v && String(v).toLowerCase().includes(q))).slice(0, 30);
      $("#sr").innerHTML = hits.length ? `<div class="list">${hits.map(c => `<div class="row tap" data-open="coin" data-mint="${esc(c.mint)}">
          <div class="ricon" style="background:var(--c2)">${esc(symOf(c).slice(0, 2).toUpperCase())}</div>
          <div class="rmain"><div class="rt">${esc(c.name || symOf(c))}</div><div class="rs">${esc(c.symbol || "")} · ${esc(c.mint.slice(0, 6) + "…" + c.mint.slice(-6))}</div></div>${fomoBtn(c.link)}</div>`).join("")}</div>`
        : `<div class="empty">${q ? "No coin from tonight matches" : "No coin yet tonight"}</div>`;
      wire($("#sr")); wireRows($("#sr"));
    },
  };

  async function getCoin(m) {
    try { const c = await D.coin(m); S.coins[m] = c; return c; }
    catch (e) { if (S.coins[m]) return S.coins[m]; throw e; }
  }
  function coinMissing(m) {
    const known = [...((S.activity || {}).items || []), ...((S.state || {}).bots || []).flatMap(b => b.feed || [])].find(x => x.mint === m);
    return `<div class="card empty">This coin isn't published.<br><span class="note">Plan B publishes open positions and tonight's Activity coins.</span><br>${known ? fomoBtn(known.link) : ""}</div>`;
  }

  VIEWS.coin = {
    mount(m) {
      view.innerHTML = backBar() + `<div id="cv">${skel(30, "60%")}${skel(16, "40%", 8)}${skel(56, "70%", 14)}${skel(220, null, 12)}${skel(50, null, 12)}</div>`;
      wire(view);
      getCoin(m).then(c => this.paint(c)).catch(() => { $("#cv").innerHTML = coinMissing(m); wire($("#cv")); });
    },
    update() {},
    paint(c) {
      const p = c.position, up = p && p.sinceEntryPct != null && p.sinceEntryPct >= 0;
      $("#cv").innerHTML = `
        <div class="coinhead"><span class="coinname">${esc(c.name || symOf(c))}</span>${paperPill()}</div>
        <div class="rs" style="display:flex;align-items:center;gap:8px;margin-top:4px">${esc([c.symbol, c.chain, age(c.ageH)].filter(Boolean).join(" · "))}
          ${c.shield ? `<button class="chip" id="shield" style="min-height:30px"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z"/></svg>${esc(c.shield)}</button>` : ""}</div>
        <div class="price">${price(c.price)}</div>
        <div class="${p ? (up ? "up" : "down") : "sec"}" style="font-size:15px">${p && p.sinceEntryPct != null ? (up ? "▲ " : "▼ ") + Math.abs(p.sinceEntryPct).toFixed(1) + "% since entry" : "No position"}${c.priceTs ? `<span class="ter"> · ${hhmm(c.priceTs)}</span>` : ""}</div>
        <div class="chartbox" style="height:200px"><canvas id="cc"></canvas></div>
        <div class="stats"><div class="stat"><div class="k">Market cap</div><div class="v">${big(c.marketCap)}</div></div>
          <div class="stat"><div class="k">Liquidity</div><div class="v">${big(c.liquidityUsd)}</div></div>
          <div class="stat"><div class="k">Holders</div><div class="v">${intf(c.holders)}</div></div></div>
        ${p ? `<div class="card"><div class="k sec" style="font-size:13px">Your position</div><div class="rt">${esc(money(p.sizeUsd))} in · Executor</div>
          <div class="rs">${p.valueUsd != null ? "now " + money(p.valueUsd) + " · " : ""}${p.pnlUsd != null ? money(p.pnlUsd, true) : ""}</div></div>` : ""}
        <div class="btns">${isFomo(c.link) ? `<a class="btn" href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">Open on FOMO</a>` : ""}
          <button class="btn danger" id="sell" ${p ? "" : "disabled"}>Sell now</button></div>
        ${c.candles && c.candles.length ? "" : '<p class="note">No 1-minute prices for this coin yet.</p>'}`;
      DeskChart.candles($("#cc"), c.candles || [], { exitLine: c.exitLine });
      const sh = $("#shield"); if (sh) sh.onclick = () => { location.hash = "#/audit/" + encodeURIComponent(c.mint); };
      $("#sell").onclick = () => sellSheet(c);
    },
  };

  function sellSheet(c) {
    let pctSel = 100;
    sheet(`<h3>Sell ${esc(symOf(c))}</h3>
      <div class="seg" style="margin:12px 0">${[25, 50, 100].map(n => `<button data-p="${n}" class="${n === 100 ? "on" : ""}">${n}%</button>`).join("")}</div>
      <div class="btns"><button class="btn" data-close>Cancel</button><button class="btn danger" id="cs">Confirm sell</button></div>`,
      (s, close) => {
        $$("[data-p]", s).forEach(b => b.onclick = () => { pctSel = Number(b.dataset.p); $$("[data-p]", s).forEach(x => x.classList.toggle("on", x === b)); });
        $("#cs", s).onclick = async () => {
          close();
          if (PLAN === "B") return planBCommand(`Sell ${pctSel}% of ${symOf(c)}`, `sell ${c.symbol || c.mint} ${pctSel}`);
          try { await api("/api/sell/" + encodeURIComponent(c.mint), { method: "POST", body: JSON.stringify({ pct: pctSel, confirm: true }) }); toast("Executor is selling"); }
          catch (e) { toast("Failed: " + e.message); }
        };
      });
  }

  VIEWS.audit = {
    mount(m) {
      view.innerHTML = backBar() + `<div id="av">${skel(280, "280px")}${skel(300, null, 12)}</div>`;
      wire(view);
      getCoin(m).then(c => this.paint(c)).catch(() => { $("#av").innerHTML = coinMissing(m); wire($("#av")); });
    },
    update() {},
    paint(c) {
      const a = c.audit || {}, L = (a.layers || []).slice(0, 8);
      while (L.length < 8) L.push({ n: L.length + 1, name: "—", value: "not checked", pass: null });
      const R = 112, pos = L.map((_, i) => { const t = -Math.PI / 2 + i * Math.PI / 4; return [140 + R * Math.cos(t), 140 + R * Math.sin(t), t]; });
      $("#av").innerHTML = `
        <div class="coinhead"><span class="coinname">${esc(c.name || symOf(c))}</span><span class="chip">${esc((a.passed != null ? a.passed : 0) + "/8")}</span></div>
        <div class="rs">${esc(a.pass === false ? "Rejected · " + (a.reason || "") : a.pass ? "Passed · score " + a.score : "")}</div>
        <div class="discs"><div class="beam" id="beam"></div>${L.map((l, i) => `<div class="disc" data-i="${i}" style="left:${pos[i][0]}px;top:${pos[i][1]}px">${l.n}</div>`).join("")}
          <div class="core">${esc(symOf(c))}</div></div>
        <div class="list plain">${L.map((l, i) => `<div class="row" data-row="${i}" style="min-height:52px;opacity:.35">
          <div class="rmain"><div class="rt">${l.n} · ${esc(l.name)}</div><div class="rs">${esc(l.source || "")}</div></div>
          <div class="rv ${l.pass === true ? "up" : l.pass === false ? "down" : "sec"}">${esc(l.value)} ${l.pass === true ? "✓" : l.pass === false ? "✕" : ""}</div></div>`).join("")}</div>
        <div class="card" style="margin-top:12px">${esc(a.socialLine || "Social: off")}</div>
        <div class="btns">${isFomo(c.link) ? `<a class="btn" href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">Open on FOMO</a>` : ""}<a class="btn" href="#/coin/${encodeURIComponent(c.mint)}">Coin</a></div>`;
      const beam = $("#beam"), reveal = (i) => {
        const l = L[i]; $(`.disc[data-i="${i}"]`).classList.add(l.pass === true ? "ok" : l.pass === false ? "no" : "na");
        $(`.disc[data-i="${i}"]`).textContent = l.pass === true ? "✓" : l.pass === false ? "✕" : "–";
        $(`[data-row="${i}"]`).style.opacity = "1";
      };
      if (RM()) { L.forEach((_, i) => reveal(i)); beam.style.display = "none"; return; }
      let i = 0;
      const step = () => {                    // the cyan beam reads each layer in turn
        if (!document.body.contains(beam)) return;
        if (i >= 8) { beam.style.opacity = "0"; return; }
        beam.style.transform = `rotate(${pos[i][2]}rad)`;
        const k = i; setTimeout(() => { reveal(k); }, 300);
        i++; setTimeout(step, 420);
      };
      setTimeout(step, 200);
    },
  };

  VIEWS.account = {
    mount(group) {
      view.innerHTML = nav() + `<h1 class="title">Account</h1><div id="acv"></div>`; wire(view); this.group = group; this.painted = false;
    },
    update() {
      const ac = S.account;
      if (!ac) { $("#acv").innerHTML = skel(120) + skel(200, null, 12); return; }
      if (this.painted && this.sig === JSON.stringify(ac)) return;      // don't reset a slider being moved
      this.sig = JSON.stringify(ac); this.painted = true;
      const tg = ac.telegram, groups = (ac.settings || {}).groups || {};
      const order = [...BOTS, ...Object.keys(groups).filter(g => !BOTS.includes(g))];
      $("#acv").innerHTML = `
        <div class="card"><div class="setrow"><span class="rt">Mode</span>${paperPill()}</div>
          <div class="seg" style="margin-top:10px"><button data-mode="PAPER" class="${ac.mode !== "LIVE" ? "on" : ""}">PAPER</button><button data-mode="LIVE" class="${ac.mode === "LIVE" ? "on" : ""}">LIVE</button></div>
          <div class="setrow" style="margin-top:12px"><span class="sec">Cash</span><span class="rt">${money(ac.cash)}</span></div>
          <div class="setrow"><span class="sec">Balance</span><span class="rt">${money(ac.balance)}</span></div></div>
        <div class="list plain">
          <a class="row tap" ${isFomo(ac.profileUrl) ? `href="${esc(ac.profileUrl)}" target="_blank" rel="noopener noreferrer"` : ""}><div class="rmain"><div class="rt">Your FOMO profile</div><div class="rs">${esc(ac.fomoHandle ? "@" + ac.fomoHandle : "handle not set")}</div></div><span class="ter">›</span></a>
          <button class="row tap" id="invite" style="width:100%;text-align:left"><div class="rmain"><div class="rt">Invite a friend</div><div class="rs">Share your FOMO invite link</div></div><span class="ter">›</span></button>
          <button class="row tap" id="watch" style="width:100%;text-align:left"><div class="rmain"><div class="rt">Watch in Grok Bot</div><div class="rs">The bot's own computer, live</div></div><span class="ter">›</span></button>
        </div>
        <div class="grp">Pushes</div>
        <div class="list plain">
          <div class="row"><div class="rmain"><div class="rt">Telegram</div><div class="rs">${tg ? "Connected" : "Not connected"}</div></div><span class="sdot" style="background:${tg ? "var(--green)" : "#636366"}"></span></div>
          <div class="row"><div class="rmain"><div class="rt">Phone notifications</div><div class="rs">Plan B: Telegram only</div></div></div>
          <button class="row tap" id="testpush" style="width:100%;text-align:left"><div class="rmain"><div class="rt" style="color:var(--blue)">Send test push</div></div></button>
        </div>
        <div class="grp">Copy picks</div>
        ${copyPicksHtml(ac)}
        ${PLAN === "B" ? `<p class="note">Plan B: the app shows the desk's numbers. A change becomes a Telegram command to send (STEP 11).</p>` : ""}
        ${order.filter(g => groups[g]).map(g => `<div class="grp" id="g-${g}">${esc(NAME[g] || g[0].toUpperCase() + g.slice(1))}</div><div class="card" style="padding:0">${groups[g].map(setRow).join("")}</div>`).join("")}
        <div class="grp">Setting changes</div>
        ${changesCard(ac)}
        <div class="grp">This phone</div>
        <div class="list plain"><div class="row"><div class="rmain"><div class="rt">Plan ${esc(PLAN || "—")}</div><div class="rs">${PLAN === "B" ? "GitHub Pages · data encrypted on the desk" : "Desk API"} · last update ${S.lastOk ? hhmmss(S.lastOk) : "—"}</div></div></div>
          <button class="row tap" id="forget" style="width:100%;text-align:left"><div class="rmain"><div class="rt" style="color:var(--red)">Forget this phone</div></div></button></div>`;
      this.wire(ac);
      if (this.group) { const g = $("#g-" + this.group); if (g) requestAnimationFrame(() => g.scrollIntoView({ block: "start" })); this.group = null; }
    },
    wire(ac) {
      const root = $("#acv");
      $$("[data-mode]", root).forEach(b => b.onclick = () => {
        if (b.dataset.mode === ac.mode) return;
        if (b.dataset.mode === "PAPER") return PLAN === "B" ? planBCommand("Back to PAPER", "paper") : api("/api/mode", { method: "POST", body: JSON.stringify({ mode: "PAPER" }) }).then(tick);
        sheet(`<h3>Switch to LIVE</h3><p class="note">Real money on FOMO. Type LIVE to confirm.</p>
          <input class="search" id="lv" autocomplete="off" autocapitalize="characters" placeholder="LIVE">
          <p class="note">${ac.liveUnlocked ? "" : esc("LIVE is locked: " + ((ac.liveBlockers || []).join("; ") || "STEP 15 hasn't passed") + ".")}</p>
          <div class="btns"><button class="btn" data-close>Cancel</button><button class="btn danger" id="go" disabled>Go LIVE</button></div>`, (s, close) => {
          $("#lv", s).oninput = (e) => { $("#go", s).disabled = !(e.target.value === "LIVE" && ac.liveUnlocked); };
          $("#go", s).onclick = () => { close(); if (PLAN === "B") return planBCommand("Go LIVE", "live"); api("/api/mode", { method: "POST", body: JSON.stringify({ mode: "LIVE", confirm: "LIVE" }) }).then(tick).catch(e => toast(e.message)); };
        });
      });
      $("#invite", root).onclick = async () => {
        const u = ac.inviteUrl; if (!isFomo(u)) return;
        if (navigator.share) { try { await navigator.share({ title: "FOMO", url: u }); return; } catch (e) { if (e.name === "AbortError") return; } }
        if (await copy(u)) toast("Link copied");
      };
      $("#watch", root).onclick = () => sheet(`<h3>Watch in Grok Bot</h3><p class="note">Open the Grok Bot app, then this desk's chat, then the computer preview: you see the bot's Chrome live and can take control there.</p><div class="btns"><button class="btn" data-close>OK</button></div>`);
      $("#testpush", root).onclick = () => PLAN === "B" ? planBCommand("Send test push", "status", "Telegram commands come in STEP 11. Send this to the desk bot to get a reply on your phone:") : toast("Plan A: test push from the desk");
      const cpt = $("#cpt", root), cp = $("#cp", root);
      if (cp) cp.onchange = (e) => PLAN === "B" && planBCommand("Copy picks", `set copy_picks to ${e.target.value} ${cpt ? cpt.value : "21:30"}`);
      $$("[data-copy]", root).forEach(btn => btn.onclick = () => {
        const h = btn.dataset.copy, on = btn.dataset.on === "1";
        const cmd = on ? `copy off ${h}` : `copy on ${h}`;
        if (PLAN === "B") planBCommand("Copy on desk", cmd);
      });
      $("#forget", root).onclick = () => sheet(`<h3>Forget this phone?</h3><p class="note">The private link and the cached numbers are removed from this phone. You'll need the link again.</p><div class="btns"><button class="btn" data-close>Cancel</button><button class="btn danger" id="fg">Forget</button></div>`,
        (s) => { $("#fg", s).onclick = () => { Object.keys(localStorage).filter(k => k.startsWith("desk.")).forEach(k => localStorage.removeItem(k)); location.replace(location.pathname); }; });
      $$("[data-key]", root).forEach(el => {
        const key = el.dataset.key, rng = $("input[type=range]", el), num = $("input[type=number]", el), commit = (v) => {
          const name = key.split(".").slice(1).join(".").replace(/_/g, " "), it = findSetting(ac, key);
          if (it && it.min != null && (typeof v !== "number" || isNaN(v) || v < it.min || v > it.max)) {   // out of range: refuse, say the range
            toast(`${name}: from ${it.min} to ${it.max}`);
            if (num) num.value = it.value; if (rng) rng.value = it.value; return;
          }
          if (it && it.value === v) return;
          const deep = it && (it.min != null || ["hhmm", "bool", "choice"].includes(it.kind)) ? encodeSet(key, v) : null;
          if (PLAN === "B" && it) { if (num) num.value = it.value; if (rng) rng.value = it.value; if (document.activeElement) document.activeElement.blur(); }   // the app keeps showing the desk's number until the desk changes it
          if (PLAN === "B") return planBCommand(`Change ${name}`, `set ${key} to ${v}`, it && it.atStart ? "Applies at the next desk start. Send this to the desk on Telegram:" : null, deep);
          api("/api/settings", { method: "POST", body: JSON.stringify({ [key]: v }) }).then(() => { toast("Saved"); tick(); }).catch(e => toast(e.message));
        };
        if (rng) { rng.oninput = () => { num.value = rng.value; }; rng.onchange = () => commit(Number(rng.value)); }
        if (num) num.onchange = () => { if (rng) rng.value = num.value; commit(Number(num.value)); };
        const other = $("select,input[type=text],input[type=checkbox]", el);
        if (other && !rng) other.onchange = () => commit(other.type === "checkbox" ? other.checked : other.value);
      });
    },
  };
  function findSetting(ac, key) {
    const groups = (ac.settings || {}).groups || {};
    for (const g in groups) for (const it of groups[g]) if (it.key === key) return it;
    return null;
  }
  function changesCard(ac) {
    const ch = ac.changes || [];
    if (!ch.length) return `<div class="card"><span class="sec">No setting changed yet: every number is the default.</span></div>`;
    const v = (x) => x === null || x === undefined ? "—" : typeof x === "object" ? JSON.stringify(x) : String(x);
    return `<div class="list plain">${ch.map(c => `<div class="row"><div class="rmain"><div class="rt">${esc(c.key.replace(".", " · ").replace(/_/g, " "))}</div>
      <div class="rs">${esc(v(c.old))} → ${esc(v(c.new))} · ${esc(c.who)} · ${hhmmss(c.ts)}</div></div></div>`).join("")}</div>`;
  }
  function setRow(it) {
    const name = it.name.replace(/_/g, " ");
    let ctl;
    if (it.readOnly) ctl = `<span class="sec ro">${esc(it.value)}</span>`;
    else if (it.min != null) ctl = `<input type="number" value="${esc(it.value)}" min="${it.min}" max="${it.max}" step="${it.step}">`;
    else if (it.kind === "choice") ctl = `<select>${(it.choices || []).map(c => `<option ${c === it.value ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>`;
    else if (it.kind === "bool") ctl = `<input type="checkbox" ${it.value ? "checked" : ""} style="width:24px;height:24px;accent-color:var(--green)">`;
    else ctl = `<input type="text" value="${esc(it.value == null ? "" : it.value)}">`;
    const sub = !it.readOnly && it.default !== undefined && JSON.stringify(it.default) !== JSON.stringify(it.value)
      ? `default ${it.default === null ? "—" : it.default}` : "";
    const hint = [sub, it.min != null && !it.readOnly ? `${it.min} to ${it.max}` : "", it.atStart ? "next start" : ""].filter(Boolean).join(" · ");
    return `<div class="set" data-key="${esc(it.key)}"><div class="setrow"><span>${esc(name)}${hint ? `<small class="shint${sub ? " chg" : ""}">${esc(hint)}</small>` : ""}</span>${ctl}</div>
      ${it.min != null && !it.readOnly ? `<input type="range" min="${it.min}" max="${it.max}" step="${it.step}" value="${esc(it.value)}" aria-label="${esc(name)}">` : ""}</div>`;
  }

  // ---------- 10. go ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  render(true);
  tick();                                            // tick() schedules itself (15 s, or 3 s / 6 s after a miss)
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  window.addEventListener("resize", () => { const r = route(); if (r.name === "home") VIEWS.home.update(); });
})();
