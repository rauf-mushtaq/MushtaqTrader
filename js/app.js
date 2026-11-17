/* MushtaqTrader – real market data, best-buy ranking and market news to help decide what to buy. */
(function () {
  'use strict';

  const DATA_URL = 'data/market.json';
  const LIVE_CRYPTO_MS = 60 * 1000;
  const DATA_RELOAD_MS = 10 * 60 * 1000;

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
    search: '',
    tf: '6M',
    chartMode: 'candle',
    live: { status: 'off', at: null },
  };

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
    const own = ((state.data.news || {}).symbols || {})[sym] || [];
    const mentioned = state.news.filter((n) => n.mentions.includes(sym));
    const seen = new Set();
    return own.concat(mentioned)
      .filter((n) => safeUrl(n.link) && !seen.has(n.title) && seen.add(n.title))
      .sort((x, y) => (y.time || 0) - (x.time || 0))
      .slice(0, 8);
  }

  // ---------------------------------------------------------------- data
  async function loadData(initial) {
    try {
      const res = await fetch(DATA_URL + '?v=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data || !Array.isArray(data.assets) || !data.assets.length) throw new Error('empty data file');
      if (!initial && state.data && data.generated_at === state.data.generated_at) return;
      state.data = data;
      state.assets = data.assets;
      state.bySym = Object.fromEntries(data.assets.map((a) => [a.symbol, a]));
      state.loadError = null;
      if (!state.selected || !state.bySym[state.selected]) state.selected = null;
      buildMatchers();
      state.news = ((data.news || {}).market || []).filter((n) => safeUrl(n.link)).map(tagHeadline);
      rescore();
      if (initial) { render(); pollCrypto(); } else softRender();
    } catch (e) {
      if (initial) {
        state.loadError = e.message || String(e);
        render();
      }
    }
  }

  function rescore() {
    const res = Scoring.scoreAll(state.assets, state.data.macro || []);
    state.regime = res.regime;
    state.ranked = res.ranked;
    if (!state.selected && res.ranked.length) state.selected = res.ranked[0].symbol;
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
        <span class="dot"></span>REAL DATA · updated ${ago(gen)}</span>`);
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

  // ---------------------------------------------------------------- views
  function render() {
    renderStatus();
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
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

  function regimeCard(compact) {
    const r = state.regime;
    if (!r) return '';
    const items = r.factors.map((f) => `<li><span class="sig ${f.signal > 0 ? 'p' : f.signal < 0 ? 'n' : 'z'}">${f.signal > 0 ? '+' : f.signal < 0 ? '−' : '·'}</span><span>${esc(f.text)}</span></li>`).join('');
    return `<div class="card">
      <div class="card-title">Market backdrop — built from index trends, fear gauge, breadth and consumer data</div>
      <div class="regime">
        <div><div class="regime-label ${r.label}">${r.label.toUpperCase()}</div>
          <div class="small muted">Signal total ${r.total > 0 ? '+' : ''}${r.total}</div></div>
        <div><p style="margin:0 0 10px">${esc(r.summary)}</p>
          ${compact ? '' : `<ul class="factor-list">${items}</ul>`}</div>
      </div>
      ${compact ? `<ul class="factor-list" style="margin-top:12px">${items}</ul>` : ''}
    </div>`;
  }

  function filterRanked(filter, sector) {
    return state.ranked.filter((a) => {
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
      <h1 class="section-title">Today's best buy, according to the data</h1>
      <p class="section-sub">${state.ranked.length} real stocks, funds and cryptocurrencies scored on momentum, trend, risk and the economic backdrop.</p>
      ${regimeCard(false)}
      <div style="height:12px"></div>
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
                <span class="mono">${pct(m.change1d)} today</span>
                ${badge(top.signal)}${top.live ? '<span class="badge live">LIVE</span>' : ''}
              </div>
            </div>
          </div>
          <div style="margin-top:10px">${sparkline(top.c.slice(-90), 400, 60)}</div>
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

      <h2 class="section-title">Best in each market</h2>
      <div class="grid cols-4">
        ${winners.map(([label, a]) => `
          <div class="card winner" data-open="${esc(a.symbol)}">
            <div class="card-title">${label}</div>
            <div class="row between"><div style="min-width:0"><div class="sym">${esc(a.symbol)}</div>
              <div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.name)}</div></div>
              ${scoreBar(a.score)}</div>
            <div class="row between mono small" style="margin-top:8px"><span>${fmtPrice(a, a.metrics.price)}</span><span>3M ${pct(a.metrics.r3m, 1)}</span>${badge(a.signal)}</div>
          </div>`).join('')}
      </div>

      ${bigNews.length ? `<h2 class="section-title">Big-picture news to know</h2>
      <div class="card"><ul class="news-list">${bigNews.map((n) => headline(n)).join('')}</ul>
        <div style="margin-top:8px"><a href="#" data-tab="news">All market news →</a></div></div>` : ''}

      <h2 class="section-title">Full ranking</h2>
      <div class="card">
        <div class="row wrap between" style="margin-bottom:10px">
          <div class="chips">
            ${[['all', 'All'], ['us', 'US stocks'], ['uk', 'UK stocks'], ['etf', 'ETFs'], ['crypto', 'Crypto']].map(([k, l]) => `<button class="fchip ${state.lbFilter === k ? 'active' : ''}" data-lb="${k}">${l}</button>`).join('')}
          </div>
          <select class="input" id="lb-sector" aria-label="Sector">
            <option value="all">All sectors</option>
            ${sectors.map((s) => `<option ${state.lbSector === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
        <div class="small muted" style="margin-bottom:6px">${list.length} assets · <span class="up">${counts.BUY} BUY</span> · <span style="color:var(--hold)">${counts.HOLD} HOLD</span> · <span class="down">${counts.AVOID} AVOID</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Asset</th><th class="hide-sm">Type</th><th class="num">Price</th><th class="num">1D</th>
            <th class="num hide-sm">1M</th><th class="num">3M</th><th class="num hide-sm">1Y</th><th class="num hide-sm">RSI</th><th>Score</th><th>Signal</th></tr></thead>
          <tbody>${shown.map((a) => {
            const mm = a.metrics;
            return `<tr class="click" data-open="${esc(a.symbol)}">
              <td class="mono faint">${a.rankPos}</td>
              <td class="asset-cell"><b>${esc(a.symbol)}</b>${a.live ? ' <span class="badge live">LIVE</span>' : ''}<div>${esc(a.name)}</div></td>
              <td class="hide-sm"><span class="badge type">${esc(typeLabel(a))}</span></td>
              <td class="num">${fmtPrice(a, mm.price)}</td>
              <td class="num">${pct(mm.change1d)}</td>
              <td class="num hide-sm">${pct(mm.r1m, 1)}</td>
              <td class="num">${pct(mm.r3m, 1)}</td>
              <td class="num hide-sm">${pct(mm.r1y, 1)}</td>
              <td class="num hide-sm">${isNum(mm.rsi14) ? mm.rsi14.toFixed(0) : '—'}</td>
              <td>${scoreBar(a.score)}</td><td>${badge(a.signal)}</td></tr>`;
          }).join('')}</tbody></table></div>
        ${list.length > shown.length ? `<div style="text-align:center;margin-top:10px"><button class="btn sm" id="lb-more">Show all ${list.length}</button></div>` : ''}
      </div>
      ${methodology()}`;
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
      <p>The backdrop combines the S&amp;P 500 trend, the VIX fear gauge, how many stocks are in uptrends, consumer sentiment, retail sales, inflation, unemployment and the yield curve. When it is <i>Cautious</i>, steadier assets are favoured.</p>
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
        <div class="chips">${inNews.map(([a, c]) => `<button class="nasset big" data-open="${esc(a.symbol)}">${esc(a.symbol)} <span class="faint">×${c}</span> ${a.signal ? `<span class="badge ${a.signal}">${a.signal} ${a.score}</span>` : ''}</button>`).join('')}</div>
      </div>` : ''}
      <div class="chips" style="margin-bottom:12px">
        ${[['all', 'All'], ['mine', 'Mentions tracked assets']].concat(TOPICS.map(([k, l]) => [k, l])).map(([k, l]) => `<button class="fchip ${state.newsTopic === k ? 'active' : ''}" data-ntopic="${k}">${l}</button>`).join('')}
      </div>
      <div class="card">${list.length ? `<ul class="news-list">${list.map((n) => headline(n)).join('')}</ul>` : '<div class="empty">No headlines on this topic right now.</div>'}</div>`;
  }

  const MARKET_GROUPS = [
    ['index', 'Indices', (a) => a.cls === 'index'],
    ['us', 'US stocks', (a) => a.cls === 'stock' && a.region === 'US'],
    ['uk', 'UK stocks (FTSE)', (a) => a.cls === 'stock' && a.region === 'UK'],
    ['etf', 'ETFs & sector funds', (a) => a.cls === 'etf'],
    ['crypto', 'Crypto', (a) => a.cls === 'crypto'],
    ['commodity', 'Commodities', (a) => a.cls === 'commodity'],
    ['fx', 'Currencies', (a) => a.cls === 'fx'],
  ];

  function viewMarkets() {
    const q = state.search.trim().toLowerCase();
    const match = (a) => !q || a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || (a.sector || '').toLowerCase().includes(q);
    const groups = MARKET_GROUPS.filter(([k]) => state.mktFilter === 'all' || state.mktFilter === k).map(([, label, fn]) => {
      const items = state.assets.filter((a) => a.metrics && fn(a) && match(a));
      if (!items.length) return '';
      return `<h2 class="section-title">${label} <span class="faint small">(${items.length})</span></h2>
        <div class="mgrid">${items.map(marketCard).join('')}</div>`;
    }).join('');
    return `
      <h1 class="section-title">All markets</h1>
      <p class="section-sub">Real prices across stocks, funds, crypto, commodities and currencies. Tap any card for the full analysis.</p>
      <div class="row wrap" style="margin-bottom:8px">
        <input class="input" id="mkt-search" placeholder="Search symbol, name or sector…" value="${esc(state.search)}" style="flex:1;min-width:200px">
      </div>
      <div class="chips">
        ${[['all', 'All']].concat(MARKET_GROUPS.map(([k, l]) => [k, l])).map(([k, l]) => `<button class="fchip ${state.mktFilter === k ? 'active' : ''}" data-mkt="${k}">${l}</button>`).join('')}
      </div>
      ${groups || '<div class="card empty" style="margin-top:12px">No matches.</div>'}`;
  }

  function marketCard(a) {
    const m = a.metrics;
    return `<div class="card mcard" data-open="${esc(a.symbol)}">
      <div class="top"><div style="min-width:0"><div class="sym">${esc(a.symbol.replace('=X', '').replace('=F', ''))} ${a.live ? '<span class="badge live">LIVE</span>' : ''}</div><div class="nm">${esc(a.name)}</div></div>
        <div><div class="px">${fmtPrice(a, m.price)}</div><div class="mono small right">${pct(m.change1d)}</div></div></div>
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
      ${regimeCard(true)}
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
        <select class="input" id="asset-select" style="flex:1;min-width:220px;max-width:480px" aria-label="Choose asset">${options}</select>
      </div>
      <div class="trade-layout">
        <div class="stack">
          <div class="card">
            <div class="asset-head">
              <div><div class="sym">${esc(a.symbol)}</div><div class="muted small" style="margin-top:4px">${esc(a.name)} · ${esc(typeLabel(a))} · ${esc(a.sector)}${a.exchange ? ' · ' + esc(a.exchange) : ''}</div></div>
              <div><div class="px">${fmtPrice(a, m.price)}</div><div class="mono small" style="margin-top:4px">${pct(m.change1d)} today</div></div>
              <div class="spacer"></div>
              ${a.score != null ? `<div class="row">${badge(a.signal)}<span class="mono small muted">Score <b style="color:${scoreColor(a.score)}">${a.score}</b> · Rank #${a.rankPos} of ${state.ranked.length}</span></div>` : ''}
            </div>
            <div class="row wrap between" style="margin:14px 0 8px">
              <div class="legend"><span><i style="background:var(--sma50)"></i>50-day avg</span><span><i style="background:var(--sma200)"></i>200-day avg</span></div>
              <div class="row">
                <div class="seg">${['1M', '3M', '6M', '1Y'].map((t) => `<button class="${state.tf === t ? 'active' : ''}" data-tf="${t}">${t}</button>`).join('')}</div>
                <div class="seg">${[['candle', 'Candle'], ['line', 'Line']].map(([k, l]) => `<button class="${state.chartMode === k ? 'active' : ''}" data-mode="${k}">${l}</button>`).join('')}</div>
              </div>
            </div>
            <div class="chart-box"><canvas id="chart"></canvas><div class="tooltip hidden" id="tt"></div></div>
            <div class="faint tiny" style="margin-top:6px">Last price ${a.live ? 'live from CoinGecko' : 'as of ' + fmtDate(a.market_time || m.lastTime, true)}${a.stale ? ' · <span style="color:var(--hold)">not refreshed in latest update</span>' : ''}</div>
          </div>
          <div class="card">
            <div class="stats">
              ${stat('1 week', pct(m.r1w, 1))}${stat('1 month', pct(m.r1m, 1))}${stat('3 months', pct(m.r3m, 1))}${stat('1 year', pct(m.r1y, 1))}
              ${stat('RSI (14)', isNum(m.rsi14) ? m.rsi14.toFixed(0) : '—')}${stat('Volatility', isNum(m.vol) ? (m.vol * 100).toFixed(0) + '% /yr' : '—')}
              ${stat('52-wk range', fmtPrice(a, m.yearLow) + ' – ' + fmtPrice(a, m.yearHigh))}${stat('From 52-wk high', pct(m.fromHigh, 1))}
            </div>
          </div>
          ${a.factors ? `<div class="card">
            <div class="card-title">Score breakdown</div>
            ${factorRows}
            <div class="faint tiny" style="margin-top:4px">Bars show how this asset ranks against all others on each factor; % is the factor's weight.${a.adjustment ? ` Entry-timing adjustment: ${a.adjustment > 0 ? '+' : ''}${a.adjustment}.` : ''}</div>
            <div class="grid cols-2" style="margin-top:12px">
              <div><div class="card-title">Strengths</div><ul class="reasons pros">${a.reasons.pros.map((r) => `<li>${esc(r)}</li>`).join('') || '<li class="faint">None stand out</li>'}</ul></div>
              <div><div class="card-title">Risks</div><ul class="reasons cons">${a.reasons.cons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li class="faint">None flagged</li>'}</ul></div>
            </div>
          </div>` : ''}
        </div>

        <div class="stack">
          <div class="card verdict ${a.signal || ''}">
            <div class="card-title">Verdict</div>
            <div class="row" style="gap:12px">${a.score != null ? scoreRing(a.score) : ''}<div><div class="vtitle">${esc(v.title)}</div>${badge(a.signal)}</div></div>
            <p class="small" style="margin:10px 0 0">${esc(v.text)}</p>
          </div>
          <div class="card">
            <div class="card-title">Latest ${esc(a.symbol)} news</div>
            ${news.length ? `<ul class="news-list compact">${news.map((n) => headline(n, { hideMentions: true })).join('')}</ul>` : '<div class="empty small">No recent headlines for this asset.</div>'}
          </div>
          ${peers.length ? `<div class="card"><div class="card-title">Compare: ${esc(a.sector)}</div>
            ${peers.map((p) => `<div class="kv click" data-open="${esc(p.symbol)}" style="cursor:pointer"><span><b class="mono">${esc(p.symbol)}</b> <span class="muted small">${esc(p.name)}</span></span><span>${p.score} ${badge(p.signal)}</span></div>`).join('')}
          </div>` : ''}
        </div>
      </div>`;
  }

  function stat(k, v) { return `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`; }

  // ---------------------------------------------------------------- chart
  const TF_DAYS = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366 };
  let chartGeom = null;

  function drawChart(hoverIdx) {
    const canvas = $('#chart');
    const a = state.bySym[state.selected];
    if (!canvas || !a) return;
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
    const mono = getComputedStyle(document.body).getPropertyValue('--mono');

    ctx.font = '10px ' + mono;
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const p = lo + ((hi - lo) * g) / 4;
      const y = Y(p);
      ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.fillText(fmtPrice(a, p), w + 6, y);
    }
    ctx.textBaseline = 'alphabetic';
    const labels = Math.min(6, Math.floor(w / 90));
    for (let g = 0; g < labels; g++) {
      const k = Math.round((g / Math.max(1, labels - 1)) * (idx.length - 1));
      const txt = new Date(a.t[idx[k]] * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
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

  function chartHover(e) {
    const canvas = $('#chart');
    if (!canvas || !chartGeom) return;
    const rect = canvas.getBoundingClientRect();
    const k = Math.floor((e.clientX - rect.left) / chartGeom.step);
    const tt = $('#tt');
    if (k < 0 || k >= chartGeom.idx.length) { tt.classList.add('hidden'); drawChart(); return; }
    const a = chartGeom.a, i = chartGeom.idx[k];
    const s50 = Scoring.smaSeries(a.c.slice(Math.max(0, i - 49), i + 1), 50);
    tt.innerHTML = `<div class="muted">${fmtDate(a.t[i])}</div>
      O ${fmtPrice(a, a.o[i])} · H ${fmtPrice(a, a.h[i])} · L ${fmtPrice(a, a.l[i])} · <b>C ${fmtPrice(a, a.c[i])}</b>
      ${i > 0 ? ' · ' + pct(a.c[i] / a.c[i - 1] - 1) : ''}${s50[s50.length - 1] != null ? `<div style="color:var(--sma50)">50-day avg ${fmtPrice(a, s50[s50.length - 1])}</div>` : ''}`;
    tt.classList.remove('hidden');
    tt.style.left = (e.clientX - rect.left > rect.width / 2 ? 6 : rect.width - tt.offsetWidth - 70) + 'px';
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
    const t = e.target.closest('button, a, [data-open], tr.click');
    if (!t) return;
    const d = t.dataset;
    if (t.tagName === 'A' && t.target === '_blank') return; // external news link
    if (d.tab) { e.preventDefault(); state.tab = d.tab; render(); window.scrollTo({ top: 0 }); return; }
    if (d.open) { e.preventDefault(); openAsset(d.open); return; }
    if (d.lb) { state.lbFilter = d.lb; state.lbLimit = 25; render(); return; }
    if (d.mkt) { state.mktFilter = d.mkt; render(); return; }
    if (d.ntopic) { state.newsTopic = d.ntopic; render(); return; }
    if (d.tf) { state.tf = d.tf; render(); return; }
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
  document.addEventListener('mouseout', (e) => {
    if (e.target.id === 'chart') { const tt = $('#tt'); if (tt) tt.classList.add('hidden'); drawChart(); }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => drawChart(), 120); });

  // Clean up the old paper-trading account from earlier versions.
  try { localStorage.removeItem('mushtaqtrader.portfolio.v2'); } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------- boot
  loadData(true);
  setInterval(pollCrypto, LIVE_CRYPTO_MS);
  setInterval(() => loadData(false), DATA_RELOAD_MS);
  setInterval(renderStatus, 60 * 1000);
})();
