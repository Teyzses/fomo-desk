// Charts by hand on <canvas>, devicePixelRatio aware. No dependency.
(function () {
  "use strict";
  const RM = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setup(el) {
    const dpr = window.devicePixelRatio || 1, w = el.clientWidth, h = el.clientHeight;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
    }
    const c = el.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    return { c, w, h };
  }

  // points [[ts, value]], opts {start, marks:[{ts,label,color}], color}
  // A new point slides in over 250 ms (the line grows from the previous last point).
  function line(el, points, opts) {
    opts = opts || {};
    const prev = el.__last || null;
    el.__last = { n: points.length, range: opts.range };
    const grow = prev && prev.range === opts.range && points.length === prev.n + 1 && !RM();
    if (!grow) return drawLine(el, points, opts, 1);
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 250), e = 1 - Math.pow(1 - p, 3);
      drawLine(el, points, opts, e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const MARK = { blue: "#0a84ff", green: "#00d35a", red: "#ff453a" };

  function drawLine(el, points, opts, prog) {
    const { c, w, h } = setup(el);
    const color = opts.color || "#00d35a";
    const top = 34, bottom = 12;                         // room above the line for the marks
    if (!points || !points.length) return;
    const pts = points.length === 1 ? [[points[0][0] - 1, points[0][1]], points[0]] : points;
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0], ts = t1 - t0 || 1;
    let lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1]));
    if (opts.start != null) { lo = Math.min(lo, opts.start); hi = Math.max(hi, opts.start); }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const X = (t) => 16 + (t - t0) / ts * (w - 32);
    const Y = (v) => top + (1 - (v - lo) / (hi - lo)) * (h - top - bottom);
    // the newest segment grows in
    const xy = pts.map(p => [X(p[0]), Y(p[1])]);
    if (prog < 1 && xy.length >= 2) {
      const a = xy[xy.length - 2], b = xy[xy.length - 1];
      xy[xy.length - 1] = [a[0] + (b[0] - a[0]) * prog, a[1] + (b[1] - a[1]) * prog];
    }
    // dashed start line
    if (opts.start != null) {
      c.save(); c.setLineDash([3, 4]); c.strokeStyle = "rgba(235,235,245,0.3)"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, Y(opts.start)); c.lineTo(w, Y(opts.start)); c.stroke(); c.restore();
    }
    // gradient under the line (the line's own color fading out, not a card gradient)
    const g = c.createLinearGradient(0, top, 0, h);
    g.addColorStop(0, hexA(color, 0.28)); g.addColorStop(1, hexA(color, 0));
    c.beginPath(); xy.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
    c.lineTo(xy[xy.length - 1][0], h); c.lineTo(xy[0][0], h); c.closePath(); c.fillStyle = g; c.fill();
    c.beginPath(); xy.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
    c.strokeStyle = color; c.lineWidth = 2; c.lineJoin = "round"; c.stroke();
    const last = xy[xy.length - 1];
    c.beginPath(); c.arc(last[0], last[1], 4, 0, 7); c.fillStyle = color; c.fill();
    // marks above the line; a later mark that would overlap moves up a row
    const rows = [];
    c.font = "600 11px -apple-system,system-ui,Roboto,sans-serif"; c.textBaseline = "middle";
    (opts.marks || []).filter(m => m.ts >= t0 && m.ts <= t1 + 1).sort((a, b) => a.ts - b.ts).forEach(m => {
      const x = X(m.ts), tw = c.measureText(m.label).width + 12;
      let left = Math.max(2, Math.min(w - tw - 2, x - tw / 2)), r = 0;
      while (rows[r] != null && rows[r] > left - 4) r++;
      rows[r] = left + tw;
      const yLine = Y(valueAt(pts, m.ts)), y = Math.max(10, yLine - 16 - r * 20);
      c.strokeStyle = "rgba(235,235,245,0.18)"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, y + 8); c.lineTo(x, yLine); c.stroke();
      const col = MARK[m.color] || m.color || "#0a84ff";
      roundRect(c, left, y - 8, tw, 16, 8); c.fillStyle = hexA(col, 0.22); c.fill();
      c.fillStyle = col; c.fillText(m.label, left + 6, y);
    });
  }

  // candles [[ts, o, h, l, c]], opts {exitLine}
  function candles(el, cs, opts) {
    opts = opts || {};
    const { c, w, h } = setup(el);
    if (!cs || !cs.length) return;
    let lo = Math.min(...cs.map(k => k[3])), hi = Math.max(...cs.map(k => k[2]));
    if (opts.exitLine) { lo = Math.min(lo, opts.exitLine); hi = Math.max(hi, opts.exitLine); }
    if (hi - lo < 1e-15) { lo *= 0.98; hi *= 1.02; if (hi === lo) { lo -= 1; hi += 1; } }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (h - 16);
    const n = Math.max(cs.length, 30), cw = (w - 32) / n, bw = Math.max(2, cw * 0.62);
    cs.forEach((k, i) => {
      const x = 16 + (n - cs.length + i) * cw + cw / 2, up = k[4] >= k[1], col = up ? "#00d35a" : "#ff453a";
      c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, Y(k[2])); c.lineTo(x, Y(k[3])); c.stroke();
      const y1 = Y(Math.max(k[1], k[4])), y2 = Y(Math.min(k[1], k[4]));
      c.fillRect(x - bw / 2, y1, bw, Math.max(1.5, y2 - y1));
    });
    if (opts.exitLine) {
      c.save(); c.setLineDash([5, 4]); c.strokeStyle = "#ff9f0a"; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(0, Y(opts.exitLine)); c.lineTo(w, Y(opts.exitLine)); c.stroke(); c.restore();
      c.font = "500 11px ui-monospace,'SF Mono','Roboto Mono',monospace"; c.fillStyle = "#ff9f0a";
      c.textAlign = "right"; c.fillText("exit", w - 6, Y(opts.exitLine) - 6);
    }
  }

  // score ring 0-100, green from 70
  function ring(el, score) {
    const { c, w, h } = setup(el), r = Math.min(w, h) / 2 - 4, cx = w / 2, cy = h / 2;
    c.lineWidth = 5; c.lineCap = "round";
    c.strokeStyle = "#2c2c2e"; c.beginPath(); c.arc(cx, cy, r, 0, 7); c.stroke();
    if (score == null) return;
    c.strokeStyle = score >= 70 ? "#00d35a" : "#ff453a";
    c.beginPath(); c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(100, score)) / 100); c.stroke();
    c.fillStyle = "#fff"; c.font = "600 15px -apple-system,system-ui,Roboto,sans-serif"; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(String(Math.round(score)), cx, cy + 1);
  }

  function valueAt(pts, t) {
    let best = pts[0];
    for (const p of pts) { if (p[0] <= t) best = p; else break; }
    return best[1];
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }
  window.DeskChart = { line, candles, ring };
})();
