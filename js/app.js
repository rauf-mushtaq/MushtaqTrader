/* MushtaqTrader – real market data, best-buy ranking and market news to help decide what to buy. */
(function () {
  'use strict';

  const DATA_URL = 'data/market.json';
  const LIVE_CRYPTO_MS = 60 * 1000;
  const DATA_RELOAD_MS = 10 * 60 * 1000;    // full reload fallback
  const UPDATE_CHECK_MS = 60 * 1000;        // tiny "anything new?" check

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

  const state = {
    data: null,
    assets: [],
    bySym: {},
    regime: null,
    ranked: [],
    news: [],          // market headlines, each tagged with topics + mentioned assets
    loadError: null,
    tab: 'best',
    selected: null,
    lbFilter: 'all',
    lbSector: 'all',
    lbLimit: 25,
    mktFilter: 'all',
    newsTopic: 'all',
    mktOpen: new Set(),
    mktVerdict: 'all',
    search: '',
    tf: '6M',
    chartMode: 'candle',
    live: { status: 'off', at: null },
    fund: null,        // analyst / financial-health / earnings snapshot (data/fundamentals.json)
    note: null,        // Claude's written market note (data/claude_view.json)
    view: null,        // Claude's view picks, recalculated on every data change
    intraday: null,    // 15-minute prices for 1D/1W charts (data/intraday.json), loaded on demand
    intradayAt: 0,
    cg: null,          // live crypto market overview from CoinGecko
    watch: loadWatch(),
    prevBy: {},        // symbol -> {score, signal} as of the previous close
    track: [],         // past top-5 picks and how they did
  };

  // ---------------------------------------------------------------- watchlist
  function loadWatch() {
    try { const w = JSON.parse(localStorage.getItem('mushtaqtrader.watchlist') || '[]'); return Array.isArray(w) ? w : []; } catch (e) { return []; }
  }
  function toggleWatch(sym) {
    state.watch = state.watch.includes(sym) ? state.watch.filter((s) => s !== sym) : state.watch.concat(sym);
    try { localStorage.setItem('mushtaqtrader.watchlist', JSON.stringify(state.watch)); } catch (e) { /* ignore */ }
  }
  const starBtn = (sym) => `<button class="star ${state.watch.includes(sym) ? 'on' : ''}" data-star="${esc(sym)}" title="${state.watch.includes(sym) ? 'Remove from' : 'Add to'} watchlist" aria-label="Watchlist">★</button>`;

  // ---------------------------------------------------------------- formatting
  function fmtNum(x, dp) {
    return x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function priceDp(p) { return p >= 1 ? 2 : p >= 0.01 ? 4 : 6; }
  function fmtPrice(a, p) {
    if (!isNum(p)) return '—';
    if (a.cls === 'fx') return fmtNum(p, a.symbol.startsWith('USDJPY') ? 2 : 4);
    if (a.cls === 'index') return fmtNum(p, 2);
    const n = fmtNum(p, priceDp(p));
    const cur = a.currency;
    if (cur === 'GBp' || cur === 'GBX') return n + 'p';
    const sym = { USD: '$', GBP: '£', EUR: '€', JPY: '¥' }[cur];
    return sym ? sym + n : n + ' ' + esc(cur || '');
  }
  // Money change: whole-cent precision for normal prices, more only for tiny prices (e.g. small coins).
  function fmtDiff(a, x) {
    const p = a.metrics ? a.metrics.price : x;
    if (a.cls === 'crypto' && p < 1) return fmtPrice(a, x);
    const n = fmtNum(x, 2);
    if (a.currency === 'GBp' || a.currency === 'GBX') return n + 'p';
    const sym = { USD: '$', GBP: '£', EUR: '€', JPY: '¥' }[a.currency];
    return sym ? sym + n : n;
  }

  function pct(x, dp = 2) {
    if (!isNum(x)) return '<span class="faint">—</span>';
    const cls = x > 0 ? 'up' : x < 0 ? 'down' : 'muted';
    return `<span class="${cls}">${x > 0 ? '+' : x < 0 ? '−' : ''}${fmtNum(Math.abs(x * 100), dp)}%</span>`;
  }
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400 * 2) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }
  function fmtDate(sec, withTime) {
    const d = new Date(sec * 1000);
    const opts = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
    if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleString('en-GB', opts) + (withTime ? ' UTC' : '');
  }
  const CLASS_LABEL = { stock: 'Stock', etf: 'ETF', crypto: 'Crypto', index: 'Index', commodity: 'Commodity', fx: 'FX' };
  function typeLabel(a) {
    if (a.cls === 'stock') return a.region === 'UK' ? 'UK stock' : 'US stock';
    return CLASS_LABEL[a.cls] || a.cls;
  }
  function scoreColor(s) { return s >= 70 ? 'var(--up)' : s >= 45 ? 'var(--hold)' : 'var(--down)'; }

  // ---------------------------------------------------------------- news tagging
  const TOPICS = [
    ['fed', 'Fed & interest rates', /\b(fed|federal reserve|fomc|powell|interest rates?|rate cuts?|rate hikes?|treasur(y|ies)|bond yields?|yields|central bank|ecb|bank of england)\b/i],
    ['inflation', 'Inflation', /\b(inflation|cpi|pce|price index|deflation|cost of living)\b/i],
    ['economy', 'Jobs & economy', /\b(jobs?|payrolls?|unemployment|jobless|gdp|recession|economy|economic|growth)\b/i],
    ['earnings', 'Earnings', /\b(earnings|quarterly|results|revenue|profits?|guidance|forecast|outlook)\b/i],
    ['energy', 'Oil & energy', /\b(oil|crude|opec|brent|natural gas|gasoline|energy prices?)\b/i],
    ['trade', 'Trade & tariffs', /\b(tariffs?|trade war|trade deal|sanctions?|exports?|imports?)\b/i],
    ['consumer', 'Consumers & retail', /\b(consumers?|retail(ers?)?|shoppers?|spending|holiday sales|black friday)\b/i],
    ['crypto', 'Crypto', /\b(bitcoin|crypto(currency|currencies)?|ethereum|ether|stablecoins?|solana|xrp|dogecoin)\b/i],
    ['uk', 'UK', /\b(uk|britain|british|ftse|london|sterling|bank of england|reeves|starmer)\b/i],
  ];
  // Extra names a company goes by in headlines (matched case-sensitively, whole words).
  const ALIASES = {
    GOOGL: ['Google', 'Alphabet'], META: ['Meta', 'Facebook', 'Instagram'], NVDA: ['Nvidia', 'NVIDIA'], AMZN: ['Amazon'],
    'BRK-B': ['Berkshire', 'Buffett'], TSM: ['TSMC'], JPM: ['JPMorgan'], GE: ['GE Aerospace'], MCD: ["McDonald's", 'McDonald’s'],
    PG: ['Procter'], CMCSA: ['Comcast'], T: ['AT&T'], TSLA: ['Tesla', 'Musk'], TGT: ['Target Corp'],
    'BTC-USD': ['Bitcoin', 'bitcoin'], 'ETH-USD': ['Ethereum', 'Ether'], 'SOL-USD': ['Solana'], 'XRP-USD': ['XRP', 'Ripple'], 'DOGE-USD': ['Dogecoin'],
    'HSBA.L': ['HSBC'], 'BATS.L': ['British American Tobacco', 'BAT'], 'RR.L': ['Rolls-Royce'], 'BT-A.L': ['BT Group', 'BT'],
    'LLOY.L': ['Lloyds'], 'AZN.L': ['AstraZeneca'], 'SHEL.L': ['Shell'], 'BARC.L': ['Barclays'], 'NXT.L': ['Next plc'],
    'ULVR.L': ['Unilever'], 'TSCO.L': ['Tesco'], 'DGE.L': ['Diageo'], 'RIO.L': ['Rio Tinto'], 'VOD.L': ['Vodafone'], 'GSK.L': ['GSK'], 'BP.L': ['BP'],
  };
  let mentionMatchers = [];
  function buildMatchers() {
    const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    mentionMatchers = state.assets
      .filter((a) => a.cls === 'stock' || a.cls === 'crypto')
      .map((a) => {
        const names = ALIASES[a.symbol] || [a.name];
        if (!names.length) return null;
        return { sym: a.symbol, re: new RegExp(`(^|[^A-Za-z0-9])(${names.map(reEsc).join('|')})(?![A-Za-z0-9])`) };
      })
      .filter(Boolean);
  }
  function tagHeadline(n) {
    const topics = TOPICS.filter(([, , re]) => re.test(n.title)).map(([k]) => k);
    const mentions = mentionMatchers.filter((m) => m.re.test(n.title)).map((m) => m.sym);
    return Object.assign({}, n, { topics, mentions });
  }
  function newsFor(sym) {
    let own = ((state.data.news || {}).symbols || {})[sym] || [];
    // Prefer headlines that actually name the company; Yahoo's per-ticker feed includes generic list articles.
    const m = mentionMatchers.find((x) => x.sym === sym);
    const bare = sym.replace(/[-.].*$/, '');
    const named = own.filter((n) => (m && m.re.test(n.title)) || new RegExp(`\\b${bare}\\b`).test(n.title));
    if (named.length) own = named;
    const mentioned = state.news.filter((n) => n.mentions.includes(sym));
    const seen = new Set();
    return own.concat(mentioned)
      .filter((n) => safeUrl(n.link) && !seen.has(n.title) && seen.add(n.title))
      .sort((x, y) => (y.time || 0) - (x.time || 0))
      .slice(0, 8);
  }

  // ---------------------------------------------------------------- data
  async function loadJson(path) {
    try {
      const res = await fetch(path + '?v=' + Date.now(), { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch (e) { return null; }
  }

  async function loadFundamentals() {
    try {
      const res = await fetch('data/fundamentals.json?v=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return null;
      const f = await res.json();
      return f && f.stocks ? f : null;
    } catch (e) { return null; }
  }

  async function loadData(initial) {
    try {
      const res = await fetch(DATA_URL + '?v=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data || !Array.isArray(data.assets) || !data.assets.length) throw new Error('empty data file');
      if (!initial && state.data && data.generated_at === state.data.generated_at) return;
      state.fund = await loadFundamentals();
      state.note = await loadJson('data/claude_view.json');
      // Add economy series that only the fundamentals snapshot has (e.g. retail sales).
      const have = new Set((data.macro || []).map((m) => m.id));
      data.macro = (data.macro || []).concat(((state.fund || {}).macro || []).filter((m) => !have.has(m.id)));
      state.data = data;
      state.assets = data.assets;
      state.bySym = Object.fromEntries(data.assets.map((a) => [a.symbol, a]));
      state.loadError = null;
      if (!state.selected || !state.bySym[state.selected]) state.selected = null;
      buildMatchers();
      state.news = ((data.news || {}).market || []).filter((n) => safeUrl(n.link)).map(tagHeadline);
      rescore();
      computeHistory();
      state.intradayAt = 0; // newer intraday prices come with each data update
      if (!initial && state.tab === 'asset' && INTRADAY_TF.has(state.tf)) loadIntraday(true);
      if (initial) { render(); pollCrypto(); if (INTRADAY_TF.has(state.tf)) loadIntraday(); }
      else { softRender(); toast('New prices loaded — updated ' + ago(Date.parse(data.generated_at))); }
    } catch (e) {
      if (initial) {
        state.loadError = e.message || String(e);
        render();
      }
    }
  }

  // Re-score the universe using only data up to a past point, to see what changed and how past picks did.
  function scoreAsOf(cutoffSec, dropLastBar, withFundamentals) {
    const assets = state.assets.map((a) => {
      let k = a.c.length - 1;
      if (!dropLastBar) { k = 0; while (k < a.t.length && a.t[k] <= cutoffSec) k++; }
      return Object.assign({}, a, {
        t: a.t.slice(0, k), o: a.o.slice(0, k), h: a.h.slice(0, k), l: a.l.slice(0, k), c: a.c.slice(0, k), v: a.v.slice(0, k),
        live: false, metrics: null, score: null, signal: null,
      });
    }).filter((a) => a.c.length >= 2);
    const cutDate = cutoffSec ? new Date(cutoffSec * 1000).toISOString().slice(0, 10) : null;
    const macro = (state.data.macro || []).map((m) => {
      if (!cutDate) return m;
      const n = m.dates.filter((d) => d <= cutDate).length;
      return Object.assign({}, m, { dates: m.dates.slice(0, n), values: m.values.slice(0, n) });
    });
    return Scoring.scoreAll(assets, macro, withFundamentals ? state.fund : null);
  }

  function computeHistory() {
    try {
      const prev = scoreAsOf(null, true, true);
      state.prevBy = Object.fromEntries(prev.ranked.map((a) => [a.symbol, { score: a.score, signal: a.signal }]));
      const spx = state.bySym.SPY || state.bySym['^GSPC'];
      const lastT = spx ? spx.t[spx.t.length - 1] : Math.floor(Date.now() / 1000);
      const fwd = (sym, cut) => {
        const a = state.bySym[sym];
        if (!a) return null;
        let k = -1;
        for (let i = 0; i < a.t.length && a.t[i] <= cut; i++) k = i;
        return k >= 0 && a.c[k] ? a.c[a.c.length - 1] / a.c[k] - 1 : null;
      };
      const avg = (xs) => { const v = xs.filter(isNum); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
      state.track = [30, 61, 91].map((days) => {
        const cut = lastT - days * 86400;
        const res = scoreAsOf(cut, false);
        const picks = res.ranked.slice(0, 5).map((a) => ({ sym: a.symbol, score: a.score, ret: fwd(a.symbol, cut) }));
        return {
          days, cut, regime: res.regime.label, picks,
          avg: avg(picks.map((p) => p.ret)),
          all: avg(res.ranked.map((a) => fwd(a.symbol, cut))),
          spy: fwd('SPY', cut),
        };
      }).filter((r) => r.picks.length);
    } catch (e) {
      state.prevBy = {}; state.track = [];
    }
  }

  function rescore() {
    const res = Scoring.scoreAll(state.assets, state.data.macro || [], state.fund);
    state.regime = res.regime;
    state.ranked = res.ranked;
    const mentions = {};
    state.news.forEach((n) => n.mentions.forEach((sym) => { (mentions[sym] = mentions[sym] || []).push(n); }));
    state.view = Scoring.claudeView(res.ranked, res.regime, { symbolNews: (state.data.news || {}).symbols || {}, mentions });
    if (!state.selected && res.ranked.length) state.selected = res.ranked[0].symbol;
  }

  async function pollCryptoMarket() {
    try {
      const [g, t] = await Promise.all([
        fetch('https://api.coingecko.com/api/v3/global').then((r) => (r.ok ? r.json() : null)),
        fetch('https://api.coingecko.com/api/v3/search/trending').then((r) => (r.ok ? r.json() : null)),
      ]);
      const gd = g && g.data;
      state.cg = {
        at: Date.now(),
        cap: gd && gd.total_market_cap ? gd.total_market_cap.usd : null,
        capChange: gd ? gd.market_cap_change_percentage_24h_usd : null,
        btcDom: gd && gd.market_cap_percentage ? gd.market_cap_percentage.btc : null,
        ethDom: gd && gd.market_cap_percentage ? gd.market_cap_percentage.eth : null,
        trending: ((t && t.coins) || []).slice(0, 7).map((c) => c.item).filter(Boolean).map((i) => ({
          name: i.name, symbol: i.symbol, rank: i.market_cap_rank,
          change: i.data && i.data.price_change_percentage_24h ? i.data.price_change_percentage_24h.usd : null,
        })),
      };
      if (state.tab === 'markets') softRender();
    } catch (e) { /* keep last values */ }
  }

  async function pollCrypto() {
    const cryptos = state.assets.filter((a) => a.cg);
    if (!cryptos.length) return;
    const ids = cryptos.map((a) => a.cg).join(',');
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_last_updated_at=true`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      let n = 0;
      cryptos.forEach((a) => {
        const q = j[a.cg];
        if (q && isNum(q.usd) && q.usd > 0) { applyLivePrice(a, q.usd); n++; }
      });
      state.live = { status: n ? 'live' : 'error', at: Date.now() };
      if (n) { rescore(); softRender(); } else renderStatus();
    } catch (e) {
      state.live = { status: 'error', at: state.live.at };
      renderStatus();
    }
  }

  function applyLivePrice(a, p) {
    const now = Math.floor(Date.now() / 1000);
    const i = a.c.length - 1;
    if (Math.floor(now / 86400) > Math.floor(a.t[i] / 86400)) {
      a.t.push(now); a.o.push(a.c[i]); a.h.push(Math.max(a.c[i], p)); a.l.push(Math.min(a.c[i], p)); a.c.push(p); a.v.push(0);
    } else {
      a.c[i] = p; a.h[i] = Math.max(a.h[i], p); a.l[i] = Math.min(a.l[i], p);
    }
    a.live = true;
  }

  // ---------------------------------------------------------------- svg helpers
  function sparkline(values, w = 200, h = 36, color) {
    const v = values.filter(isNum);
    if (v.length < 2) return '';
    const min = Math.min(...v), max = Math.max(...v), rng = max - min || 1;
    const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - ((x - min) / rng) * (h - 4)).toFixed(1)}`);
    const col = color || (v[v.length - 1] >= v[0] ? 'var(--up)' : 'var(--down)');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
  }
  function scoreRing(score) {
    const r = 36, c = 2 * Math.PI * r, f = (score / 100) * c;
    return `<div class="score-ring"><svg width="84" height="84" viewBox="0 0 84 84">
      <circle cx="42" cy="42" r="${r}" fill="none" stroke="var(--border)" stroke-width="7"/>
      <circle cx="42" cy="42" r="${r}" fill="none" stroke="${scoreColor(score)}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${f} ${c}"/></svg>
      <div class="val"><div>${score}<small>/ 100</small></div></div></div>`;
  }
  function scoreBar(score) {
    if (!isNum(score)) return '<span class="faint">—</span>';
    return `<div class="scorebar"><div class="track"><div class="fill" style="width:${score}%;background:${scoreColor(score)}"></div></div><b>${score}</b></div>`;
  }
  const badge = (sig) => (sig ? `<span class="badge ${sig}">${sig}</span>` : '');
  function scoreDelta(a) {
    const p = state.prevBy[a.symbol];
    if (!p || a.score == null) return '';
    const d = a.score - p.score;
    if (Math.abs(d) < 1) return '';
    return `<span class="delta-chip ${d > 0 ? 'up' : 'down'}" title="Change since the previous close">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
  }

  // ---------------------------------------------------------------- news rendering
  function headline(n, opts = {}) {
    const url = safeUrl(n.link);
    if (!url) return '';
    const topics = (n.topics || []).map((k) => TOPICS.find((t) => t[0] === k)).filter(Boolean)
      .map((t) => `<span class="ntag">${t[1]}</span>`).join('');
    const mentions = opts.hideMentions ? '' : (n.mentions || []).map((s) => {
      const a = state.bySym[s];
      return a ? `<button class="nasset" data-open="${esc(s)}" title="${esc(a.name)}">${esc(s)}${a.signal ? ` <span class="badge ${a.signal}">${a.signal}</span>` : ''}</button>` : '';
    }).join('');
    return `<li class="news-item">
      <a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(n.title)}</a>
      <div class="news-meta"><span>${esc(n.source)}${n.time ? ' · ' + ago(n.time * 1000) : ''}</span>${topics}${mentions}</div>
    </li>`;
  }

  // ---------------------------------------------------------------- header
  function renderStatus() {
    const chips = [];
    if (state.data) {
      const gen = Date.parse(state.data.generated_at);
      const old = Date.now() - gen > 1000 * 60 * 60 * 26;
      chips.push(`<span class="chip ${old ? 'warn' : 'ok'}" title="Stocks, ETFs, indices, news and economic data">
        <span class="dot"></span><span class="long">Real data · updated</span><span class="short">Updated</span> ${ago(gen)}</span>`);
    } else if (state.loadError) {
      chips.push('<span class="chip err"><span class="dot"></span>NO DATA</span>');
    }
    if (state.live.status === 'live') chips.push('<span class="chip ok" title="Crypto prices stream from CoinGecko every minute"><span class="dot"></span>CRYPTO LIVE</span>');
    else if (state.live.status === 'error') chips.push('<span class="chip warn" title="Could not reach CoinGecko; using last data refresh"><span class="dot"></span>CRYPTO DELAYED</span>');
    $('#status').innerHTML = chips.join('');

    const r = state.regime, top = state.ranked[0];
    $('#hdr-summary').innerHTML = r && top ? `<span class="muted">MARKET <b class="regime-label ${r.label}" style="font-size:12px">${r.label.toUpperCase()}</b></span>
      <span class="muted">TOP PICK <a href="#" data-open="${esc(top.symbol)}"><b>${esc(top.symbol)}</b></a> ${top.score}</span>` : '';
  }

  // ---------------------------------------------------------------- routing (#best, #news, #asset/AAPL ...)
  const TABS = ['best', 'news', 'markets', 'economy', 'asset'];
  function readRoute() {
    let h = '';
    try { h = decodeURIComponent(location.hash.slice(1)); } catch (e) { h = ''; }
    if (h.startsWith('asset/')) { state.tab = 'asset'; state.selected = h.slice(6) || state.selected; }
    else if (TABS.includes(h)) state.tab = h;
  }
  function writeRoute() {
    const h = state.tab === 'asset' && state.selected ? '#asset/' + encodeURIComponent(state.selected) : '#' + state.tab;
    if (location.hash !== h) { try { history.pushState(null, '', h); } catch (e) { /* ignore */ } }
    const a = state.tab === 'asset' && state.bySym[state.selected];
    document.title = a ? `${a.symbol} ${a.signal ? '(' + a.signal + ') ' : ''}– MushtaqTrader` : 'MushtaqTrader – Real Market Data & Best Buys';
  }
  window.addEventListener('popstate', () => { readRoute(); render(); });

  // ---------------------------------------------------------------- views
  function render() {
    renderStatus();
    if (state.data) writeRoute();
    document.querySelectorAll('.tab, .bnav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    const view = $('#view');
    if (!state.data) {
      view.innerHTML = state.loadError ? emptyState() : '<div class="loading">Loading real market data…</div>';
      return;
    }
    if (state.tab === 'best') view.innerHTML = viewBest();
    else if (state.tab === 'news') view.innerHTML = viewNews();
    else if (state.tab === 'markets') view.innerHTML = viewMarkets();
    else if (state.tab === 'economy') view.innerHTML = viewEconomy();
    else if (state.tab === 'asset') { view.innerHTML = viewAsset(); drawChart(); }
  }

  // Re-render after a live price tick without clobbering what the user is typing.
  function softRender() {
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest('#view') && /INPUT|SELECT/.test(ae.tagName)) { renderStatus(); return; }
    render();
  }

  function emptyState() {
    const local = location.protocol === 'file:';
    return `<div class="card" style="max-width:720px;margin:40px auto">
      <h2 style="margin-bottom:8px">No market data yet</h2>
      <p class="muted">The app reads real prices and news from <code>data/market.json</code>, which a GitHub Action
      (<b>Update market data</b>) refreshes every 30 minutes on market days.</p>
      <ol class="muted">
        <li>On GitHub open <b>Actions → Update market data → Run workflow</b> to create the file.</li>
        ${local ? '<li>Browsers block reading files when you open the page straight from disk. Serve it instead, e.g. <code>python3 -m http.server</code> and visit <code>http://localhost:8000</code>, or use GitHub Pages.</li>' : '<li>Reload this page once the action has finished.</li>'}
      </ol>
      <p class="faint small">Error: ${esc(state.loadError)}</p></div>`;
  }

  function regimeCard() {
    const r = state.regime;
    if (!r) return '';
    const items = r.factors.map((f) => `<li><span class="sig ${f.signal > 0 ? 'p' : f.signal < 0 ? 'n' : 'z'}">${f.signal > 0 ? '+' : f.signal < 0 ? '−' : '·'}</span><span>${esc(f.text)}</span></li>`).join('');
    return `<div class="card">
      <div class="card-title">Market backdrop</div>
      <div class="regime">
        <div><div class="regime-label ${r.label}">${r.label.toUpperCase()}</div>
          <div class="small muted">Signal total ${r.total > 0 ? '+' : ''}${r.total} from ${r.factors.length} indicators</div></div>
        <div><p style="margin:0 0 10px">${esc(r.summary)}</p>
          <details class="regime-more" ${isWide() ? 'open' : ''}><summary>Show the ${r.factors.length} indicators behind this ›</summary>
            <ul class="factor-list">${items}</ul></details></div>
      </div>
    </div>`;
  }

  const describe = (sym) => (window.Companies ? window.Companies.describe(sym) : '');
  function verdictBadge(r) {
    if (!r || !r.verdict) return '';
    return `<span class="vb ${r.verdict.key}">${esc(r.verdict.label)}</span>`;
  }
  function verdictText(r, a) {
    if (!r || !r.verdict) return '';
    let reason = r.verdict.reason || '';
    if (r.verdict.key === 'dip' && r.dipLevel) reason = `wait for it to dip below ${fmtPrice(a, r.dipLevel)}${reason ? ' (' + reason + ')' : ''}`;
    return reason ? reason.charAt(0).toUpperCase() + reason.slice(1) + '.' : '';
  }

  const isWide = () => !window.matchMedia || window.matchMedia('(min-width: 721px)').matches;

  function filterRanked(filter, sector) {
    return state.ranked.filter((a) => {
      if (filter === 'watch' && !state.watch.includes(a.symbol)) return false;
      if (filter === 'us' && !(a.cls === 'stock' && a.region === 'US')) return false;
      if (filter === 'uk' && !(a.cls === 'stock' && a.region === 'UK')) return false;
      if (filter === 'etf' && a.cls !== 'etf') return false;
      if (filter === 'crypto' && a.cls !== 'crypto') return false;
      if (sector !== 'all' && a.sector !== sector) return false;
      return true;
    });
  }

  // Plain-English verdict for one asset.
  function verdict(a) {
    if (a.score == null) return { title: 'Not scored', text: `${typeLabel(a)}s are shown for market context only.` };
    const m = a.metrics;
    const hot = isNum(m.rsi14) && m.rsi14 > 70;
    if (a.signal === 'BUY' && hot) return { title: 'Strong, but stretched', text: `It ranks #${a.rankPos} of ${state.ranked.length}, but it has risen fast (RSI ${m.rsi14.toFixed(0)}). Buyers often wait for a pullback towards the 50-day average (${fmtPrice(a, m.sma50)}).` };
    if (a.signal === 'BUY') return { title: 'Data supports buying', text: `It ranks #${a.rankPos} of ${state.ranked.length} on trend, momentum and risk, and the entry timing looks reasonable. Check the news below for anything that could change the picture.` };
    if (a.signal === 'HOLD') return { title: 'No clear edge', text: `Mixed signals (rank #${a.rankPos} of ${state.ranked.length}). If you already own it there is no strong reason to sell; if not, higher-ranked assets look better right now.` };
    return { title: 'Data says avoid for now', text: `Weak trend or momentum (rank #${a.rankPos} of ${state.ranked.length}). The price data does not support buying at the moment.` };
  }

  function viewBest() {
    const top = state.ranked[0];
    if (!top) return '<div class="card empty">Not enough price history to rank assets yet.</div>';
    const m = top.metrics;
    const runners = state.ranked.slice(1, 4);
    const winners = [
      ['Best US stock', filterRanked('us', 'all')[0]],
      ['Best UK stock', filterRanked('uk', 'all')[0]],
      ['Best ETF / fund', filterRanked('etf', 'all')[0]],
      ['Best crypto', filterRanked('crypto', 'all')[0]],
    ].filter(([, a]) => a);

    const sectors = [...new Set(state.ranked.map((a) => a.sector))].sort();
    const list = filterRanked(state.lbFilter, state.lbSector);
    const shown = list.slice(0, state.lbLimit);
    const counts = { BUY: 0, HOLD: 0, AVOID: 0 };
    list.forEach((a) => counts[a.signal]++);
    const topNews = newsFor(top.symbol).slice(0, 3);
    const bigNews = state.news.filter((n) => n.topics.some((t) => ['fed', 'inflation', 'economy', 'trade'].includes(t))).slice(0, 5);

    return `
      <h1 class="section-title">Today's best buys</h1>
      <p class="section-sub">${state.ranked.length} real stocks, funds and cryptocurrencies scored on momentum, trend, risk, analysts, news and the economic backdrop.</p>
      ${claudeCard()}
      <h2 class="section-title">The model's #1</h2>
      <div class="card hero">
        <div>
          <div class="kicker">#1 overall · ${esc(typeLabel(top))} · ${esc(top.sector)}</div>
          <div class="row" style="gap:16px;margin-top:8px;align-items:center">
            ${scoreRing(top.score)}
            <div style="min-width:0">
              <div class="sym">${esc(top.symbol)}</div>
              <div class="name">${esc(top.name)}</div>
              <div class="row wrap" style="margin-top:6px">
                <span class="price">${fmtPrice(top, m.price)}</span>
                ${top.fund && top.fund.data && top.fund.data.grades ? `<span class="badge type">Analysts: ${esc(top.fund.data.grades.consensus)}${isNum(top.fund.upside) ? (Math.abs(top.fund.upside) < 0.01 ? ' · at target' : ' · target ' + (top.fund.upside >= 0 ? '+' : '−') + Math.abs(top.fund.upside * 100).toFixed(0) + '%') : ''}</span>` : ''}
                <span class="mono">${pct(m.change1d)} today</span>
                ${badge(top.signal)}${top.live ? '<span class="badge live">LIVE</span>' : ''}
              </div>
            </div>
          </div>
          <div class="spark" style="margin-top:12px">${sparkline(top.c.slice(-90), 400, 60)}</div>
          <div class="row wrap tiny muted mono">
            <span>1M ${pct(m.r1m, 1)}</span><span>3M ${pct(m.r3m, 1)}</span><span>1Y ${pct(m.r1y, 1)}</span>
            <span>RSI ${isNum(m.rsi14) ? m.rsi14.toFixed(0) : '—'}</span><span>Vol ${isNum(m.vol) ? (m.vol * 100).toFixed(0) + '%' : '—'}</span>
          </div>
          ${topNews.length ? `<div class="card-title" style="margin-top:14px">Latest ${esc(top.symbol)} news</div><ul class="news-list compact">${topNews.map((n) => headline(n, { hideMentions: true })).join('')}</ul>` : ''}
        </div>
        <div>
          <div class="card-title">Why it ranks #1</div>
          <ul class="reasons pros">${top.reasons.pros.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>Solid across all factors</li>'}</ul>
          ${top.reasons.cons.length ? `<div class="card-title" style="margin-top:12px">Watch out for</div><ul class="reasons cons">${top.reasons.cons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
          <div class="row wrap" style="margin-top:14px">
            <button class="btn buy" data-open="${esc(top.symbol)}">Full analysis of ${esc(top.symbol)}</button>
          </div>
          ${runners.length ? `<div class="small muted" style="margin-top:12px">Runners-up: ${runners.map((a) => `<a href="#" data-open="${esc(a.symbol)}">${esc(a.symbol)}</a> (${a.score})`).join(', ')}</div>` : ''}
        </div>
      </div>

      <div style="height:16px"></div>
      ${regimeCard()}
      <div class="grid cols-3" style="margin-top:16px">${changesCard()}${earningsCard() || ''}${watchCard()}</div>

      <h2 class="section-title">Best in each market</h2>
      <div class="grid cols-4">
        ${winners.map(([label, a]) => `
          <div class="card winner" data-open="${esc(a.symbol)}">
            <div class="card-title">${label}</div>
            <div class="row between"><div style="min-width:0"><div class="sym">${esc(a.symbol)}</div>
              <div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.name)}</div></div>
              ${scoreBar(a.score)}</div>
            <div class="row between mono small" style="margin-top:8px"><span>${fmtPrice(a, a.metrics.price)}</span><span>3M ${pct(a.metrics.r3m, 1)}</span>${badge(a.signal)}</div>
            ${a.signal !== 'BUY' ? '<div class="faint tiny" style="margin-top:6px">None in this group is rated BUY right now.</div>' : ''}
          </div>`).join('')}
      </div>

      ${sectorCard()}

      ${bigNews.length ? `<h2 class="section-title">Big-picture news to know</h2>
      <div class="card"><ul class="news-list">${bigNews.map((n) => headline(n)).join('')}</ul>
        <div style="margin-top:8px"><a href="#" data-tab="news">All market news →</a></div></div>` : ''}

      <h2 class="section-title">Full ranking</h2>
      <div class="card">
        <div class="row wrap between" style="margin-bottom:12px;gap:10px">
          <div class="chips scroll-x" style="flex:1;min-width:0">
            ${[['all', 'All'], ['watch', '★ Watchlist'], ['us', 'US stocks'], ['uk', 'UK stocks'], ['etf', 'ETFs'], ['crypto', 'Crypto']].map(([k, l]) => `<button class="fchip ${state.lbFilter === k ? 'active' : ''}" data-lb="${k}">${l}</button>`).join('')}
          </div>
          <select class="input" id="lb-sector" aria-label="Sector">
            <option value="all">All sectors</option>
            ${sectors.map((s) => `<option ${state.lbSector === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
        <div class="small muted" style="margin-bottom:6px">${list.length} assets · <span class="up">${counts.BUY} BUY</span> · <span style="color:var(--hold)">${counts.HOLD} HOLD</span> · <span class="down">${counts.AVOID} AVOID</span></div>
        ${rankList(shown)}
        <div class="table-wrap rank-table"><table>
          <thead><tr><th></th><th>#</th><th>Asset</th><th class="hide-sm">Type</th><th class="num">Price</th><th class="num">1D</th>
            <th class="num hide-sm">1M</th><th class="num">3M</th><th class="num hide-sm">1Y</th><th class="num hide-sm">RSI</th><th class="num hide-sm" title="Analysts' average price target vs today's price">Target</th><th>Score</th><th>Signal</th></tr></thead>
          <tbody>${shown.map((a) => {
            const mm = a.metrics;
            return `<tr class="click" data-open="${esc(a.symbol)}">
              <td class="star-cell">${starBtn(a.symbol)}</td>
              <td class="mono faint">${a.rankPos}</td>
              <td class="asset-cell"><b>${esc(a.symbol)}</b>${a.live ? ' <span class="badge live">LIVE</span>' : ''}<div>${esc(a.name)}</div></td>
              <td class="hide-sm"><span class="badge type">${esc(typeLabel(a))}</span></td>
              <td class="num">${fmtPrice(a, mm.price)}</td>
              <td class="num">${pct(mm.change1d)}</td>
              <td class="num hide-sm">${pct(mm.r1m, 1)}</td>
              <td class="num">${pct(mm.r3m, 1)}</td>
              <td class="num hide-sm">${pct(mm.r1y, 1)}</td>
              <td class="num hide-sm">${isNum(mm.rsi14) ? mm.rsi14.toFixed(0) : '—'}</td>
              <td class="num hide-sm">${a.fund && isNum(a.fund.upside) ? pct(a.fund.upside, 0) : '<span class="faint">—</span>'}</td>
              <td><div class="row" style="gap:6px">${scoreBar(a.score)}${scoreDelta(a)}</div></td><td>${badge(a.signal)}</td></tr>`;
          }).join('')}</tbody></table></div>
        ${list.length > shown.length ? `<div style="text-align:center;margin-top:10px"><button class="btn sm" id="lb-more">Show all ${list.length}</button></div>` : ''}
        ${state.lbFilter === 'watch' && !list.length ? '<div class="empty small">Your watchlist is empty. Tap ★ next to any asset to add it.</div>' : ''}
      </div>
      ${trackCard()}
      ${methodology()}`;
  }

  const TIMING = { now: ['BUY NOW', 'BUY'], dip: ['BUY ON A DIP', 'HOLD'], results: ['WAIT FOR RESULTS', 'HOLD'], watch: ['WATCH', 'HOLD'] };
  function claudeCard() {
    const v = state.view;
    if (!v || !v.picks.length) return '';
    const note = state.note;
    const noteAge = note && note.updated ? (Date.now() - Date.parse(note.updated)) / 86400000 : null;
    const dataAt = Date.parse(state.data.generated_at);
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const row = (r, i) => {
      const a = r.a, m = a.metrics, f = a.fund || {};
      const uk = a.cls === 'stock' && a.region === 'UK';
      return `<li class="cv-pick" data-open="${esc(a.symbol)}">
        <div class="cv-rank">${i + 1}</div>
        <div class="cv-main">
          <div class="row wrap" style="gap:6px 8px"><b class="cv-sym">${esc(a.symbol)}</b><span class="muted small">${esc(a.name)}</span>
            <span class="badge BUY">${TIMING[r.timing][0]}</span>${uk ? '<span class="badge type" title="UK share: no currency risk, ISA-friendly">UK · ISA-friendly</span>' : ''}</div>
          ${describe(a.symbol) ? `<div class="tiny cv-desc">${esc(describe(a.symbol))}</div>` : ''}
          <div class="small cv-why">${esc(cap(r.why.slice(0, 3).join('; ')))}.</div>
          <div class="tiny cv-risk">${r.risks.length ? 'Watch: ' + esc(r.risks.slice(0, 2).join('; ')) : 'No major warning signs in the data.'}${f.earnings ? ' · Results ' + esc(earnLabel(f.earnings)) : ''}</div>
        </div>
        <div class="cv-right"><div class="px">${fmtPrice(a, m.price)}</div><div class="small">${pct(m.change1d)}</div>
          ${isNum(f.upside) ? `<div class="tiny muted">Target ${pct(f.upside, 0)}</div>` : ''}</div>
      </li>`;
    };
    const chip = (r, label) => `<button class="nasset big" data-open="${esc(r.a.symbol)}">${esc(r.a.symbol)} <span class="faint">${label}</span></button>`;
    return `<div class="card claude">
      <div class="row between wrap" style="gap:6px;margin-bottom:6px">
        <div class="cv-title"><span class="cv-logo">✦</span> Claude's view</div>
        <span class="tiny faint">Picks recalculated ${ago(dataAt)} from the latest prices, news and analyst data</span>
      </div>
      ${note && note.headline ? `<h2 class="cv-head">${esc(note.headline)}</h2>` : ''}
      <p class="cv-summary">${esc(note && note.summary ? note.summary : state.regime.summary)}</p>
      ${note && Array.isArray(note.points) && note.points.length ? `<ul class="cv-points">${note.points.slice(0, 5).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      ${note && note.updated ? `<div class="tiny faint" style="margin:-4px 0 12px">Market note written ${fmtDate(Date.parse(note.updated) / 1000, true)}${noteAge > 4 ? ' · <span style="color:var(--hold)">older note — picks below are still current</span>' : ''}</div>` : ''}
      <div class="card-title" style="margin-top:6px">My picks right now</div>
      <ol class="cv-picks">${v.picks.map(row).join('')}</ol>
      ${v.uk ? `<div class="card-title" style="margin-top:14px">Best UK option</div><ol class="cv-picks">${row(v.uk, v.picks.length)}</ol>` : ''}
      <div class="grid cols-3 cv-more">
        ${v.dips.length ? `<div><div class="small muted" style="margin-bottom:8px">Good companies — wait for a dip</div><div class="chips">${v.dips.map((r) => chip(r, r.dipLevel ? 'below ' + fmtPrice(r.a, r.dipLevel) : 'stretched')).join('')}</div></div>` : ''}
        ${v.results.length ? `<div><div class="small muted" style="margin-bottom:8px">Results due — wait and see</div><div class="chips">${v.results.map((r) => chip(r, r.a.fund && r.a.fund.earnings ? earnLabel(r.a.fund.earnings).replace(/\s*\(.*\)/, '') : '')).join('')}</div></div>` : ''}
        ${v.avoid.length ? `<div><div class="small muted" style="margin-bottom:8px">Avoid for now</div><ul class="cv-avoid">${v.avoid.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      </div>
      <p class="tiny faint" style="margin:14px 0 0">How this works: the picks re-rank automatically every time prices, news or analyst data change, using the reasoning Claude applies — analyst upside, entry timing, financial health, earnings dates, headline tone, which sectors suit the current market, and no doubling up on near-identical holdings. The written note is refreshed three times each weekday (UK morning, before the US open and after the US close). It's a research shortlist, not financial advice; prices can fall as well as rise.</p>
    </div>`;
  }

  function rankList(items) {
    return `<ul class="rlist">${items.map((a) => {
      const mm = a.metrics;
      return `<li data-open="${esc(a.symbol)}">
        <span class="rk">${a.rankPos}</span>${starBtn(a.symbol)}
        <div class="nm" style="min-width:0"><b>${esc(a.symbol)}</b>${a.live ? ' <span class="badge live">LIVE</span>' : ''}<div>${esc(a.name)}</div></div>
        <div class="rt"><div class="px">${fmtPrice(a, mm.price)} <span class="small">${pct(mm.change1d)}</span></div>
          <div class="sc">${scoreDelta(a)}<span class="pill-score" style="background:${scoreColor(a.score)}">${a.score}</span>${badge(a.signal)}</div></div>
      </li>`;
    }).join('')}</ul>`;
  }

  function changesCard() {
    const now = state.ranked;
    const gained = now.filter((a) => a.signal === 'BUY' && state.prevBy[a.symbol] && state.prevBy[a.symbol].signal !== 'BUY');
    const lost = now.filter((a) => a.signal !== 'BUY' && state.prevBy[a.symbol] && state.prevBy[a.symbol].signal === 'BUY');
    const movers = now.filter((a) => state.prevBy[a.symbol])
      .map((a) => [a, a.score - state.prevBy[a.symbol].score]).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 4);
    const chip = (a) => `<button class="nasset big" data-open="${esc(a.symbol)}">${esc(a.symbol)} ${badge(a.signal)} <span class="faint">${a.score}</span></button>`;
    const empty = !gained.length && !lost.length;
    return `<div class="card">
      <div class="card-title">What changed since the last close</div>
      ${gained.length ? `<div class="small muted" style="margin-bottom:6px">New BUY signals</div><div class="chips" style="margin-bottom:10px">${gained.slice(0, 8).map(chip).join('')}</div>` : ''}
      ${lost.length ? `<div class="small muted" style="margin-bottom:6px">Lost their BUY signal</div><div class="chips" style="margin-bottom:10px">${lost.slice(0, 8).map(chip).join('')}</div>` : ''}
      ${empty ? '<p class="small muted" style="margin:0 0 10px">No BUY signals were gained or lost since the previous close.</p>' : ''}
      ${movers.length ? `<div class="small muted" style="margin-bottom:6px">Biggest score moves</div>${movers.map(([a, d]) => `<div class="kv click" data-open="${esc(a.symbol)}" style="cursor:pointer"><span><b class="mono">${esc(a.symbol)}</b> <span class="muted small">${esc(a.name)}</span></span><span>${a.score} <span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'}${Math.abs(d)}</span></span></div>`).join('')}` : ''}
    </div>`;
  }

  function watchCard() {
    const items = state.watch.map((s) => state.bySym[s]).filter(Boolean);
    return `<div class="card">
      <div class="card-title">Your watchlist</div>
      ${items.length ? items.map((a) => `<div class="kv click" data-open="${esc(a.symbol)}" style="cursor:pointer">
          <span><b class="mono">${esc(a.symbol)}</b> <span class="muted small">${esc(a.name)}</span></span>
          <span class="row" style="gap:8px"><span class="mono small">${fmtPrice(a, a.metrics.price)}</span><span class="mono small">${pct(a.metrics.change1d)}</span>${a.signal ? badge(a.signal) : ''}${scoreDelta(a)}</span></div>`).join('')
        : '<p class="small muted" style="margin:0">Tap ★ next to any asset in the ranking or on its analysis page to follow it here. Saved in this browser only.</p>'}
    </div>`;
  }

  function sectorCard() {
    const groups = {};
    state.ranked.filter((a) => a.cls === 'stock').forEach((a) => { (groups[a.sector] = groups[a.sector] || []).push(a); });
    const rows = Object.entries(groups).map(([sec, xs]) => ({
      sec, n: xs.length,
      score: Math.round(xs.reduce((s, a) => s + a.score, 0) / xs.length),
      buys: xs.filter((a) => a.signal === 'BUY').length,
      r1m: xs.map((a) => a.metrics.r1m).filter(isNum).reduce((s, x, _, arr) => s + x / arr.length, 0),
      best: xs[0],
    })).sort((x, y) => y.score - x.score);
    if (!rows.length) return '';
    return `<h2 class="section-title">Sector strength</h2>
      <p class="section-sub">Average score of the stocks tracked in each sector. Strong sectors tend to stay strong for a while; weak ones can take time to turn.</p>
      <div class="card"><div class="table-wrap"><table class="fit">
        <thead><tr><th>Sector</th><th>Avg score</th><th class="num">BUYs</th><th class="num hide-sm">1M avg</th><th class="hide-sm">Best in sector</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="click" data-sector="${esc(r.sec)}">
          <td><b>${esc(r.sec)}</b> <span class="faint small">(${r.n})</span></td><td>${scoreBar(r.score)}</td>
          <td class="num">${r.buys}/${r.n}</td><td class="num hide-sm">${pct(r.r1m, 1)}</td>
          <td class="hide-sm"><a href="#" data-open="${esc(r.best.symbol)}" class="mono">${esc(r.best.symbol)}</a> ${badge(r.best.signal)}</td></tr>`).join('')}</tbody>
      </table></div><div class="faint tiny" style="margin-top:6px">Tap a sector to filter the full ranking.</div></div>`;
  }

  function trackCard() {
    if (!state.track.length) return '';
    const beat = state.track.filter((r) => isNum(r.avg) && isNum(r.spy) && r.avg > r.spy).length;
    return `<h2 class="section-title">Track record</h2>
      <p class="section-sub">If you had bought the model's top 5 on these dates, here's how they'd have done since — compared with the S&amp;P 500 and with every asset the model ranks.</p>
      <div class="card"><div class="table-wrap"><table class="fit">
        <thead><tr><th>Picked on</th><th class="hide-sm">Top 5 then</th><th class="num">Top 5 avg</th><th class="num">S&amp;P 500</th><th class="num hide-sm">All assets</th></tr></thead>
        <tbody>${state.track.map((r) => `<tr>
          <td class="nowrap">${fmtDate(r.cut)}<div class="faint tiny">${r.days} days ago · ${esc(r.regime)}</div><div class="show-sm tiny">${r.picks.map((p) => esc(p.sym)).join(', ')}</div></td>
          <td class="wrap-cell hide-sm">${r.picks.map((p) => `<a href="#" data-open="${esc(p.sym)}" class="mono">${esc(p.sym)}</a> <span class="tiny">${pct(p.ret, 0)}</span>`).join(' · ')}</td>
          <td class="num"><b>${pct(r.avg, 1)}</b></td><td class="num">${pct(r.spy, 1)}</td><td class="num hide-sm">${pct(r.all, 1)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="small muted" style="margin:10px 0 0">The top 5 beat the S&amp;P 500 in <b>${beat} of ${state.track.length}</b> of these periods. This is a quick check, not proof: three short windows, using today's list of tracked assets. Past picks working doesn't guarantee future ones will.</p></div>`;
  }

  function methodology() {
    const w = state.regime ? Scoring.WEIGHTS[state.regime.label] : Scoring.WEIGHTS.Neutral;
    const errs = (state.data.errors || []).length;
    return `<div class="card" style="margin-top:12px"><details class="method">
      <summary>How the score works (and its limits)</summary>
      <p>Every stock, ETF and cryptocurrency gets a 0–100 score from real daily prices over the last year. Each factor is ranked against all other assets, then weighted. The weights shift with the market backdrop (currently <b>${esc(state.regime ? state.regime.label : 'Neutral')}</b>):</p>
      <ul>${Object.entries(w).map(([k, v]) => `<li><b>${Scoring.FACTOR_LABELS[k]}</b> — ${Math.round(v * 100)}%</li>`).join('')}</ul>
      <p>Entry-timing adjustments: −8 to −12 if overbought (RSI above 75), −5 if oversold while still falling, +4 for a calm pause inside an uptrend.
      Signals: <b class="up">BUY</b> 70+, <b style="color:var(--hold)">HOLD</b> 45–69, <b class="down">AVOID</b> under 45.</p>
      <p>The backdrop combines the S&amp;P 500 trend, the VIX fear gauge, how many stocks are in uptrends, consumer sentiment, inflation, unemployment and the yield curve (plus retail sales when available). When it is <i>Cautious</i>, steadier assets are favoured.</p>
      <p><b>Second opinion</b> (US stocks covered by the free data plan): +3 if analysts' average target is 15%+ above the price, −4 if the price is already above it; +2 if 75%+ of analysts say Buy, −2 if most say Hold, −5 if they lean Sell; +2 for an A financial-health rating, −3 for C or worse. Capped at ±8. A warning (no score change) appears when earnings are due within 7 days. The track record uses price data only.</p>
      <p>News headlines are shown next to each asset so you can spot events the numbers can't see yet (earnings, lawsuits, rate decisions). They do <b>not</b> change the score.</p>
      <p><b>Limits:</b> the score uses price history and economic data only — no company earnings or valuations. Momentum and trend effects are well documented, but they fail regularly, especially at turning points. The model has not been back-tested here. Treat the ranking as a shortlist for your own research. This is not financial advice.</p>
      <p class="faint">Data generated ${fmtDate(Date.parse(state.data.generated_at) / 1000, true)}${errs ? ` · ${errs} source error(s) in the last refresh (previous data kept)` : ''}.</p>
    </details></div>`;
  }

  function viewNews() {
    const all = state.news;
    if (!all.length) {
      return `<h1 class="section-title">Market news</h1><div class="card empty">No headlines in this data refresh yet. News arrives with the next update.</div>`;
    }
    const list = state.newsTopic === 'all' ? all : state.newsTopic === 'mine'
      ? all.filter((n) => n.mentions.length) : all.filter((n) => n.topics.includes(state.newsTopic));
    const counts = {};
    all.forEach((n) => n.mentions.forEach((s) => { counts[s] = (counts[s] || 0) + 1; }));
    const inNews = Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([s, c]) => [state.bySym[s], c]).filter(([a]) => a);
    const sources = [...new Set(all.map((n) => n.source))];
    return `
      <h1 class="section-title">Market news</h1>
      <p class="section-sub">Headlines that can move markets, from ${esc(sources.join(', '))}. Refreshed with each data update. Tap a ticker to see how the data rates it.</p>
      ${inNews.length ? `<div class="card" style="margin-bottom:12px">
        <div class="card-title">Tracked assets in the news</div>
        <div class="chips scroll-x">${inNews.map(([a, c]) => `<button class="nasset big" data-open="${esc(a.symbol)}">${esc(a.symbol)} <span class="faint">×${c}</span> ${a.signal ? `<span class="badge ${a.signal}">${a.signal} ${a.score}</span>` : ''}</button>`).join('')}</div>
      </div>` : ''}
      <div class="chips scroll-x" style="margin-bottom:12px">
        ${[['all', 'All'], ['mine', 'Mentions tracked assets']].concat(TOPICS.map(([k, l]) => [k, l])).map(([k, l]) => `<button class="fchip ${state.newsTopic === k ? 'active' : ''}" data-ntopic="${k}">${l}</button>`).join('')}
      </div>
      <div class="card">${list.length ? `<ul class="news-list">${list.map((n) => headline(n)).join('')}</ul>` : '<div class="empty">No headlines on this topic right now.</div>'}</div>`;
  }

  const MARKET_GROUPS = [
    ['us', 'US stocks', (a) => a.cls === 'stock' && a.region === 'US'],
    ['uk', 'UK stocks (FTSE)', (a) => a.cls === 'stock' && a.region === 'UK'],
    ['etf', 'ETFs & funds', (a) => a.cls === 'etf'],
    ['crypto', 'Crypto', (a) => a.cls === 'crypto'],
    ['index', 'Stock-market indices', (a) => a.cls === 'index'],
    ['commodity', 'Commodities', (a) => a.cls === 'commodity'],
    ['fx', 'Currencies', (a) => a.cls === 'fx'],
  ];

  function viewMarkets() {
    const q = state.search.trim().toLowerCase();
    const vf = state.mktVerdict;
    const vOf = (a) => state.view && state.view.bySymbol[a.symbol];
    const match = (a) => (!q || a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || (a.sector || '').toLowerCase().includes(q) || describe(a.symbol).toLowerCase().includes(q))
      && (vf === 'all' || (vOf(a) && (vf === 'buy' ? ['top', 'good'].includes(vOf(a).verdict.key) : vOf(a).verdict.key === vf)));
    const limit = isWide() ? 12 : 6;
    const groups = MARKET_GROUPS.filter(([k]) => (state.mktFilter === 'all' || state.mktFilter === k) && (vf === 'all' || !['index', 'commodity', 'fx'].includes(k))).map(([key, label, fn]) => {
      const items = state.assets.filter((a) => a.metrics && fn(a) && match(a));
      if (!items.length) return '';
      const all = q || state.mktFilter === key || state.mktOpen.has(key);
      const shown = all ? items : items.slice(0, limit);
      return `<h2 class="section-title">${label} <span class="faint small">(${items.length})</span></h2>
        <div class="${['index', 'commodity', 'fx'].includes(key) ? 'mgrid' : 'guide'}">${shown.map((a) => (['index', 'commodity', 'fx'].includes(key) ? marketCard(a) : guideRow(a))).join('')}</div>
        ${shown.length < items.length ? `<div class="more-row"><button class="btn sm" data-mopen="${key}">Show all ${items.length}</button></div>` : ''}`;
    }).join('');
    return `
      <h1 class="section-title">All companies &amp; markets</h1>
      <p class="section-sub">What every company does, in plain English, with my verdict on whether it's a good buy right now. Verdicts update automatically whenever prices, news or analyst data change. Tap any company for the full analysis.</p>
      <div class="row wrap" style="margin-bottom:8px">
        <input class="input" id="mkt-search" placeholder="Search a company, symbol, sector or what it does…" value="${esc(state.search)}" style="flex:1;min-width:200px">
      </div>
      <div class="chips scroll-x" style="margin-bottom:8px">
        ${[['all', 'Every verdict'], ['buy', 'Top picks & good buys'], ['dip', 'Buy on a dip'], ['results', 'Wait for results'], ['hold', 'Not yet'], ['avoid', 'Avoid']].map(([k, l]) => `<button class="fchip ${state.mktVerdict === k ? 'active' : ''}" data-mverdict="${k}">${l}</button>`).join('')}
      </div>
      <div class="chips scroll-x">
        ${[['all', 'All']].concat(MARKET_GROUPS.map(([k, l]) => [k, l])).map(([k, l]) => `<button class="fchip ${state.mktFilter === k ? 'active' : ''}" data-mkt="${k}">${l}</button>`).join('')}
      </div>
      ${state.mktFilter === 'all' || state.mktFilter === 'crypto' ? cryptoMarketCard() : ''}
      ${groups || '<div class="card empty" style="margin-top:12px">No matches.</div>'}`;
  }

  function guideRow(a) {
    const m = a.metrics, r = state.view && state.view.bySymbol[a.symbol];
    return `<div class="card grow" data-open="${esc(a.symbol)}">
      <div class="g-top">
        <div style="min-width:0"><div class="row" style="gap:8px"><b class="g-sym">${esc(a.symbol)}</b><span class="g-name">${esc(a.name)}</span></div>
          <div class="tiny faint">${esc(typeLabel(a))} · ${esc(a.sector)}</div></div>
        <div class="g-px"><div class="px">${fmtPrice(a, m.price)}</div><div class="small">${pct(m.change1d)}</div></div>
      </div>
      <p class="g-desc">${esc(describe(a.symbol) || a.name)}</p>
      ${r ? `<div class="g-verdict">${verdictBadge(r)}<span class="small">${esc(verdictText(r, a))}</span></div>` : ''}
    </div>`;
  }

  function marketCard(a) {
    const m = a.metrics;
    return `<div class="card mcard" data-open="${esc(a.symbol)}">
      <div class="top"><div style="min-width:0"><div class="sym">${esc(a.symbol.replace('=X', '').replace('=F', ''))} ${a.live ? '<span class="badge live">LIVE</span>' : ''}</div><div class="nm">${esc(a.name)}</div></div>
        <div><div class="px">${fmtPrice(a, m.price)}</div><div class="chg">${pct(m.change1d)}</div></div></div>
      ${sparkline(a.c.slice(-63))}
      <div class="row between tiny mono muted" style="margin-top:4px"><span>3M ${pct(m.r3m, 1)}</span><span>1Y ${pct(m.r1y, 1)}</span>${a.signal ? badge(a.signal) : `<span class="faint">${esc(typeLabel(a))}</span>`}</div>
    </div>`;
  }

  const MACRO_NOTES = {
    UMCSENT: 'How confident US consumers feel about their finances. Long-run average is about 85; low readings often mean weaker spending ahead.',
    RSAFS: 'How much more shoppers are spending than a year ago (not adjusted for inflation). Compare with inflation to see real growth.',
    CPIAUCSL: 'How fast prices are rising. The Federal Reserve targets 2%; high inflation squeezes consumers and keeps rates high.',
    UNRATE: 'Share of the workforce without a job. A quick rise has preceded most recessions.',
    FEDFUNDS: 'The Federal Reserve’s key interest rate. Higher rates make loans, mortgages and credit cards pricier.',
    DGS10: 'The 10-year government bond yield, which drives mortgage rates and how investors value stocks.',
    T10Y2Y: '10-year minus 2-year yield. Below zero (inverted) has come before most US recessions.',
  };
  const GOOD_WHEN_UP = { UMCSENT: true, RSAFS: true, T10Y2Y: true, CPIAUCSL: false, UNRATE: false };

  function viewEconomy() {
    const macro = state.data.macro || [];
    const cards = macro.map((s) => {
      const n = s.values.length;
      if (!n) return '';
      const v = s.values[n - 1];
      const back = Math.min(n - 1, 3);
      const d = v - s.values[n - 1 - back];
      const good = GOOD_WHEN_UP[s.id];
      const cls = good === undefined || Math.abs(d) < 1e-9 ? 'muted' : (d > 0) === good ? 'up' : 'down';
      const unit = s.unit === 'index' ? '' : s.unit === 'pp' ? 'pp' : '%';
      const dt = new Date(s.dates[n - 1] + 'T00:00:00Z').toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      return `<div class="card macro">
        <div class="card-title">${esc(s.name)}</div>
        <div class="row between" style="align-items:baseline"><span class="val">${v.toFixed(1)}${unit}</span>
          <span class="delta ${cls}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(2)} vs ${back} mo. ago</span></div>
        ${sparkline(s.values.slice(-36), 200, 44, 'var(--accent)')}
        <p>${esc(MACRO_NOTES[s.id] || '')}</p>
        <p class="faint tiny" style="margin-top:6px">${s.unit === '% y/y' ? 'Year-on-year change · ' : ''}Latest: ${dt} · ${esc(s.source || 'FRED')}</p>
      </div>`;
    }).join('');
    const consumerStocks = ['XLY', 'XLP', 'AMZN', 'WMT', 'COST', 'TSCO.L', 'ULVR.L', 'MCD', 'NKE', 'HD'].map((s) => state.bySym[s]).filter((a) => a && a.metrics);
    const econNews = state.news.filter((n) => n.topics.some((t) => ['fed', 'inflation', 'economy', 'consumer'].includes(t))).slice(0, 8);
    return `
      <h1 class="section-title">Consumer &amp; economy</h1>
      <p class="section-sub">What consumers are feeling and spending, and the economic conditions behind the market. These feed into the market backdrop used by the score.</p>
      ${regimeCard()}
      <div class="grid cols-3" style="margin-top:12px">${cards || '<div class="card empty">Economic data not available in this refresh.</div>'}</div>
      ${econNews.length ? `<h2 class="section-title">Economy &amp; consumer news</h2><div class="card"><ul class="news-list">${econNews.map((n) => headline(n)).join('')}</ul></div>` : ''}
      ${consumerStocks.length ? `<h2 class="section-title">Consumer stocks at a glance</h2><div class="mgrid">${consumerStocks.map(marketCard).join('')}</div>` : ''}`;
  }

  // ---------------------------------------------------------------- asset analysis view
  function viewAsset() {
    const a = state.bySym[state.selected] || state.ranked[0] || state.assets[0];
    if (!a) return '';
    state.selected = a.symbol;
    const m = a.metrics;
    const options = MARKET_GROUPS.map(([, label, fn]) => {
      const items = state.assets.filter(fn);
      return items.length ? `<optgroup label="${label}">${items.map((x) => `<option value="${esc(x.symbol)}" ${x.symbol === a.symbol ? 'selected' : ''}>${esc(x.symbol)} — ${esc(x.name)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    const factorRows = a.factors ? Object.keys(Scoring.FACTOR_LABELS).map((k) => {
      const v = a.factors[k];
      return `<div class="fbar"><span>${Scoring.FACTOR_LABELS[k]}</span>
        <div class="track"><div class="fill" style="width:${isNum(v) ? Math.round(v * 100) : 0}%"></div></div>
        <span class="w">${Math.round(a.weights[k] * 100)}%</span></div>`;
    }).join('') : '';
    const v = verdict(a);
    const news = newsFor(a.symbol);
    const peers = a.score != null ? state.ranked.filter((x) => x.sector === a.sector && x.symbol !== a.symbol).slice(0, 4) : [];

    return `
      <div class="row wrap" style="margin-bottom:12px">
        <select class="input" id="asset-select" style="flex:1;min-width:0;max-width:480px" aria-label="Choose asset">${options}</select>
      </div>
      <div class="trade-layout">
        <div class="stack">
          <div class="card o-chart">
            <div class="asset-head">
              <div><div class="row" style="gap:8px"><div class="sym">${esc(a.symbol)}</div>${starBtn(a.symbol)}</div><div class="muted small" style="margin-top:4px">${esc(a.name)} · ${esc(typeLabel(a))} · ${esc(a.sector)}${a.exchange ? ' · ' + esc(a.exchange) : ''}</div></div>
              <div><div class="px">${fmtPrice(a, m.price)}</div><div class="mono small" style="margin-top:4px">${pct(m.change1d)} today</div></div>
              <div class="tf-change" id="tf-change" aria-live="polite"></div>
              <div class="spacer"></div>
              ${a.score != null ? `<div class="row">${badge(a.signal)}<span class="mono small muted">Score <b style="color:${scoreColor(a.score)}">${a.score}</b>${scoreDelta(a)} · Rank #${a.rankPos} of ${state.ranked.length}</span></div>` : ''}
            </div>
            ${describe(a.symbol) ? `<p class="asset-desc">${esc(describe(a.symbol))}</p>` : ''}
            <div class="row wrap between" style="margin:14px 0 8px;gap:8px">
              <div class="legend${INTRADAY_TF.has(state.tf) ? ' hidden' : ''}" title="Average price over the last 50 / 200 trading days. Price above these lines usually means an uptrend."><span><i style="background:var(--sma50)"></i>Average, last 50 days</span><span><i style="background:var(--sma200)"></i>Average, last 200 days</span></div>
              <div class="row chart-controls">
                <div class="seg">${['1D', '1W', '1M', '3M', '6M', '1Y'].map((t) => `<button class="${state.tf === t ? 'active' : ''}" data-tf="${t}" title="${{ '1D': 'Today', '1W': 'Past week', '1M': 'Past month', '3M': 'Past 3 months', '6M': 'Past 6 months', '1Y': 'Past year' }[t]}">${t}</button>`).join('')}</div>
                ${INTRADAY_TF.has(state.tf) ? '' : `<div class="seg">${[['candle', 'Candle'], ['line', 'Line']].map(([k, l]) => `<button class="${state.chartMode === k ? 'active' : ''}" data-mode="${k}">${l}</button>`).join('')}</div>`}
              </div>
            </div>
            <div class="chart-info" id="tt">${tipHint()}</div>
            <div class="chart-box"><canvas id="chart"></canvas></div>
            <div class="faint tiny" style="margin-top:6px">Last price ${a.live ? 'live from CoinGecko' : 'as of ' + fmtDate(a.market_time || m.lastTime, true)}${a.stale ? ' · <span style="color:var(--hold)">not refreshed in latest update</span>' : ''}</div>
          </div>
          <div class="card o-stats">
            <div class="stats">
              ${stat('1 week', pct(m.r1w, 1))}${stat('1 month', pct(m.r1m, 1))}${stat('3 months', pct(m.r3m, 1))}${stat('1 year', pct(m.r1y, 1))}
              ${stat('RSI (14)', isNum(m.rsi14) ? m.rsi14.toFixed(0) : '—')}${stat('Volatility', isNum(m.vol) ? (m.vol * 100).toFixed(0) + '% /yr' : '—')}
              ${stat('52-wk range', fmtPrice(a, m.yearLow) + ' – ' + fmtPrice(a, m.yearHigh))}${stat('From 52-wk high', pct(m.fromHigh, 1))}
            </div>
          </div>
          ${a.factors ? `<div class="card o-breakdown">
            <div class="card-title">Score breakdown</div>
            ${factorRows}
            <div class="faint tiny" style="margin-top:4px">Bars show how this asset ranks against all others on each factor; % is the factor's weight.${a.adjustment ? ` Adjustments (entry timing${a.fund && a.fund.adj ? ', analysts &amp; health' : ''}): ${a.adjustment > 0 ? '+' : ''}${a.adjustment}.` : ''}</div>
            <div class="grid cols-2" style="margin-top:12px">
              <div><div class="card-title">Strengths</div><ul class="reasons pros">${a.reasons.pros.map((r) => `<li>${esc(r)}</li>`).join('') || '<li class="faint">None stand out</li>'}</ul></div>
              <div><div class="card-title">Risks</div><ul class="reasons cons">${a.reasons.cons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li class="faint">None flagged</li>'}</ul></div>
            </div>
          </div>` : ''}
        </div>

        <div class="stack">
          <div class="card o-verdict verdict ${a.signal || ''}">
            <div class="card-title">Verdict</div>
            <div class="row" style="gap:12px">${a.score != null ? scoreRing(a.score) : ''}<div><div class="vtitle">${esc(v.title)}</div>${badge(a.signal)}</div></div>
            <p class="small" style="margin:10px 0 0">${esc(v.text)}</p>
            ${claudeTake(a)}
          </div>
          ${analystCard(a)}
          <div class="card o-news">
            <div class="card-title">Latest ${esc(a.symbol)} news</div>
            ${news.length ? `<ul class="news-list compact">${news.map((n) => headline(n, { hideMentions: true })).join('')}</ul>` : '<div class="empty small">No recent headlines for this asset.</div>'}
          </div>
          ${peers.length ? `<div class="card o-peers"><div class="card-title">Compare: ${esc(a.sector)}</div>
            ${peers.map((p) => `<div class="kv click" data-open="${esc(p.symbol)}" style="cursor:pointer"><span><b class="mono">${esc(p.symbol)}</b> <span class="muted small">${esc(p.name)}</span></span><span>${p.score} ${badge(p.signal)}</span></div>`).join('')}
          </div>` : ''}
        </div>
      </div>`;
  }

  function fmtBig(x) {
    if (!isNum(x)) return '—';
    if (x >= 1e12) return '$' + (x / 1e12).toFixed(2) + 'T';
    if (x >= 1e9) return '$' + (x / 1e9).toFixed(1) + 'B';
    return '$' + fmtNum(x, 0);
  }
  function dots(n) { return `<span class="dots" title="${n} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`; }
  function earnLabel(e) {
    if (!e) return '';
    const when = e.days === 0 ? 'today' : e.days === 1 ? 'tomorrow' : `in ${e.days} days`;
    return `${new Date(e.date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} (${when})`;
  }
  function analystCard(a) {
    const f = a.fund, fd = f && f.data;
    const earn = f && f.earnings;
    if (!fd && !earn) {
      return a.cls === 'stock' ? `<div class="card o-analyst"><div class="card-title">Analysts &amp; financial health</div>
        <p class="small muted" style="margin:0">Not covered by the free data plan for this ${a.region === 'UK' ? 'UK ' : ''}stock. The score uses price data only.</p></div>` : '';
    }
    const g = fd && fd.grades, t = fd && fd.target, h = fd && fd.health;
    const total = g ? g.strongBuy + g.buy + g.hold + g.sell + g.strongSell : 0;
    const seg = (n, cls) => (total && n ? `<div class="${cls}" style="width:${(n / total) * 100}%"></div>` : '');
    const asOf = state.fund && state.fund.generated_at ? fmtDate(Date.parse(state.fund.generated_at) / 1000) : '';
    return `<div class="card o-analyst">
      <div class="card-title">Analysts &amp; financial health</div>
      ${g && total ? `<div class="row between"><span>Analyst consensus</span><b>${esc(g.consensus)}</b></div>
        <div class="gradebar">${seg(g.strongBuy + g.buy, 'b')}${seg(g.hold, 'h')}${seg(g.sell + g.strongSell, 's')}</div>
        <div class="row between tiny muted"><span class="up">${g.strongBuy + g.buy} buy</span><span style="color:var(--hold)">${g.hold} hold</span><span class="down">${g.sell + g.strongSell} sell</span></div>` : ''}
      ${t ? `<div class="kv" style="margin-top:8px"><span class="muted">Average price target</span><span>$${t.consensus.toFixed(2)} ${isNum(f.upside) ? `(${pct(f.upside, 0)})` : ''}</span></div>
        <div class="kv"><span class="muted">Target range</span><span>$${fmtNum(t.low, 0)} – $${fmtNum(t.high, 0)}</span></div>` : ''}
      ${h ? `<div class="kv" style="margin-top:6px"><span class="muted">Financial health rating</span><span class="grade g${esc(h.rating[0])}">${esc(h.rating)}</span></div>
        <div class="health">
          <span>Profitability (ROE)</span>${dots(h.roe)}<span>Asset returns (ROA)</span>${dots(h.roa)}
          <span>Debt level</span>${dots(h.debt)}<span>Value vs earnings (P/E)</span>${dots(h.pe)}
          <span>Value vs cash flow</span>${dots(h.dcf)}<span>Value vs book</span>${dots(h.pb)}
        </div><div class="faint tiny">More dots = better. A low "value" score means the stock is priced expensively.</div>` : ''}
      ${earn ? `<div class="kv" style="margin-top:8px"><span class="muted">Next earnings</span><span>${earnLabel(earn)}${isNum(earn.epsEstimated) ? ` · EPS est. $${earn.epsEstimated.toFixed(2)}` : ''}</span></div>` : ''}
      ${f && f.adj ? `<div class="small" style="margin-top:8px">Second-opinion effect on score: <b class="${f.adj > 0 ? 'up' : 'down'}">${f.adj > 0 ? '+' : ''}${f.adj}</b></div>` : ''}
      <div class="faint tiny" style="margin-top:6px">Source: Financial Modeling Prep${asOf ? ', as of ' + asOf : ''}.</div>
    </div>`;
  }
  function earningsCard() {
    if (!state.fund || !state.fund.earnings) return '';
    const today = new Date().toISOString().slice(0, 10);
    const soon = state.fund.earnings.filter((e) => e.date >= today && state.bySym[e.symbol])
      .sort((x, y) => (x.date < y.date ? -1 : 1)).slice(0, 10);
    if (!soon.length) return '';
    return `<div class="card"><div class="card-title">Upcoming earnings (tracked stocks)</div>
      ${soon.map((e) => { const a = state.bySym[e.symbol]; const days = Math.round((Date.parse(e.date) - Date.parse(today)) / 86400000);
        return `<div class="kv click" data-open="${esc(e.symbol)}" style="cursor:pointer"><span><b class="mono">${esc(e.symbol)}</b> <span class="muted small">${esc(a.name)}</span></span>
          <span class="row" style="gap:8px"><span class="small">${earnLabel({ date: e.date, days })}</span>${a.signal ? badge(a.signal) : ''}</span></div>`; }).join('')}
      <div class="faint tiny" style="margin-top:6px">Prices often jump or drop sharply on results day.</div></div>`;
  }
  function cryptoMarketCard() {
    const c = state.cg;
    if (!c || !isNum(c.cap)) return '';
    return `<div class="card" style="margin-top:12px">
      <div class="card-title">Crypto market — live from CoinGecko</div>
      <div class="stats">
        ${stat('Total value', fmtBig(c.cap))}${stat('24h change', pct(isNum(c.capChange) ? c.capChange / 100 : null, 1))}
        ${stat('Bitcoin share', isNum(c.btcDom) ? c.btcDom.toFixed(1) + '%' : '—')}${stat('Ethereum share', isNum(c.ethDom) ? c.ethDom.toFixed(1) + '%' : '—')}
      </div>
      ${c.trending.length ? `<div class="small muted" style="margin:10px 0 6px">Trending searches right now</div><div class="chips">${c.trending.map((t) => `<span class="ntag" style="padding:2px 8px">${esc(t.name)} <span class="mono">${esc(t.symbol)}</span>${isNum(t.change) ? ' ' + pct(t.change / 100, 1) : ''}</span>`).join('')}</div>
        <div class="faint tiny" style="margin-top:6px">Trending means lots of people are searching for it, not that it's a good buy.</div>` : ''}
    </div>`;
  }

  function claudeTake(a) {
    const r = state.view && state.view.bySymbol[a.symbol];
    if (!r) return '';
    const inPicks = state.view.picks.includes(r) || state.view.uk === r;
    const label = inPicks ? 'One of my picks right now' : r.timing === 'dip' ? `Good company — I'd wait for a dip${r.dipLevel ? ' below ' + fmtPrice(a, r.dipLevel) : ''}` : r.timing === 'results' ? 'I\'d wait for its results first' : 'Not in my top picks right now';
    return `<div class="cv-take"><div class="tiny" style="font-weight:800;color:var(--accent)">✦ CLAUDE'S TAKE</div>
      <div class="small"><b>${esc(label)}.</b> ${r.why.length ? esc((r.why.slice(0, 2).join('; ')).replace(/^./, (c) => c.toUpperCase())) + '.' : ''}${r.risks.length ? ' Watch: ' + esc(r.risks.slice(0, 2).join('; ')) + '.' : ''}</div></div>`;
  }

  function stat(k, v) { return `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`; }

  // ---------------------------------------------------------------- chart
  const TF_DAYS = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366 };
  const INTRADAY_TF = new Set(['1D', '1W']);
  let chartGeom = null;
  let intradayLoading = null;

  function loadIntraday(force) {
    if (intradayLoading) return intradayLoading;
    if (!force && state.intraday && Date.now() - state.intradayAt < 10 * 60 * 1000) return Promise.resolve(state.intraday);
    intradayLoading = loadJson('data/intraday.json').then((d) => {
      if (d && d.series) { state.intraday = d; state.intradayAt = Date.now(); }
      intradayLoading = null;
      if (state.tab === 'asset' && INTRADAY_TF.has(state.tf)) drawChart();
      return state.intraday;
    });
    return intradayLoading;
  }

  function tzLabel(a, tz) {
    if (a.region === 'UK') return 'UK time';
    if (a.region === 'US' && a.cls !== 'crypto') return 'New York time';
    return tz ? 'local exchange time' : 'UTC';
  }

  // Build the 1D / 1W series from 15-minute prices.
  function intradaySeries(a) {
    const s = state.intraday && state.intraday.series && state.intraday.series[a.symbol];
    if (!s || !s.t || s.t.length < 2) return null;
    const tz = s.tz || 0;
    let t = s.t.slice(), c = s.c.slice();
    // Live crypto: extend with the latest live price.
    if (a.live && a.metrics && Date.now() / 1000 - t[t.length - 1] > 600) { t.push(Math.floor(Date.now() / 1000)); c.push(a.metrics.price); }
    const dayOf = (x) => Math.floor((x + tz) / 86400);
    const lastT = t[t.length - 1];
    let start = 0, base = c[0], baseLabel = 'start of the week';
    if (state.tf === '1D') {
      if (a.cls === 'crypto' || a.cls === 'fx') {
        start = Math.max(0, t.findIndex((x) => x >= lastT - 86400));
        base = c[start]; baseLabel = '24 hours ago';
      } else {
        start = t.findIndex((x) => dayOf(x) === dayOf(lastT));
        if (start < 0) start = 0;
        if (start > 0) { base = c[start - 1]; baseLabel = 'previous close'; } else { base = c[0]; baseLabel = 'the open'; }
      }
    }
    return { t: t.slice(start), c: c.slice(start), base, baseLabel, tz, sessionDay: dayOf(lastT) };
  }

  function drawIntraday(canvas, ctx, W, H, a, hoverIdx) {
    const mono = getComputedStyle(document.body).fontFamily;
    const s = intradaySeries(a);
    const tfEl = $('#tf-change');
    if (!s) {
      ctx.fillStyle = '#94a3ba'; ctx.font = '13px ' + mono; ctx.textAlign = 'center';
      ctx.fillText(state.intraday || !intradayLoading ? 'Intraday prices are not available for this asset yet.' : 'Loading today\'s prices…', W / 2, H / 2);
      ctx.textAlign = 'start';
      if (!state.intraday) loadIntraday();
      // Still show the move from the daily data.
      if (tfEl && a.metrics) {
        const ch = state.tf === '1D' ? a.metrics.change1d : a.metrics.r1w;
        if (isNum(ch)) { tfEl.className = 'tf-change ' + (ch >= 0 ? 'pos' : 'neg'); tfEl.innerHTML = `<span class="tf-l">${state.tf === '1D' ? 'Today' : 'Past week'}</span><b>${ch >= 0 ? '▲ +' : '▼ −'}${fmtNum(Math.abs(ch * 100), 2)}%</b>`; }
      }
      chartGeom = null;
      return;
    }
    const n = s.c.length, lastPx = s.c[n - 1];
    const padR = 64, padB = 22, padT = 8;
    const w = W - padR, h = H - padB - padT;
    let lo = Math.min(...s.c, s.base), hi = Math.max(...s.c, s.base);
    const padP = (hi - lo) * 0.08 || hi * 0.005 || 1; lo -= padP; hi += padP;
    const step = w / Math.max(1, n - 1);
    const X = (k) => k * step;
    const Y = (p) => padT + h - ((p - lo) / (hi - lo)) * h;
    chartGeom = { intraday: true, s, step, a, n };

    // Change box
    if (tfEl) {
      const ch = lastPx / s.base - 1, diff = lastPx - s.base;
      const todayDay = Math.floor((Date.now() / 1000 + s.tz) / 86400);
      const dayName = new Date(s.t[n - 1] * 1000 + s.tz * 1000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
      const label = state.tf === '1W' ? 'Past week' : (a.cls === 'crypto' || a.cls === 'fx') ? 'Last 24 hours' : s.sessionDay === todayDay ? 'Today' : `Last trading day · ${dayName}`;
      tfEl.className = 'tf-change ' + (ch >= 0 ? 'pos' : 'neg');
      tfEl.innerHTML = `<span class="tf-l">${label}</span><b>${ch >= 0 ? '▲' : '▼'} ${ch >= 0 ? '+' : '−'}${fmtNum(Math.abs(ch * 100), 2)}%</b>
        <span class="tf-d">${diff >= 0 ? '+' : '−'}${fmtDiff(a, Math.abs(diff))} since ${esc(s.baseLabel)}</span>`;
    }

    // Grid + price axis
    ctx.font = '10px ' + mono; ctx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const p = lo + ((hi - lo) * g) / 4, y = Y(p);
      ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = '#64748b';
      if (Math.abs(y - Y(lastPx)) > 14) ctx.fillText(fmtPrice(a, p), w + 6, y);
    }
    // Time axis
    ctx.textBaseline = 'alphabetic';
    const labels = Math.max(3, Math.min(6, Math.floor(w / 90)));
    for (let g = 0; g < labels; g++) {
      const k = Math.round((g / Math.max(1, labels - 1)) * (n - 1));
      const d = new Date((s.t[k] + s.tz) * 1000);
      const txt = state.tf === '1D'
        ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
        : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
      ctx.fillStyle = '#64748b';
      const tw = ctx.measureText(txt).width;
      ctx.fillText(txt, Math.min(Math.max(0, X(k) - tw / 2), w - tw), H - 6);
    }
    // Baseline (previous close / start of week)
    const by = Y(s.base);
    ctx.strokeStyle = 'rgba(148,163,184,.55)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(w, by); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#94a3ba'; ctx.textBaseline = 'bottom'; ctx.fillText(s.baseLabel === 'previous close' ? 'Previous close' : 'Start', 4, by - 3);
    // Price line
    const up = lastPx >= s.base, col = up ? '#16c784' : '#f0465a';
    ctx.beginPath();
    s.c.forEach((p, k) => (k ? ctx.lineTo(X(k), Y(p)) : ctx.moveTo(X(k), Y(p))));
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    ctx.lineTo(X(n - 1), padT + h); ctx.lineTo(X(0), padT + h); ctx.closePath();
    const gr = ctx.createLinearGradient(0, padT, 0, padT + h);
    gr.addColorStop(0, up ? 'rgba(22,199,132,.22)' : 'rgba(240,70,90,.22)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.fill();
    // Last price tag
    const ly = Y(lastPx);
    ctx.fillStyle = col; ctx.fillRect(w + 1, ly - 8, padR - 1, 16);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.font = 'bold 10px ' + mono; ctx.fillText(fmtPrice(a, lastPx), w + 5, ly);
    if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < n) {
      ctx.strokeStyle = 'rgba(148,163,184,.5)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(hoverIdx), padT); ctx.lineTo(X(hoverIdx), padT + h); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(hoverIdx), Y(s.c[hoverIdx]), 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawChart(hoverIdx) {
    const canvas = $('#chart');
    const a = state.bySym[state.selected];
    if (!canvas || !a) return;
    if (INTRADAY_TF.has(state.tf)) {
      const dpr0 = window.devicePixelRatio || 1, W0 = canvas.clientWidth, H0 = canvas.clientHeight;
      if (!W0 || !H0) return;
      if (canvas.width !== Math.round(W0 * dpr0) || canvas.height !== Math.round(H0 * dpr0)) { canvas.width = Math.round(W0 * dpr0); canvas.height = Math.round(H0 * dpr0); }
      const ctx0 = canvas.getContext('2d'); ctx0.setTransform(dpr0, 0, 0, dpr0, 0, 0); ctx0.clearRect(0, 0, W0, H0);
      drawIntraday(canvas, ctx0, W0, H0, a, hoverIdx);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const n = a.c.length;
    const cutoff = a.t[n - 1] - TF_DAYS[state.tf] * 86400;
    let start = a.t.findIndex((t) => t >= cutoff);
    if (start < 0) start = 0;
    const sma50 = Scoring.smaSeries(a.c, 50), sma200 = Scoring.smaSeries(a.c, 200);
    const idx = []; for (let i = start; i < n; i++) idx.push(i);
    if (idx.length < 2) return;

    const padR = 64, padB = 22, padT = 8;
    const w = W - padR, h = H - padB - padT;
    const volH = h * 0.16;
    let lo = Infinity, hi = -Infinity;
    idx.forEach((i) => {
      const L = state.chartMode === 'candle' ? a.l[i] : a.c[i];
      const Hh = state.chartMode === 'candle' ? a.h[i] : a.c[i];
      lo = Math.min(lo, L, sma50[i] ?? Infinity, sma200[i] ?? Infinity);
      hi = Math.max(hi, Hh, sma50[i] ?? -Infinity, sma200[i] ?? -Infinity);
    });
    const padP = (hi - lo) * 0.06 || hi * 0.01 || 1;
    lo -= padP; hi += padP;
    const step = w / idx.length;
    const X = (k) => k * step + step / 2;
    const Y = (p) => padT + (h - volH) - ((p - lo) / (hi - lo)) * (h - volH);
    chartGeom = { idx, step, a };
    const first = a.c[idx[0]], lastPx = a.c[n - 1];
    const tfEl = $('#tf-change');
    if (tfEl && first) {
      const ch = lastPx / first - 1, diff = lastPx - first;
      const LABEL = { '1M': 'Past month', '3M': 'Past 3 months', '6M': 'Past 6 months', '1Y': 'Past year' };
      tfEl.className = 'tf-change ' + (ch >= 0 ? 'pos' : 'neg');
      tfEl.innerHTML = `<span class="tf-l">${LABEL[state.tf]}</span><b>${ch >= 0 ? '▲' : '▼'} ${ch >= 0 ? '+' : '−'}${fmtNum(Math.abs(ch * 100), 1)}%</b>
        <span class="tf-d">${diff >= 0 ? '+' : '−'}${fmtDiff(a, Math.abs(diff))} since ${fmtDate(a.t[idx[0]])}</span>`;
    }
    const mono = getComputedStyle(document.body).fontFamily;

    ctx.font = '10px ' + mono;
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const p = lo + ((hi - lo) * g) / 4;
      const y = Y(p);
      ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = '#64748b';
      // Skip axis labels that would sit under the current-price tag.
      if (Math.abs(y - Y(a.c[n - 1])) > 14) ctx.fillText(fmtPrice(a, p), w + 6, y);
    }
    ctx.textBaseline = 'alphabetic';
    const labels = Math.max(3, Math.min(6, Math.floor(w / 90)));
    const longRange = state.tf === '6M' || state.tf === '1Y';
    for (let g = 0; g < labels; g++) {
      const k = Math.round((g / Math.max(1, labels - 1)) * (idx.length - 1));
      const txt = new Date(a.t[idx[k]] * 1000).toLocaleDateString('en-GB', longRange ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' });
      ctx.fillStyle = '#64748b';
      const tw = ctx.measureText(txt).width;
      ctx.fillText(txt, Math.min(Math.max(0, X(k) - tw / 2), w - tw), H - 6);
    }

    const maxV = Math.max(1, ...idx.map((i) => a.v[i] || 0));
    idx.forEach((i, k) => {
      const vh = ((a.v[i] || 0) / maxV) * volH;
      ctx.fillStyle = a.c[i] >= a.o[i] ? 'rgba(16,185,129,.22)' : 'rgba(244,63,94,.22)';
      ctx.fillRect(X(k) - step * 0.35, padT + h - vh, Math.max(1, step * 0.7), vh);
    });

    if (state.chartMode === 'line') {
      const up = a.c[n - 1] >= a.c[idx[0]];
      const col = up ? '#10b981' : '#f43f5e';
      ctx.beginPath();
      idx.forEach((i, k) => (k ? ctx.lineTo(X(k), Y(a.c[i])) : ctx.moveTo(X(k), Y(a.c[i]))));
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      ctx.lineTo(X(idx.length - 1), padT + h - volH); ctx.lineTo(X(0), padT + h - volH); ctx.closePath();
      const gr = ctx.createLinearGradient(0, padT, 0, padT + h - volH);
      gr.addColorStop(0, up ? 'rgba(16,185,129,.22)' : 'rgba(244,63,94,.22)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr; ctx.fill();
    } else {
      const bw = Math.max(1, step * 0.62);
      idx.forEach((i, k) => {
        const col = a.c[i] >= a.o[i] ? '#10b981' : '#f43f5e';
        ctx.strokeStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(k), Y(a.h[i])); ctx.lineTo(X(k), Y(a.l[i])); ctx.stroke();
        const y1 = Y(Math.max(a.o[i], a.c[i])), y2 = Y(Math.min(a.o[i], a.c[i]));
        ctx.fillStyle = col; ctx.fillRect(X(k) - bw / 2, y1, bw, Math.max(1, y2 - y1));
      });
    }

    [[sma50, '#f59e0b'], [sma200, '#a78bfa']].forEach(([s, col]) => {
      ctx.beginPath(); let started = false;
      idx.forEach((i, k) => {
        if (s[i] == null) return;
        if (!started) { ctx.moveTo(X(k), Y(s[i])); started = true; } else ctx.lineTo(X(k), Y(s[i]));
      });
      ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke();
    });

    const lp = a.c[n - 1], ly = Y(lp);
    ctx.fillStyle = lp >= (a.c[n - 2] ?? lp) ? '#10b981' : '#f43f5e';
    ctx.fillRect(w + 1, ly - 8, padR - 1, 16);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.font = 'bold 10px ' + mono;
    ctx.fillText(fmtPrice(a, lp), w + 5, ly);

    if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < idx.length) {
      ctx.strokeStyle = 'rgba(148,163,184,.5)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(hoverIdx), padT); ctx.lineTo(X(hoverIdx), padT + h); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function tipHint() {
    return INTRADAY_TF.has(state.tf) ? 'Tap or drag on the chart to see the price at any time (15-minute steps).' : 'Tap or drag on the chart to see the price on any day.';
  }

  function resetTip() {
    const tt = $('#tt');
    if (tt) { tt.classList.remove('active'); tt.innerHTML = tipHint(); }
    drawChart();
  }

  function chartHover(e) {
    const canvas = $('#chart');
    if (!canvas || !chartGeom) return;
    const rect = canvas.getBoundingClientRect();
    const tt = $('#tt');
    if (chartGeom.intraday) {
      const g = chartGeom, k = Math.round((e.clientX - rect.left) / g.step);
      if (k < 0 || k >= g.n) { resetTip(); return; }
      const a = g.a, s = g.s, since = s.c[k] / s.base - 1;
      const d = new Date((s.t[k] + s.tz) * 1000);
      const when = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      tt.innerHTML = `<div class="ci-row"><span class="ci-date">${when} <span class="faint">(${tzLabel(a, s.tz)})</span></span><b class="ci-price">${fmtPrice(a, s.c[k])}</b></div>
        <div class="ci-row small"><span class="${since >= 0 ? 'up' : 'down'}">${since >= 0 ? '▲' : '▼'} ${pct(since, 2)} since ${esc(s.baseLabel)}</span></div>`;
      tt.classList.add('active');
      drawChart(k);
      return;
    }
    const k = Math.floor((e.clientX - rect.left) / chartGeom.step);
    if (k < 0 || k >= chartGeom.idx.length) { resetTip(); return; }
    const a = chartGeom.a, i = chartGeom.idx[k], i0 = chartGeom.idx[0];
    const day = a.c[i] / a.c[i - 1] - 1;
    const since = a.c[i] / a.c[i0] - 1;
    const arrow = (x) => (x >= 0 ? '▲' : '▼');
    const when = new Date(a.t[i] * 1000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    tt.innerHTML = `<div class="ci-row"><span class="ci-date">${when}</span><b class="ci-price">${fmtPrice(a, a.c[i])}</b></div>
      <div class="ci-row small">
        ${i > 0 ? `<span class="${day >= 0 ? 'up' : 'down'}">${arrow(day)} ${pct(day)} that day</span>` : ''}
        <span class="${since >= 0 ? 'up' : 'down'}">${arrow(since)} ${pct(since, 1)} since ${fmtDate(a.t[i0])}</span>
      </div>
      <div class="ci-row tiny faint">Day's range ${fmtPrice(a, a.l[i])} – ${fmtPrice(a, a.h[i])}</div>`;
    tt.classList.add('active');
    drawChart(k);
  }

  // ---------------------------------------------------------------- events
  function openAsset(sym) {
    if (!state.bySym[sym]) return;
    state.selected = sym;
    state.tab = 'asset';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a, [data-open], [data-sector], tr.click');
    if (!t) return;
    const d = t.dataset;
    if (t.tagName === 'A' && t.target === '_blank') return; // external news link
    if (d.star) { e.preventDefault(); e.stopPropagation(); toggleWatch(d.star); render(); return; }
    if (d.sector) { state.lbSector = d.sector; state.lbFilter = 'all'; state.lbLimit = 1000; render(); const el = $('#lb-sector'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (d.tab) { e.preventDefault(); state.tab = d.tab; render(); window.scrollTo({ top: 0 }); return; }
    if (d.open) { e.preventDefault(); openAsset(d.open); return; }
    if (d.lb) { state.lbFilter = d.lb; state.lbLimit = 25; render(); return; }
    if (d.mkt) { state.mktFilter = d.mkt; render(); return; }
    if (d.mopen) { state.mktOpen.add(d.mopen); render(); return; }
    if (d.mverdict) { state.mktVerdict = d.mverdict; render(); return; }
    if (d.ntopic) { state.newsTopic = d.ntopic; render(); return; }
    if (d.tf) { state.tf = d.tf; if (INTRADAY_TF.has(d.tf)) loadIntraday(); render(); return; }
    if (d.mode) { state.chartMode = d.mode; render(); return; }
    if (t.id === 'lb-more') { state.lbLimit = 1000; render(); }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'lb-sector') { state.lbSector = e.target.value; state.lbLimit = 25; render(); }
    if (e.target.id === 'asset-select') { state.selected = e.target.value; render(); }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'mkt-search') {
      state.search = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const inp = $('#mkt-search');
      if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
    }
  });

  document.addEventListener('mousemove', (e) => { if (e.target.id === 'chart') chartHover(e); });
  let touchTimer = null;
  const onTouch = (e) => {
    if (e.target.id !== 'chart' || !e.touches || !e.touches[0]) return;
    clearTimeout(touchTimer);
    chartHover({ clientX: e.touches[0].clientX });
  };
  document.addEventListener('touchstart', onTouch, { passive: true });
  document.addEventListener('touchmove', onTouch, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (e.target.id !== 'chart') return;
    touchTimer = setTimeout(resetTip, 4000);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.id === 'chart') resetTip();
  });

  let resizeTimer = null;
  let wasWide = isWide();
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (isWide() !== wasWide) { wasWide = isWide(); render(); } else drawChart(); }, 120);
  });

  // Clean up the old paper-trading account from earlier versions.
  try { localStorage.removeItem('mushtaqtrader.portfolio.v2'); } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------- small pop-up messages
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  // ---------------------------------------------------------------- auto-update (no refresh needed)
  // Every minute, and whenever the app comes back on screen, check two tiny files:
  // data/version.json (new prices?) and data/claude_view.json (new written note?).
  // Also notice when a new version of the app itself has been published.
  let appSig = null, appUpdateReady = false, checking = false;
  async function appSignature() {
    try {
      const rs = await Promise.all(['js/app.js', 'js/scoring.js', 'js/companies.js', 'css/styles.css', 'index.html']
        .map((u) => fetch(u + '?check=' + Date.now(), { method: 'HEAD', cache: 'no-store' })));
      if (rs.some((r) => !r.ok)) return null;
      return rs.map((r) => r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length') || '').join('|');
    } catch (e) { return null; }
  }
  async function applyAppUpdate() {
    // Refresh the browser's cached copies first, then reload into the new version.
    try { await Promise.all(['js/app.js', 'js/scoring.js', 'js/companies.js', 'css/styles.css', 'index.html'].map((u) => fetch(u, { cache: 'reload' }))); } catch (e) { /* ignore */ }
    location.reload();
  }
  function offerAppUpdate() {
    if (appUpdateReady) return;
    appUpdateReady = true;
    if (document.hidden) { applyAppUpdate(); return; }
    const bar = document.createElement('div');
    bar.className = 'update-bar';
    bar.innerHTML = '<span>A new version of MushtaqTrader is ready.</span><button class="btn sm buy" id="do-update">Update now</button>';
    document.body.appendChild(bar);
    bar.querySelector('#do-update').addEventListener('click', applyAppUpdate);
  }
  async function checkForUpdates() {
    if (checking || !state.data) return;
    checking = true;
    try {
      const [v, note] = await Promise.all([loadJson('data/version.json'), loadJson('data/claude_view.json')]);
      if (v && v.generated_at && v.generated_at !== state.data.generated_at) await loadData(false);
      else if (note && note.updated && (!state.note || note.updated !== state.note.updated)) {
        state.note = note; softRender(); toast("Claude's market note has been updated");
      }
      const sig = await appSignature();
      if (sig) { if (appSig === null) appSig = sig; else if (sig !== appSig) offerAppUpdate(); }
    } finally { checking = false; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (appUpdateReady) { applyAppUpdate(); return; }
    renderStatus(); checkForUpdates(); pollCrypto();
  });
  window.addEventListener('focus', () => { checkForUpdates(); });

  // ---------------------------------------------------------------- boot
  readRoute();
  loadData(true).then(() => appSignature().then((s) => { if (s) appSig = s; }));
  setInterval(pollCrypto, LIVE_CRYPTO_MS);
  pollCryptoMarket();
  setInterval(pollCryptoMarket, 5 * LIVE_CRYPTO_MS);
  setInterval(checkForUpdates, UPDATE_CHECK_MS);
  setInterval(() => loadData(false), DATA_RELOAD_MS);
  setInterval(renderStatus, 60 * 1000);
})();
