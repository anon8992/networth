"""
Parse chequing CSV statements and output spending to data/spending/spending.json.

Keeps rows where `transaction` starts with "SPEND" (ex: SPEND, SPEND_REFUND).
Output fields: date, transaction, description, amount
"""

import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHEQUING_DIR = ROOT / "csvs" / "chequing"
OUT_DIR = ROOT / "data" / "spending"
OUT_FILE = OUT_DIR / "spending.json"


def parse_amount(text: str):
    try:
        return float((text or "").strip().strip('"').replace(",", ""))
    except ValueError:
        return None


def iter_spending_rows(path: Path):
    with path.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            transaction = (row.get("transaction") or "").strip().strip('"')
            if not transaction.startswith("SPEND"):
                continue

            date = (row.get("date") or "").strip().strip('"')
            description = (row.get("description") or "").strip().strip('"')
            amount = parse_amount(row.get("amount") or "")
            if not date or amount is None:
                continue

            yield {
                "date": date,
                "transaction": transaction,
                "description": description,
                "amount": amount,
            }


def main():
    if not CHEQUING_DIR.exists():
        raise SystemExit(f"Missing folder: {CHEQUING_DIR}")

    rows = []
    for path in sorted(CHEQUING_DIR.glob("*.csv")):
        rows.extend(iter_spending_rows(path))

    rows.sort(key=lambda r: (r["date"], r["transaction"], r["description"]))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_FILE.open("w", encoding="utf-8") as f:
        f.write("[\n")
        for i, row in enumerate(rows):
            comma = "," if i < len(rows) - 1 else ""
            f.write(f"  {json.dumps(row)}{comma}\n")
        f.write("]\n")

    print(f"Wrote {len(rows)} rows to {OUT_FILE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

