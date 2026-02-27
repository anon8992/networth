#!/usr/bin/env python3
"""
Update stock price history JSON files with yfinance (no API keys).

- Reads tickers from data/trades.json by default.
- Uses src/config.js for Canadian ticker detection and Yahoo symbol overrides.
- Incrementally fetches from last known date -7 days (or --start for new files).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from datetime import datetime, timedelta
from pathlib import Path

import yfinance as yf


ROOT = Path(__file__).resolve().parents[2]
TRADES_FILE = ROOT / "data" / "trades.json"
PRICES_DIR = ROOT / "data" / "stockPriceHistory"
CONFIG_FILE = ROOT / "src" / "config.js"


def log(msg: str) -> None:
    print(f"[updateYF] {msg}")


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_tickers_from_trades() -> list[str]:
    trades = load_json(TRADES_FILE) or []
    tickers = set()
    for row in trades:
        ticker = str((row or {}).get("ticker") or "").strip().upper()
        if ticker:
            tickers.add(ticker)
    return sorted(tickers)


def parse_config_symbols() -> tuple[set[str], dict[str, str]]:
    try:
        text = CONFIG_FILE.read_text(encoding="utf-8")
    except Exception:
        return set(), {}

    canadian_tickers = set()
    m = re.search(r"useAlphaVantageTickers\s*=\s*\[(.*?)\];", text, re.S)
    if m:
        canadian_tickers = {v.strip().upper() for v in re.findall(r"'([^']+)'", m.group(1))}

    overrides: dict[str, str] = {}
    m = re.search(r"yfinanceSymbolByTicker\s*=\s*{(.*?)};", text, re.S)
    if m:
        body = m.group(1)
        for key, val in re.findall(r"([A-Za-z0-9_.\-]+)\s*:\s*'([^']+)'", body):
            overrides[key.strip().upper()] = val.strip()

    return canadian_tickers, overrides


def resolve_symbol(ticker: str, canadian_tickers: set[str], overrides: dict[str, str]) -> str:
    t = ticker.upper()
    if t in overrides:
        return overrides[t]
    if t in canadian_tickers and "." not in t:
        return f"{t}.TO"
    return t


def load_price_rows(path: Path) -> list[list]:
    rows = load_json(path)
    if not isinstance(rows, list):
        return []
    out = []
    for row in rows:
        if not (isinstance(row, list) and len(row) >= 2):
            continue
        date_str = row[0]
        price = row[1]
        if isinstance(date_str, str) and isinstance(price, (int, float)):
            out.append([date_str, float(price)])
    out.sort(key=lambda x: x[0])
    return out


def write_price_rows(path: Path, rows: list[list]) -> None:
    lines = ["["]
    for i, (date_str, price) in enumerate(rows):
        comma = "," if i < len(rows) - 1 else ""
        lines.append(f'  ["{date_str}",{price}]{comma}')
    lines.append("]")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_date(date_str: str) -> datetime:
    return datetime.strptime(date_str, "%Y-%m-%d")


def fetch_rows(symbol: str, start_date: str) -> list[list]:
    history = yf.Ticker(symbol).history(start=start_date, auto_adjust=True)
    if history.empty:
        return []

    rows = []
    for date, row in history.iterrows():
        close = row.get("Close")
        if close is None:
            continue
        price = float(close)
        if not math.isfinite(price):
            continue
        rows.append([date.strftime("%Y-%m-%d"), round(price, 4)])

    rows.sort(key=lambda x: x[0])
    return rows


def merge_rows(existing: list[list], new_rows: list[list]) -> list[list]:
    merged = {d: p for d, p in existing}
    for d, p in new_rows:
        merged[d] = p
    return [[d, merged[d]] for d in sorted(merged.keys())]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update stock prices with yfinance.")
    parser.add_argument(
        "--tickers",
        default="",
        help="Comma-separated tickers to update. Default: all tickers from trades.json",
    )
    parser.add_argument(
        "--start",
        default="2015-01-01",
        help="Start date for new files or --full mode (YYYY-MM-DD). Default: 2015-01-01",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Ignore existing last date and refetch from --start for selected tickers.",
    )
    parser.add_argument(
        "--sleep-ms",
        type=int,
        default=150,
        help="Delay between tickers in milliseconds. Default: 150",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    explicit = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    tickers = sorted(set(explicit)) if explicit else load_tickers_from_trades()
    if not tickers:
        log("No tickers found to update.")
        return

    canadian_tickers, overrides = parse_config_symbols()
    PRICES_DIR.mkdir(parents=True, exist_ok=True)

    log(f"Updating {len(tickers)} tickers...")
    updated = 0

    for ticker in tickers:
        symbol = resolve_symbol(ticker, canadian_tickers, overrides)
        path = PRICES_DIR / f"{ticker}.json"
        existing = load_price_rows(path)

        if args.full or not existing:
            start_date = args.start
        else:
            last_date = existing[-1][0]
            start_date = (parse_date(last_date) - timedelta(days=7)).strftime("%Y-%m-%d")

        log(f"{ticker}: {symbol} from {start_date}")

        try:
            new_rows = fetch_rows(symbol, start_date)
        except Exception as e:
            log(f"{ticker}: error ({e})")
            time.sleep(max(args.sleep_ms, 0) / 1000.0)
            continue

        if not new_rows:
            log(f"{ticker}: no data returned")
            time.sleep(max(args.sleep_ms, 0) / 1000.0)
            continue

        merged = merge_rows(existing, new_rows)
        if merged != existing:
            write_price_rows(path, merged)
            updated += 1
            log(f"{ticker}: updated ({len(merged)} rows)")
        else:
            log(f"{ticker}: unchanged")

        time.sleep(max(args.sleep_ms, 0) / 1000.0)

    log(f"Done. Updated {updated}/{len(tickers)} tickers.")


if __name__ == "__main__":
    main()
