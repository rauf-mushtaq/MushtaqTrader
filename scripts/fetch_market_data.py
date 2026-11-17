#!/usr/bin/env python3
"""Fetch real market + consumer/economic data and write data/market.json.

Runs in GitHub Actions on a schedule (see .github/workflows/update-market-data.yml).
Standard library only, so no install step is needed.

Sources (all free, no API key):
  * Yahoo Finance chart API  - 1 year of daily OHLCV for stocks, ETFs, indices,
                               crypto, commodities and FX.
  * Stooq CSV                - fallback for US stocks/ETFs if Yahoo fails.
  * FRED (St. Louis Fed)     - consumer & economic series (sentiment, CPI,
                               retail sales, unemployment, rates...).

If a symbol fails to download, the previous good copy from the existing
data/market.json is kept so one bad run never blanks the app.
"""

from __future__ import annotations

import csv
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "data", "market.json")
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
    dict(id="RSAFS", name="Retail Sales", unit="% y/y", transform="yoy"),
    dict(id="PCE", name="Consumer Spending (PCE)", unit="% y/y", transform="yoy"),
    dict(id="CPIAUCSL", name="Inflation (CPI)", unit="% y/y", transform="yoy"),
    dict(id="UNRATE", name="Unemployment Rate", unit="%", transform="level"),
    dict(id="PSAVERT", name="Personal Saving Rate", unit="%", transform="level"),
    dict(id="FEDFUNDS", name="Fed Funds Rate", unit="%", transform="level"),
    dict(id="DGS10", name="10-Year Treasury Yield", unit="%", transform="level"),
    dict(id="T10Y2Y", name="Yield Curve (10y - 2y)", unit="pp", transform="level"),
]


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------
def http_get(url: str, timeout: int = 20, retries: int = 3) -> bytes:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (400, 404):
                break
            time.sleep(1.5 * (attempt + 1) + (3 if e.code == 429 else 0))
        except Exception as e:  # noqa: BLE001 - network errors of all kinds
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


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
def fetch_yahoo(symbol: str) -> dict:
    q = urllib.parse.quote(symbol)
    params = "range=1y&interval=1d&includePrePost=false&events=div%2Csplit"
    last = None
    for host in ("query1", "query2"):
        try:
            raw = http_get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{q}?{params}")
            data = json.loads(raw)
            res = (data.get("chart") or {}).get("result")
            if not res:
                raise RuntimeError(f"no result: {(data.get('chart') or {}).get('error')}")
            return parse_yahoo(res[0])
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"yahoo {symbol}: {last}")


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


def fetch_stooq(symbol: str) -> dict:
    s = symbol.lower().replace("-", ".") + ".us"
    raw = http_get(f"https://stooq.com/q/d/l/?s={urllib.parse.quote(s)}&i=d").decode("utf-8", "replace")
    reader = csv.DictReader(io.StringIO(raw))
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=372)
    rows = []
    for rec in reader:
        try:
            d = datetime.strptime(rec["Date"], "%Y-%m-%d").date()
        except (KeyError, ValueError):
            continue
        if d < cutoff:
            continue
        t = int(datetime(d.year, d.month, d.day, 14, 30, tzinfo=timezone.utc).timestamp())
        rows.append((t, float(rec["Open"]), float(rec["High"]), float(rec["Low"]),
                     float(rec["Close"]), float(rec.get("Volume") or 0)))
    if len(rows) < 20:
        raise RuntimeError(f"stooq {symbol}: too little history")
    return dict(currency="USD", exchange="", market_time=rows[-1][0], prev_close=None, rows=rows, source="Stooq")


def fetch_asset(spec: dict) -> tuple[dict, dict | None, str | None]:
    sym = spec["symbol"]
    try:
        return spec, fetch_yahoo(sym), None
    except Exception as e:  # noqa: BLE001
        err = str(e)
    if spec["region"] == US and spec["cls"] in ("stock", "etf"):
        try:
            return spec, fetch_stooq(sym), None
        except Exception as e:  # noqa: BLE001
            err += f" | {e}"
    return spec, None, err


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
# FRED consumer / economic data
# --------------------------------------------------------------------------
def fetch_fred(spec: dict) -> dict:
    start = (datetime.now(timezone.utc) - timedelta(days=365 * 6)).strftime("%Y-%m-%d")
    raw = http_get(
        f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={spec['id']}&cosd={start}"
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
    if not pts:
        raise RuntimeError(f"fred {spec['id']}: empty")

    # Daily series (rates) -> keep the last observation of each month.
    if len(pts) > 200:
        monthly = {}
        for d, val in pts:
            monthly[d[:7]] = (d, val)
        pts = [monthly[k] for k in sorted(monthly)]

    if spec["transform"] == "yoy":
        lookup = {d[:7]: val for d, val in pts}
        yoy = []
        for d, val in pts:
            y, m = int(d[:4]), d[5:7]
            prev = lookup.get(f"{y - 1}-{m}")
            if prev:
                yoy.append((d, (val / prev - 1) * 100))
        pts = yoy
    pts = pts[-60:]
    out = {k: spec[k] for k in ("id", "name", "unit", "transform")}
    out["dates"] = [d for d, _ in pts]
    out["values"] = [round(val, 3) for _, val in pts]
    out["source"] = "FRED, Federal Reserve Bank of St. Louis"
    return out


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

    macro = []
    for spec in MACRO:
        try:
            macro.append(fetch_fred(spec))
        except Exception as e:  # noqa: BLE001
            errors.append(f"{spec['id']}: {e}")
            if spec["id"] in prev_macro:
                macro.append(prev_macro[spec["id"]])

    fresh = sum(1 for a in assets if not a.get("stale"))
    print(f"assets: {fresh} fresh, {len(assets) - fresh} stale, {len(UNIVERSE) - len(assets)} missing")
    print(f"macro series: {len(macro)}/{len(MACRO)}")
    for e in errors:
        print("  !", e[:300])

    if fresh < len(UNIVERSE) * 0.5:
        print("Too many failures - keeping the previous data file untouched.")
        return 1 if not prev else 0

    order = {s["symbol"]: i for i, s in enumerate(UNIVERSE)}
    assets.sort(key=lambda a: order.get(a["symbol"], 1e9))
    payload = dict(
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        sources=["Yahoo Finance", "Stooq", "FRED (Federal Reserve Bank of St. Louis)"],
        assets=assets,
        macro=macro,
        errors=errors[:50],
    )
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"wrote {OUT_PATH} ({os.path.getsize(OUT_PATH) / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
