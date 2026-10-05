/* =====================================================================
   backtest.js · Backtest del plan del panel SOL/USDT
   Integración: ya viene enlazado al final de index.html (<script src="backtest.js">).
   El modo semanal usa el motor de indicadores IND que está dentro de index.html.
   Agrega una tarjeta "Backtest del plan" con dos modos: plan 1h (long) y semanal long/short.
   Usa los inputs #r-lev y #r-frac (% del capital como margen) del panel y la constante SYMBOL si existe.
   ===================================================================== */
(function (root) {
'use strict';

const HOUR = 3600e3;
const STEP = { '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR };

const DEFAULTS = {
  entry: 'limit',        // 'limit' (orden límite en soporte) | 'confirm' (vela de rechazo)
  stopAtr: 0.5,          // stop = soporte - stopAtr * ATR(1h)
  minScore: 3,           // puntaje mínimo (máx. 5 en este backtest)
  tp: [1.5, 2.5, 4],     // TP en múltiplos de R
  split: [0.5, 0.3, 0.2],// % de la posición que se cierra en cada TP
  be: false,             // mover stop a break-even al tocar TP1
  lev: 10,
  frac: 0.2,             // fracción del capital que va como margen de cada trade (el resto queda de respaldo)
  validBars: 24,         // velas 1h que vive la orden pendiente
  maxHold: 96,           // máx. velas 1h con la posición abierta
  maxSlPct: 6,           // descarta si el stop queda a más de 6%
  blockRR: true,         // descarta si hay resistencia antes de TP1
  feeMaker: 0.0002,      // 0.02% por lado (límite / TP)
  feeTaker: 0.0005,      // 0.05% por lado (mercado / stop)
  slip: 0.0003,          // slippage en stops
  fundingHour: 0.0001 / 8, // funding 0.01% cada 8h, por hora abierta
  zoneTol: 0.002,        // tolerancia de la zona de soporte (modo confirm)
  volMult: 1.2           // volumen mínimo de la vela de rechazo vs promedio 20
};

/* ---------------- Datos ---------------- */
async function fetchRange(interval, sym, startMs, endMs, onProg) {
  const out = [], step = STEP[interval];
  let from = startMs;
  while (from < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('klines ' + r.status);
    const raw = await r.json();
    if (!raw.length) break;
    for (const x of raw) out.push({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] });
    if (onProg) onProg(interval, out.length);
    from = raw[raw.length - 1][0] + step;
    if (raw.length < 1000) break;
  }
  const now = Date.now();
  while (out.length && out[out.length - 1].t + step > now) out.pop(); // solo velas cerradas
  return out;
}

async function loadData(sym, days, onProg) {
  const end = Date.now(), simStart = end - days * 24 * HOUR, from = simStart - 270 * 24 * HOUR;
  const k1 = await fetchRange('1h', sym, from, end, onProg);
  const k4 = await fetchRange('4h', sym, from, end, onProg);
  const kd = await fetchRange('1d', sym, from, end, onProg);
  return { k1, k4, kd, simStart };
}

/* ---------------- Indicadores (series completas) ---------------- */
const emaS = (v, n) => { const k = 2 / (n + 1), o = new Array(v.length); let e = v[0];
  for (let i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[0]; o[i] = e; } return o; };

function rsiS(c, n = 14) {
  const o = new Array(c.length).fill(null);
  if (c.length <= n) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d >= 0 ? g += d : l -= d; }
  g /= n; l /= n; o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}

function atrS(k, n = 14) {
  const o = new Array(k.length).fill(null); let a = null;
  for (let i = 1; i < k.length; i++) {
    const tr = Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c));
    a = a == null ? tr : (a * (n - 1) + tr) / n; o[i] = a;
  }
  return o;
}

function macdHistS(c) {
  const e12 = emaS(c, 12), e26 = emaS(c, 26), ml = e12.map((x, i) => x - e26[i]), sg = emaS(ml, 9);
  return ml.map((x, i) => x - sg[i]);
}

function swingsIn(k, to, len = 150, side = 3) {
  const from = Math.max(0, to - len + 1), lows = [], highs = [];
  for (let i = from + side; i <= to - side; i++) {
    let L = true, H = true;
    for (let j = 1; j <= side; j++) {
      if (k[i].l >= k[i - j].l || k[i].l >= k[i + j].l) L = false;
      if (k[i].h <= k[i - j].h || k[i].h <= k[i + j].h) H = false;
    }
    if (L) lows.push(k[i].l);
    if (H) highs.push(k[i].h);
  }
  return { lows, highs };
}

// índice de la última vela cerrada de la TF mayor al cierre de cada vela 1h
function alignIdx(k1, kx, step) {
  const out = new Array(k1.length); let j = -1;
  for (let i = 0; i < k1.length; i++) {
    const close1 = k1[i].t + HOUR;
    while (j + 1 < kx.length && kx[j + 1].t + step <= close1) j++;
    out[i] = j;
  }
  return out;
}

/* ---------------- Features por vela (sin look-ahead) ---------------- */
async function buildFeatures(data, onProg) {
  const { k1, k4, kd, simStart } = data;
  const c1 = k1.map(x => x.c), c4 = k4.map(x => x.c), cd = kd.map(x => x.c);
  const h20 = emaS(c1, 20), h50 = emaS(c1, 50), h200 = emaS(c1, 200);
  const f20 = emaS(c4, 20), f50 = emaS(c4, 50), f200 = emaS(c4, 200);
  const d20 = emaS(cd, 20), d50 = emaS(cd, 50), d200 = emaS(cd, 200);
  const rsi1 = rsiS(c1), atr1 = atrS(k1), hist4 = macdHistS(c4);
  const idx4 = alignIdx(k1, k4, STEP['4h']), idxd = alignIdx(k1, kd, STEP['1d']);
  const VR = k1.map((x, i) => { if (i < 20) return 0; let s = 0; for (let q = i - 20; q < i; q++) s += k1[q].v; return x.v / (s / 20 || 1); });
  const sw4 = new Map(), swd = new Map();
  const S4 = j => { let s = sw4.get(j); if (!s) { s = swingsIn(k4, j); sw4.set(j, s); } return s; };
  const SD = j => { let s = swd.get(j); if (!s) { s = swingsIn(kd, j); swd.set(j, s); } return s; };
  const tr = (p, a, b, c) => (p > b ? 1 : -1) + (a > b ? 1 : -1) + (b > c ? 1 : -1);

  function levels(i, p) {
    const raw = [], add = v => { if (v > 0 && isFinite(v)) raw.push(v); };
    const jd = idxd[i], j4 = idx4[i];
    if (jd >= 30) {
      const y = kd[jd], P = (y.h + y.l + y.c) / 3, r = y.h - y.l;
      [P, 2 * P - y.l, P + r, y.h + 2 * (P - y.l), 2 * P - y.h, P - r, y.l - 2 * (y.h - P), y.h, y.l].forEach(add);
      let H = -Infinity, Lo = Infinity;
      for (let q = jd - 29; q <= jd; q++) { H = Math.max(H, kd[q].h); Lo = Math.min(Lo, kd[q].l); }
      [.382, .5, .618].forEach(f => add(H - (H - Lo) * f)); add(H); add(Lo);
    }
    add(h50[i]); add(h200[i]);
    if (j4 >= 0) { add(f50[j4]); add(f200[j4]); }
    if (jd >= 0) { add(d50[jd]); add(d200[jd]); }
    const s1 = swingsIn(k1, i);
    s1.lows.slice(-4).forEach(add); s1.highs.slice(-4).forEach(add);
    if (j4 >= 0) { const s = S4(j4); s.lows.slice(-4).forEach(add); s.highs.slice(-4).forEach(add); }
    if (jd >= 0) { const s = SD(jd); s.lows.slice(-4).forEach(add); s.highs.slice(-4).forEach(add); }
    const st = p >= 100 ? 5 : 1, b = Math.round(p / st) * st;
    [-2, -1, 0, 1, 2].forEach(q => add(b + q * st));
    raw.sort((a, b) => a - b);
    const out = [];
    raw.forEach(x => { const c = out[out.length - 1];
      if (c && (x - c.p) / c.p < 0.004) { c.p = (c.p * c.n + x) / (c.n + 1); c.n++; } else out.push({ p: x, n: 1 }); });
    return out;
  }

  let start = -1;
  for (let i = 300; i < k1.length; i++) if (k1[i].t >= simStart && idxd[i] >= 200 && idx4[i] >= 200) { start = i; break; }
  if (start < 0) throw new Error('No hay suficientes velas para el período pedido.');

  const F = new Array(k1.length);
  for (let i = start; i < k1.length; i++) {
    const p = k1[i].c, j4 = idx4[i], jd = idxd[i];
    const t4 = tr(p, f20[j4], f50[j4], f200[j4]), t1 = tr(p, h20[i], h50[i], h200[i]), td = tr(p, d20[jd], d50[jd], d200[jd]);
    let score = (t4 >= 2 ? 2 : t4 <= -2 ? -2 : 0) + (t1 >= 2 ? 1 : t1 <= -2 ? -1 : 0) + (td >= 2 ? 1 : td <= -2 ? -1 : 0)
      + (hist4[j4] > 0 ? 1 : -1) + (rsi1[i] > 72 ? -1 : rsi1[i] < 32 ? 1 : 0);
    const f = { score, atr: atr1[i], p, support: null, resistance: null };
    if (score >= 3) {
      const L = levels(i, p);
      const ss = L.filter(x => x.p < p * 0.998), rs = L.filter(x => x.p > p * 1.002);
      const strong = ss.filter(x => x.n >= 2);
      const sObj = (strong.length ? strong : ss).sort((a, b) => b.p - a.p)[0];
      f.support = sObj ? sObj.p : p * 0.98;
      const rObj = rs.sort((a, b) => a.p - b.p)[0]; f.resistance = rObj ? rObj.p : null;
    }
    F[i] = f;
    if (onProg && i % 400 === 0) { onProg('calc', (i - start) / (k1.length - start)); await new Promise(r => setTimeout(r, 0)); }
  }
  F.start = start; F.VR = VR;
  return F;
}

/* ---------------- Simulación ---------------- */
function simulate(data, F, userCfg) {
  const cfg = Object.assign({}, DEFAULTS, userCfg), k1 = data.k1, n = k1.length, VR = F.VR;
  const trades = []; let order = null, pos = null;

  const plan = (entry, support, atr, resistance) => {
    const sl = support - cfg.stopAtr * atr, risk = entry - sl;
    if (!(risk > 0)) return null;
    const slPct = risk / entry * 100;
    if (slPct >= 100 / cfg.lev * 0.8 || slPct > cfg.maxSlPct) return null;
    const tps = cfg.tp.map(m => entry + risk * m);
    if (cfg.blockRR && resistance && resistance < tps[0]) return null;
    return { entry, sl, tps, risk, support };
  };
  const exitPart = (px, frac, fee) => { pos.r += frac * (px - pos.entry) / pos.R - frac * fee * px / pos.R; pos.rem -= frac; };
  const finish = (b, label) => {
    trades.push({ tEntry: k1[pos.iEntry].t, tExit: b.t + HOUR, entry: pos.entry, r: pos.r, rp: pos.R / pos.entry, bars: pos.hold, out: label });
    pos = null;
  };
  const manage = (b, isFill) => {
    if (b.l <= pos.sl) { exitPart(Math.min(pos.sl, b.o) * (1 - cfg.slip), pos.rem, cfg.feeTaker); return finish(b, pos.be ? 'BE' : 'SL'); }
    if (!isFill) {
      for (let k = 0; k < cfg.tp.length; k++) {
        if (!pos.done[k] && b.h >= pos.tps[k]) {
          exitPart(pos.tps[k], Math.min(cfg.split[k], pos.rem), cfg.feeMaker); pos.done[k] = true;
          if (k === 0 && cfg.be) { pos.sl = Math.max(pos.sl, pos.entry); pos.be = true; }
        }
      }
    }
    pos.r -= pos.rem * cfg.fundingHour * pos.entry / pos.R;
    pos.hold++;
    if (pos.rem <= 1e-9) return finish(b, 'TP');
    if (pos.hold >= cfg.maxHold) { exitPart(b.c, pos.rem, cfg.feeTaker); return finish(b, 'TIME'); }
  };
  const openPos = (fill, pl, i, fee) => ({ entry: fill, sl: pl.sl, tps: pl.tps, R: pl.risk, rem: 1, done: [], r: -fee * fill / pl.risk, hold: 0, iEntry: i, be: false });

  for (let i = F.start; i < n; i++) {
    const b = k1[i], f = F[i];
    if (pos) manage(b, false);
    if (!pos && order) {
      if (i - order.i > cfg.validBars) order = null;
      else if (cfg.entry === 'limit') {
        if (b.l <= order.pl.entry) {
          pos = openPos(Math.min(order.pl.entry, b.o), order.pl, i, cfg.feeMaker); order = null;
          manage(b, true);
        } else if (b.h >= order.tp1Ref) order = null;
      } else {
        if (b.l <= order.sl) order = null;
        else {
          const rg = b.h - b.l;
          const ok = rg > 0 && b.l <= order.support * (1 + cfg.zoneTol) && b.c > order.support && b.c > b.o
            && (Math.min(b.o, b.c) - b.l) / rg >= 0.5 && VR[i] >= cfg.volMult;
          if (ok) {
            const pl = plan(b.c, order.support, order.atr, order.resistance);
            if (pl) pos = openPos(b.c, pl, i, cfg.feeTaker);
            order = null;
          } else if (b.h >= order.tp1Ref) order = null;
        }
      }
    }
    if (!pos && !order && f.score >= cfg.minScore && f.support) {
      const tp1Ref = f.support + 1.5 * cfg.stopAtr * f.atr, sl = f.support - cfg.stopAtr * f.atr;
      if (cfg.entry === 'limit') {
        const pl = plan(f.support, f.support, f.atr, f.resistance);
        if (pl) order = { i, pl, tp1Ref };
      } else order = { i, support: f.support, atr: f.atr, resistance: f.resistance, sl, tp1Ref };
    }
  }
  return trades;
}

/* ---------------- Métricas ---------------- */
function stats(trades, expo) {
  const n = trades.length;
  if (!n) return { n: 0 };
  let eq = 1, peak = 1, dd = 0, cum = 0, pk = 0, ddR = 0, sW = 0, sL = 0, w = 0, st = 0, mx = 0, bars = 0, sRisk = 0, worst = 0;
  const curve = [{ t: trades[0].tEntry, eq: 1 }];
  trades.forEach(t => {
    eq = Math.max(0, eq * (1 + expo * t.rp * t.r)); cum += t.r; bars += t.bars;
    sRisk += expo * t.rp * 100; worst = Math.min(worst, expo * t.rp * t.r * 100);
    peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
    pk = Math.max(pk, cum); ddR = Math.max(ddR, pk - cum);
    if (t.r > 0) { w++; sW += t.r; st = 0; } else { sL += -t.r; st++; mx = Math.max(mx, st); }
    curve.push({ t: t.tExit, eq });
  });
  return { n, win: w / n * 100, avgR: cum / n, pf: sL ? sW / sL : Infinity, totalR: cum, ddPct: dd * 100, ddR, ret: (eq - 1) * 100, avgBars: bars / n, streak: mx, avgRisk: sRisk / n, worst, curve };
}

function runBacktest(data, F, userCfg) {
  const cfg = Object.assign({}, DEFAULTS, userCfg), expo = cfg.frac * cfg.lev;
  const trades = simulate(data, F, cfg);
  const k1 = data.k1, t0 = k1[F.start].t, t1 = k1[k1.length - 1].t + HOUR, splitT = t0 + 0.7 * (t1 - t0);
  const bh = (k1[k1.length - 1].c / k1[F.start].o - 1) * 100;
  return {
    cfg, expo, trades, splitT, bh,
    all: stats(trades, expo),
    is: stats(trades.filter(t => t.tEntry < splitT), expo),
    oos: stats(trades.filter(t => t.tEntry >= splitT), expo)
  };
}

/* ---------------- Semanal long/short (solo el gráfico semanal decide) ---------------- */
async function loadWeekly(sym) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1w&limit=1000`);
  if (!r.ok) throw new Error('klines 1w ' + r.status);
  const k = (await r.json()).map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
  while (k.length && k[k.length - 1].t + 7 * 24 * HOUR > Date.now()) k.pop(); // solo semanas cerradas
  return k;
}

// Al cierre de cada semana se calcula el puntaje con TODOS los indicadores semanales (motor IND de index.html).
// Puntaje > umbral => long la semana siguiente; < -umbral => short; en el medio => fuera del mercado.
// Se opera de apertura a cierre de cada semana; el costo de comisión solo se paga cuando cambia la dirección.
function weeklyTest(k, userCfg) {
  const IND = root.IND;
  if (!IND) throw new Error('Falta el motor de indicadores (viene dentro de index.html).');
  const cfg = Object.assign({ weeks: 156, th: 0, lev: 10, frac: 0.2, isolated: false, feeTaker: 0.0005, fundingWeek: 0.0001 * 21, minBars: 60 }, userCfg);
  // exposición = margen del trade × apalancamiento (20% × 10X = 2× el capital)
  const expo = cfg.frac * cfg.lev;
  // cruzado: el resto del capital respalda la posición; aislado: solo el margen del trade
  const first = Math.max(cfg.minBars, k.length - 1 - cfg.weeks), liqDist = cfg.isolated ? 1 / cfg.lev - 0.005 : (1 - 0.005 * expo) / expo;
  let eq = 1, bh = 1, prev = null, seg = null, liquidated = false, liqs = 0, signalNow = null;
  const segs = [], rets = [], curve = [], side = { 1: { w: 0, sum: 0, m: 1 }, '-1': { w: 0, sum: 0, m: 1 }, 0: { w: 0 } };
  const closeSeg = () => { if (seg) { segs.push(seg); seg = null; } };
  for (let i = first; i < k.length; i++) {
    const sc = IND.score(IND.compute(k.slice(0, i + 1), '1w'));
    const dir = sc > cfg.th ? 1 : sc < -cfg.th ? -1 : 0;
    if (i === k.length - 1) { signalNow = { dir, sc }; break; }
    const w = k[i + 1];
    let ret = 0, cost = 0;
    if (dir) {
      ret = dir * (w.c / w.o - 1) * expo;
      const adverse = dir === 1 ? (w.l / w.o - 1) : -(w.h / w.o - 1);
      if (adverse <= -liqDist) { liqs++; if (cfg.isolated) ret = -cfg.frac; else { ret = -1; liquidated = true; } }
      cost += cfg.fundingWeek * expo;
    }
    if (prev !== dir) cost += ((prev ? 1 : 0) + (dir ? 1 : 0)) * cfg.feeTaker * expo;
    const net = Math.max(-1, ret - cost);
    eq = Math.max(0, eq * (1 + net)); bh *= w.c / w.o; rets.push(net);
    if (dir) { const b = side[dir]; b.w++; b.sum += net; b.m *= (1 + net); } else side[0].w++;
    if (prev !== dir) { closeSeg(); if (dir) seg = { dir, tStart: w.t, weeks: 0, m: 1 }; }
    if (seg) { seg.weeks++; seg.m *= (1 + net); seg.tEnd = w.t + 7 * 24 * HOUR; }
    prev = dir;
    curve.push({ t: w.t + 7 * 24 * HOUR, eq, bh });
    if (liquidated) break;
  }
  closeSeg();
  let peak = 1, dd = 0; curve.forEach(c => { peak = Math.max(peak, c.eq); dd = Math.max(dd, 1 - c.eq / peak); });
  const mu = rets.reduce((a, x) => a + x, 0) / (rets.length || 1), sd = Math.sqrt(rets.reduce((a, x) => a + (x - mu) ** 2, 0) / (rets.length || 1));
  const wins = segs.filter(s => s.m > 1).length;
  return {
    cfg, weeks: rets.length, trades: segs.length, win: segs.length ? wins / segs.length * 100 : 0,
    ret: (eq - 1) * 100, bh: (bh - 1) * 100, ddPct: dd * 100, sharpe: sd ? mu / sd * Math.sqrt(52) : 0,
    long: { w: side[1].w, avg: side[1].w ? side[1].sum / side[1].w * 100 : 0, tot: (side[1].m - 1) * 100 },
    short: { w: side[-1].w, avg: side[-1].w ? side[-1].sum / side[-1].w * 100 : 0, tot: (side[-1].m - 1) * 100 },
    expo, flat: side[0].w, liquidated, liqs, signalNow, curve, segs
  };
}

root.BT = { DEFAULTS, loadData, buildFeatures, simulate, stats, runBacktest, loadWeekly, weeklyTest };

/* ---------------- UI ---------------- */
function initUI() {
  const grid = document.querySelector('.grid');
  if (!grid || document.getElementById('bt-card')) return;
  const card = document.createElement('div');
  card.className = 'card full'; card.id = 'bt-card';
  card.innerHTML = `<h2>Backtest del plan</h2>
  <div class="row" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
    <div><label for="bt-days">Período</label><select id="bt-days"><option value="180">6 meses</option><option value="365">1 año</option><option value="730" selected>2 años</option></select></div>
    <div><label for="bt-entry">Entrada</label><select id="bt-entry"><option value="limit">Límite en soporte</option><option value="confirm">Vela de rechazo</option></select></div>
    <div><label for="bt-stop">Stop (ATR 1h bajo soporte)</label><select id="bt-stop"><option>0.5</option><option>1</option><option>1.5</option><option>2</option></select></div>
    <div><label for="bt-score">Puntaje mínimo (máx. 5)</label><select id="bt-score"><option>3</option><option>4</option><option>5</option></select></div>
    <div><label for="bt-be">Break-even tras TP1</label><select id="bt-be"><option value="0">No</option><option value="1">Sí</option></select></div>
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
    <button id="bt-run">Correr backtest</button>
    <button id="bt-cmp" class="ghost">Comparar variantes</button>
    <button id="bt-csv" class="ghost">Descargar trades (CSV)</button>
    <span id="bt-st" class="hint" style="margin:0;align-self:center"></span>
  </div>
  <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">
    <b class="gold" style="font-size:.88rem">Estrategia semanal long / short</b>
    <div class="hint" style="margin:4px 0 10px">Decide solo con el gráfico semanal: al cierre de cada semana, si el puntaje de todos los indicadores semanales es positivo va long la semana siguiente; si es negativo, short. Sin stop: lo único que lo saca es la liquidación.</div>
    <div class="row" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div><label for="bw-weeks">Período</label><select id="bw-weeks"><option value="104">2 años</option><option value="156" selected>3 años</option><option value="260">5 años</option><option value="1000">Máximo disponible</option></select></div>
      <div><label for="bw-mm">Tipo de margen</label><select id="bw-mm"><option value="cross">Cruzado (el resto del capital respalda)</option><option value="iso">Aislado (solo el margen del trade)</option></select></div>
      <div><label for="bw-th">Zona neutra del puntaje</label><select id="bw-th"><option value="0">Ninguna (siempre long o short)</option><option value="0.1">±0.10 (fuera del mercado)</option><option value="0.2">±0.20 (fuera del mercado)</option></select></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button id="bw-run">Correr backtest semanal</button><button id="bw-csv" class="ghost">Descargar tramos (CSV)</button></div>
  </div>
  <div id="bt-out" style="margin-top:14px"></div>
  <canvas id="bt-cv" height="170" style="width:100%;display:none;margin-top:10px"></canvas>
  <div class="hint">Simula el plan del panel vela por vela (1h) con datos históricos de Binance spot. Usa comisiones, slippage en stops y funding. Si el stop y un TP caen en la misma vela, cuenta el stop. El 30% más reciente del período se reporta aparte (out-of-sample) para detectar sobreajuste. Usa el apalancamiento y el % de capital como margen de tu panel (por defecto 10X con 20%: la posición vale 2× el capital).</div>`;
  grid.appendChild(card);

  const $b = id => document.getElementById(id);
  const sym = (typeof SYMBOL !== 'undefined') ? SYMBOL : 'SOLUSDT';
  let data = null, F = null, key = '', last = null;
  const st = t => { $b('bt-st').textContent = t; };
  const f2 = (x, d = 2) => (x == null || !isFinite(x)) ? '∞' : x.toFixed(d);
  const cls = x => x > 0 ? 'up' : x < 0 ? 'down' : '';
  const cfgUI = () => ({
    entry: $b('bt-entry').value, stopAtr: +$b('bt-stop').value, minScore: +$b('bt-score').value, be: $b('bt-be').value === '1',
    lev: +$b('r-lev').value, frac: (+$b('r-frac').value || 20) / 100
  });

  async function ensure() {
    const days = +$b('bt-days').value;
    if (key !== String(days)) {
      st('Descargando velas…');
      data = await loadData(sym, days, (i, n) => st(`Descargando ${i}: ${n} velas…`));
      st('Calculando señales…');
      F = await buildFeatures(data, (_, p) => st(`Calculando señales… ${Math.round(p * 100)}%`));
      key = String(days);
    }
  }

  const row = (name, s) => !s.n ? `<tr><td>${name}</td><td colspan="7">sin trades</td></tr>` :
    `<tr><td>${name}</td><td class="num">${s.n}</td><td class="num">${f2(s.win, 0)}%</td><td class="num ${cls(s.avgR)}">${f2(s.avgR)}R</td><td class="num">${f2(s.pf)}</td><td class="num ${cls(s.totalR)}">${f2(s.totalR, 1)}R</td><td class="num down">-${f2(s.ddPct, 1)}%</td><td class="num ${cls(s.ret)}">${f2(s.ret, 1)}%</td></tr>`;
  const head = '<thead><tr><th></th><th>Trades</th><th>Win%</th><th>Esperanza</th><th>PF</th><th>Total</th><th>DD máx</th><th>Retorno</th></tr></thead>';

  function verdict(r) {
    const a = r.all, o = r.oos;
    if (a.n < 30) return `<div class="alert">⚠ Solo ${a.n} trades: muestra demasiado chica para concluir algo. Probá un período más largo o un puntaje mínimo más bajo.</div>`;
    if (a.avgR <= 0) return '<div class="alert" style="color:var(--down)">✖ Esperanza ≤ 0 después de costos: con esta configuración el veredicto "entrar long" no tiene ventaja.</div>';
    if (o.n >= 10 && o.avgR <= 0) return '<div class="alert">⚠ Ganaba en el tramo viejo pero no en el reciente (out-of-sample): señal típica de sobreajuste o de un régimen que cambió.</div>';
    return '<div class="alert" style="color:var(--up)">✔ Esperanza positiva en toda la muestra y en el tramo reciente. Todavía validá con otro símbolo/período y con paper trading antes de arriesgar plata.</div>';
  }

  function draw(r) {
    const cv = $b('bt-cv'); const c = r.all.curve; if (!c || c.length < 2) { cv.style.display = 'none'; return; }
    cv.style.display = 'block';
    const w = cv.width = cv.clientWidth * (devicePixelRatio || 1), h = cv.height = 170 * (devicePixelRatio || 1), g = cv.getContext('2d');
    const t0 = c[0].t, t1 = c[c.length - 1].t, lo = Math.min(...c.map(x => x.eq)), hi = Math.max(...c.map(x => x.eq));
    const X = t => (t - t0) / ((t1 - t0) || 1) * (w - 20) + 10, Y = e => h - 14 - (e - lo) / ((hi - lo) || 1) * (h - 28);
    g.clearRect(0, 0, w, h); g.strokeStyle = '#2b313a'; g.beginPath(); g.moveTo(10, Y(1)); g.lineTo(w - 10, Y(1)); g.stroke();
    g.strokeStyle = '#f0b90b'; g.lineWidth = 2; g.beginPath(); c.forEach((p, i) => i ? g.lineTo(X(p.t), Y(p.eq)) : g.moveTo(X(p.t), Y(p.eq))); g.stroke();
    if (r.splitT > t0 && r.splitT < t1) { g.setLineDash([5, 5]); g.strokeStyle = '#848e9c'; g.beginPath(); g.moveTo(X(r.splitT), 6); g.lineTo(X(r.splitT), h - 6); g.stroke(); g.setLineDash([]); }
    g.fillStyle = '#848e9c'; g.font = (11 * (devicePixelRatio || 1)) + 'px sans-serif'; g.fillText('capital (x)  ·  línea punteada: inicio out-of-sample', 12, 14);
  }

  $b('bt-run').onclick = async () => {
    try {
      await ensure();
      const r = runBacktest(data, F, cfgUI()); last = r;
      $b('bt-out').innerHTML = `<table>${head}<tbody>${row('Todo el período', r.all)}${row('In-sample (70%)', r.is)}${row('Out-of-sample (30%)', r.oos)}</tbody></table>
        <div class="hint">Comprar y mantener en el mismo período: <b class="${cls(r.bh)}">${f2(r.bh, 1)}%</b> (sin apalancamiento). Esperanza = R promedio por trade; PF = ganancias brutas / pérdidas brutas; retorno compuesto con ${f2(r.cfg.frac * 100, 0)}% del capital como margen a ${r.cfg.lev}X (posición = ${f2(r.expo, 1)}× el capital).${r.all.n ? ` Riesgo medio al stop: ${f2(r.all.avgRisk, 1)}% del capital; peor trade: ${f2(r.all.worst, 1)}%.` : ''}${r.all.n ? ` Racha máxima de pérdidas: ${r.all.streak}. Duración media: ${f2(r.all.avgBars, 0)} h.` : ''}</div>${verdict(r)}`;
      draw(r); st('Listo.');
    } catch (e) { st('Error: ' + e.message); }
  };

  $b('bt-cmp').onclick = async () => {
    try {
      await ensure(); const base = cfgUI(); let rows = '';
      ['limit', 'confirm'].forEach(en => [0.5, 1, 1.5].forEach(sa => {
        const r = runBacktest(data, F, Object.assign({}, base, { entry: en, stopAtr: sa }));
        const name = (en === 'limit' ? 'Límite' : 'Rechazo') + ` · stop ${sa} ATR`;
        rows += row(name, r.all).replace('</tr>', `<td class="num ${r.oos.n ? cls(r.oos.avgR) : ''}">${r.oos.n ? f2(r.oos.avgR) + 'R' : '—'}</td></tr>`);
      }));
      $b('bt-out').innerHTML = `<table>${head.replace('</tr>', '<th>Esperanza OOS</th></tr>')}<tbody>${rows}</tbody></table>
        <div class="hint">Elegí la variante con esperanza positiva <i>y</i> estable en el tramo out-of-sample, no la de mejor retorno total.</div>`;
      $b('bt-cv').style.display = 'none'; st('Listo.');
    } catch (e) { st('Error: ' + e.message); }
  };

  let wk = null, wlast = null;
  function drawW(r) {
    const cv = $b('bt-cv'), c = r.curve; if (c.length < 2) { cv.style.display = 'none'; return; }
    cv.style.display = 'block';
    const dpr = devicePixelRatio || 1, w = cv.width = cv.clientWidth * dpr, h = cv.height = 170 * dpr, g = cv.getContext('2d');
    const t0 = c[0].t, t1 = c[c.length - 1].t, all = c.flatMap(x => [x.eq, x.bh]), lo = Math.min(...all, 1), hi = Math.max(...all, 1);
    const X = t => (t - t0) / ((t1 - t0) || 1) * (w - 20) + 10, Y = e => h - 14 * dpr - (e - lo) / ((hi - lo) || 1) * (h - 28 * dpr);
    g.clearRect(0, 0, w, h); g.strokeStyle = '#2b313a'; g.beginPath(); g.moveTo(10, Y(1)); g.lineTo(w - 10, Y(1)); g.stroke();
    [['bh', '#848e9c'], ['eq', '#f0b90b']].forEach(([key, col]) => { g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); c.forEach((p, i) => i ? g.lineTo(X(p.t), Y(p[key])) : g.moveTo(X(p.t), Y(p[key]))); g.stroke(); });
    g.fillStyle = '#848e9c'; g.font = (11 * dpr) + 'px sans-serif'; g.fillText('dorado: estrategia semanal  ·  gris: comprar y mantener (capital = 1)', 12, 14 * dpr);
  }
  $b('bw-run').onclick = async () => {
    try {
      if (!root.IND) throw new Error('falta el motor de indicadores (viene en index.html)');
      st('Descargando velas semanales…'); if (!wk) wk = await loadWeekly(sym);
      st('Calculando señales semanales…'); await new Promise(r => setTimeout(r, 30));
      const r = weeklyTest(wk, { weeks: +$b('bw-weeks').value, lev: +$b('r-lev').value, frac: (+$b('r-frac').value || 20) / 100, isolated: $b('bw-mm').value === 'iso', th: +$b('bw-th').value }); wlast = r;
      const sn = r.signalNow, snTxt = !sn ? '—' : sn.dir > 0 ? '<b class="up">LONG</b>' : sn.dir < 0 ? '<b class="down">SHORT</b>' : '<b>fuera del mercado</b>';
      const edge = r.ret > r.bh ? 'up' : 'down';
      $b('bt-out').innerHTML = `<table><thead><tr><th></th><th>Retorno</th><th>DD máx</th><th>Sharpe</th><th>Tramos</th><th>Win% tramos</th></tr></thead><tbody>
        <tr><td>Semanal long/short · ${r.cfg.lev}X con ${f2(r.cfg.frac * 100, 0)}% del capital</td><td class="num ${cls(r.ret)}">${f2(r.ret, 1)}%</td><td class="num down">-${f2(r.ddPct, 1)}%</td><td class="num">${f2(r.sharpe)}</td><td class="num">${r.trades}</td><td class="num">${f2(r.win, 0)}%</td></tr>
        <tr><td>Comprar y mantener (1X)</td><td class="num ${cls(r.bh)}">${f2(r.bh, 1)}%</td><td colspan="4">—</td></tr></tbody></table>
        <table style="margin-top:10px"><thead><tr><th></th><th>Semanas</th><th>Promedio semanal</th><th>Retorno compuesto</th></tr></thead><tbody>
        <tr><td>Semanas long</td><td class="num">${r.long.w}</td><td class="num ${cls(r.long.avg)}">${f2(r.long.avg)}%</td><td class="num ${cls(r.long.tot)}">${f2(r.long.tot, 1)}%</td></tr>
        <tr><td>Semanas short</td><td class="num">${r.short.w}</td><td class="num ${cls(r.short.avg)}">${f2(r.short.avg)}%</td><td class="num ${cls(r.short.tot)}">${f2(r.short.tot, 1)}%</td></tr>
        ${r.flat ? `<tr><td>Fuera del mercado</td><td class="num">${r.flat}</td><td colspan="2">—</td></tr>` : ''}</tbody></table>
        <div class="hint">Señal de la última semana cerrada (la que rige ahora): ${snTxt}${sn ? ` · puntaje ${f2(sn.sc * 100, 0)}` : ''}. ${r.weeks} semanas simuladas. Costos: comisión 0.05% por lado solo al cambiar de dirección y funding 0.01% cada 8h (se cuenta como costo en ambos lados, criterio conservador). La posición se rebalancea cada semana a exposición constante (margen × apalancamiento).</div>
        ${r.liqs ? `<div class="alert" style="color:var(--down)">✖ Hubo ${r.liqs} liquidación(es) intrasemana${r.cfg.isolated ? ': en cada una perdés el margen de ese trade.' : ': la cuenta se liquidó y la simulación se detuvo.'}</div>` : ''}
        ${r.weeks < 52 ? '<div class="alert">⚠ Menos de un año de semanas: muestra demasiado chica para concluir algo.</div>' : r.ret <= 0 ? '<div class="alert" style="color:var(--down)">✖ La estrategia perdió plata en este período.</div>' : `<div class="alert" style="color:var(--${r.ret > r.bh ? 'up' : 'gold'})">${r.ret > r.bh ? '✔ Le ganó a comprar y mantener' : '⚠ Ganó plata pero rindió menos que comprar y mantener'}; ${r.long.tot > 0 && r.short.tot < 0 ? 'ojo: los shorts restaron, conviene probar solo long.' : 'validalo en otros períodos antes de arriesgar plata.'}</div>`}`;
      drawW(r); st('Listo.');
    } catch (e) { st('Error: ' + e.message); }
  };
  $b('bw-csv').onclick = () => {
    if (!wlast || !wlast.segs.length) { st('Primero corré el backtest semanal.'); return; }
    const csv = 'direccion,inicio,fin,semanas,retorno_pct\n' + wlast.segs.map(s => [s.dir > 0 ? 'LONG' : 'SHORT', new Date(s.tStart).toISOString().slice(0, 10), new Date(s.tEnd).toISOString().slice(0, 10), s.weeks, ((s.m - 1) * 100).toFixed(2)].join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'backtest_semanal.csv'; a.click();
  };

  $b('bt-csv').onclick = () => {
    if (!last || !last.trades.length) { st('Primero corré un backtest.'); return; }
    const csv = 'entrada,salida,precio_entrada,R_neto,horas,resultado\n' + last.trades.map(t =>
      [new Date(t.tEntry).toISOString(), new Date(t.tExit).toISOString(), t.entry.toFixed(3), t.r.toFixed(3), t.bars, t.out].join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'backtest_trades.csv'; a.click();
  };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI); else initUI();
}
})(typeof window !== 'undefined' ? window : globalThis);
