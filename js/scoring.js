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

  // ---------- second opinion: analysts, financial health, earnings ----------
  // Small, capped adjustment on top of the price-based score. Only applied when
  // fundamentals data is available for the asset (US stocks on the free data plan).
  const HEALTH_WORDS = { debt: 'heavy debt', roe: 'low return on shareholders\' money', roa: 'low return on assets', pe: 'expensive versus its earnings', dcf: 'priced above its estimated cash-flow value' };
  function nextEarnings(fundamentals, sym, nowSec) {
    const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
    const list = (fundamentals.earnings || []).filter((e) => e.symbol === sym && e.date >= today).sort((x, y) => (x.date < y.date ? -1 : 1));
    if (!list.length) return null;
    const days = Math.round((Date.parse(list[0].date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    return Object.assign({ days: Math.max(0, days) }, list[0]);
  }
  function secondOpinion(a, fundamentals, pros, cons) {
    const fd = (fundamentals.stocks || {})[a.symbol];
    const nowSec = a.metrics.lastTime || Math.floor(Date.now() / 1000);
    const earn = nextEarnings(fundamentals, a.symbol, nowSec);
    const out = { adj: 0, earnings: earn };
    if (earn && earn.days <= 7) cons.push(`Reports earnings ${earn.days === 0 ? 'today' : earn.days === 1 ? 'tomorrow' : 'in ' + earn.days + ' days'} (${earn.date}) — results can move the price sharply`);
    if (!fd) return out;
    let adj = 0;
    const price = a.metrics.price;
    if (fd.target && isNum(fd.target.consensus) && a.currency === 'USD' && price > 0) {
      const up = fd.target.consensus / price - 1;
      out.upside = up;
      if (up >= 0.15) { adj += 3; pros.push(`Analysts' average target ($${fd.target.consensus.toFixed(2)}) is ${fmtPct(up, 0)} above the price`); }
      else if (up >= 0.05) pros.push(`Analysts' average target ($${fd.target.consensus.toFixed(2)}) is ${fmtPct(up, 0)} above the price`);
      else if (up < -0.01) { adj -= 4; cons.push(`Already ${fmtPct(-up, 0)} above analysts' average target ($${fd.target.consensus.toFixed(2)})`); }
    }
    if (fd.grades) {
      const g = fd.grades;
      const total = g.strongBuy + g.buy + g.hold + g.sell + g.strongSell;
      const buys = g.strongBuy + g.buy, sells = g.sell + g.strongSell;
      if (total) {
        out.buyShare = buys / total;
        if (/sell/i.test(g.consensus)) { adj -= 5; cons.push(`Analysts lean Sell (${sells} of ${total})`); }
        else if (/hold/i.test(g.consensus)) { adj -= 2; cons.push(`Most analysts say Hold (${g.hold} of ${total})`); }
        else if (buys / total >= 0.75) { adj += 2; pros.push(`${buys} of ${total} analysts rate it Buy`); }
      }
    }
    if (fd.health && fd.health.rating) {
      const h = fd.health, letter = h.rating[0];
      const weak = Object.keys(HEALTH_WORDS).filter((k) => h[k] === 1).map((k) => HEALTH_WORDS[k]);
      if (letter === 'A') { adj += 2; pros.push(`Strong financial health (rating ${h.rating})`); }
      else if (letter === 'C' || letter === 'D' || letter === 'F') { adj -= 3; cons.push(`Weak financial health (rating ${h.rating})${weak.length ? ': ' + weak.slice(0, 2).join(', ') : ''}`); }
    }
    out.adj = clamp(adj, -8, 8);
    out.data = fd;
    return out;
  }

  // ---------- main entry ----------
  function scoreAll(assets, macroList, fundamentals) {
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
      a.fund = null;
      if (fundamentals) {
        a.fund = secondOpinion(a, fundamentals, pros, cons);
        if (a.fund.adj) { score += a.fund.adj; adjustments.push(a.fund.adj); }
      }
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

  // ---------- Claude's view ----------
  // Turns the scores into a short, diversified buy list using the same reasoning
  // Claude applies by hand: analyst upside, entry timing, financial health,
  // earnings dates, the tone of recent headlines, sector fit for the current
  // market mood, and not doubling up on near-identical holdings.
  const POS_WORDS = /\b(beats?|beat|tops|raises?|raised|upgrades?|upgraded|record|surges?|jumps?|soars?|best idea|outperform|strong|growth|wins?|approval|approved|deal)\b/i;
  const NEG_WORDS = /\b(miss(es|ed)?|probe|investigation|lawsuit|sues?|breach|downgrades?|downgraded|cuts?|recall|fraud|struggles?|plunges?|slumps?|falls?|warns?|scandal|layoffs?|delay(s|ed)?|fine[sd]?)\b/i;
  const DEFENSIVE = new Set(['Consumer Staples', 'Healthcare', 'Utilities']);
  const CYCLICAL = new Set(['Technology', 'Consumer Discretionary', 'Communication', 'Crypto']);
  const TAKEOVER_RE = /takeover|buyout|to be acquired|recommended (?:cash )?offer|offer period|scheme of arrangement|Form 8\.3/i;
  const SAME_BET = [['V', 'MA'], ['SPY', 'DIA'], ['GOOGL', 'META']];

  function newsTone(items) {
    let pos = 0, neg = 0;
    (items || []).slice(0, 8).forEach((n) => {
      const t = n.title || '';
      if (POS_WORDS.test(t)) pos++;
      if (NEG_WORDS.test(t)) neg++;
    });
    return { pos, neg, net: pos - neg };
  }

  // Two buying styles. 'dip' (the default) looks for good assets that have fallen a
  // lot and could bounce back; 'trend' buys assets that are already rising steadily.
  function claudeView(ranked, regime, opts) {
    opts = opts || {};
    return opts.style === 'trend' ? trendView(ranked, regime, opts) : dipView(ranked, regime, opts);
  }

  // ---------- Buy the dip ----------
  // A dip = at least 10% below its 52-week high, or down 8%+ over the past month.
  // Among those, prefer ones likely to recover: strong over the past year (a good
  // business having a bad patch), heavily sold (low RSI), analysts see upside,
  // healthy finances, no bad company-specific news, and signs of turning up.
  // Steep, long slides with bad news are flagged as falling knives instead.
  function dipView(ranked, regime, opts) {
    const symNews = opts.symbolNews || {};
    const mentions = opts.mentions || {};
    const rows = ranked.map((a) => {
      const m = a.metrics, f = a.fund || {};
      const why = [], risks = [];
      const fromHigh = isNum(m.fromHigh) ? -m.fromHigh : 0;   // 0.25 = 25% below its high
      const fell1m = isNum(m.r1m) ? -m.r1m : 0;
      const isDip = fromHigh >= 0.10 || fell1m >= 0.08;
      let c = 40 + (a.score - 50) * 0.15;
      let timing = isDip ? 'now' : 'wait';
      // how big a discount
      const depth = Math.max(fromHigh, fell1m);
      if (isDip) {
        c += Math.min(depth, 0.45) * 60;
        why.push(`it's ${fmtPct(fromHigh, 0)} below its 52-week high${fell1m >= 0.05 ? ` and fell ${fmtPct(fell1m, 0)} this month` : ''}`);
      }
      if (depth > 0.5) { c -= 12; risks.push(`down more than half from its high, so something may be badly wrong`); }
      // heavily sold
      if (isNum(m.rsi14)) {
        if (m.rsi14 < 30) { c += 8; why.push(`heavily sold (RSI ${m.rsi14.toFixed(0)}), which often comes before a bounce`); }
        else if (m.rsi14 < 40) { c += 4; why.push(`oversold (RSI ${m.rsi14.toFixed(0)})`); }
      }
      // longer-term strength: a good business having a bad patch vs a long slide
      if (isNum(m.r1y)) {
        if (m.r1y > 0.10) { c += 8; why.push(`still up ${fmtPct(m.r1y, 0)} over the past year`); }
        else if (m.r1y > 0) c += 4;
        else if (m.r1y < -0.30) { c -= 10; risks.push(`down ${fmtPct(-m.r1y, 0)} over a year, a long slide rather than a dip`); }
        else if (m.r1y < -0.10) { c -= 4; risks.push(`down ${fmtPct(-m.r1y, 0)} over the past year`); }
      }
      // analysts and finances
      if (isNum(f.upside)) {
        if (f.upside >= 0.20) { c += 8; why.push(`analysts see ${fmtPct(f.upside, 0)} upside`); }
        else if (f.upside >= 0.10) { c += 5; why.push(`analysts see ${fmtPct(f.upside, 0)} upside`); }
        else if (f.upside < 0) { c -= 5; risks.push(`already above analysts' target`); }
      }
      const g = f.data && f.data.grades;
      if (g && /sell/i.test(g.consensus)) { c -= 5; risks.push(`most analysts say ${g.consensus}`); }
      const h = f.data && f.data.health;
      if (h && h.rating) {
        if (h.rating[0] === 'A') { c += 4; why.push(`strong finances (${h.rating})`); }
        else if (/^[CDF]/.test(h.rating)) { c -= 6; risks.push(`weaker finances (${h.rating})`); }
      }
      // news behind the fall
      const tone = newsTone((symNews[a.symbol] || []).concat(mentions[a.symbol] || []));
      if (tone.net <= -2) { c -= 6; risks.push('bad news behind the fall'); }
      else if (tone.net >= 2) { c += 3; why.push('recent headlines are positive'); }
      // turning up
      if (isDip && isNum(m.change1d) && m.change1d >= 0.01) { c += 3; why.push(`starting to bounce (up ${fmtPct(m.change1d, 1)} today)`); }
      // kind of asset
      if (a.cls === 'etf') { c += 4; why.push('a whole basket of companies, so less risky than one share'); }
      if (a.cls === 'crypto') { c -= 8; risks.push('crypto can keep falling much further than shares'); }
      if (isNum(m.vol) && m.vol > 0.6) { c -= 4; risks.push(`very big swings (${fmtPct(m.vol, 0)} a year)`); }
      // results soon: prices can gap either way
      if (f.earnings && f.earnings.days <= 7) { c -= 3; risks.push(`results due ${f.earnings.days <= 1 ? 'within a day' : 'in ' + f.earnings.days + ' days'}`); if (isDip) timing = 'results'; }
      // takeover targets are pinned to the offer price
      if (a.cls === 'stock' && isNum(m.vol) && m.vol < 0.08) {
        timing = 'takeover';
        risks.unshift('a takeover offer looks to be pending, so the price is pinned near the offer with little upside left');
      }
      // a buy-below level for good assets that haven't dropped yet
      const dipLevel = !isDip && isNum(m.yearHigh) ? m.yearHigh * 0.9 : null;
      return { a, conviction: Math.round(clamp(c, 0, 110)), why, risks, timing, dipLevel, isDip, depth, style: 'dip' };
    }).sort((x, y) => y.conviction - x.conviction);

    const picks = [], perSector = {};
    const clash = (sym) => SAME_BET.some((pair) => pair.includes(sym) && picks.some((p) => pair.includes(p.a.symbol) && p.a.symbol !== sym));
    for (const r of rows) {
      if (picks.length >= (opts.max || 5)) break;
      if (r.timing !== 'now' || r.conviction < 60) continue;
      if ((perSector[r.a.sector] || 0) >= 2 || clash(r.a.symbol)) continue;
      perSector[r.a.sector] = (perSector[r.a.sector] || 0) + 1;
      picks.push(r);
    }
    const uk = rows.find((r) => r.a.cls === 'stock' && r.a.region === 'UK' && r.timing === 'now' && r.conviction >= 55);
    // Good assets that haven't dropped yet: the price to wait for.
    const dips = rows.filter((r) => r.timing === 'wait' && r.a.signal === 'BUY' && r.dipLevel).sort((x, y) => y.a.score - x.a.score).slice(0, 4);
    const results = rows.filter((r) => r.timing === 'results' && r.conviction >= 55).slice(0, 3);
    const knives = rows.filter((r) => r.isDip && r.timing === 'now' && r.conviction < 45 && r.a.cls === 'stock')
      .sort((x, y) => y.depth - x.depth).slice(0, 4);
    const avoid = [];
    if (knives.length) avoid.push(`Falling knives: ${knives.map((r) => r.a.symbol).join(', ')}. Down a lot, but with no sign it's over yet`);
    const cryptos = ranked.filter((a) => a.cls === 'crypto');
    if (cryptos.length && cryptos.every((a) => a.signal === 'AVOID')) avoid.push('Crypto: every coin is still falling, and crypto dips can run much deeper than shares');

    rows.forEach((r) => {
      const firstRisk = r.risks[0] || '';
      if (r.timing === 'takeover') r.verdict = { key: 'hold', label: 'Takeover pending', reason: firstRisk };
      else if (picks.includes(r) || uk === r) r.verdict = { key: 'top', label: 'Top dip buy', reason: r.why[0] || '' };
      else if (r.timing === 'results' && r.conviction >= 55) r.verdict = { key: 'results', label: 'Wait for results', reason: r.risks.find((x) => /results/.test(x)) || '' };
      else if (r.isDip && r.conviction >= 66) r.verdict = { key: 'good', label: 'Good dip to buy', reason: r.why[0] || '' };
      else if (r.isDip && r.conviction < 45) r.verdict = { key: 'avoid', label: 'Falling knife', reason: firstRisk || 'down a lot with nothing yet suggesting a recovery' };
      else if (r.isDip) r.verdict = { key: 'hold', label: 'Risky dip', reason: firstRisk || 'mixed signals' };
      else if (r.a.signal === 'BUY') r.verdict = { key: 'dip', label: 'Wait for a dip', reason: `only ${fmtPct(r.depth, 0)} below its high` };
      else r.verdict = { key: 'hold', label: 'Not yet', reason: `not down much (${fmtPct(r.depth, 0)} below its high) and the signals are mixed` };
    });
    const bySymbol = Object.fromEntries(rows.map((r) => [r.a.symbol, r]));
    return { style: 'dip', picks, uk: uk && !picks.includes(uk) ? uk : null, dips, results, avoid, strongSectors: [], bySymbol };
  }

  // ---------- Follow the trend ----------
  function trendView(ranked, regime, opts) {
    const symNews = opts.symbolNews || {};
    const mentions = opts.mentions || {};       // symbol -> market headlines mentioning it
    const cautious = regime && regime.label === 'Cautious';
    const riskOn = regime && regime.label === 'Risk-on';

    // sector strength among stocks
    const secAvg = {};
    ranked.filter((a) => a.cls === 'stock').forEach((a) => { (secAvg[a.sector] = secAvg[a.sector] || []).push(a.score); });
    const strongSectors = Object.entries(secAvg).map(([k, v]) => [k, v.reduce((s, x) => s + x, 0) / v.length])
      .sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k]) => k);

    const rows = ranked.map((a) => {
      const m = a.metrics, f = a.fund || {};
      let c = a.score;
      const why = [], risks = [];
      let timing = 'now';
      // analysts
      if (isNum(f.upside)) {
        if (f.upside >= 0.10) { c += 6; why.push(`analysts see ${fmtPct(f.upside, 0)} upside`); }
        else if (f.upside >= 0.05) { c += 3; why.push(`analyst target ${fmtPct(f.upside, 0)} above the price`); }
        else if (f.upside < -0.01) { c -= 8; risks.push(`already ${fmtPct(-f.upside, 0)} above analysts' target`); timing = 'dip'; }
        else if (f.upside < 0.01) { c -= 4; risks.push('trading right at the analysts\' target'); timing = 'dip'; }
        else risks.push(`limited analyst upside (${fmtPct(f.upside, 0)})`);
      }
      const g = f.data && f.data.grades;
      if (g && /hold|sell/i.test(g.consensus)) { c -= 4; risks.push(`most analysts say ${g.consensus}`); }
      // entry timing
      if (isNum(m.rsi14)) {
        if (m.rsi14 > 68) { c -= 6; risks.push(`running hot (RSI ${m.rsi14.toFixed(0)})`); timing = 'dip'; }
        else if (m.rsi14 <= 60 && m.trendPoints === m.trendMax && m.trendMax) { c += 4; why.push(`calm entry point in an uptrend (RSI ${m.rsi14.toFixed(0)})`); }
      }
      if (isNum(m.fromHigh) && m.fromHigh <= -0.05 && m.fromHigh >= -0.12 && m.aboveSma200) {
        c += 4; why.push(`pulled back ${fmtPct(-m.fromHigh, 0)} from its high while the trend holds`);
      }
      // financial health
      const h = f.data && f.data.health;
      if (h && h.rating) {
        if (h.rating[0] === 'A') { c += 3; why.push(`strong finances (${h.rating})`); }
        else if (/^[CDF]/.test(h.rating)) { c -= 5; risks.push(`weaker finances (${h.rating})`); }
      }
      // earnings soon
      if (f.earnings && f.earnings.days <= 7) { c -= 5; risks.push(`results due ${f.earnings.days <= 1 ? 'within a day' : 'in ' + f.earnings.days + ' days'}`); timing = 'results'; }
      // news tone
      const tone = newsTone((symNews[a.symbol] || []).concat(mentions[a.symbol] || []));
      if (tone.net >= 2) { c += 3; why.push('recent headlines are positive'); }
      else if (tone.net <= -2) { c -= 4; risks.push('recent headlines are negative'); }
      // market mood and sector fit
      if (cautious) {
        if (DEFENSIVE.has(a.sector)) { c += 4; why.push(`${a.sector.toLowerCase()} tends to hold up in nervous markets`); }
        if (CYCLICAL.has(a.sector) || a.cls === 'crypto') { c -= 4; risks.push('the kind of asset investors are selling right now'); }
        if (isNum(m.vol) && m.vol > 0.35) { c -= 4; risks.push(`big swings (${fmtPct(m.vol, 0)} a year)`); }
      } else if (riskOn && CYCLICAL.has(a.sector)) { c += 3; why.push('growth assets tend to lead when markets are confident'); }
      if (strongSectors.includes(a.sector)) { c += 2; if (!why.some((w) => /sector|nervous/.test(w))) why.push(`${a.sector} is one of the strongest sectors`); }
      if (!why.length) why.push(...(a.reasons.pros.slice(0, 1).map((p) => p.charAt(0).toLowerCase() + p.slice(1))));
      if (a.signal !== 'BUY' && timing === 'now') timing = 'watch';
      // Falling over the past month: not a good buy right now, however strong the year has been.
      const falling = (isNum(m.r1m) && m.r1m <= -0.05) || (isNum(m.r3m) && m.r3m < 0);
      if (falling) {
        c -= 6;
        risks.unshift(isNum(m.r1m) && m.r1m <= -0.05 ? `it's fallen ${fmtPct(-m.r1m, 0)} in the past month` : `it's down ${fmtPct(-m.r3m, 1)} over the past 3 months`);
        if (timing === 'now') timing = 'watch';
      }
      // Takeover targets: once a bid is agreed the share price is pinned near the offer,
      // so it looks ultra-calm to the model but has almost no upside left.
      const pinned = a.cls === 'stock' && isNum(m.vol) && m.vol < 0.08;
      const bid = (symNews[a.symbol] || []).some((n) => TAKEOVER_RE.test(n.title || ''));
      if (pinned) {
        c -= 15;
        risks.unshift(bid ? 'a takeover offer is pending, so the price is pinned near the offer with little upside left'
                          : `the price has barely moved (${fmtPct(m.vol, 0)} annual swings), which usually means a takeover offer is pending`);
        timing = 'takeover';
      }
      // A dip level only makes sense below today's price.
      const dipLevel = isNum(m.sma50) && m.sma50 < m.price * 0.99 ? m.sma50 : null;
      if (timing === 'dip' && !dipLevel) timing = 'watch';
      return { a, conviction: Math.round(clamp(c, 0, 110)), why, risks, timing, dipLevel };
    }).sort((x, y) => y.conviction - x.conviction);

    // Diversified buy-now list: at most 2 per sector, no near-identical pairs.
    const picks = [], perSector = {};
    const clash = (sym) => SAME_BET.some((pair) => pair.includes(sym) && picks.some((p) => pair.includes(p.a.symbol) && p.a.symbol !== sym));
    for (const r of rows) {
      if (picks.length >= (opts.max || 5)) break;
      if (r.timing !== 'now' || r.a.signal !== 'BUY') continue;
      if ((perSector[r.a.sector] || 0) >= 2 || clash(r.a.symbol)) continue;
      perSector[r.a.sector] = (perSector[r.a.sector] || 0) + 1;
      picks.push(r);
    }
    const uk = rows.find((r) => r.a.cls === 'stock' && r.a.region === 'UK' && r.a.signal === 'BUY' && r.timing !== 'results' && r.timing !== 'takeover');
    const dips = rows.filter((r) => r.timing === 'dip' && r.a.signal === 'BUY').slice(0, 4);
    const results = rows.filter((r) => r.timing === 'results').slice(0, 3);
    const avoid = [];
    const cryptos = ranked.filter((a) => a.cls === 'crypto');
    if (cryptos.length && cryptos.every((a) => a.signal === 'AVOID')) avoid.push('All crypto — every coin is in a downtrend');
    const weakest = Object.entries(secAvg).map(([k, v]) => [k, v.reduce((s, x) => s + x, 0) / v.length]).sort((x, y) => x[1] - y[1])[0];
    if (weakest && weakest[1] < 45) avoid.push(`${weakest[0]} stocks — the weakest sector right now (average score ${Math.round(weakest[1])})`);
    // A plain verdict for every asset.
    const lower = (t) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : '');
    rows.forEach((r) => {
      const a = r.a;
      const firstCon = r.risks[0] || lower(a.reasons.cons[0]) || '';
      if (picks.includes(r) || uk === r) r.verdict = { key: 'top', label: 'Top pick', reason: r.why[0] || '' };
      else if (r.timing === 'takeover') r.verdict = { key: 'hold', label: 'Takeover pending', reason: r.risks[0] };
      else if (r.timing === 'results') r.verdict = { key: 'results', label: 'Wait for results', reason: r.risks.find((x) => /results/.test(x)) || '' };
      else if (a.signal === 'BUY' && r.timing === 'now') r.verdict = { key: 'good', label: 'Good buy', reason: r.why[0] || '' };
      else if (a.signal === 'BUY' && r.timing === 'dip') r.verdict = { key: 'dip', label: 'Buy on a dip', reason: firstCon };
      else if (a.signal === 'AVOID') r.verdict = { key: 'avoid', label: 'Avoid for now', reason: firstCon || 'weak trend and momentum' };
      else r.verdict = { key: 'hold', label: 'Not yet', reason: firstCon || `mixed signals (score ${a.score}/100), not strong enough to buy yet` };
    });
    const bySymbol = Object.fromEntries(rows.map((r) => [r.a.symbol, r]));
    return { style: 'trend', picks, uk: uk && !picks.includes(uk) ? uk : null, dips, results, avoid, strongSectors, bySymbol };
  }

  const api = {
    scoreAll, claudeView, newsTone, computeMetrics, marketRegime, percentiles, rsi, smaSeries, smaLast,
    returnOver, annualisedVol, indexDaysAgo, signalFor, WEIGHTS, FACTOR_LABELS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof window !== 'undefined' ? window : this);
