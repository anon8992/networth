import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', '..');

const DATA_DIR = path.join(ROOT_DIR, 'data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
const CONTRIBUTIONS_FILE = path.join(DATA_DIR, 'contributions.json');
const STOCK_PRICE_DIR = path.join(DATA_DIR, 'stockPriceHistory');
const OUT_DIR = path.join(DATA_DIR, 'networthIntraday');

const INTERVAL_KEYS = ['fivemin', 'quarterhourly', 'semihourly', 'hourly'];

function log(msg) {
    console.log(`[updatePortfolioIntradayNW] ${msg}`);
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const tickersIndex = args.indexOf('--tickers');
    const tickersText = tickersIndex !== -1 ? args[tickersIndex + 1] : '';
    const tickers = tickersText
        ? tickersText.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
        : null;

    return { tickers };
}

async function readJson(filePath) {
    try {
        const text = await fs.readFile(filePath, 'utf8');
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function writeJsonRows(filePath, rows) {
    const lines = ['['];
    for (let i = 0; i < rows.length; i++) {
        const [ts, nw, c] = rows[i];
        const comma = i === rows.length - 1 ? '' : ',';
        lines.push(`  ["${ts}",${nw},${c}]${comma}`);
    }
    lines.push(']');
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');
}

function parseTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1e12 ? value : value * 1000;
    }

    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;

    if (/^\d+$/.test(text)) {
        const n = Number(text);
        if (!Number.isFinite(n)) return null;
        return n > 1e12 ? n : n * 1000;
    }

    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
}

function toDateStrUTC(epochMs) {
    const d = new Date(epochMs);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

function toIsoTimestampUTC(epochMs) {
    const d = new Date(epochMs);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString().replace('.000Z', 'Z');
}

function getTodayDateStrMountain() {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Denver',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());

    const values = {};
    for (const part of parts) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }

    return `${values.year}-${values.month}-${values.day}`;
}

function getDateStrMountain(epochMs) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Denver',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(epochMs);

    const values = {};
    for (const part of parts) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }

    return `${values.year}-${values.month}-${values.day}`;
}

function getMountainHourMinute(epochMs) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Denver',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(epochMs);

    const values = {};
    for (const part of parts) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }

    const hour = Number(values.hour);
    const minute = Number(values.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { hour, minute };
}

function isWithinNorthAmericaSession(epochMs) {
    const hm = getMountainHourMinute(epochMs);
    if (!hm) return false;
    const totalMinutes = hm.hour * 60 + hm.minute;
    // 7:30am - 2:00pm Mountain (regular US/CA market hours).
    return totalMinutes >= (7 * 60 + 30) && totalMinutes <= (14 * 60);
}

function normalizeTrades(rows, allowedTickerSet) {
    const out = [];
    for (const row of rows || []) {
        const ticker = String(row?.ticker || '').toUpperCase();
        const date = String(row?.date || '');
        const side = String(row?.side || '').toUpperCase();
        const amount = Number(row?.amount);
        if (!ticker || !allowedTickerSet.has(ticker)) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (!(side === 'BUY' || side === 'SELL')) continue;
        if (!Number.isFinite(amount) || amount <= 0) continue;

        out.push({ ticker, date, side, amount });
    }

    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
}

function buildContributionsLookup(rows) {
    const byDate = new Map();
    for (const row of rows || []) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const dateStr = row[0];
        const amount = row[1];
        if (typeof dateStr !== 'string' || typeof amount !== 'number' || !Number.isFinite(amount)) continue;
        byDate.set(dateStr, amount);
    }

    const dates = [...byDate.keys()].sort();
    const values = dates.map((d) => byDate.get(d));

    return function getContributionAtDate(dateStr) {
        let lo = 0;
        let hi = dates.length - 1;
        let best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (dates[mid] <= dateStr) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (best < 0) return 0;
        return values[best] ?? 0;
    };
}

function buildTradesByDate(trades) {
    const byDate = {};
    for (const trade of trades) {
        if (!byDate[trade.date]) byDate[trade.date] = [];
        byDate[trade.date].push(trade);
    }
    return byDate;
}

function normalizePriceRows(rows) {
    const byDate = new Map();
    for (const row of rows || []) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const dateStr = row[0];
        const price = row[1];
        if (typeof dateStr !== 'string' || typeof price !== 'number' || !Number.isFinite(price)) continue;
        byDate.set(dateStr, price);
    }

    const dates = [...byDate.keys()].sort();
    return {
        dates,
        byDate
    };
}

async function loadDailyPriceLookup(tickers) {
    const out = {};
    await Promise.all(tickers.map(async (ticker) => {
        const filePath = path.join(STOCK_PRICE_DIR, `${ticker}.json`);
        const rows = await readJson(filePath);
        out[ticker] = normalizePriceRows(rows);
    }));
    return out;
}

function getDailyPrice(priceLookupByTicker, ticker, dateStr) {
    const lookup = priceLookupByTicker[ticker];
    if (!lookup) return null;

    const direct = lookup.byDate.get(dateStr);
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;

    const dates = lookup.dates;
    let lo = 0;
    let hi = dates.length - 1;
    let best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] <= dateStr) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best < 0) return null;
    const fallback = lookup.byDate.get(dates[best]);
    return (typeof fallback === 'number' && Number.isFinite(fallback)) ? fallback : null;
}

function applyTradeAndCash(state, trade, dailyPriceLookupByTicker) {
    const price = getDailyPrice(dailyPriceLookupByTicker, trade.ticker, trade.date);
    if (!(typeof price === 'number' && price > 0)) return;

    const sharesDelta = trade.amount / price;
    const currentShares = state.positionsByTicker[trade.ticker] || 0;

    if (trade.side === 'BUY') {
        state.positionsByTicker[trade.ticker] = currentShares + sharesDelta;
        state.cashBalance -= trade.amount;
    } else {
        state.positionsByTicker[trade.ticker] = Math.max(0, currentShares - sharesDelta);
        state.cashBalance += trade.amount;
    }
}

function buildStartingState(trades, startDate, dailyPriceLookupByTicker, getContributionAtDate) {
    const state = {
        positionsByTicker: {},
        cashBalance: 0,
        currentContribution: 0
    };
    let currentDate = '';

    for (const trade of trades) {
        if (trade.date >= startDate) break;

        if (trade.date !== currentDate) {
            const nextContribution = getContributionAtDate(trade.date);
            state.cashBalance += (nextContribution - state.currentContribution);
            state.currentContribution = nextContribution;
            currentDate = trade.date;
        }

        applyTradeAndCash(state, trade, dailyPriceLookupByTicker);
    }
    return state;
}

async function loadIntradaySeriesByTicker(tickers, intervalKey, todayMtDateStr) {
    const out = {};

    await Promise.all(tickers.map(async (ticker) => {
        const filePath = path.join(STOCK_PRICE_DIR, intervalKey, `${ticker}.json`);
        const rows = await readJson(filePath);

        const byMs = new Map();
        for (const row of rows || []) {
            if (!Array.isArray(row) || row.length < 2) continue;
            const ms = parseTimestamp(row[0]);
            const price = row[1];
            if (!Number.isFinite(ms) || typeof price !== 'number' || !Number.isFinite(price)) continue;
            if (getDateStrMountain(ms) > todayMtDateStr) continue;
            byMs.set(ms, price);
        }

        out[ticker] = [...byMs.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([ms, price]) => ({ ms, price }));
    }));

    return out;
}

function buildTimelineMs(intradaySeriesByTicker) {
    const set = new Set();
    for (const ticker in intradaySeriesByTicker) {
        const rows = intradaySeriesByTicker[ticker] || [];
        for (const row of rows) {
            if (Number.isFinite(row?.ms)) set.add(row.ms);
        }
    }
    return [...set].sort((a, b) => a - b).filter(isWithinNorthAmericaSession);
}

function buildIntervalRows({
    tickers,
    intervalKey,
    trades,
    tradesByDate,
    getContributionAtDate,
    dailyPriceLookupByTicker,
    todayMtDateStr
}) {
    return loadIntradaySeriesByTicker(tickers, intervalKey, todayMtDateStr).then((intradaySeriesByTicker) => {
        const timeline = buildTimelineMs(intradaySeriesByTicker);
        if (!timeline.length) return [];

        const startDate = toDateStrUTC(timeline[0]);
        if (!startDate) return [];

        const startState = buildStartingState(trades, startDate, dailyPriceLookupByTicker, getContributionAtDate);
        const positionsByTicker = startState.positionsByTicker;
        let cashBalance = startState.cashBalance;
        let currentContribution = startState.currentContribution;
        let currentDate = '';

        const cursorByTicker = {};
        const lastPriceByTicker = {};
        for (const ticker of tickers) {
            cursorByTicker[ticker] = -1;
            lastPriceByTicker[ticker] = null;
        }

        const outRows = [];

        for (const ts of timeline) {
            const dateStr = toDateStrUTC(ts);
            if (!dateStr) continue;

            if (dateStr !== currentDate) {
                currentDate = dateStr;
                const nextContribution = getContributionAtDate(dateStr);
                cashBalance += (nextContribution - currentContribution);
                currentContribution = nextContribution;
                const todaysTrades = tradesByDate[dateStr] || [];
                for (const trade of todaysTrades) {
                    const price = getDailyPrice(dailyPriceLookupByTicker, trade.ticker, trade.date);
                    if (!(typeof price === 'number' && price > 0)) continue;

                    const sharesDelta = trade.amount / price;
                    const currentShares = positionsByTicker[trade.ticker] || 0;

                    if (trade.side === 'BUY') {
                        positionsByTicker[trade.ticker] = currentShares + sharesDelta;
                        cashBalance -= trade.amount;
                    } else {
                        positionsByTicker[trade.ticker] = Math.max(0, currentShares - sharesDelta);
                        cashBalance += trade.amount;
                    }
                }
            }

            let totalValue = cashBalance;
            for (const ticker of tickers) {
                const shares = positionsByTicker[ticker] || 0;
                if (shares <= 0.0001) continue;

                const rows = intradaySeriesByTicker[ticker] || [];
                let cursor = cursorByTicker[ticker];
                while (cursor + 1 < rows.length && rows[cursor + 1].ms <= ts) {
                    cursor += 1;
                    lastPriceByTicker[ticker] = rows[cursor].price;
                }
                cursorByTicker[ticker] = cursor;

                let price = lastPriceByTicker[ticker];
                if (!(typeof price === 'number' && Number.isFinite(price))) {
                    price = getDailyPrice(dailyPriceLookupByTicker, ticker, dateStr);
                }
                if (!(typeof price === 'number' && Number.isFinite(price))) continue;

                totalValue += shares * price;
            }

            const iso = toIsoTimestampUTC(ts);
            if (!iso) continue;

            outRows.push([iso, round2(totalValue), round2(currentContribution)]);
        }

        return outRows;
    });
}

async function main() {
    const args = parseArgs();

    const tradesRaw = await readJson(TRADES_FILE);
    const contributionsRaw = await readJson(CONTRIBUTIONS_FILE);
    if (!Array.isArray(tradesRaw) || !Array.isArray(contributionsRaw)) {
        throw new Error('Missing required input files: data/trades.json and/or data/contributions.json');
    }

    const tradesTickers = [...new Set(tradesRaw.map((t) => String(t?.ticker || '').toUpperCase()).filter(Boolean))].sort();
    const selectedTickers = args.tickers && args.tickers.length ? args.tickers : tradesTickers;
    const tickerSet = new Set(selectedTickers);

    const trades = normalizeTrades(tradesRaw, tickerSet);
    const tradesByDate = buildTradesByDate(trades);
    const getContributionAtDate = buildContributionsLookup(contributionsRaw);
    const dailyPriceLookupByTicker = await loadDailyPriceLookup(selectedTickers);
    const todayMtDateStr = getTodayDateStrMountain();

    await fs.mkdir(OUT_DIR, { recursive: true });
    log(`Building intraday net worth for ${selectedTickers.length} tickers (${todayMtDateStr} MT cutoff)...`);

    for (const intervalKey of INTERVAL_KEYS) {
        const rows = await buildIntervalRows({
            tickers: selectedTickers,
            intervalKey,
            trades,
            tradesByDate,
            getContributionAtDate,
            dailyPriceLookupByTicker,
            todayMtDateStr
        });

        const outPath = path.join(OUT_DIR, `${intervalKey}.json`);
        if (!rows.length) {
            log(`${intervalKey}: no rows; skipping write`);
            continue;
        }

        await writeJsonRows(outPath, rows);
        log(`${intervalKey}: wrote ${rows.length} rows`);
    }

    log('Done.');
}

main().catch((err) => {
    console.error(`[updatePortfolioIntradayNW] error: ${err.message}`);
    process.exit(1);
});
