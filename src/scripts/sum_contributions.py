import csv
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


def find_repo_root(start: Path) -> Path:
    """
    Resolve the project root so this script can be run from anywhere.
    Prefer `package.json` as the anchor (repo contains it).
    """
    start = start.resolve()
    for candidate in (start, *start.parents):
        if (candidate / "package.json").exists():
            return candidate
    return start.parents[2]


ROOT = find_repo_root(Path(__file__))
NBDB_DIR = ROOT / "csvs" / "nbdb"
NEWWS_DIR = ROOT / "csvs" / "newwsacc"
WEALTHSIMPLE_DIR = ROOT / "csvs" / "wealthsimple" / "monthly_csvs"
NETWORTH_FILE = ROOT / "data" / "networth.json"
OUT_CONTRIBS_FILE = ROOT / "data" / "calculatedContributions.json"

FX_RATE = 1.35  # USD -> CAD placeholder
START_DATE = "2022-08-18"


@dataclass
class Totals:
    contributions: float = 0.0
    withdrawals: float = 0.0
    rows: int = 0

    @property
    def net(self) -> float:
        return self.contributions - self.withdrawals


def parse_float(text: str):
    try:
        return float((text or "").strip().strip('"').replace(",", ""))
    except ValueError:
        return None


def as_cad(amount: float, is_usd: bool) -> float:
    return amount * FX_RATE if is_usd else amount


def sum_nbdb() -> Totals:
    totals = Totals()
    for path in sorted(NBDB_DIR.glob("*.csv")):
        with path.open(encoding="utf-8") as f:
            reader = csv.DictReader(f, delimiter=";")
            for row in reader:
                op = (row.get("Operation") or "").strip().strip('"')
                if op not in ("Contribution", "Withdrawal"):
                    continue

                amount = parse_float(row.get("Net amount") or "")
                if amount is None:
                    continue

                market = (row.get("Market") or "").strip().strip('"').upper()
                account_desc = (row.get("Account description") or "").strip().strip('"').upper()
                currency = (row.get("Currency") or row.get("currency") or "").strip().strip('"').upper()
                is_usd = currency == "USD" or market == "USA" or "USD" in account_desc

                cad = as_cad(abs(amount), is_usd)
                if op == "Contribution":
                    totals.contributions += cad
                else:
                    totals.withdrawals += cad
                totals.rows += 1

    return totals


def sum_newwsacc() -> Totals:
    totals = Totals()
    in_types = {"CONT", "TRFIN"}
    out_types = {"TRFOUT"}

    for path in sorted(NEWWS_DIR.glob("*.csv")):
        with path.open(encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                tx = (row.get("transaction") or "").strip().strip('"').upper()
                if tx not in in_types and tx not in out_types:
                    continue

                amount = parse_float(row.get("amount") or "")
                if amount is None:
                    continue

                currency = (row.get("currency") or "").strip().strip('"').upper()
                is_usd = currency == "USD"
                cad = as_cad(abs(amount), is_usd)

                if tx in in_types:
                    totals.contributions += cad
                else:
                    totals.withdrawals += cad
                totals.rows += 1

    return totals


def sum_oldwsacc() -> Totals:
    totals = Totals()
    in_types = {"CONT", "TRFIN"}
    out_types = {"TRFOUT", "WD"}

    for path in sorted(WEALTHSIMPLE_DIR.glob("*.csv")):
        with path.open(encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                tx = (row.get("transaction") or "").strip().strip('"').upper()
                if tx not in in_types and tx not in out_types:
                    continue

                amount = parse_float(row.get("amount") or "")
                if amount is None:
                    continue

                currency = (row.get("currency") or "").strip().strip('"').upper()
                is_usd = currency == "USD"
                cad = as_cad(abs(amount), is_usd)

                if tx in in_types:
                    totals.contributions += cad
                else:
                    totals.withdrawals += cad
                totals.rows += 1

    return totals


def iter_cashflows_by_date():
    """
    Return a dict: YYYY-MM-DD -> net cashflow (CAD)
    (contributions positive, withdrawals negative)
    """
    cashflow = {}

    for path in sorted(NBDB_DIR.glob("*.csv")):
        with path.open(encoding="utf-8") as f:
            reader = csv.DictReader(f, delimiter=";")
            for row in reader:
                op = (row.get("Operation") or "").strip().strip('"')
                if op not in ("Contribution", "Withdrawal"):
                    continue

                date_text = (row.get("Trade date") or "").strip().strip('"')
                try:
                    date = datetime.strptime(date_text, "%d/%m/%Y").strftime("%Y-%m-%d")
                except ValueError:
                    continue

                amount = parse_float(row.get("Net amount") or "")
                if amount is None:
                    continue

                market = (row.get("Market") or "").strip().strip('"').upper()
                account_desc = (row.get("Account description") or "").strip().strip('"').upper()
                currency = (row.get("Currency") or row.get("currency") or "").strip().strip('"').upper()
                is_usd = currency == "USD" or market == "USA" or "USD" in account_desc

                cad = as_cad(abs(amount), is_usd)
                delta = cad if op == "Contribution" else -cad
                cashflow[date] = cashflow.get(date, 0.0) + delta

    in_types = {"CONT", "TRFIN"}
    out_types = {"TRFOUT"}

    for path in sorted(NEWWS_DIR.glob("*.csv")):
        with path.open(encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                tx = (row.get("transaction") or "").strip().strip('"').upper()
                if tx not in in_types and tx not in out_types:
                    continue

                date = (row.get("date") or "").strip().strip('"')
                if not date:
                    continue

                amount = parse_float(row.get("amount") or "")
                if amount is None:
                    continue

                currency = (row.get("currency") or "").strip().strip('"').upper()
                is_usd = currency == "USD"
                cad = as_cad(abs(amount), is_usd)

                delta = cad if tx in in_types else -cad
                cashflow[date] = cashflow.get(date, 0.0) + delta

    in_types = {"CONT", "TRFIN"}
    out_types = {"TRFOUT", "WD"}

    for path in sorted(WEALTHSIMPLE_DIR.glob("*.csv")):
        with path.open(encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                tx = (row.get("transaction") or "").strip().strip('"').upper()
                if tx not in in_types and tx not in out_types:
                    continue

                date = (row.get("date") or "").strip().strip('"')
                if not date:
                    continue

                amount = parse_float(row.get("amount") or "")
                if amount is None:
                    continue

                currency = (row.get("currency") or "").strip().strip('"').upper()
                is_usd = currency == "USD"
                cad = as_cad(abs(amount), is_usd)

                delta = cad if tx in in_types else -cad
                cashflow[date] = cashflow.get(date, 0.0) + delta

    return cashflow


def load_networth_dates():
    data = json.loads(NETWORTH_FILE.read_text("utf-8"))
    return [row[0] for row in data if row and row[0] >= START_DATE]


def write_calculated_contributions():
    if not NETWORTH_FILE.exists():
        raise SystemExit(f"Missing file: {NETWORTH_FILE}")

    dates = load_networth_dates()
    cashflow = iter_cashflows_by_date()

    running = 0.0
    out = []
    for date in dates:
        running += cashflow.get(date, 0.0)
        out.append([date, round(running, 2)])

    OUT_CONTRIBS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUT_CONTRIBS_FILE.open("w", encoding="utf-8") as f:
        f.write("[\n")
        for i, row in enumerate(out):
            comma = "," if i < len(out) - 1 else ""
            f.write(f"  {json.dumps(row, separators=(',', ':'))}{comma}\n")
        f.write("]\n")
    print(f"Wrote {len(out)} rows to {OUT_CONTRIBS_FILE.relative_to(ROOT)}")


def money(n: float) -> str:
    return f"${n:,.2f}"


def main():
    if not NBDB_DIR.exists():
        raise SystemExit(f"Missing folder: {NBDB_DIR}")
    if not NEWWS_DIR.exists():
        raise SystemExit(f"Missing folder: {NEWWS_DIR}")
    if not WEALTHSIMPLE_DIR.exists():
        raise SystemExit(f"Missing folder: {WEALTHSIMPLE_DIR}")

    nbdb = sum_nbdb()
    newws = sum_newwsacc()
    oldws = sum_oldwsacc()

    total_contrib = nbdb.contributions + newws.contributions + oldws.contributions
    total_withdraw = nbdb.withdrawals + newws.withdrawals + oldws.withdrawals
    total_net = total_contrib - total_withdraw

    print("NBDB")
    print(f"  rows:         {nbdb.rows}")
    print(f"  contributions:{money(nbdb.contributions)}")
    print(f"  withdrawals:  {money(nbdb.withdrawals)}")
    print(f"  net:          {money(nbdb.net)}")

    print("New WS")
    print(f"  rows:         {newws.rows}")
    print(f"  contributions:{money(newws.contributions)}")
    print(f"  withdrawals:  {money(newws.withdrawals)}")
    print(f"  net:          {money(newws.net)}")

    print("Old WS")
    print(f"  rows:         {oldws.rows}")
    print(f"  contributions:{money(oldws.contributions)}")
    print(f"  withdrawals:  {money(oldws.withdrawals)}")
    print(f"  net:          {money(oldws.net)}")

    print("Total (CAD)")
    print(f"  contributions:{money(total_contrib)}")
    print(f"  withdrawals:  {money(total_withdraw)}")
    print(f"  net:          {money(total_net)}")

    write_calculated_contributions()


if __name__ == "__main__":
    main()
