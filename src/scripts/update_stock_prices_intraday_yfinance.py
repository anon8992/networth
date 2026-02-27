#!/usr/bin/env python3
"""
Update intraday stock price history JSON files with yfinance (no API keys).

Outputs (rolling windows):
- data/stockPriceHistory/quarterhourly/{TICKER}.json  -> 15m bars, last 1 day
- data/stockPriceHistory/semihourly/{TICKER}.json    -> 30m bars, last 7 days
- data/stockPriceHistory/hourly/{TICKER}.json        -> 60m bars, last 30 days
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yfinance as yf


ROOT = Path(__file__).resolve().parents[2]
TRADES_FILE = ROOT / "data" / "trades.json"
PRICES_DIR = ROOT / "data" / "stockPriceHistory"
CONFIG_FILE = ROOT / "src" / "config.js"


@dataclass(frozen=True)
class IntervalConfig:
    folder: str
    interval: str
    lookback_days: int
    period: str


INTERVALS: tuple[IntervalConfig, ...] = (
    IntervalConfig(folder="quarterhourly", interval="15m", lookback_days=1, period="5d"),
    IntervalConfig(folder="semihourly", interval="30m", lookback_days=7, period="1mo"),
    IntervalConfig(folder="hourly", interval="60m", lookback_days=30, period="3mo"),
)


def log(msg: str) -> None:
    print(f"[updateIntradayYF] {msg}")


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


def read_rows(path: Path) -> dict[str, float]:
    data = load_json(path)
    out: dict[str, float] = {}
    if not isinstance(data, list):
        return out
    for row in data:
        if not (isinstance(row, list) and len(row) >= 2):
            continue
        ts = row[0]
        px = row[1]
        if isinstance(ts, str) and isinstance(px, (int, float)) and math.isfinite(px):
            out[ts] = float(px)
    return out


def write_rows(path: Path, rows: dict[str, float]) -> None:
    items = sorted(rows.items(), key=lambda x: x[0])
    lines = ["["]
    for i, (ts, px) in enumerate(items):
        comma = "," if i < len(items) - 1 else ""
        lines.append(f'  ["{ts}",{px}]{comma}')
    lines.append("]")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def fetch_intraday_rows(symbol: str, interval: str, period: str) -> dict[str, float]:
    history = yf.Ticker(symbol).history(period=period, interval=interval, auto_adjust=True, prepost=False)
    if history.empty:
        return {}

    out: dict[str, float] = {}
    for ts, row in history.iterrows():
        close = row.get("Close")
        if close is None:
            continue
        px = float(close)
        if not math.isfinite(px):
            continue

        dt = ts.to_pydatetime()
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt_utc = dt.astimezone(timezone.utc).replace(microsecond=0)
        key = dt_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
        out[key] = round(px, 4)
    return out


def trim_rows(rows: dict[str, float], lookback_days: int) -> dict[str, float]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    out: dict[str, float] = {}
    for ts, px in rows.items():
        try:
            dt = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if dt >= cutoff:
            out[ts] = px
    return out


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update intraday stock prices with yfinance.")
    parser.add_argument(
        "--tickers",
        default="",
        help="Comma-separated tickers to update. Default: all tickers from trades.json",
    )
    parser.add_argument(
        "--sleep-ms",
        type=int,
        default=150,
        help="Delay between ticker requests in milliseconds. Default: 150",
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

    for cfg in INTERVALS:
        (PRICES_DIR / cfg.folder).mkdir(parents=True, exist_ok=True)

    log(f"Updating {len(tickers)} tickers...")
    updated_files = 0
    attempted_files = 0

    for ticker in tickers:
        symbol = resolve_symbol(ticker, canadian_tickers, overrides)
        log(f"{ticker}: {symbol}")

        for cfg in INTERVALS:
            attempted_files += 1
            target = PRICES_DIR / cfg.folder / f"{ticker}.json"
            existing = read_rows(target)
            fetched = fetch_intraday_rows(symbol, cfg.interval, cfg.period)
            if not fetched:
                log(f"  {cfg.folder}: no data returned")
                continue

            merged = dict(existing)
            merged.update(fetched)
            trimmed = trim_rows(merged, cfg.lookback_days)

            if not trimmed:
                log(f"  {cfg.folder}: empty after trim")
                continue

            if trimmed != existing:
                write_rows(target, trimmed)
                updated_files += 1
                log(f"  {cfg.folder}: updated ({len(trimmed)} rows)")
            else:
                log(f"  {cfg.folder}: unchanged")

        time.sleep(max(args.sleep_ms, 0) / 1000.0)

    log(f"Done. Updated {updated_files}/{attempted_files} files.")


if __name__ == "__main__":
    main()
