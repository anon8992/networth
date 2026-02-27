import csv
import json
import re
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSVS_DIR = ROOT / "csvs"
OUT_FILE = ROOT / "data" / "trades.json"
CONFIG_FILE = ROOT / "src" / "config.js"
RBC_DIR = CSVS_DIR / "rbc"

MONTH_TO_NUMBER = {
    "JAN": 1,
    "FEB": 2,
    "MAR": 3,
    "APR": 4,
    "MAY": 5,
    "JUN": 6,
    "JUL": 7,
    "AUG": 8,
    "SEP": 9,
    "OCT": 10,
    "NOV": 11,
    "DEC": 12,
}

RBC_ACTIVITY_START_RE = re.compile(
    r"(?:^|\b)"
    r"(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|"
    r"JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|"
    r"OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)"
    r"\.?\s*(\d{1,2})\s+([A-Z]+)\b\s*(.*)$"
)
RBC_AMOUNT_LINE_RE = re.compile(
    r"^([0-9][0-9,]*(?:\.\d+)?-?)\s+([0-9][0-9,]*(?:\.\d+)?-?)\s+([0-9][0-9,]*(?:\.\d+)?-?)$"
)
RBC_INLINE_AMOUNT_RE = re.compile(
    r"^(.*?)\s+([0-9][0-9,]*(?:\.\d+)?-?)\s+([0-9][0-9,]*(?:\.\d+)?-?)\s+([0-9][0-9,]*(?:\.\d+)?-?)$"
)
RBC_ASSET_LINE_RE = re.compile(
    r"^(.*?)\s+([A-Z][A-Z0-9.\-]{1,12})\s+"
    r"([0-9][0-9,]*(?:\.\d+)?)\s+"
    r"([0-9][0-9,]*(?:\.\d+)?)\s+"
    r"([0-9][0-9,]*(?:\.\d+)?)\s+\$([0-9][0-9,]*(?:\.\d+)?)$"
)
RBC_FX_RE = re.compile(r"Exchange rate 1USD = ([0-9.]+) CAD")

RBC_IGNORE_DESCRIPTION_LINE_RE = re.compile(
    r"^(UNSOLICITED|INTERCLASSSWITCHIN|INTERCLASSSWITCHOUT|ASOF|"
    r"AVG PRICE SHOWN|WE ACTED AS PRINCIPAL|THESEARESECURITIES|RELATEDISSUER|"
    r"REC[0-9/]+PAY[0-9/]+|REC [0-9/]+ PAY [0-9/]+|STCG|REINV|REINV@|DIST ON|CASHDIV ON|"
    r"CASH DIV ON|PREMIUMDISTON|PREMIUM DIST ON|DA|CA)$"
)


def get_wealthsimple_trade_src():
    """Read wealthsimpleTradeDataSrc from config.js"""
    if CONFIG_FILE.exists():
        text = CONFIG_FILE.read_text()
        match = re.search(r"const\s+wealthsimpleTradeDataSrc\s*=\s*['\"]([^'\"]+)['\"]", text)
        if match:
            return match.group(1)
    return "activities_export"  # default

def normalize_ticker_symbol(ticker: str):
    t = (ticker or "").strip().upper()
    if t == "GOOGL":
        return "GOOG"
    if t == "BRKB":
        return "BRK-B"
    return t

# Regex for parsing old WealthSimple description format
# e.g. "TMF - Direxion Daily...: Bought 3.0000 shares (executed at 2022-12-29)"
OLD_WS_RE = re.compile(
    r"^(?P<ticker>[A-Za-z0-9.\-]+)\s*-.*?:\s*(?P<verb>Bought|Sold)\s+(?P<qty>[0-9.]+)\s+shares?"
    r"(?:.*?\(executed at (?P<date>\d{4}-\d{2}-\d{2})\))?",
    re.IGNORECASE,
)

def parse_nbdb(path: Path):
    """National Bank - semicolon delimited, DD/MM/YYYY dates."""
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f, delimiter=";"):
            op = row.get("Operation", "").strip().strip('"')
            if op not in ("Buy", "Sell"):
                continue
            try:
                date = datetime.strptime(row["Trade date"].strip('"'), "%d/%m/%Y").strftime("%Y-%m-%d")
            except (ValueError, KeyError):
                continue
            ticker = row.get("Symbol", "").strip().strip('"')
            ticker = normalize_ticker_symbol(ticker)
            amount = row.get("Net amount", "").strip().strip('"').replace(",", "")
            if not (ticker and amount):
                continue

            # NBDB exports sometimes include USD trades without converting to CAD.
            # If we can detect USD, convert to CAD with a simple placeholder FX rate.
            fx_rate = 1.35
            currency = (row.get("Currency") or row.get("currency") or "").strip().strip('"').upper()
            market = (row.get("Market") or "").strip().strip('"').upper()
            account_desc = (row.get("Account description") or "").strip().strip('"').upper()
            is_usd = currency == "USD" or market == "USA" or "USD" in account_desc

            net_amount = abs(float(amount))
            if is_usd:
                net_amount *= fx_rate

            yield (date, op.upper(), ticker, net_amount)


def parse_wealthsimple_activities(path: Path):
    """WealthSimple activities export - comma delimited, YYYY-MM-DD dates."""
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if (row.get("activity_type") or "").strip() != "Trade":
                continue
            side = (row.get("activity_sub_type") or "").strip().upper()
            if side not in ("BUY", "SELL"):
                continue
            date = (row.get("transaction_date") or "").strip()
            ticker = (row.get("symbol") or "").strip()
            ticker = normalize_ticker_symbol(ticker)
            amount = (row.get("net_cash_amount") or "").strip()
            if date and ticker and amount:
                yield (date, side, ticker, abs(float(amount)))


# NOTE: Not currently used - kept for reference if needed for monthly_statements
def parse_wealthsimple_monthly(path: Path):
    """WealthSimple monthly statements - needs regex to extract ticker/side from description."""
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            tx = row.get("transaction", "").strip().strip('"').upper()
            if tx not in ("BUY", "SELL"):
                continue
            desc = row.get("description", "").strip().strip('"')
            m = OLD_WS_RE.match(desc)
            if not m:
                continue
            fallback_date = row.get("date", "").strip().strip('"')
            date = m.group("date") or fallback_date
            ticker = m.group("ticker").upper()
            ticker = normalize_ticker_symbol(ticker)
            amount = row.get("amount", "").strip().strip('"')
            if date and ticker and amount:
                yield (date, tx, ticker, abs(float(amount)))

def parse_wealthsimple_from_available_sources(configured_src: str):
    """
    Parse Wealthsimple trades from configured source, with folder fallbacks.
    The mom dataset uses monthly-statements-2017-01-to-2026-02.
    """
    ws_root = CSVS_DIR / "wealthsimple"
    if not ws_root.exists():
        print("WealthSimple folder missing: csvs/wealthsimple")
        return [], []

    source_specs = {
        "activities_export": ("activities_export", parse_wealthsimple_activities),
        "monthly_csvs": ("monthly_csvs", parse_wealthsimple_monthly),
        "monthly-statements-2017-01-to-2026-02": (
            "monthly-statements-2017-01-to-2026-02",
            parse_wealthsimple_monthly,
        ),
    }

    parse_order = []
    if configured_src in source_specs:
        parse_order.append(configured_src)
    for key in source_specs:
        if key != configured_src:
            parse_order.append(key)

    parsed = []
    used_sources = []

    for key in parse_order:
        rel_path, parser_fn = source_specs[key]
        src_dir = ws_root / rel_path
        if not src_dir.exists():
            continue

        files = sorted(src_dir.glob("*.csv"))
        if not files:
            continue

        used_sources.append(rel_path)
        for path in files:
            parsed.extend(parser_fn(path))

        # Keep behavior intuitive: if configured source has data, stop there.
        if key == configured_src:
            break

        # Fallback source found; use it and stop so we don't accidentally
        # merge overlapping exports from multiple WS folders.
        if key != configured_src:
            break

    return parsed, used_sources

def normalize_space(text: str) -> str:
    return " ".join((text or "").strip().split())

def compact_key(text: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "", (text or "").upper())

def token_key_set(text: str):
    return set(re.findall(r"[A-Z0-9]+", (text or "").upper()))

def parse_number(text: str):
    try:
        cleaned = (text or "").replace("$", "").replace(",", "").strip()
        # RBC sometimes uses trailing-minus accounting style (e.g., 3,170.85-).
        if cleaned.endswith("-"):
            cleaned = f"-{cleaned[:-1]}"
        return float(cleaned)
    except ValueError:
        return None

def month_token_to_number(token: str):
    token = (token or "").upper().rstrip(".")
    if token.startswith("SEPT"):
        token = "SEP"
    else:
        token = token[:3]
    return MONTH_TO_NUMBER.get(token)

def list_rbc_statement_pdfs():
    if not RBC_DIR.exists():
        return []

    files = sorted(RBC_DIR.glob("*.pdf"))
    selected = []
    for path in files:
        # Skip duplicate file copies like "...-1.pdf" when the base PDF exists.
        m = re.match(r"^(.*)-\d+\.pdf$", path.name)
        if m:
            base = RBC_DIR / f"{m.group(1)}.pdf"
            if base.exists():
                continue
        selected.append(path)
    return selected

def extract_pdf_pages_with_swift(pdf_paths):
    if not pdf_paths:
        return {}

    swift_source = """
import Foundation
import PDFKit

struct Row: Encodable {
    let file: String
    let pages: [String]
}

let encoder = JSONEncoder()
for filePath in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: filePath)
    guard let doc = PDFDocument(url: url) else { continue }
    var pages: [String] = []
    pages.reserveCapacity(doc.pageCount)
    for i in 0..<doc.pageCount {
        pages.append(doc.page(at: i)?.string ?? "")
    }
    let row = Row(file: filePath, pages: pages)
    if let data = try? encoder.encode(row), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}
"""

    module_cache = Path("/tmp/folioscout-swift-module-cache")
    module_cache.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile("w", suffix=".swift", delete=False) as f:
        f.write(swift_source)
        swift_path = Path(f.name)

    abs_paths = [str(p.resolve()) for p in pdf_paths]
    cmd = ["swift", "-module-cache-path", str(module_cache), str(swift_path), *abs_paths]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    finally:
        try:
            swift_path.unlink()
        except FileNotFoundError:
            pass

    if res.returncode != 0:
        raise RuntimeError(
            "Failed to extract RBC PDF text with Swift/PDFKit.\n"
            f"Command: {' '.join(cmd[:4])} ...\n"
            f"stderr: {res.stderr.strip()[:600]}"
        )

    pages_by_file = {}
    for line in res.stdout.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        file_key = str(Path(row.get("file", "")).resolve())
        pages = row.get("pages")
        if file_key and isinstance(pages, list):
            pages_by_file[file_key] = pages

    return pages_by_file

def extract_statement_year_month(path: Path):
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", path.name)
    if not m:
        return None, None, None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))

def statement_usd_to_cad_rate(pages):
    for page in pages:
        m = RBC_FX_RE.search(page)
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                continue
    return 1.35

def collect_rbc_asset_aliases(pages, compact_to_symbol, code_to_symbol):
    for page in pages:
        lines = [normalize_space(line) for line in page.splitlines()]
        in_asset_review = False
        for line in lines:
            if not line:
                continue
            if "Asset Review" in line:
                in_asset_review = True
                continue
            if in_asset_review and "Account Activity" in line:
                in_asset_review = False
                continue
            if not in_asset_review:
                continue

            m = RBC_ASSET_LINE_RE.match(line)
            if not m:
                continue

            desc = normalize_space(m.group(1))
            symbol = m.group(2).upper()
            symbol = normalize_ticker_symbol(symbol)

            key = compact_key(desc)
            if key:
                compact_to_symbol.setdefault(key, symbol)

            code_match = re.search(r"\((\d{3,5})\)", desc)
            if code_match:
                code_to_symbol.setdefault(code_match.group(1), symbol)
            if symbol.startswith("RBF") and symbol[3:].isdigit():
                code_to_symbol.setdefault(symbol[3:], symbol)
            if symbol.startswith("FID") and symbol[3:].isdigit():
                code_to_symbol.setdefault(symbol[3:], symbol)

def resolve_rbc_symbol(desc_text, compact_to_symbol, code_to_symbol):
    desc_text = normalize_space(desc_text)
    if not desc_text:
        return None

    upper_desc = desc_text.upper()
    compact_desc = compact_key(upper_desc)

    for match in re.findall(r"\((\d{3,5})\)", upper_desc):
        if match in code_to_symbol:
            return code_to_symbol[match]
    for match in re.findall(r"(?<!\d)(\d{3,5})(?!\d)", upper_desc):
        if match in code_to_symbol:
            return code_to_symbol[match]

    if compact_desc in compact_to_symbol:
        return compact_to_symbol[compact_desc]

    candidates = []
    desc_tokens = token_key_set(desc_text)
    for key, symbol in compact_to_symbol.items():
        if not key:
            continue
        if compact_desc and (compact_desc in key or key in compact_desc):
            score = min(len(key), len(compact_desc))
            candidates.append((score, symbol))
            continue

        key_tokens = token_key_set(key)
        overlap = len(desc_tokens & key_tokens)
        if overlap >= 2:
            score = overlap * 100 + min(len(key), len(compact_desc))
            candidates.append((score, symbol))

    if not candidates:
        # Last-resort symbol inference for common mutual-fund codes.
        m_rbc = re.search(r"\((\d{3,5})\)", upper_desc)
        if m_rbc and "RBC" in upper_desc:
            return f"RBF{m_rbc.group(1)}"
        if m_rbc and "FIDELITY" in upper_desc:
            return f"FID{m_rbc.group(1)}"
        return None

    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]

def parse_rbc_statement_trades(path: Path, pages, compact_to_symbol, code_to_symbol):
    statement_year, statement_month, _ = extract_statement_year_month(path)
    if statement_year is None:
        return []

    usd_to_cad = statement_usd_to_cad_rate(pages)
    trades = []
    unresolved = []

    current = None
    in_activity = False

    def flush_current():
        nonlocal current
        if not current:
            return

        amount = current.get("amount")
        if amount is None:
            current = None
            return

        desc_text = normalize_space(" ".join(current.get("desc_parts", [])))
        symbol = resolve_rbc_symbol(desc_text, compact_to_symbol, code_to_symbol)
        if not symbol:
            unresolved.append((current.get("date"), current.get("side"), desc_text, amount))
            current = None
            return

        trade_amount = amount
        if current.get("currency") == "USD":
            trade_amount = trade_amount * usd_to_cad

        trades.append((current["date"], current["side"], symbol, abs(trade_amount)))
        current = None

    for page in pages:
        page_currency = "USD" if "Statement (U.S.$)" in page else "CAD"
        lines = [normalize_space(line) for line in page.splitlines()]

        for line in lines:
            if not line:
                continue

            if "FOOTNOTES" in line:
                flush_current()
                in_activity = False
                continue

            if "Account Activity" in line:
                flush_current()
                in_activity = True
                continue

            if not in_activity:
                continue

            if line.startswith("Closing Balance"):
                flush_current()
                in_activity = False
                continue

            m_activity = RBC_ACTIVITY_START_RE.match(line)
            if not m_activity:
                m_activity = RBC_ACTIVITY_START_RE.search(line)
            if m_activity:
                mon, day_text, activity, rest = m_activity.groups()
                activity = activity.upper()
                if activity not in ("BOUGHT", "SOLD"):
                    # Once we have a complete trade row (amount captured),
                    # any subsequent dated activity means this trade ended.
                    if current and current.get("amount") is not None:
                        flush_current()
                    current = None
                    continue

                flush_current()

                day = int(day_text)
                month_num = month_token_to_number(mon)
                if not month_num:
                    current = None
                    continue

                year = statement_year
                # Handle statements in January that may include late-December activity.
                if statement_month == 1 and month_num == 12:
                    year -= 1

                side = "BUY" if activity == "BOUGHT" else "SELL"
                amount = None
                desc = normalize_space(rest)
                m_inline = RBC_INLINE_AMOUNT_RE.match(desc)
                if m_inline:
                    desc = normalize_space(m_inline.group(1))
                    amount = parse_number(m_inline.group(4))

                iso_date = f"{year:04d}-{month_num:02d}-{day:02d}"
                current = {
                    "date": iso_date,
                    "side": side,
                    "currency": page_currency,
                    "desc_parts": [desc] if desc else [],
                    "amount": amount,
                }
                continue

            if (
                line.startswith("Opening Balance")
                or line == "PRICE"
                or line == "DATE ACTIVITY DESCRIPTION"
                or line == "QUANTITY \\RATE DEBIT CREDIT"
            ):
                continue

            if not current:
                continue

            m_amt = RBC_AMOUNT_LINE_RE.match(line)
            if m_amt and current.get("amount") is None:
                current["amount"] = parse_number(m_amt.group(3))
                continue

            m_inline = RBC_INLINE_AMOUNT_RE.match(line)
            if m_inline and current.get("amount") is None:
                desc_line = normalize_space(m_inline.group(1))
                if desc_line:
                    current["desc_parts"].append(desc_line)
                current["amount"] = parse_number(m_inline.group(4))
                continue

            if RBC_IGNORE_DESCRIPTION_LINE_RE.match(line.upper()):
                continue

            current["desc_parts"].append(line)

    flush_current()

    if unresolved:
        print(f"RBC unresolved symbols in {path.name}: {len(unresolved)}")

    return trades

def parse_rbc():
    pdf_paths = list_rbc_statement_pdfs()
    if not pdf_paths:
        return []

    try:
        pages_by_file = extract_pdf_pages_with_swift(pdf_paths)
    except Exception as e:
        print(f"Failed to parse RBC PDFs: {e}")
        return []

    compact_to_symbol = {}
    code_to_symbol = {}

    # Build symbol aliases first so trade rows can resolve sold-out positions later.
    for path in pdf_paths:
        pages = pages_by_file.get(str(path.resolve()))
        if not pages:
            continue
        collect_rbc_asset_aliases(pages, compact_to_symbol, code_to_symbol)

    trades = []
    for path in pdf_paths:
        pages = pages_by_file.get(str(path.resolve()))
        if not pages:
            continue
        trades.extend(parse_rbc_statement_trades(path, pages, compact_to_symbol, code_to_symbol))

    print(f"Parsed RBC statements: {len(pdf_paths)} files")
    print(f"Parsed RBC trades: {len(trades)}")
    return trades


def main():
    trades = []

    for path in (CSVS_DIR / "nbdb").glob("*.csv"):
        trades.extend(parse_nbdb(path))

    ws_src = get_wealthsimple_trade_src()
    ws_trades, ws_used_sources = parse_wealthsimple_from_available_sources(ws_src)
    trades.extend(ws_trades)
    if ws_used_sources:
        print(f"Using WealthSimple source: {ws_used_sources[0]}")
    else:
        print(f"Using WealthSimple source: {ws_src} (no files found)")
    print(f"Parsed WealthSimple trades: {len(ws_trades)}")

    trades.extend(parse_rbc())

    trades.sort(key=lambda t: t[0])  # sort by date

    # Convert tuples to dicts for JSON
    trades_json = [
        {"date": t[0], "side": t[1], "ticker": normalize_ticker_symbol(t[2]), "amount": t[3]}
        for t in trades
    ]

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUT_FILE.open("w", encoding="utf-8") as f:
        f.write("[\n")
        for i, trade in enumerate(trades_json):
            comma = "," if i < len(trades_json) - 1 else ""
            f.write(f"  {json.dumps(trade)}{comma}\n")
        f.write("]\n")

    print(f"Wrote {len(trades)} trades to {OUT_FILE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
