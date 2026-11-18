#!/usr/bin/env python3
"""Fetch real market + consumer/economic data and write data/market.json.

Runs in GitHub Actions on a schedule (see .github/workflows/update-market-data.yml).
Standard library only, so no install step is needed.

Sources (all free, no API key):
  * Yahoo Finance chart API  - 1 year of daily OHLCV for stocks, ETFs, indices,
                               crypto, commodities and FX.
  * Stooq CSV                - fallback for US stocks/ETFs if Yahoo fails.
  * News RSS feeds           - market-moving headlines (CNBC, MarketWatch, BBC, Federal Reserve, CoinDesk) and
                               per-symbol headlines from Yahoo Finance.
  * Consumer & economic data - FRED first; it often times out from GitHub
                               runners, so each series falls back to its official
                               source: U. Michigan, BLS, NY Fed, US Treasury.

If a symbol fails to download, the previous good copy from the existing
data/market.json is kept so one bad run never blanks the app.
"""

from __future__ import annotations

import csv
import html
import http.cookiejar
import io
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "data", "market.json")
FUND_PATH = os.path.join(ROOT, "data", "fundamentals.json")
INTRADAY_PATH = os.path.join(ROOT, "data", "intraday.json")
INTRADAY_BUDGET_S = 4 * 60
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# --------------------------------------------------------------------------
# Universe. cls: stock | etf | crypto | index | commodity | fx
# rank=True means the asset is scored in the "Best Buys" leaderboard.
# --------------------------------------------------------------------------
US = "US"
UK = "UK"

UNIVERSE: list[dict] = []


def add(symbol, name, cls, sector, region=US, rank=True, **extra):
    UNIVERSE.append(
        dict(symbol=symbol, name=name, cls=cls, sector=sector, region=region, rank=rank, **extra)
    )


# US stocks by sector
for s, n in [
    ("AAPL", "Apple"), ("MSFT", "Microsoft"), ("NVDA", "NVIDIA"), ("GOOGL", "Alphabet"),
    ("META", "Meta Platforms"), ("AVGO", "Broadcom"), ("AMD", "Advanced Micro Devices"),
    ("ORCL", "Oracle"), ("CRM", "Salesforce"), ("ADBE", "Adobe"), ("INTC", "Intel"),
    ("CSCO", "Cisco"), ("QCOM", "Qualcomm"), ("TSM", "Taiwan Semiconductor"),
    ("PLTR", "Palantir"), ("MU", "Micron"),
]:
    add(s, n, "stock", "Technology")
for s, n in [
    ("AMZN", "Amazon"), ("TSLA", "Tesla"), ("HD", "Home Depot"), ("MCD", "McDonald's"),
    ("NKE", "Nike"), ("SBUX", "Starbucks"), ("LOW", "Lowe's"), ("BKNG", "Booking Holdings"),
    ("TJX", "TJX Companies"), ("CMG", "Chipotle"),
]:
    add(s, n, "stock", "Consumer Discretionary")
for s, n in [
    ("WMT", "Walmart"), ("COST", "Costco"), ("PG", "Procter & Gamble"), ("KO", "Coca-Cola"),
    ("PEP", "PepsiCo"), ("PM", "Philip Morris"), ("MDLZ", "Mondelez"),
    ("CL", "Colgate-Palmolive"), ("TGT", "Target"),
]:
    add(s, n, "stock", "Consumer Staples")
for s, n in [
    ("JPM", "JPMorgan Chase"), ("BAC", "Bank of America"), ("V", "Visa"), ("MA", "Mastercard"),
    ("GS", "Goldman Sachs"), ("MS", "Morgan Stanley"), ("WFC", "Wells Fargo"),
    ("AXP", "American Express"), ("BRK-B", "Berkshire Hathaway"), ("PYPL", "PayPal"),
]:
    add(s, n, "stock", "Financials")
for s, n in [
    ("LLY", "Eli Lilly"), ("UNH", "UnitedHealth"), ("JNJ", "Johnson & Johnson"),
    ("ABBV", "AbbVie"), ("MRK", "Merck"), ("PFE", "Pfizer"), ("TMO", "Thermo Fisher"),
    ("ISRG", "Intuitive Surgical"),
]:
    add(s, n, "stock", "Healthcare")
for s, n in [("XOM", "Exxon Mobil"), ("CVX", "Chevron"), ("COP", "ConocoPhillips"), ("SLB", "Schlumberger")]:
    add(s, n, "stock", "Energy")
for s, n in [
    ("GE", "GE Aerospace"), ("CAT", "Caterpillar"), ("BA", "Boeing"), ("HON", "Honeywell"),
    ("UNP", "Union Pacific"), ("DE", "Deere"), ("LMT", "Lockheed Martin"),
]:
    add(s, n, "stock", "Industrials")
for s, n in [("NFLX", "Netflix"), ("DIS", "Walt Disney"), ("CMCSA", "Comcast"), ("T", "AT&T"), ("VZ", "Verizon")]:
    add(s, n, "stock", "Communication")
for s, n in [("NEE", "NextEra Energy"), ("DUK", "Duke Energy")]:
    add(s, n, "stock", "Utilities")
for s, n in [("PLD", "Prologis"), ("AMT", "American Tower")]:
    add(s, n, "stock", "Real Estate")
for s, n in [("LIN", "Linde"), ("FCX", "Freeport-McMoRan")]:
    add(s, n, "stock", "Materials")

# More US-listed stocks (added for wider coverage)
for s, n, sec in [
    ("NOW", "ServiceNow", "Technology"), ("INTU", "Intuit", "Technology"), ("IBM", "IBM", "Technology"),
    ("TXN", "Texas Instruments", "Technology"), ("AMAT", "Applied Materials", "Technology"),
    ("LRCX", "Lam Research", "Technology"), ("ASML", "ASML Holding", "Technology"), ("ARM", "Arm Holdings", "Technology"),
    ("PANW", "Palo Alto Networks", "Technology"), ("CRWD", "CrowdStrike", "Technology"), ("SNOW", "Snowflake", "Technology"),
    ("SHOP", "Shopify", "Technology"), ("DELL", "Dell Technologies", "Technology"),
    ("UBER", "Uber", "Industrials"), ("ABNB", "Airbnb", "Consumer Discretionary"),
    ("C", "Citigroup", "Financials"), ("SCHW", "Charles Schwab", "Financials"), ("BLK", "BlackRock", "Financials"),
    ("SPGI", "S&P Global", "Financials"), ("PGR", "Progressive", "Financials"), ("COIN", "Coinbase", "Financials"),
    ("HOOD", "Robinhood", "Financials"), ("SOFI", "SoFi Technologies", "Financials"),
    ("NVO", "Novo Nordisk", "Healthcare"), ("AMGN", "Amgen", "Healthcare"), ("GILD", "Gilead Sciences", "Healthcare"),
    ("BMY", "Bristol Myers Squibb", "Healthcare"), ("VRTX", "Vertex Pharmaceuticals", "Healthcare"),
    ("CVS", "CVS Health", "Healthcare"), ("MDT", "Medtronic", "Healthcare"), ("ABT", "Abbott Laboratories", "Healthcare"),
    ("MRNA", "Moderna", "Healthcare"),
    ("F", "Ford", "Consumer Discretionary"), ("GM", "General Motors", "Consumer Discretionary"),
    ("RIVN", "Rivian", "Consumer Discretionary"), ("LULU", "Lululemon", "Consumer Discretionary"),
    ("ROST", "Ross Stores", "Consumer Discretionary"), ("YUM", "Yum! Brands", "Consumer Discretionary"),
    ("MAR", "Marriott", "Consumer Discretionary"), ("RCL", "Royal Caribbean", "Consumer Discretionary"),
    ("CCL", "Carnival", "Consumer Discretionary"),
    ("MO", "Altria", "Consumer Staples"), ("KHC", "Kraft Heinz", "Consumer Staples"), ("GIS", "General Mills", "Consumer Staples"),
    ("KMB", "Kimberly-Clark", "Consumer Staples"), ("DG", "Dollar General", "Consumer Staples"),
    ("RTX", "RTX", "Industrials"), ("NOC", "Northrop Grumman", "Industrials"), ("UPS", "UPS", "Industrials"),
    ("FDX", "FedEx", "Industrials"), ("DAL", "Delta Air Lines", "Industrials"), ("UAL", "United Airlines", "Industrials"),
    ("WM", "Waste Management", "Industrials"), ("ETN", "Eaton", "Industrials"),
    ("OXY", "Occidental Petroleum", "Energy"), ("EOG", "EOG Resources", "Energy"),
    ("NEM", "Newmont", "Materials"), ("SHW", "Sherwin-Williams", "Materials"),
    ("SO", "Southern Company", "Utilities"), ("O", "Realty Income", "Real Estate"), ("EQIX", "Equinix", "Real Estate"),
    ("TMUS", "T-Mobile US", "Communication"), ("SPOT", "Spotify", "Communication"), ("SNAP", "Snap", "Communication"),
    ("PINS", "Pinterest", "Communication"), ("RBLX", "Roblox", "Communication"),
]:
    add(s, n, "stock", sec)

# UK (FTSE 100) stocks - Yahoo quotes these in pence (GBp)
for s, n, sec in [
    ("AZN.L", "AstraZeneca", "Healthcare"), ("GSK.L", "GSK", "Healthcare"),
    ("SHEL.L", "Shell", "Energy"), ("BP.L", "BP", "Energy"),
    ("HSBA.L", "HSBC", "Financials"), ("BARC.L", "Barclays", "Financials"),
    ("LLOY.L", "Lloyds Banking", "Financials"),
    ("ULVR.L", "Unilever", "Consumer Staples"), ("TSCO.L", "Tesco", "Consumer Staples"),
    ("DGE.L", "Diageo", "Consumer Staples"), ("BATS.L", "British American Tobacco", "Consumer Staples"),
    ("RIO.L", "Rio Tinto", "Materials"), ("RR.L", "Rolls-Royce", "Industrials"),
    ("VOD.L", "Vodafone", "Communication"), ("BT-A.L", "BT Group", "Communication"),
    ("NXT.L", "Next", "Consumer Discretionary"),
    ("LSEG.L", "London Stock Exchange Group", "Financials"), ("PRU.L", "Prudential", "Financials"),
    ("LGEN.L", "Legal & General", "Financials"), ("AV.L", "Aviva", "Financials"), ("NWG.L", "NatWest", "Financials"),
    ("REL.L", "RELX", "Industrials"), ("EXPN.L", "Experian", "Industrials"), ("BA.L", "BAE Systems", "Industrials"),
    ("IAG.L", "International Airlines Group", "Industrials"), ("EZJ.L", "easyJet", "Industrials"),
    ("NG.L", "National Grid", "Utilities"), ("SSE.L", "SSE", "Utilities"),
    ("SBRY.L", "Sainsbury's", "Consumer Staples"), ("MKS.L", "Marks & Spencer", "Consumer Staples"),
    ("IMB.L", "Imperial Brands", "Consumer Staples"), ("RKT.L", "Reckitt", "Consumer Staples"), ("HLN.L", "Haleon", "Consumer Staples"),
    ("JD.L", "JD Sports", "Consumer Discretionary"), ("CPG.L", "Compass Group", "Consumer Discretionary"),
    ("AAL.L", "Anglo American", "Materials"), ("GLEN.L", "Glencore", "Materials"),
    ("AUTO.L", "Auto Trader", "Communication"),
]:
    add(s, n, "stock", sec, region=UK)

# ETFs
for s, n, sec in [
    ("SPY", "S&P 500 ETF", "Broad Market"), ("QQQ", "Nasdaq-100 ETF", "Broad Market"),
    ("DIA", "Dow Jones ETF", "Broad Market"), ("IWM", "Russell 2000 ETF", "Broad Market"),
    ("XLK", "Technology Sector ETF", "Technology"),
    ("XLY", "Consumer Discretionary ETF", "Consumer Discretionary"),
    ("XLP", "Consumer Staples ETF", "Consumer Staples"),
    ("XLF", "Financials Sector ETF", "Financials"), ("XLV", "Healthcare Sector ETF", "Healthcare"),
    ("XLE", "Energy Sector ETF", "Energy"), ("XLI", "Industrials Sector ETF", "Industrials"),
    ("XLU", "Utilities Sector ETF", "Utilities"), ("XLB", "Materials Sector ETF", "Materials"),
    ("XLRE", "Real Estate Sector ETF", "Real Estate"), ("XLC", "Communication Sector ETF", "Communication"),
    ("GLD", "Gold ETF", "Commodities"), ("TLT", "20+ Year Treasury ETF", "Bonds"),
]:
    add(s, n, "etf", sec)
for s, n, sec in [
    ("VUSA.L", "Vanguard S&P 500 (UK-listed)", "Broad Market"), ("ISF.L", "iShares FTSE 100 (UK-listed)", "Broad Market"),
]:
    add(s, n, "etf", sec, region=UK)

# Crypto (cg = CoinGecko id, used by the browser for live prices)
for s, n, cg in [
    ("BTC-USD", "Bitcoin", "bitcoin"), ("ETH-USD", "Ethereum", "ethereum"),
    ("SOL-USD", "Solana", "solana"), ("XRP-USD", "XRP", "ripple"),
    ("BNB-USD", "BNB", "binancecoin"), ("ADA-USD", "Cardano", "cardano"),
    ("DOGE-USD", "Dogecoin", "dogecoin"),
]:
    add(s, n, "crypto", "Crypto", region="Global", cg=cg)

# Context-only (not ranked)
for s, n, reg in [
    ("^GSPC", "S&P 500", US), ("^IXIC", "Nasdaq Composite", US), ("^DJI", "Dow Jones", US),
    ("^FTSE", "FTSE 100", UK), ("^GDAXI", "DAX", "EU"), ("^N225", "Nikkei 225", "JP"),
    ("^VIX", "VIX Volatility Index", US),
]:
    add(s, n, "index", "Index", region=reg, rank=False)
for s, n in [("GC=F", "Gold"), ("SI=F", "Silver"), ("CL=F", "Crude Oil (WTI)"), ("NG=F", "Natural Gas")]:
    add(s, n, "commodity", "Commodities", region="Global", rank=False)
for s, n in [("GBPUSD=X", "GBP / USD"), ("EURUSD=X", "EUR / USD"), ("USDJPY=X", "USD / JPY")]:
    add(s, n, "fx", "Currencies", region="Global", rank=False)

# Consumer & economy series from FRED. transform: level | yoy (year-on-year % change)
MACRO = [
    dict(id="UMCSENT", name="Consumer Sentiment (U. Michigan)", unit="index", transform="level"),
    dict(id="CPIAUCSL", name="Inflation (CPI)", unit="% y/y", transform="yoy"),
    dict(id="UNRATE", name="Unemployment Rate", unit="%", transform="level"),
    dict(id="FEDFUNDS", name="Fed Funds Rate", unit="%", transform="level"),
    dict(id="DGS10", name="10-Year Treasury Yield", unit="%", transform="level"),
    dict(id="T10Y2Y", name="Yield Curve (10y - 2y)", unit="pp", transform="level"),
]


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------
_JAR = http.cookiejar.CookieJar()
_OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_JAR))
ASSET_BUDGET_S = 9 * 60          # stop starting new downloads after this
_DEADLINE = [time.monotonic() + ASSET_BUDGET_S]


def log(*args):
    print(*args, flush=True)


def http_get(url: str, timeout: int = 12, retries: int = 2) -> bytes:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with _OPENER.open(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code in (400, 401, 402, 403, 404):
                break
            if attempt + 1 < retries:
                time.sleep(2 * (attempt + 1) + (3 if e.code == 429 else 0))
        except Exception as e:  # noqa: BLE001 - network errors of all kinds
            last = f"{type(e).__name__}: {e}"
            if attempt + 1 < retries:
                time.sleep(1 + attempt)
    raise RuntimeError(f"{url.split('?')[0]}: {last}")


class Breaker:
    """Stops hammering a source that is clearly down (no successes, many failures)."""

    def __init__(self, name: str, threshold: int = 8):
        self.name, self.threshold = name, threshold
        self.ok = self.fail = self.streak = 0
        self.lock = threading.Lock()

    def is_open(self) -> bool:
        return self.ok == 0 and self.streak >= self.threshold

    def record(self, success: bool):
        with self.lock:
            if success:
                self.ok += 1
                self.streak = 0
            else:
                self.fail += 1
                self.streak += 1
                if self.is_open() and self.streak == self.threshold:
                    log(f"  !! {self.name} looks unavailable ({self.streak} failures, 0 successes) - skipping it")


YAHOO = Breaker("Yahoo Finance")
STOOQ = Breaker("Stooq")
COINGECKO = Breaker("CoinGecko", threshold=4)
_CG_LOCK = threading.Lock()
_CG_LAST = [0.0]
_YAHOO_CRUMB: list = []


def rnd(x):
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return None
    ax = abs(x)
    if ax >= 1000:
        return round(x, 2)
    if ax >= 1:
        return round(x, 4)
    return float(f"{x:.6g}")


# --------------------------------------------------------------------------
# Price history
# --------------------------------------------------------------------------
def yahoo_crumb() -> str:
    """Yahoo sometimes rate-limits cookieless clients; grab a session cookie + crumb once."""
    if _YAHOO_CRUMB:
        return _YAHOO_CRUMB[0]
    crumb = ""
    try:
        http_get("https://fc.yahoo.com", timeout=8, retries=1)
    except Exception:  # noqa: BLE001 - fc.yahoo.com answers 404 but still sets the cookie
        pass
    try:
        crumb = http_get("https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=8, retries=1).decode().strip()
        if len(crumb) > 40 or "<" in crumb:
            crumb = ""
    except Exception as e:  # noqa: BLE001
        log(f"  (no Yahoo crumb: {e})")
    _YAHOO_CRUMB.append(crumb)
    return crumb


def fetch_yahoo(symbol: str) -> dict:
    q = urllib.parse.quote(symbol)
    params = "range=1y&interval=1d&includePrePost=false&events=div%2Csplit"
    crumb = _YAHOO_CRUMB[0] if _YAHOO_CRUMB else ""
    if crumb:
        params += "&crumb=" + urllib.parse.quote(crumb)
    last = None
    for host in ("query1", "query2"):
        try:
            raw = http_get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{q}?{params}", retries=1)
            data = json.loads(raw)
            res = (data.get("chart") or {}).get("result")
            if not res:
                raise RuntimeError(f"no result: {(data.get('chart') or {}).get('error')}")
            return parse_yahoo(res[0])
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"yahoo: {last}")


def parse_yahoo(r: dict) -> dict:
    meta = r.get("meta") or {}
    ts = r.get("timestamp") or []
    quote = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    o, h, l, c, v = (quote.get(k) or [] for k in ("open", "high", "low", "close", "volume"))
    rows = []
    for i, t in enumerate(ts):
        ci = c[i] if i < len(c) else None
        if ci is None:
            continue
        oi = o[i] if i < len(o) and o[i] is not None else ci
        hi = h[i] if i < len(h) and h[i] is not None else max(oi, ci)
        li = l[i] if i < len(l) and l[i] is not None else min(oi, ci)
        vi = v[i] if i < len(v) and v[i] is not None else 0
        rows.append((int(t), oi, hi, li, ci, vi))
    # Yahoo sometimes appends today's live bar as well as a final bar for the
    # same day; keep the last row per calendar day.
    by_day = {}
    for row in rows:
        by_day[datetime.fromtimestamp(row[0], timezone.utc).date()] = row
    rows = [by_day[d] for d in sorted(by_day)]

    # Prefer the live market price for the latest bar if Yahoo gives one.
    price = meta.get("regularMarketPrice")
    if rows and price:
        t, oi, hi, li, _, vi = rows[-1]
        rows[-1] = (t, oi, max(hi, price), min(li, price), price, vi)
    if len(rows) < 20:
        raise RuntimeError("too little history")
    return dict(
        currency=meta.get("currency") or "USD",
        exchange=meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        market_time=meta.get("regularMarketTime"),
        prev_close=meta.get("chartPreviousClose"),
        rows=rows,
        source="Yahoo Finance",
    )


STOOQ_MAP = {
    "^GSPC": "^spx", "^IXIC": "^ndq", "^DJI": "^dji", "^FTSE": "^ukx", "^GDAXI": "^dax",
    "^N225": "^nkx", "GC=F": "gc.f", "SI=F": "si.f", "CL=F": "cl.f", "NG=F": "ng.f",
    "GBPUSD=X": "gbpusd", "EURUSD=X": "eurusd", "USDJPY=X": "usdjpy",
}


def stooq_symbol(spec: dict) -> str | None:
    s = spec["symbol"]
    if s in STOOQ_MAP:
        return STOOQ_MAP[s]
    if spec["cls"] in ("stock", "etf"):
        if s.endswith(".L"):
            return s[:-2].lower() + ".uk"
        return s.lower() + ".us"
    return None


def fetch_stooq(spec: dict) -> dict:
    s = stooq_symbol(spec)
    if not s:
        raise RuntimeError("no stooq symbol")
    raw = http_get(f"https://stooq.com/q/d/l/?s={urllib.parse.quote(s)}&i=d").decode("utf-8", "replace")
    reader = csv.DictReader(io.StringIO(raw))
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=372)
    rows = []
    for rec in reader:
        try:
            d = datetime.strptime(rec["Date"], "%Y-%m-%d").date()
            row = (float(rec["Open"]), float(rec["High"]), float(rec["Low"]), float(rec["Close"]))
        except (KeyError, ValueError, TypeError):
            continue
        if d < cutoff:
            continue
        t = int(datetime(d.year, d.month, d.day, 14, 30, tzinfo=timezone.utc).timestamp())
        rows.append((t, *row, float(rec.get("Volume") or 0)))
    if len(rows) < 20:
        raise RuntimeError(f"stooq: too little history ({raw[:60]!r})")
    currency = "GBp" if s.endswith(".uk") else "USD"
    return dict(currency=currency, exchange="", market_time=rows[-1][0], prev_close=None, rows=rows, source="Stooq")


def fetch_coingecko(spec: dict) -> dict:
    with _CG_LOCK:  # free tier allows only a few calls per minute
        wait = _CG_LAST[0] + 6 - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _CG_LAST[0] = time.monotonic()
    raw = http_get(
        f"https://api.coingecko.com/api/v3/coins/{spec['cg']}/market_chart?vs_currency=usd&days=365&interval=daily"
    )
    d = json.loads(raw)
    vols = {int(t // 86400000): v for t, v in d.get("total_volumes", [])}
    by_day = {}
    for t_ms, p in d.get("prices", []):
        by_day[int(t_ms // 86400000)] = (int(t_ms // 1000), p)
    rows, prev = [], None
    for day in sorted(by_day):
        t, p = by_day[day]
        o = prev if prev is not None else p
        rows.append((t, o, max(o, p), min(o, p), p, vols.get(day, 0)))
        prev = p
    if len(rows) < 20:
        raise RuntimeError("coingecko: too little history")
    return dict(currency="USD", exchange="CoinGecko", market_time=rows[-1][0], prev_close=None, rows=rows, source="CoinGecko")


def fetch_asset(spec: dict) -> tuple[dict, dict | None, str | None]:
    sym = spec["symbol"]
    if time.monotonic() > _DEADLINE[0]:
        return spec, None, "skipped: time budget used up"
    errs = []
    attempts = []
    if not YAHOO.is_open():
        attempts.append((YAHOO, fetch_yahoo, sym))
    if spec.get("cg") and not COINGECKO.is_open():
        attempts.append((COINGECKO, fetch_coingecko, spec))
    elif stooq_symbol(spec) and not STOOQ.is_open():
        attempts.append((STOOQ, fetch_stooq, spec))
    for breaker, fn, arg in attempts:
        try:
            data = fn(arg)
            breaker.record(True)
            log(f"  ok   {sym:<10} {data['source']} ({len(data['rows'])} days)")
            return spec, data, None
        except Exception as e:  # noqa: BLE001
            breaker.record(False)
            errs.append(f"{breaker.name}: {e}")
    if not attempts:
        errs.append("all sources unavailable")
    log(f"  FAIL {sym:<10} {' | '.join(errs)[:220]}")
    return spec, None, " | ".join(errs)


def build_asset(spec: dict, data: dict) -> dict:
    rows = data["rows"]
    out = dict(spec)
    out.update(
        currency=data["currency"],
        exchange=data["exchange"],
        market_time=data["market_time"],
        source=data["source"],
        t=[r[0] for r in rows],
        o=[rnd(r[1]) for r in rows],
        h=[rnd(r[2]) for r in rows],
        l=[rnd(r[3]) for r in rows],
        c=[rnd(r[4]) for r in rows],
        v=[int(r[5] or 0) for r in rows],
    )
    return out


# --------------------------------------------------------------------------
# Consumer / economic data: FRED first, then official fallback sources
# --------------------------------------------------------------------------
FRED = Breaker("FRED", threshold=2)
_CACHE: dict = {}
MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"])}


def http_post_json(url: str, body: dict, timeout: int = 20) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"User-Agent": UA, "Content-Type": "application/json"},
    )
    with _OPENER.open(req, timeout=timeout) as r:
        return json.loads(r.read())


def to_monthly(pts, how="last"):
    """[(YYYY-MM-DD, value)] -> [(YYYY-MM-01, value)] one point per month."""
    groups: dict = {}
    for d, v in sorted(pts):
        groups.setdefault(d[:7], []).append(v)
    agg = (lambda vs: vs[-1]) if how == "last" else (lambda vs: sum(vs) / len(vs))
    return [(k + "-01", agg(vs)) for k, vs in sorted(groups.items())]


def start_year() -> int:
    return datetime.now(timezone.utc).year - 5


def fred_points(series_id: str):
    start = (datetime.now(timezone.utc) - timedelta(days=365 * 6)).strftime("%Y-%m-%d")
    raw = http_get(
        f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start}",
        timeout=20, retries=1,
    ).decode("utf-8", "replace")
    reader = csv.reader(io.StringIO(raw))
    next(reader, None)
    pts = []
    for row in reader:
        if len(row) < 2 or row[1] in (".", ""):
            continue
        try:
            pts.append((row[0], float(row[1])))
        except ValueError:
            continue
    if len(pts) > 200:  # daily series -> month-end values
        pts = to_monthly(pts)
    return pts


def umich_points():
    raw = http_get("https://www.sca.isr.umich.edu/files/tbmics.csv").decode("utf-8", "replace")
    pts = []
    for rec in csv.DictReader(io.StringIO(raw)):
        rec = {(k or "").strip().lower(): (v or "").strip() for k, v in rec.items()}
        try:
            m = MONTHS[rec["month"].lower()]
            pts.append((f"{int(rec['yyyy'])}-{m:02d}-01", float(rec["ics_all"])))
        except (KeyError, ValueError):
            continue
    return pts


def bls_points(series_id: str):
    if "bls" not in _CACHE:
        yr = datetime.now(timezone.utc).year
        data = http_post_json(
            "https://api.bls.gov/publicAPI/v1/timeseries/data/",
            {"seriesid": ["CUSR0000SA0", "LNS14000000"], "startyear": str(yr - 6), "endyear": str(yr)},
        )
        if data.get("status") != "REQUEST_SUCCEEDED":
            raise RuntimeError(f"BLS: {data.get('status')} {data.get('message')}")
        _CACHE["bls"] = {
            ser["seriesID"]: [
                (f"{row['year']}-{row['period'][1:]}-01", float(row["value"]))
                for row in ser.get("data", [])
                if row.get("period", "").startswith("M") and row["period"] != "M13" and row.get("value") not in ("-", "")
            ]
            for ser in data["Results"]["series"]
        }
    return sorted(_CACHE["bls"].get(series_id, []))


def treasury_rows():
    if "treasury" not in _CACHE:
        rows = []
        for yr in range(start_year(), datetime.now(timezone.utc).year + 1):
            raw = http_get(
                "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
                f"daily-treasury-rates.csv/{yr}/all?type=daily_treasury_yield_curve"
                f"&field_tdr_date_value={yr}&page&_format=csv"
            ).decode("utf-8", "replace")
            for rec in csv.DictReader(io.StringIO(raw)):
                try:
                    d = datetime.strptime(rec["Date"], "%m/%d/%Y").strftime("%Y-%m-%d")
                    rows.append((d, float(rec["10 Yr"]), float(rec["2 Yr"])))
                except (KeyError, ValueError):
                    continue
        _CACHE["treasury"] = sorted(rows)
    return _CACHE["treasury"]


def nyfed_effr_points():
    today = datetime.now(timezone.utc).date()
    data = json.loads(http_get(
        "https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json"
        f"?startDate={start_year()}-01-01&endDate={today.isoformat()}"
    ))
    pts = [(r["effectiveDate"], float(r["percentRate"])) for r in data.get("refRates", []) if r.get("percentRate") is not None]
    return to_monthly(pts, how="mean")


MACRO_FALLBACKS = {
    "UMCSENT": [("University of Michigan", umich_points)],
    "CPIAUCSL": [("US Bureau of Labor Statistics", lambda: bls_points("CUSR0000SA0"))],
    "UNRATE": [("US Bureau of Labor Statistics", lambda: bls_points("LNS14000000"))],
    "FEDFUNDS": [("Federal Reserve Bank of New York", nyfed_effr_points)],
    "DGS10": [("US Treasury", lambda: to_monthly([(d, ten) for d, ten, _ in treasury_rows()]))],
    "T10Y2Y": [("US Treasury", lambda: to_monthly([(d, ten - two) for d, ten, two in treasury_rows()]))],
}


def finish_macro(spec: dict, pts, source: str) -> dict:
    if spec["transform"] == "yoy":
        lookup = {d[:7]: val for d, val in pts}
        pts = [
            (d, (val / lookup[f"{int(d[:4]) - 1}-{d[5:7]}"] - 1) * 100)
            for d, val in pts if lookup.get(f"{int(d[:4]) - 1}-{d[5:7]}")
        ]
    pts = pts[-60:]
    if len(pts) < 6:
        raise RuntimeError(f"{source}: too few points ({len(pts)})")
    out = {k: spec[k] for k in ("id", "name", "unit", "transform")}
    out["dates"] = [d for d, _ in pts]
    out["values"] = [round(val, 3) for _, val in pts]
    out["source"] = source
    return out


def fetch_macro(spec: dict) -> dict:
    sources = []
    if not FRED.is_open():
        sources.append(("FRED, Federal Reserve Bank of St. Louis", lambda: fred_points(spec["id"]), FRED))
    sources += [(name, fn, None) for name, fn in MACRO_FALLBACKS.get(spec["id"], [])]
    errs = []
    for name, fn, breaker in sources:
        try:
            out = finish_macro(spec, fn(), name)
            if breaker:
                breaker.record(True)
            log(f"  ok   {spec['id']:<10} {name} (latest {out['dates'][-1]})")
            return out
        except Exception as e:  # noqa: BLE001
            if breaker:
                breaker.record(False)
            errs.append(f"{name}: {e}")
    msg = " | ".join(errs) or "no source available"
    log(f"  FAIL {spec['id']:<10} {msg[:220]}")
    raise RuntimeError(msg)


# --------------------------------------------------------------------------
# News (RSS). Headlines are shown alongside the scores; they do not change them.
# --------------------------------------------------------------------------
MARKET_FEEDS = [
    ("CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"),
    ("CNBC Finance", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664"),
    ("CNBC Economy", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258"),
    ("MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_marketpulse"),
    ("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml"),
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
]
NEWS_BUDGET_S = 3 * 60
YAHOO_RSS = Breaker("Yahoo news", threshold=8)
ATOM = "{http://www.w3.org/2005/Atom}"


def parse_feed(raw: bytes, source: str) -> list[dict]:
    if b"<!ENTITY" in raw[:4000]:  # refuse entity tricks in untrusted XML
        raise RuntimeError("feed declares entities")
    root = ET.fromstring(raw)
    items = root.findall(".//item") or root.findall(f".//{ATOM}entry")
    out = []
    for it in items:
        title = (it.findtext("title") or it.findtext(f"{ATOM}title") or "").strip()
        link = (it.findtext("link") or "").strip()
        if not link:
            el = it.find(f"{ATOM}link")
            link = (el.get("href") if el is not None else "") or ""
        date = it.findtext("pubDate") or it.findtext(f"{ATOM}published") or it.findtext(f"{ATOM}updated") or ""
        if not title or not link.lower().startswith(("http://", "https://")):
            continue
        try:
            dt = parsedate_to_datetime(date) if "," in date or " " in date.strip() else datetime.fromisoformat(date.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            ts = int(dt.timestamp())
        except Exception:  # noqa: BLE001
            ts = None
        out.append(dict(title=html.unescape(" ".join(title.split()))[:300], link=link[:600], source=source, time=ts))
    return out


def fetch_market_feed(feed) -> tuple[str, list[dict] | None, str | None]:
    name, url = feed
    try:
        items = parse_feed(http_get(url, timeout=15), name)
        log(f"  ok   news {name} ({len(items)})")
        return name, items, None
    except Exception as e:  # noqa: BLE001
        log(f"  FAIL news {name}: {str(e)[:160]}")
        return name, None, str(e)


def fetch_symbol_news(spec: dict) -> tuple[str, list[dict] | None]:
    sym = spec["symbol"]
    if time.monotonic() > _DEADLINE[0] or YAHOO_RSS.is_open():
        return sym, None
    region = "GB" if spec["region"] == UK else "US"
    try:
        raw = http_get(
            f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={urllib.parse.quote(sym)}&region={region}&lang=en-{region}",
            timeout=10, retries=1,
        )
        items = parse_feed(raw, "Yahoo Finance")
        YAHOO_RSS.record(True)
        return sym, items
    except Exception:  # noqa: BLE001
        YAHOO_RSS.record(False)
        return sym, None


def newest(items: list[dict], limit: int, max_age_days: int) -> list[dict]:
    cutoff = time.time() - max_age_days * 86400
    seen, out = set(), []
    for it in sorted(items, key=lambda x: x.get("time") or 0, reverse=True):
        key = "".join(ch for ch in it["title"].lower() if ch.isalnum())[:80]
        if key in seen or (it.get("time") and it["time"] < cutoff):
            continue
        seen.add(key)
        out.append(it)
        if len(out) >= limit:
            break
    return out


def fetch_news(prev_news: dict) -> tuple[dict, list[str]]:
    _DEADLINE[0] = time.monotonic() + NEWS_BUDGET_S
    errors = []
    market = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for name, items, err in pool.map(fetch_market_feed, MARKET_FEEDS):
            if items:
                market += items
            else:
                errors.append(f"news {name}: {err}")
    symbols = {}
    targets = [s for s in UNIVERSE if s["cls"] in ("stock", "etf", "crypto")]
    with ThreadPoolExecutor(max_workers=6) as pool:
        for sym, items in pool.map(fetch_symbol_news, targets):
            if items:
                symbols[sym] = newest(items, 6, 14)
    log(f"  news: {len(market)} market headlines, {len(symbols)}/{len(targets)} symbols with headlines")
    prev_symbols = (prev_news or {}).get("symbols", {})
    for sym, items in prev_symbols.items():  # keep older headlines if a symbol failed this time
        symbols.setdefault(sym, items)
    market = newest(market, 80, 4) or (prev_news or {}).get("market", [])
    return dict(market=market, symbols=symbols), errors


# --------------------------------------------------------------------------
# Fundamentals (analysts, financial health, earnings, retail sales) -> data/fundamentals.json
# Runs only when the free API keys are saved as GitHub secrets, at most once a day.
# Without keys the existing snapshot file is left as it is.
# --------------------------------------------------------------------------
FMP = "https://financialmodelingprep.com/stable"


def _fmp(path: str, key: str):
    sep = "&" if "?" in path else "?"
    return json.loads(http_get(f"{FMP}/{path}{sep}apikey={urllib.parse.quote(key)}", timeout=15, retries=1))


def refresh_fundamentals() -> None:
    fmp_key = os.environ.get("FMP_API_KEY", "").strip()
    av_key = os.environ.get("ALPHAVANTAGE_API_KEY", "").strip()
    if not fmp_key and not av_key:
        log("Fundamentals: no FMP_API_KEY / ALPHAVANTAGE_API_KEY secret - keeping the existing snapshot")
        return
    try:
        with open(FUND_PATH, encoding="utf-8") as f:
            prev = json.load(f)
    except Exception:  # noqa: BLE001
        prev = {}
    try:
        age_h = (datetime.now(timezone.utc) - datetime.strptime(prev["generated_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)).total_seconds() / 3600
    except Exception:  # noqa: BLE001
        age_h = 1e9
    if age_h < 20 and os.environ.get("FORCE_FUNDAMENTALS") != "1":
        log(f"Fundamentals: snapshot is {age_h:.0f}h old - refreshing once a day only")
        return

    out = dict(prev)
    out.setdefault("sources", {})
    if fmp_key:
        stocks, denied = {}, 0
        for spec in [u for u in UNIVERSE if u["cls"] == "stock" and u["region"] == US]:
            sym = spec["symbol"]
            try:
                t = _fmp(f"price-target-consensus?symbol={sym}", fmp_key)
            except Exception:  # noqa: BLE001 - not on this plan, skip the rest for this symbol
                denied += 1
                continue
            rec = {}
            if t:
                t = t[0]
                rec["target"] = dict(high=t.get("targetHigh"), low=t.get("targetLow"),
                                     consensus=t.get("targetConsensus"), median=t.get("targetMedian"))
            for path, key in ((f"grades-consensus?symbol={sym}", "grades"), (f"ratings-snapshot?symbol={sym}", "health")):
                try:
                    r = _fmp(path, fmp_key)
                    if not r:
                        continue
                    r = r[0]
                    if key == "grades":
                        rec["grades"] = {k: r.get(k, 0) for k in ("strongBuy", "buy", "hold", "sell", "strongSell")}
                        rec["grades"]["consensus"] = r.get("consensus", "")
                    else:
                        rec["health"] = dict(rating=r.get("rating"), overall=r.get("overallScore"), dcf=r.get("discountedCashFlowScore"),
                                             roe=r.get("returnOnEquityScore"), roa=r.get("returnOnAssetsScore"),
                                             debt=r.get("debtToEquityScore"), pe=r.get("priceToEarningsScore"), pb=r.get("priceToBookScore"))
                except Exception as e:  # noqa: BLE001
                    log(f"  fmp {path.split('?')[0]} {sym}: {str(e)[:120]}")
            if rec:
                stocks[sym] = rec
        log(f"Fundamentals: FMP data for {len(stocks)} stocks ({denied} not on this plan)")
        if stocks:
            out["stocks"] = stocks
            out["sources"].update(analysts="Financial Modeling Prep", health="Financial Modeling Prep")
        try:
            today = datetime.now(timezone.utc).date()
            cal = _fmp(f"earnings-calendar?from={today}&to={today + timedelta(days=90)}", fmp_key)
            tracked = {u["symbol"] for u in UNIVERSE}
            earn = [dict(symbol=e["symbol"], date=e["date"], epsEstimated=e.get("epsEstimated"))
                    for e in cal if e.get("symbol") in tracked and e.get("date")]
            if earn:
                out["earnings"] = sorted(earn, key=lambda e: e["date"])
                out["sources"]["earnings"] = "Financial Modeling Prep"
            log(f"Fundamentals: {len(earn)} upcoming earnings for tracked stocks")
        except Exception as e:  # noqa: BLE001
            log(f"Fundamentals: earnings calendar failed: {str(e)[:160]}")
    if av_key:
        try:
            r = json.loads(http_get(f"https://www.alphavantage.co/query?function=RETAIL_SALES&datatype=json&apikey={urllib.parse.quote(av_key)}"))
            raw = {d["date"][:7]: float(d["value"]) for d in r.get("data", []) if d.get("value") not in (None, ".", "")}
            pts = []
            for k in sorted(raw):
                y, m = k.split("-")
                prev_v = raw.get(f"{int(y) - 1}-{m}")
                if prev_v:
                    pts.append((k + "-01", round((raw[k] / prev_v - 1) * 100, 3)))
            pts = pts[-48:]
            if len(pts) >= 6:
                out["macro"] = [dict(id="RSAFS", name="Retail Sales", unit="% y/y", transform="yoy",
                                     dates=[d for d, _ in pts], values=[v for _, v in pts], source="Alpha Vantage (US Census Bureau)")]
                out["sources"]["retail_sales"] = "Alpha Vantage (US Census Bureau data)"
                log(f"Fundamentals: retail sales to {pts[-1][0]}")
        except Exception as e:  # noqa: BLE001
            log(f"Fundamentals: Alpha Vantage retail sales failed: {str(e)[:160]}")
    out["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out["method"] = "api"
    with open(FUND_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))


# --------------------------------------------------------------------------
# Intraday prices (15-minute bars, last 5 trading days) -> data/intraday.json
# Powers the 1D (today) and 1W (last week) charts. Kept in its own file so the
# main page stays light; the browser only loads it when 1D/1W is chosen.
# --------------------------------------------------------------------------
def fetch_intraday(symbol: str):
    if time.monotonic() > _DEADLINE[0] or YAHOO.is_open():
        return symbol, None
    q = urllib.parse.quote(symbol)
    params = "range=5d&interval=15m&includePrePost=false"
    crumb = _YAHOO_CRUMB[0] if _YAHOO_CRUMB else ""
    if crumb:
        params += "&crumb=" + urllib.parse.quote(crumb)
    for host in ("query1", "query2"):
        try:
            data = json.loads(http_get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{q}?{params}", retries=1))
            res = ((data.get("chart") or {}).get("result") or [None])[0]
            if not res:
                continue
            ts = res.get("timestamp") or []
            closes = (((res.get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
            pts = [(int(t), c) for t, c in zip(ts, closes) if c is not None]
            if len(pts) < 5:
                continue
            gmt = (res.get("meta") or {}).get("gmtoffset") or 0
            return symbol, dict(t=[t for t, _ in pts], c=[rnd(c) for _, c in pts], tz=gmt)
        except Exception:  # noqa: BLE001
            continue
    return symbol, None


def refresh_intraday(symbols: list[str]) -> int:
    _DEADLINE[0] = time.monotonic() + INTRADAY_BUDGET_S
    series = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for sym, s in pool.map(fetch_intraday, symbols):
            if s:
                series[sym] = s
    if len(series) < len(symbols) * 0.3:
        log(f"Intraday: only {len(series)}/{len(symbols)} - keeping the previous file")
        return len(series)
    try:
        with open(INTRADAY_PATH, encoding="utf-8") as f:
            prev = json.load(f).get("series", {})
    except Exception:  # noqa: BLE001
        prev = {}
    for sym in symbols:  # keep yesterday's intraday for symbols that failed this time
        if sym not in series and sym in prev:
            series[sym] = prev[sym]
    with open(INTRADAY_PATH, "w", encoding="utf-8") as f:
        json.dump(dict(generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), interval="15m", series=series),
                  f, separators=(",", ":"))
    log(f"Intraday: {len(series)}/{len(symbols)} symbols ({os.path.getsize(INTRADAY_PATH) / 1024:.0f} KB)")
    return len(series)


# --------------------------------------------------------------------------
def load_previous() -> dict:
    try:
        with open(OUT_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def main() -> int:
    prev = load_previous()
    prev_assets = {a["symbol"]: a for a in prev.get("assets", [])}
    prev_macro = {m["id"]: m for m in prev.get("macro", [])}
    errors: list[str] = []

    _DEADLINE[0] = time.monotonic() + ASSET_BUDGET_S
    log(f"Fetching {len(UNIVERSE)} assets...")
    crumb = yahoo_crumb()
    log(f"  Yahoo session {'ready' if crumb else 'without crumb'}")
    assets = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for spec, data, err in pool.map(fetch_asset, UNIVERSE):
            if data:
                assets.append(build_asset(spec, data))
            else:
                errors.append(f"{spec['symbol']}: {err}")
                if spec["symbol"] in prev_assets:
                    stale = dict(prev_assets[spec["symbol"]])
                    stale["stale"] = True
                    assets.append(stale)

    log("Fetching consumer & economic data...")
    macro = []
    for spec in MACRO:
        try:
            macro.append(fetch_macro(spec))
        except Exception as e:  # noqa: BLE001
            errors.append(f"{spec['id']}: {e}")
            if spec["id"] in prev_macro:
                macro.append(prev_macro[spec["id"]])

    log("Fetching intraday prices...")
    try:
        refresh_intraday([a["symbol"] for a in assets if not a.get("stale")])
    except Exception as e:  # noqa: BLE001 - never let this break the main update
        errors.append(f"intraday: {e}")

    log("Fetching news...")
    try:
        news, news_errors = fetch_news(prev.get("news") or {})
        errors += news_errors
    except Exception as e:  # noqa: BLE001
        errors.append(f"news: {e}")
        news = prev.get("news") or {"market": [], "symbols": {}}

    try:
        refresh_fundamentals()
    except Exception as e:  # noqa: BLE001 - never let this break the price update
        errors.append(f"fundamentals: {e}")

    fresh = sum(1 for a in assets if not a.get("stale"))
    log(f"assets: {fresh} fresh, {len(assets) - fresh} stale, {len(UNIVERSE) - len(assets)} missing")
    log(f"macro series: {len(macro)}/{len(MACRO)}")
    for e in errors:
        print("  !", e[:300])

    if fresh < len(UNIVERSE) * 0.5:
        print("Too many failures - keeping the previous data file untouched.")
        return 1 if not prev else 0

    order = {s["symbol"]: i for i, s in enumerate(UNIVERSE)}
    assets.sort(key=lambda a: order.get(a["symbol"], 1e9))
    payload = dict(
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        sources=sorted({a.get("source", "") for a in assets} | {m.get("source", "") for m in macro}),
        assets=assets,
        macro=macro,
        news=news,
        errors=errors[:50],
    )
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"wrote {OUT_PATH} ({os.path.getsize(OUT_PATH) / 1024:.0f} KB)")
    # Tiny file the page polls every minute to know when to fetch new data.
    with open(os.path.join(ROOT, "data", "version.json"), "w", encoding="utf-8") as f:
        json.dump(dict(generated_at=payload["generated_at"]), f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
