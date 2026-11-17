# MushtaqTrader

An app that helps you decide what to buy. It tracks real prices for stocks, ETFs, crypto, commodities and currencies, plus consumer and economic indicators, and ranks which assets look like the best buy right now using a transparent scoring model. It also gathers the latest market news, so you can see events that could move prices before you decide.

## What it does

- **Best Buys**: about 115 real US and UK stocks, ETFs and cryptocurrencies get a 0–100 score from the last year of prices. The score covers momentum, trend, return per unit of risk, volatility and distance from the 52-week high. The #1 pick, the best in each market and a full ranking are shown, each with plain-English reasons and risks.
- **Market backdrop**: the S&P 500 trend, the VIX, market breadth and consumer and economic data (sentiment, retail sales, inflation, unemployment and the yield curve) are combined into a Risk-on / Neutral / Cautious reading. When the reading is Cautious, the score favours steadier assets.
- **Market News**: headlines from Yahoo Finance, CNBC, MarketWatch, BBC Business, the Federal Reserve and CoinDesk. They're tagged by topic (interest rates, inflation, earnings, oil, tariffs and so on), and any tracked company a headline mentions is linked to its rating.
- **Markets**: indices, stocks, ETFs, crypto, commodities and currencies with real prices.
- **Consumer & Economy**: US consumer sentiment, retail sales, inflation, unemployment, interest rates and the yield curve.
- **Chart & Analysis**: for any asset, a candlestick chart with 50 and 200-day averages, key stats, the score breakdown, a plain-English verdict, its latest news and how it compares with others in the same sector.

> The scores are a mechanical ranking of past data. News is shown alongside them but doesn't change them. Nothing here predicts prices or is financial advice.

## How the data gets in

`.github/workflows/update-market-data.yml` runs `scripts/fetch_market_data.py`. It runs every 30 minutes while the UK and US markets are open, every 4 hours at weekends, and whenever you start it by hand. The script downloads prices from Yahoo Finance (with Stooq and CoinGecko as fallbacks). It tries FRED for economic data first and falls back to the official source for each figure: University of Michigan, US Bureau of Labor Statistics, US Census Bureau, New York Fed and US Treasury. It also collects news headlines from RSS feeds, then commits everything to `data/market.json`. While the page is open, it also pulls live crypto prices from CoinGecko every minute.

Scheduled runs only happen on the repository's **default branch**, so merge this work into `main`. To refresh the data immediately, go to **Actions → Update market data → Run workflow**.

## Running it

- **GitHub Pages**: Settings → Pages → deploy from branch `main`, folder `/`.
- **Locally**: `python3 -m http.server` in the repository folder, then open <http://localhost:8000>. Opening `index.html` straight from disk won't work, because browsers block it from reading the data file.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `css/styles.css` | Page and styling (no external dependencies) |
| `js/scoring.js` | Scoring model and market backdrop (also runs in Node for testing) |
| `js/app.js` | UI, charts, news and live crypto prices |
| `scripts/fetch_market_data.py` | Data fetcher (Python standard library only) |
| `data/market.json` | Generated data. Don't edit it by hand. |
