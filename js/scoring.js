/*
 * MushtaqTrader scoring model.
 *
 * Ranks every asset using only real price history plus consumer / economic
 * data. Each factor is transparent and shown in the UI. This is a mechanical
 * screen of past data, NOT a prediction and NOT financial advice.
 *
 * Works in the browser (window.Scoring) and in Node (module.exports) so it can be tested.
 */
(function (root) {
  'use strict';

  const DAY = 86400;

  // ---------- small numeric helpers ----------
  const last = (a) => a[a.length - 1];
  const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const isNum = (x) => typeof x === 'number' && isFinite(x);

  function smaSeries(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function smaLast(values, n) {
    if (values.length < n) return null;
    return mean(values.slice(-n));
  }

  // Wilder's RSI
  function rsi(closes, n = 14) {
    if (closes.length < n + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (n - 1) + Math.max(d, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    }
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  }

  // Index of the last bar at or before (lastTime - days). If history does not
  // reach that far back but covers >= 90% of the window, use the first bar.
  function indexDaysAgo(t, days) {
    const target = last(t) - days * DAY;
    if (t[0] > target) {
      return (last(t) - t[0]) >= 0.9 * days * DAY ? 0 : -1;
    }
    let lo = 0, hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= target) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function returnOver(t, c, days, endDaysAgo = 0) {
    const i0 = indexDaysAgo(t, days);
    const i1 = endDaysAgo ? indexDaysAgo(t, endDaysAgo) : c.length - 1;
    if (i0 < 0 || i1 < 0 || i1 <= i0 || !c[i0]) return null;
    return c[i1] / c[i0] - 1;
  }

  function annualisedVol(c, bars, periodsPerYear) {
    const s = c.slice(-(bars + 1));
    if (s.length < 20) return null;
    const r = [];
    for (let i = 1; i < s.length; i++) if (s[i - 1] > 0) r.push(Math.log(s[i] / s[i - 1]));
    const m = mean(r);
    const v = r.reduce((acc, x) => acc + (x - m) ** 2, 0) / Math.max(1, r.length - 1);
    return Math.sqrt(v) * Math.sqrt(periodsPerYear);
  }

  // ---------- per-asset metrics ----------
  function computeMetrics(a) {
    const t = a.t, c = a.c, h = a.h, l = a.l;
    const n = c.length;
    if (!n) return null;
    const ppy = a.cls === 'crypto' ? 365 : 252;
    const price = c[n - 1];
    const prev = n > 1 ? c[n - 2] : null;
    const sma50 = smaLast(c, 50);
    const sma200 = smaLast(c, 200);
    const yearHigh = Math.max(...h.slice(-ppy).filter(isNum));
    const yearLow = Math.min(...l.slice(-ppy).filter(isNum));
    const vol = annualisedVol(c, a.cls === 'crypto' ? 90 : 63, ppy);
    const r6m = returnOver(t, c, 182);

    let trendPoints = 0, trendMax = 0;
    if (sma50 != null) { trendMax++; if (price > sma50) trendPoints++; }
    if (sma200 != null) { trendMax++; if (price > sma200) trendPoints++; }
    if (sma50 != null && sma200 != null) { trendMax++; if (sma50 > sma200) trendPoints++; }

    return {
      price,
      change1d: prev ? price / prev - 1 : null,
      r1w: returnOver(t, c, 7),
      r1m: returnOver(t, c, 30),
      r3m: returnOver(t, c, 91),
      r6m,
      r1y: returnOver(t, c, 365),
      mom12_1: returnOver(t, c, 365, 30),
      sma50, sma200,
      aboveSma50: sma50 != null ? price > sma50 : null,
      aboveSma200: sma200 != null ? price > sma200 : null,
      goldenCross: sma50 != null && sma200 != null ? sma50 > sma200 : null,
      trend: trendMax ? trendPoints / trendMax : null,
      trendPoints, trendMax,
      rsi14: rsi(c, 14),
      vol,
      riskAdj: r6m != null && vol ? r6m / (vol * Math.SQRT1_2) : null,
      yearHigh, yearLow,
      fromHigh: yearHigh ? price / yearHigh - 1 : null,
      bars: n,
      lastTime: last(t),
    };
  }

  // Percentile rank 0..1 among non-null values (ties share the average rank).
  function percentiles(values) {
    const idx = values.map((v, i) => [v, i]).filter(([v]) => isNum(v)).sort((x, y) => x[0] - y[0]);
    const out = new Array(values.length).fill(null);
    if (idx.length === 1) { out[idx[0][1]] = 0.5; return out; }
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const p = ((i + j) / 2) / (idx.length - 1);
      for (let k = i; k <= j; k++) out[idx[k][1]] = p;
      i = j + 1;
    }
    return out;
  }

  // ---------- macro helpers ----------
  function macroLatest(m, back = 0) {
    if (!m || !m.values || m.values.length <= back) return null;
    return m.values[m.values.length - 1 - back];
  }

  // ---------- market backdrop (uses index, breadth and consumer/economic data) ----------
  function marketRegime(assets, macroList) {
    const bySym = Object.fromEntries(assets.map((a) => [a.symbol, a]));
    const macro = Object.fromEntries((macroList || []).map((m) => [m.id, m]));
    const factors = [];
    const push = (name, signal, text) => factors.push({ name, signal, text });

    const spx = bySym['^GSPC'] || bySym.SPY;
    if (spx && spx.metrics && spx.metrics.sma200) {
      const m = spx.metrics;
      const gap = m.price / m.sma200 - 1;
      push('S&P 500 trend', gap > 0 ? 1 : -1,
        `S&P 500 is ${fmtPct(Math.abs(gap))} ${gap > 0 ? 'above' : 'below'} its 200-day average`);
    }

    const vix = bySym['^VIX'];
    if (vix && vix.metrics) {
      const v = vix.metrics.price;
      push('Fear gauge (VIX)', v < 17 ? 1 : v > 25 ? -1 : 0,
        `VIX at ${v.toFixed(1)} — ${v < 17 ? 'calm markets' : v > 25 ? 'elevated fear' : 'normal nervousness'}`);
    }

    const stocks = assets.filter((a) => a.cls === 'stock' && a.metrics && a.metrics.aboveSma200 != null);
    if (stocks.length >= 10) {
      const share = stocks.filter((a) => a.metrics.aboveSma200).length / stocks.length;
      push('Market breadth', share > 0.6 ? 1 : share < 0.4 ? -1 : 0,
        `${Math.round(share * 100)}% of tracked stocks are above their 200-day average`);
    }

    const sent = macro.UMCSENT;
    if (macroLatest(sent, 3) != null) {
      const now = macroLatest(sent), then = macroLatest(sent, 3);
      const d = now - then;
      push('Consumer sentiment', d > 2 ? 1 : d < -2 ? -1 : 0,
        `Consumer sentiment ${now.toFixed(1)}, ${d >= 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(1)} pts over 3 months`);
    }

    const retail = macro.RSAFS;
    if (macroLatest(retail) != null) {
      const v = macroLatest(retail);
      push('Consumer spending', v > 3 ? 1 : v < 0 ? -1 : 0,
        `Retail sales ${v >= 0 ? 'up' : 'down'} ${Math.abs(v).toFixed(1)}% year-on-year`);
    }

    const cpi = macro.CPIAUCSL;
    if (macroLatest(cpi) != null) {
      const v = macroLatest(cpi);
      push('Inflation', v <= 3 ? 1 : v > 4 ? -1 : 0, `Inflation running at ${v.toFixed(1)}% a year`);
    }

    const un = macro.UNRATE;
    if (un && un.values && un.values.length >= 12) {
      const recent = un.values.slice(-12);
      const rise = last(recent) - Math.min(...recent);
      push('Jobs market', rise >= 0.5 ? -1 : 0,
        `Unemployment ${last(recent).toFixed(1)}%` + (rise >= 0.5 ? `, up ${rise.toFixed(1)}pp from its 12-month low (recession warning)` : ', stable'));
    }

    const curve = macro.T10Y2Y;
    if (macroLatest(curve) != null) {
      const v = macroLatest(curve);
      push('Yield curve', v < 0 ? -1 : 0,
        v < 0 ? `Yield curve inverted (${v.toFixed(2)}pp) — historically a recession warning` : `Yield curve positive (+${v.toFixed(2)}pp)`);
    }

    const total = factors.reduce((s, f) => s + f.signal, 0);
    const label = total >= 3 ? 'Risk-on' : total <= -1 ? 'Cautious' : 'Neutral';
    const summary = {
      'Risk-on': 'Conditions favour growth: the model leans on momentum.',
      Neutral: 'Mixed signals: the model balances momentum and stability.',
      Cautious: 'Conditions look shaky: the model favours steadier, lower-volatility assets.',
    }[label];
    return { label, total, factors, summary };
  }

  const WEIGHTS = {
    'Risk-on': { momentum: 0.30, recent: 0.15, trend: 0.20, riskAdj: 0.20, lowVol: 0.05, nearHigh: 0.10 },
    Neutral:   { momentum: 0.25, recent: 0.15, trend: 0.20, riskAdj: 0.20, lowVol: 0.10, nearHigh: 0.10 },
    Cautious:  { momentum: 0.20, recent: 0.10, trend: 0.20, riskAdj: 0.15, lowVol: 0.20, nearHigh: 0.15 },
  };

  const FACTOR_LABELS = {
    momentum: '12-month momentum',
    recent: '3-month performance',
    trend: 'Trend (50/200-day averages)',
    riskAdj: 'Return per unit of risk',
    lowVol: 'Stability (low volatility)',
    nearHigh: 'Strength vs 52-week high',
  };

  function fmtPct(x, digits = 1) {
    return (x * 100).toFixed(digits) + '%';
  }
  function signed(x, digits = 1) {
    return (x >= 0 ? '+' : '−') + fmtPct(Math.abs(x), digits);
  }

  function signalFor(score) {
    if (score >= 70) return 'BUY';
    if (score >= 45) return 'HOLD';
    return 'AVOID';
  }

  // ---------- main entry ----------
  function scoreAll(assets, macroList) {
    assets.forEach((a) => { a.metrics = computeMetrics(a); });
    const regime = marketRegime(assets, macroList);
    const w = WEIGHTS[regime.label];

    const ranked = assets.filter((a) => a.rank && a.metrics && a.metrics.bars >= 120);
    const col = (f) => ranked.map((a) => f(a.metrics));
    const P = {
      momentum: percentiles(col((m) => (m.mom12_1 != null ? m.mom12_1 : m.r6m))),
      recent: percentiles(col((m) => m.r3m)),
      riskAdj: percentiles(col((m) => m.riskAdj)),
      lowVol: percentiles(col((m) => (m.vol != null ? -m.vol : null))),
      nearHigh: percentiles(col((m) => m.fromHigh)),
    };

    ranked.forEach((a, i) => {
      const m = a.metrics;
      const f = {
        momentum: P.momentum[i],
        recent: P.recent[i],
        trend: m.trend,
        riskAdj: P.riskAdj[i],
        lowVol: P.lowVol[i],
        nearHigh: P.nearHigh[i],
      };
      let raw = 0, wsum = 0;
      for (const k of Object.keys(w)) {
        if (f[k] != null) { raw += w[k] * f[k]; wsum += w[k]; }
      }
      let score = wsum ? (raw / wsum) * 100 : 50;

      const pros = [], cons = [], adjustments = [];
      const mom = m.mom12_1 != null ? m.mom12_1 : m.r6m;
      const momLabel = m.mom12_1 != null ? 'over the past year (excluding the last month)' : 'over 6 months';

      if (mom != null) {
        if (f.momentum >= 0.7) pros.push(`Strong momentum: ${signed(mom)} ${momLabel}, in the top ${Math.max(1, Math.round((1 - f.momentum) * 100))}% of assets`);
        else if (f.momentum <= 0.3) cons.push(`Weak momentum: ${signed(mom)} ${momLabel}`);
      }
      if (m.trendMax === 3 && m.trendPoints === 3) pros.push('Clear uptrend: price above its 50- and 200-day averages, and the 50-day is above the 200-day');
      else if (m.trendMax && m.trendPoints === 0) cons.push('Downtrend: price below its 50- and 200-day averages');
      else if (m.aboveSma200 === false) cons.push('Trading below its 200-day average');
      if (f.riskAdj != null && f.riskAdj >= 0.75) pros.push(`Good reward for the risk taken (top ${Math.max(1, Math.round((1 - f.riskAdj) * 100))}% on return ÷ volatility)`);
      if (m.vol != null) {
        if (f.lowVol >= 0.75) pros.push(`Relatively stable: ${fmtPct(m.vol, 0)} annual volatility`);
        else if (f.lowVol <= 0.2) cons.push(`Very volatile: ${fmtPct(m.vol, 0)} annual swings`);
      }
      if (m.fromHigh != null) {
        if (m.fromHigh > -0.03) pros.push('Trading at or near its 52-week high');
        else if (m.fromHigh < -0.3) cons.push(`${fmtPct(-m.fromHigh, 0)} below its 52-week high`);
      }

      // Entry-timing adjustments based on RSI
      if (m.rsi14 != null) {
        if (m.rsi14 > 80) { score -= 12; adjustments.push(-12); cons.push(`Heavily overbought (RSI ${m.rsi14.toFixed(0)}) — buying now risks chasing a spike`); }
        else if (m.rsi14 > 75) { score -= 8; adjustments.push(-8); cons.push(`Overbought (RSI ${m.rsi14.toFixed(0)}) — a pullback is common from here`); }
        else if (m.rsi14 < 30 && m.trendPoints <= 1) { score -= 5; adjustments.push(-5); cons.push(`Oversold in a downtrend (RSI ${m.rsi14.toFixed(0)}) — falling knife risk`); }
        else if (m.trendMax === 3 && m.trendPoints === 3 && m.rsi14 >= 40 && m.rsi14 <= 60) { score += 4; adjustments.push(4); pros.push(`Healthy pause in an uptrend (RSI ${m.rsi14.toFixed(0)}) — a reasonable entry point`); }
      }
      if (a.stale) { score -= 5; adjustments.push(-5); cons.push('Price did not refresh in the latest data update'); }
      if (m.change1d != null && Math.abs(m.change1d) > (a.cls === 'crypto' ? 0.1 : 0.07)) {
        cons.push(`Big one-day move (${signed(m.change1d)}) — wait for it to settle`);
      }

      a.score = clamp(Math.round(score), 0, 100);
      a.signal = signalFor(a.score);
      a.factors = f;
      a.weights = w;
      a.reasons = { pros, cons };
      a.adjustment = adjustments.reduce((s, x) => s + x, 0);
    });

    ranked.sort((x, y) => y.score - x.score);
    ranked.forEach((a, i) => { a.rankPos = i + 1; });
    assets.filter((a) => !ranked.includes(a)).forEach((a) => { a.score = null; a.signal = null; a.rankPos = null; });
    return { regime, ranked, weights: w };
  }

  const api = {
    scoreAll, computeMetrics, marketRegime, percentiles, rsi, smaSeries, smaLast,
    returnOver, annualisedVol, indexDaysAgo, signalFor, WEIGHTS, FACTOR_LABELS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof window !== 'undefined' ? window : this);
