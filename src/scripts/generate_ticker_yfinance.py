import argparse
import re
from pathlib import Path

import yfinance as yf


def load_alpha_vantage_tickers():
    config_path = Path(__file__).resolve().parents[1] / "config.js"
    try:
        text = config_path.read_text(encoding="utf-8")
    except Exception as e:
        print(f"Could not read {config_path}: {e}")
        return []

    match = re.search(r"useAlphaVantageTickers\s*=\s*\[(.*?)\];", text, re.S)
    if not match:
        return []

    return [t.strip().upper() for t in re.findall(r"'([^']+)'", match.group(1))]


def fetch_and_save_clean_json(
    ticker, start_date="2019-02-01", symbol_override=None, assume_nyse=False
):
    if symbol_override:
        symbol = symbol_override.strip()
    else:
        symbol = ticker if assume_nyse else f"{ticker}.TO"
    print(f"Fetching data from {start_date} for {symbol}...")

    yf_ticker = yf.Ticker(symbol)
    history = yf_ticker.history(start=start_date)

    if history.empty:
        print(f"No data found for {symbol}")
        return False

    folder_path = Path("data") / "stockPriceHistory"
    folder_path.mkdir(parents=True, exist_ok=True)

    filename = f"{ticker}.json"
    full_path = folder_path / filename

    lines = []
    for date, row in history.iterrows():
        date_str = date.strftime("%Y-%m-%d")
        price = round(float(row["Close"]), 2)
        lines.append(f'  ["{date_str}",{price}]')

    json_output = "[\n" + ",\n".join(lines) + "\n]\n"
    full_path.write_text(json_output, encoding="utf-8")

    print(f"Saved as: {filename}")
    print(f"Location: {full_path}")
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Fetch ticker history from Yahoo Finance and save JSON files."
    )
    parser.add_argument("tickers", nargs="*", help="Ticker symbols (without .TO suffix)")
    parser.add_argument(
        "--all-alpha",
        action="store_true",
        help="Use useAlphaVantageTickers from src/config.js",
    )
    parser.add_argument(
        "--start",
        default="2019-02-01",
        help="Start date in YYYY-MM-DD (default: 2019-02-01)",
    )
    parser.add_argument(
        "--alias",
        action="append",
        default=[],
        help="Override Yahoo symbol while keeping output filename. Format: OUT=YAHOO (repeatable)",
    )
    parser.add_argument(
        "--assume-nyse",
        action="store_true",
        help="For tickers without --alias, use raw symbol (e.g. AMZN) instead of appending .TO",
    )
    args = parser.parse_args()

    tickers = [t.strip().upper() for t in args.tickers if t.strip()]
    if args.all_alpha:
        tickers.extend(load_alpha_vantage_tickers())

    alias_by_ticker = {}
    for raw in args.alias:
        if "=" not in raw:
            print(f"Ignoring invalid --alias '{raw}' (expected OUT=YAHOO)")
            continue
        left, right = raw.split("=", 1)
        out_ticker = left.strip().upper()
        yahoo_symbol = right.strip()
        if not out_ticker or not yahoo_symbol:
            print(f"Ignoring invalid --alias '{raw}' (expected OUT=YAHOO)")
            continue
        alias_by_ticker[out_ticker] = yahoo_symbol

    # Preserve order while removing duplicates.
    seen = set()
    ordered_tickers = []
    for ticker in tickers:
        if ticker not in seen:
            seen.add(ticker)
            ordered_tickers.append(ticker)

    if not ordered_tickers:
        print("No tickers provided. Example:")
        print("  .venv/bin/python src/scripts/generate_ticker_yfinance.py --all-alpha")
        print("  .venv/bin/python src/scripts/generate_ticker_yfinance.py XBAL VFV CASH")
        return

    success = 0
    for ticker in ordered_tickers:
        symbol_override = alias_by_ticker.get(ticker)
        if fetch_and_save_clean_json(
            ticker,
            start_date=args.start,
            symbol_override=symbol_override,
            assume_nyse=args.assume_nyse,
        ):
            success += 1

    print(f"\nDone: {success}/{len(ordered_tickers)} tickers saved.")


if __name__ == "__main__":
    main()
