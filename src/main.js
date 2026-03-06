let resetHeadlineTimeoutId = null;
const sharedConfig = globalThis.FolioScoutConfig || {};
const chartStartCapDateStr = normalizeChartStartDate(sharedConfig.chartStartDate);
const chartStartCapMs = chartStartCapDateStr ? Date.parse(`${chartStartCapDateStr}T00:00:00Z`) : null;
const useIntradayCharts = sharedConfig.useIntraday === true;

const STOCK_INTERVAL_BY_RANGE = {
    '1d': 'fivemin',
    '1w': 'semihourly',
    '1m': 'hourly',
    '3m': 'hourly'
};
// temporary default startup ticker; keep null to default to portfolio-on-load.
const TEMP_INITIAL_TICKER = null;

const STOCK_PRICE_PATHS_BY_INTERVAL = {
    daily: (ticker) => [
        `data/stockPriceHistory/${ticker}.json`
    ],
    fivemin: (ticker) => [
        `data/stockPriceHistory/fivemin/${ticker}.json`,
        `data/stockPriceHistory/5m/${ticker}.json`
    ],
    hourly: (ticker) => [
        `data/stockPriceHistory/hourly/${ticker}.json`,
        `data/stockPriceHistory/1h/${ticker}.json`
    ],
    semihourly: (ticker) => [
        `data/stockPriceHistory/semihourly/${ticker}.json`,
        `data/stockPriceHistory/30m/${ticker}.json`
    ],
    quarterhourly: (ticker) => [
        `data/stockPriceHistory/quarterhourly/${ticker}.json`,
        `data/stockPriceHistory/15m/${ticker}.json`
    ]
};
const PORTFOLIO_NETWORTH_PATHS_BY_INTERVAL = {
    fivemin: [
        'data/networthIntraday/fivemin.json'
    ],
    quarterhourly: [
        'data/networthIntraday/quarterhourly.json'
    ],
    semihourly: [
        'data/networthIntraday/semihourly.json'
    ],
    hourly: [
        'data/networthIntraday/hourly.json'
    ]
};
const INTERVAL_FALLBACKS = {
    fivemin: ['quarterhourly', 'semihourly', 'hourly', 'daily'],
    quarterhourly: ['semihourly', 'hourly', 'daily'],
    semihourly: ['hourly', 'daily'],
    hourly: ['daily'],
    daily: []
};
const SYNTHETIC_MARKET_CLOSE_APPEND_MINUTES = {
    fivemin: 5,
    quarterhourly: 15,
    semihourly: 30,
    hourly: 30
};
const DEFAULT_MARKET_SESSION = Object.freeze({
    timeZone: 'America/Denver',
    closeTotalMinutes: 14 * 60
});
const MARKET_SESSION_BY_TICKER_SUFFIX = Object.freeze([
    {
        suffix: '.PA',
        timeZone: 'Europe/Paris',
        closeTotalMinutes: 17 * 60 + 30
    }
]);

function normalizeChartStartDate(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
    const ms = Date.parse(`${trimmed}T00:00:00Z`);
    if (!Number.isFinite(ms)) return null;
    return trimmed;
}

function getPreferredStockIntervalForRange(range) {
    if (!useIntradayCharts) return 'daily';
    return STOCK_INTERVAL_BY_RANGE[range] || 'daily';
}

function parsePriceTimestamp(value) {
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

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const ms = Date.parse(`${text}T00:00:00Z`);
        return Number.isFinite(ms) ? ms : null;
    }

    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
}

function toDateStrUTC(epochMs) {
    const d = new Date(epochMs);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

function getDateStrInTimeZone(epochMs, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
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

function getDateStrMountain(epochMs) {
    return getDateStrInTimeZone(epochMs, 'America/Denver');
}

function getHourMinuteInTimeZone(epochMs, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
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

function getMountainHourMinute(epochMs) {
    return getHourMinuteInTimeZone(epochMs, 'America/Denver');
}

function getDatePartsInTimeZone(epochMs, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(epochMs);

    const values = {};
    for (const part of parts) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }

    return {
        year: Number(values.year),
        month: Number(values.month),
        day: Number(values.day)
    };
}

function getMountainDateParts(epochMs) {
    return getDatePartsInTimeZone(epochMs, 'America/Denver');
}

function parseShortOffsetMinutes(text) {
    const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(String(text || '').trim());
    if (!match) return null;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3] || '0');
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return sign * ((hours * 60) + minutes);
}

function getTimeZoneOffsetMinutes(timeZone, epochMs) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'shortOffset',
        hour: '2-digit'
    }).formatToParts(epochMs);

    const offsetText = parts.find((part) => part.type === 'timeZoneName')?.value;
    return parseShortOffsetMinutes(offsetText);
}

function getMarketSessionForTicker(ticker) {
    if (typeof ticker !== 'string' || !ticker) return DEFAULT_MARKET_SESSION;

    const upperTicker = ticker.trim().toUpperCase();
    for (const session of MARKET_SESSION_BY_TICKER_SUFFIX) {
        if (upperTicker.endsWith(session.suffix)) {
            return session;
        }
    }

    return DEFAULT_MARKET_SESSION;
}

function getMarketCloseMsForEpoch(epochMs, marketSession = DEFAULT_MARKET_SESSION) {
    if (!Number.isFinite(epochMs)) return null;

    const resolvedMarketSession = marketSession || DEFAULT_MARKET_SESSION;
    const marketDate = getDatePartsInTimeZone(epochMs, resolvedMarketSession.timeZone);
    if (!Number.isFinite(marketDate.year) || !Number.isFinite(marketDate.month) || !Number.isFinite(marketDate.day)) {
        return null;
    }

    const closeHour = Math.floor(resolvedMarketSession.closeTotalMinutes / 60);
    const closeMinute = resolvedMarketSession.closeTotalMinutes % 60;
    const utcGuessMs = Date.UTC(marketDate.year, marketDate.month - 1, marketDate.day, closeHour, closeMinute, 0);
    const offsetMinutes = getTimeZoneOffsetMinutes(resolvedMarketSession.timeZone, utcGuessMs);
    if (!Number.isFinite(offsetMinutes)) return null;

    return utcGuessMs - (offsetMinutes * 60 * 1000);
}

function isIntradayStockInterval(interval) {
    return ['fivemin', 'quarterhourly', 'semihourly', 'hourly'].includes(interval);
}

function getFirstDataPointMsOnOrAfter(targetMs) {
    if (!Number.isFinite(targetMs) || !Array.isArray(AppState.dataPoints) || AppState.dataPoints.length === 0) {
        return null;
    }

    let lo = 0;
    let hi = AppState.dataPoints.length - 1;
    let bestIdx = -1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const midMs = AppState.dataPoints[mid]?.date;
        if (!Number.isFinite(midMs)) {
            lo = mid + 1;
            continue;
        }

        if (midMs >= targetMs) {
            bestIdx = mid;
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }

    return bestIdx >= 0 ? AppState.dataPoints[bestIdx]?.date ?? null : null;
}

function getFirstDataPointMsAtMountainDayBoundaryOnOrAfter(targetMs) {
    const firstPointMs = getFirstDataPointMsOnOrAfter(targetMs);
    if (!Number.isFinite(firstPointMs)) return null;

    const targetHm = getMountainHourMinute(targetMs);
    const targetDay = getDateStrMountain(targetMs);
    const isSessionStart = targetHm && ((targetHm.hour * 60 + targetHm.minute) === (7 * 60 + 30));
    if (isSessionStart) return firstPointMs;

    for (let i = 0; i < AppState.dataPoints.length; i++) {
        const pointMs = AppState.dataPoints[i]?.date;
        if (!Number.isFinite(pointMs) || pointMs < firstPointMs) continue;
        if (getDateStrMountain(pointMs) > targetDay) return pointMs;
    }

    return firstPointMs;
}

function getPreviousDailyClose(ticker, dateStr) {
    if (typeof ticker !== 'string' || !ticker) return null;
    if (typeof dateStr !== 'string' || !dateStr) return null;

    const dates = AppState.stockPriceDatesByTicker?.[ticker];
    const priceLookup = AppState.stockPrices?.[ticker];
    if (!Array.isArray(dates) || !dates.length || !priceLookup) return null;

    let lo = 0;
    let hi = dates.length - 1;
    let bestIdx = -1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const midDate = dates[mid];

        if (midDate < dateStr) {
            bestIdx = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    if (bestIdx < 0) return null;
    const price = priceLookup[dates[bestIdx]];
    return (typeof price === 'number' && Number.isFinite(price)) ? price : null;
}

function shouldUsePreviousCloseForOneDayStockChange() {
    if (sharedConfig.usePreviousCloseForOneDayStockChange !== true) return false;
    if (AppState.currentView === 'portfolio') return false;
    if (AppState.activeRange !== '1d') return false;
    return isIntradayStockInterval(AppState.activeStockInterval);
}

function getDisplayChangeStats(startIndex, endIndex, options = {}) {
    const startPoint = AppState.dataPoints[startIndex];
    const endPoint = AppState.dataPoints[endIndex];
    if (!startPoint || !endPoint) return null;

    if (shouldUsePreviousCloseForOneDayStockChange()) {
        const previousClose = getPreviousDailyClose(AppState.currentView, startPoint.dateStr);
        if (typeof previousClose === 'number' && previousClose > 0) {
            return {
                gain: endPoint.netWorth - previousClose,
                twrr: ((endPoint.netWorth / previousClose) - 1) * 100
            };
        }
    }

    const isPortfolioIntradayRange =
        AppState.currentView === 'portfolio' &&
        isIntradayStockInterval(AppState.activeStockInterval);

    if (options.mode === 'point' && startIndex === 0 && !isPortfolioIntradayRange) {
        return {
            gain: endPoint.netGain,
            twrr: endPoint.TWRR
        };
    }

    const valChange = endPoint.netWorth - startPoint.netWorth;
    const contributionsChange = endPoint.contribution - startPoint.contribution;
    return {
        gain: valChange - contributionsChange,
        twrr: calculateTWRR(startIndex, endIndex)
    };
}

function getSyntheticMarketCloseInfo(rows, interval, marketSession = DEFAULT_MARKET_SESSION) {
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const appendMinutes = SYNTHETIC_MARKET_CLOSE_APPEND_MINUTES[interval];
    if (!Number.isFinite(appendMinutes)) return null;

    const lastRow = rows[rows.length - 1];
    const lastMs = lastRow?.ms;
    if (!Number.isFinite(lastMs)) return null;

    const resolvedMarketSession = marketSession || DEFAULT_MARKET_SESSION;
    const closeMs = lastMs + (appendMinutes * 60 * 1000);
    const lastHm = getHourMinuteInTimeZone(lastMs, resolvedMarketSession.timeZone);
    const closeHm = getHourMinuteInTimeZone(closeMs, resolvedMarketSession.timeZone);
    if (!lastHm || !closeHm) return null;

    const sameSessionDate = getDateStrInTimeZone(lastMs, resolvedMarketSession.timeZone) === getDateStrInTimeZone(closeMs, resolvedMarketSession.timeZone);
    const reachesMarketClose = closeHm.hour * 60 + closeHm.minute === resolvedMarketSession.closeTotalMinutes;
    if (!sameSessionDate || !reachesMarketClose) return null;

    return {
        lastRow,
        lastMs,
        closeMs,
        closeDateStr: toDateStrUTC(closeMs)
    };
}

function maybeAppendSyntheticStockClose(rows, interval, ticker) {
    const info = getSyntheticMarketCloseInfo(rows, interval, getMarketSessionForTicker(ticker));
    if (!info?.closeDateStr) return rows;

    const closePrice = AppState.stockPrices?.[ticker]?.[info.closeDateStr];
    if (!(typeof closePrice === 'number' && Number.isFinite(closePrice))) return rows;

    return [...rows, {
        ...info.lastRow,
        ms: info.closeMs,
        dateStr: info.closeDateStr,
        price: closePrice
    }];
}

function maybeAppendSyntheticPortfolioClose(rows, interval) {
    const info = getSyntheticMarketCloseInfo(rows, interval, DEFAULT_MARKET_SESSION);
    if (!info?.closeDateStr) return rows;

    const portfolioIndex = AppState.portfolioIndexByDateStr?.[info.closeDateStr];
    const closePoint = typeof portfolioIndex === 'number'
        ? AppState.portfolioDataPoints?.[portfolioIndex]
        : null;
    if (!closePoint) return rows;
    if (!(typeof closePoint.netWorth === 'number' && Number.isFinite(closePoint.netWorth))) return rows;

    return [...rows, {
        ...info.lastRow,
        ms: info.closeMs,
        dateStr: info.closeDateStr,
        netWorth: closePoint.netWorth,
        contribution: closePoint.contribution
    }];
}

function normalizePriceSeriesRows(rows) {
    const byMs = new Map();

    for (const row of rows || []) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const ms = parsePriceTimestamp(row[0]);
        const price = row[1];
        if (!Number.isFinite(ms) || typeof price !== 'number' || !Number.isFinite(price)) continue;
        byMs.set(ms, price);
    }

    const out = [...byMs.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ms, price]) => ({
            ms,
            price,
            dateStr: toDateStrUTC(ms)
        }))
        .filter((row) => typeof row.dateStr === 'string');

    return out;
}

function normalizePortfolioIntradaySeriesRows(rows) {
    const byMs = new Map();

    for (const row of rows || []) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const ms = parsePriceTimestamp(row[0]);
        const netWorth = row[1];
        const contribution = row[2];

        if (!Number.isFinite(ms) || typeof netWorth !== 'number' || !Number.isFinite(netWorth)) continue;

        const existing = byMs.get(ms) || {};
        const nextContribution = (typeof contribution === 'number' && Number.isFinite(contribution))
            ? contribution
            : existing.contribution;

        byMs.set(ms, {
            netWorth,
            contribution: nextContribution
        });
    }

    return [...byMs.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ms, row]) => ({
            ms,
            netWorth: row.netWorth,
            contribution: row.contribution,
            dateStr: toDateStrUTC(ms)
        }))
        .filter((row) => typeof row.dateStr === 'string');
}

async function loadStockSeriesForInterval(ticker, interval) {
    if (!AppState.stockSeriesCacheByTicker[ticker]) {
        AppState.stockSeriesCacheByTicker[ticker] = {};
    }
    const cache = AppState.stockSeriesCacheByTicker[ticker];
    if (cache[interval]) return cache[interval];

    const buildPaths = STOCK_PRICE_PATHS_BY_INTERVAL[interval] || STOCK_PRICE_PATHS_BY_INTERVAL.daily;
    const candidatePaths = buildPaths(ticker);

    for (const filePath of candidatePaths) {
        try {
            const data = await extractData(filePath);
            const rows = maybeAppendSyntheticStockClose(normalizePriceSeriesRows(data), interval, ticker);
            if (rows.length > 0) {
                cache[interval] = rows;
                return rows;
            }
        } catch (e) {
            // try next path
        }
    }

    cache[interval] = [];
    return [];
}

async function loadPortfolioSeriesForInterval(interval) {
    if (AppState.portfolioSeriesCacheByInterval[interval]) return AppState.portfolioSeriesCacheByInterval[interval];

    const candidatePaths = PORTFOLIO_NETWORTH_PATHS_BY_INTERVAL[interval] || [];
    for (const filePath of candidatePaths) {
        try {
            const data = await extractData(filePath);
            const rows = maybeAppendSyntheticPortfolioClose(normalizePortfolioIntradaySeriesRows(data), interval);
            if (rows.length > 0) {
                AppState.portfolioSeriesCacheByInterval[interval] = rows;
                return rows;
            }
        } catch (e) {
            // try next path
        }
    }

    AppState.portfolioSeriesCacheByInterval[interval] = [];
    return [];
}

function buildStockDataPointsFromSeries(seriesRows) {
    if (!Array.isArray(seriesRows) || seriesRows.length === 0) return [];
    const initialPrice = seriesRows[0].price;

    return seriesRows.map((row, index) => {
        const percentReturn = initialPrice !== 0
            ? ((row.price - initialPrice) / initialPrice) * 100
            : 0;

        return {
            netWorth: row.price,
            contribution: initialPrice,
            TWRR: percentReturn,
            netGain: row.price - initialPrice,
            index,
            date: row.ms,
            dateStr: row.dateStr
        };
    });
}

function buildPortfolioDataPointsFromSeries(seriesRows) {
    if (!Array.isArray(seriesRows) || seriesRows.length === 0) return [];

    const points = [];
    let lastKnownContribution = 0;
    let cumulativeGrowth = 1;

    for (let i = 0; i < seriesRows.length; i++) {
        const row = seriesRows[i];
        const netWorth = row?.netWorth;
        if (typeof netWorth !== 'number' || !Number.isFinite(netWorth)) continue;

        let contribution = row?.contribution;
        if (typeof contribution !== 'number' || !Number.isFinite(contribution)) {
            contribution = lastKnownContribution;
        } else {
            lastKnownContribution = contribution;
        }

        const prevPoint = points[points.length - 1];
        if (prevPoint) {
            const cashFlow = contribution - prevPoint.contribution;
            const base = prevPoint.netWorth + cashFlow;
            if (base !== 0) {
                const ratio = netWorth / base;
                if (Number.isFinite(ratio)) cumulativeGrowth *= ratio;
            }
        }

        points.push({
            netWorth,
            contribution,
            TWRR: (cumulativeGrowth - 1) * 100,
            netGain: netWorth - contribution,
            index: points.length,
            date: row.ms,
            dateStr: row.dateStr
        });
    }

    return points;
}

async function setStockDataForInterval(ticker, interval) {
    let effectiveInterval = interval;
    let seriesRows = await loadStockSeriesForInterval(ticker, interval);

    if (seriesRows.length === 0 && interval === 'fivemin') {
        effectiveInterval = 'quarterhourly';
        seriesRows = await loadStockSeriesForInterval(ticker, 'quarterhourly');
    }

    if (seriesRows.length === 0 && effectiveInterval !== 'daily') {
        effectiveInterval = 'daily';
        seriesRows = await loadStockSeriesForInterval(ticker, 'daily');
    }

    if (seriesRows.length === 0) return false;

    AppState.dataPoints = buildStockDataPointsFromSeries(seriesRows);
    AppState.activeStockInterval = effectiveInterval;
    return true;
}

async function setPortfolioDataForInterval(interval) {
    const fallbackOrder = [interval, ...(INTERVAL_FALLBACKS[interval] || [])];

    for (const candidateInterval of fallbackOrder) {
        if (candidateInterval === 'daily') {
            if (!Array.isArray(AppState.portfolioDataPoints) || AppState.portfolioDataPoints.length === 0) continue;
            AppState.dataPoints = AppState.portfolioDataPoints.slice();
            AppState.activeStockInterval = 'daily';
            return true;
        }

        const rows = await loadPortfolioSeriesForInterval(candidateInterval);
        if (!rows.length) continue;

        const points = buildPortfolioDataPointsFromSeries(rows);
        if (!points.length) continue;

        AppState.dataPoints = points;
        AppState.activeStockInterval = candidateInterval;
        return true;
    }

    return false;
}

async function ensureStockIntervalForRange(range, options = {}) {
    if (!useIntradayCharts) return false;

    const desiredInterval = getPreferredStockIntervalForRange(range);
    if (desiredInterval === AppState.activeStockInterval) return false;

    let changed = false;
    if (AppState.currentView === 'portfolio') {
        changed = await setPortfolioDataForInterval(desiredInterval);
    } else {
        const ticker = AppState.currentView;
        changed = await setStockDataForInterval(ticker, desiredInterval);
    }
    if (!changed) return false;

    if (options?.rebuildChart !== false) {
        if (AppState.chart) AppState.chart.destroy();
        createChart({ animateSeries: options?.animateSeries !== false });
    }

    return true;
}

async function init() {
    initUI();
    const initialTicker = typeof TEMP_INITIAL_TICKER === 'string' && TEMP_INITIAL_TICKER.trim()
        ? TEMP_INITIAL_TICKER.trim().toUpperCase()
        : null;

    if (!initialTicker) {
        warmHeaderFromLatestData();
    }
    const initialHoldingsPromise = initHoldingsPanel();
    await prepareData();
    AppState.portfolioDataPoints = AppState.dataPoints.slice();
    initRangeSelector();
    await initialHoldingsPromise;
    await initHoldingsPanel();
    initBackButton();

    const canLoadInitialTicker = initialTicker && AppState.portfolioTickers.includes(initialTicker);
    if (canLoadInitialTicker) {
        await loadStock(initialTicker);
        return;
    }

    if (initialTicker) {
        console.warn(`temporary startup ticker ${initialTicker} not found; defaulting to portfolio`);
    }

    createChart();
    await setRange('all');
}

window.addEventListener('DOMContentLoaded', init);

async function prepareData() {
    const netWorthData = await extractData('data/networth.json');
    const contributionData = await extractData('data/contributions.json');
    const trades = await extractData('data/trades.json');
    AppState.portfolioTickers = getTickersFromTrades(trades);

    await loadStockPrices(AppState.portfolioTickers);

    const tradesByDate = {};
    for (const trade of trades) {
        if (!tradesByDate[trade.date]) tradesByDate[trade.date] = [];
        tradesByDate[trade.date].push(trade);
    }

    const positionsByTicker = {};
    const contributionsByDate = {};
    for (const entry of contributionData) {
        contributionsByDate[entry[0]] = entry[1];
    }

    let lastKnownContribution = 0;
    let currentContribution = 0;
    let cumulativeGrowth = 1;

    for (let i = 0; i < netWorthData.length; i++) {
        const dateStr = netWorthData[i]?.[0];
        const netWorth = netWorthData[i]?.[1];
        if (typeof dateStr !== 'string' || typeof netWorth !== 'number') continue;
        const utcDateInMS = Date.parse(dateStr);

        const todaysTrades = tradesByDate[dateStr] || [];
        for (const trade of todaysTrades) {
            const price = getStockPrice(trade.ticker, dateStr);
            positionsByTicker[trade.ticker] = processTrade(
                positionsByTicker[trade.ticker],
                trade,
                price
            );
        }

        const valueByTicker = {};
        const weightByTicker = {};
        const returnPercentByTicker = {};
        const returnDollarByTicker = {};
        const dailyChangePercentByTicker = {};
        const dailyChangeDollarByTicker = {};

        let totalHoldingsValue = 0;
        for (const ticker of AppState.portfolioTickers) {
            const position = positionsByTicker[ticker];
            const price = getStockPrice(ticker, dateStr);
            const value = position?.shares > 0.0001 ? position.shares * price : 0;
            const previousClose = getPreviousDailyClose(ticker, dateStr);
            const shares = position?.shares || 0;
            valueByTicker[ticker] = value;
            totalHoldingsValue += value;
            returnPercentByTicker[ticker] = calculateTotalReturnPercent(position, price);
            returnDollarByTicker[ticker] = calculateTotalReturnDollar(position, price);
            dailyChangePercentByTicker[ticker] = (shares > 0.0001 && previousClose > 0)
                ? (((price / previousClose) - 1) * 100)
                : null;
            dailyChangeDollarByTicker[ticker] = (shares > 0.0001 && previousClose > 0)
                ? (shares * (price - previousClose))
                : null;
        }
        for (const ticker of AppState.portfolioTickers) {
            const value = valueByTicker[ticker] || 0;
            weightByTicker[ticker] = totalHoldingsValue > 0 ? (value / totalHoldingsValue) * 100 : 0;
        }

        if (contributionsByDate[dateStr] !== undefined) {
            currentContribution = contributionsByDate[dateStr];
            lastKnownContribution = currentContribution;
        } else {
            currentContribution = lastKnownContribution;
        }

        const currentNetGain = netWorth - currentContribution;

        const prevPoint = AppState.dataPoints[AppState.dataPoints.length - 1];
        if (prevPoint) {
            const cashFlow = currentContribution - prevPoint.contribution;
            const base = prevPoint.netWorth + cashFlow;
            if (base !== 0) {
                const ratio = netWorth / base;
                if (isFinite(ratio)) cumulativeGrowth *= ratio;
            }
        }

        const point = {
            netWorth,
            contribution: currentContribution,
            TWRR: (cumulativeGrowth - 1) * 100,
            netGain: currentNetGain,
            index: AppState.dataPoints.length,
            date: utcDateInMS,
            dateStr: dateStr,
            holdingsValueByTicker: valueByTicker,
            holdingsWeightByTicker: weightByTicker,
            returnPercentByTicker: returnPercentByTicker,
            returnDollarByTicker: returnDollarByTicker,
            dailyChangePercentByTicker: dailyChangePercentByTicker,
            dailyChangeDollarByTicker: dailyChangeDollarByTicker
        };
        AppState.dataPoints.push(point);
    }

    AppState.latestReturnPercentByTicker = {};
    AppState.latestReturnDollarByTicker = {};
    AppState.latestDailyChangePercentByTicker = {};
    AppState.latestDailyChangeDollarByTicker = {};

    AppState.portfolioIndexByDateStr = {};
    for (let i = 0; i < AppState.dataPoints.length; i++) {
        AppState.portfolioIndexByDateStr[AppState.dataPoints[i].dateStr] = i;
    }

    const latestPortfolioPoint = AppState.dataPoints[AppState.dataPoints.length - 1];
    if (latestPortfolioPoint) {
        AppState.latestReturnPercentByTicker = { ...(latestPortfolioPoint.returnPercentByTicker || {}) };
        AppState.latestReturnDollarByTicker = { ...(latestPortfolioPoint.returnDollarByTicker || {}) };
        AppState.latestDailyChangePercentByTicker = { ...(latestPortfolioPoint.dailyChangePercentByTicker || {}) };
        AppState.latestDailyChangeDollarByTicker = { ...(latestPortfolioPoint.dailyChangeDollarByTicker || {}) };
    }
}

function updateHeader(hoverIndex, seriesName = 'Net worth') {
    const hoverPoint = AppState.dataPoints[hoverIndex];
    if (!hoverPoint) return;

    if (seriesName === 'Contributions') {
        UI.headline.style.color = COLORS.GOLD;
        clearNetWorthSeriesSplit();
        animateDisplay(`$${formatNumber(hoverPoint.contribution)}`);
        UI.gain.textContent = '';
        return;
    }

    let startIndex = 0;
    let foundIndex = -1;

    const chartExists = AppState.chart && typeof AppState.chart.xAxis[0].min === 'number';

    if (chartExists) {
        const minDate = AppState.chart.xAxis[0].min;

        for (let i = 0; i < AppState.dataPoints.length; i++) {
            if (AppState.dataPoints[i].date >= minDate) {
                foundIndex = i;
                break;
            }
        }
        if (foundIndex !== -1 && foundIndex < hoverIndex) startIndex = foundIndex;
    }

    const stats = getDisplayChangeStats(startIndex, hoverIndex, { mode: 'point' });
    const gain = stats?.gain ?? hoverPoint.netGain;
    const twrr = stats?.twrr ?? hoverPoint.TWRR;

    const color = twrr < 0 ? COLORS.RED : COLORS.GREEN;

    UI.headline.style.color = color;
    if (color === AppState.lockednetWorthSeriesColor) {
        clearNetWorthSeriesSplit();
    } else {
        setNetWorthSeriesZones(hoverPoint.date, color, AppState.lockednetWorthSeriesColor);
    }

    const gainSign = gain >= 0 ? '+' : '-';
    const twrrSign = twrr >= 0 ? '+' : '';

    animateDisplay(`$${formatNumber(hoverPoint.netWorth)}`);
    UI.gain.textContent = `${gainSign}$${formatNumber(Math.abs(gain))} (${twrrSign}${formatNumber(twrr)}%)`;
}

function getDefaultHeaderSeriesName() {
    if (!AppState.chart?.series?.length) return 'Net worth';

    const netWorthSeries = AppState.chart.series.find(series => series.name === 'Net worth');
    const contributionsSeries = AppState.chart.series.find(series => series.name === 'Contributions');

    if (contributionsSeries?.visible && netWorthSeries && !netWorthSeries.visible) {
        return 'Contributions';
    }

    return 'Net worth';
}

function resetHeader() {
    if (!AppState.chart || !AppState.dataPoints.length) return;
    const defaultSeriesName = getDefaultHeaderSeriesName();

    const axis = AppState.chart.xAxis[0];
    const ext = axis.getExtremes();
    const minDate = ext.min ?? ext.dataMin;
    const maxDate = ext.max ?? ext.dataMax;

    const startIndex = AppState.dataPoints.findIndex(p => p.date >= minDate);

    let endIndex = AppState.dataPoints.length - 1;
    for (let i = AppState.dataPoints.length - 1; i >= 0; i--) {
        if (AppState.dataPoints[i].date <= maxDate) {
            endIndex = i;
            break;
        }
    }
    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
        updateHeader(AppState.dataPoints.length - 1, defaultSeriesName);
        return;
    }

    if (defaultSeriesName === 'Contributions') {
        updateHeader(endIndex, 'Contributions');
        return;
    }

    const endPoint = AppState.dataPoints[endIndex];
    const stats = getDisplayChangeStats(startIndex, endIndex);
    const gain = stats?.gain ?? 0;
    const twrr = stats?.twrr ?? 0;

    const safeTwrr = Number.isFinite(twrr) ? twrr : 0;
    const newColor = safeTwrr < 0 ? COLORS.RED : COLORS.GREEN;

    setLockednetWorthSeriesColor(newColor);

    UI.headline.style.color = newColor;

    const gainSign = gain >= 0 ? '+' : '-';
    const twrrSign = twrr >= 0 ? '+' : '';

    animateDisplay(`$${formatNumber(endPoint.netWorth)}`);
    UI.gain.textContent = `${gainSign}$${formatNumber(Math.abs(gain))} (${twrrSign}${formatNumber(twrr)}%)`;
}

async function warmHeaderFromLatestData() {
    try {
        const [netWorthData, contributionData] = await Promise.all([
            extractData('data/networth.json'),
            extractData('data/contributions.json')
        ]);
        if (!Array.isArray(netWorthData) || !netWorthData.length) return;

        const contributionsByDate = {};
        for (const entry of contributionData || []) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
                contributionsByDate[entry[0]] = entry[1];
            }
        }

        let lastKnownContribution = 0;
        let previousNetWorth = null;
        let previousContribution = 0;
        let cumulativeGrowth = 1;

        let latestNetWorth = null;
        let latestContribution = 0;

        for (let i = 0; i < netWorthData.length; i++) {
            const dateStr = netWorthData[i][0];
            const netWorth = netWorthData[i][1];
            if (typeof dateStr !== 'string' || typeof netWorth !== 'number') continue;

            if (contributionsByDate[dateStr] !== undefined) {
                lastKnownContribution = contributionsByDate[dateStr];
            }
            const currentContribution = lastKnownContribution;

            if (previousNetWorth !== null) {
                const cashFlow = currentContribution - previousContribution;
                const base = previousNetWorth + cashFlow;
                if (base !== 0) {
                    const ratio = netWorth / base;
                    if (isFinite(ratio)) cumulativeGrowth *= ratio;
                }
            }

            previousNetWorth = netWorth;
            previousContribution = currentContribution;
            latestNetWorth = netWorth;
            latestContribution = currentContribution;
        }

        if (typeof latestNetWorth !== 'number') return;

        const twrr = (cumulativeGrowth - 1) * 100;
        const gain = latestNetWorth - latestContribution;
        const color = twrr < 0 ? COLORS.RED : COLORS.GREEN;

        UI.headline.style.color = color;

        const gainSign = gain >= 0 ? '+' : '-';
        const twrrSign = twrr >= 0 ? '+' : '';

        animateDisplay(`$${formatNumber(latestNetWorth)}`);
        UI.gain.textContent = `${gainSign}$${formatNumber(Math.abs(gain))} (${twrrSign}${formatNumber(twrr)}%)`;
    } catch (e) {
        // header warm-up is best-effort only
    }
}

async function setRange(range, options = {}) {
    const fromRangeSelector = options?.fromRangeSelector === true;
    const shouldAnimateRangeSelection = fromRangeSelector && sharedConfig.animateRangeSelectionRedraw === true;
    AppState.activeRange = range;

    await ensureStockIntervalForRange(range, {
        rebuildChart: !shouldAnimateRangeSelection,
        animateSeries: shouldAnimateRangeSelection
    });

    const endMs = AppState.dataPoints[AppState.dataPoints.length - 1]?.date;
    const firstDataMs = AppState.dataPoints[0]?.date;
    let startMs = getStartDate(range);
    let rangeMax = Number.isFinite(endMs) ? endMs : null;

    if (range === '1d' && isIntradayStockInterval(AppState.activeStockInterval)) {
        const marketSession = AppState.currentView === 'portfolio'
            ? DEFAULT_MARKET_SESSION
            : getMarketSessionForTicker(AppState.currentView);
        const marketCloseMs = getMarketCloseMsForEpoch(endMs, marketSession);
        if (Number.isFinite(marketCloseMs)) rangeMax = marketCloseMs;
    }

    if (Number.isFinite(chartStartCapMs)) {
        if (!Number.isFinite(startMs) || startMs < chartStartCapMs) {
            startMs = chartStartCapMs;
        }
    }

    if (range === '1m' && isIntradayStockInterval(AppState.activeStockInterval)) {
        const snappedStartMs = getFirstDataPointMsAtMountainDayBoundaryOnOrAfter(startMs);
        if (Number.isFinite(snappedStartMs)) startMs = snappedStartMs;
    }

    // Never start before the actual first point; avoids large empty pre-listing areas.
    if (Number.isFinite(firstDataMs)) {
        if (!Number.isFinite(startMs) || startMs < firstDataMs) {
            startMs = firstDataMs;
        }
    }

    const hasExplicitRangeMin = Number.isFinite(startMs) && Number.isFinite(endMs);
    const rangeMin = hasExplicitRangeMin ? Math.min(startMs, endMs) : null;

    // Range-button animation should only be the full initial draw, never an axis tween.
    if (shouldAnimateRangeSelection) {
        if (AppState.chart) AppState.chart.destroy();
        createChart({
            animateSeries: true,
            initialXAxisMin: rangeMin,
            initialXAxisMax: rangeMax
        });
        updateRangeButtons(range);
        return;
    }

    if (!AppState.chart || !AppState.dataPoints.length) return;
    const axis = AppState.chart.xAxis[0];

    // clear any active split before changing only axis extremes (e.g. 1m <-> 3m on same interval)
    // to avoid blended/morphing look from stale hover zones.
    if (fromRangeSelector && !shouldAnimateRangeSelection && typeof clearNetWorthSeriesSplit === 'function') {
        clearNetWorthSeriesSplit();
    }

    if (typeof window.syncChartRenderedSeriesToRange === 'function') {
        window.syncChartRenderedSeriesToRange(rangeMin, rangeMax);
    }

    if (!Number.isFinite(rangeMin)) {
        axis.setExtremes(null, null, true, false);
    } else {
        axis.setExtremes(rangeMin, rangeMax, true, false);
    }

    if (range === 'all' && AppState.chart?.resetZoomButton) {
        AppState.chart.resetZoomButton.destroy();
        AppState.chart.resetZoomButton = null;
    }

    updateRangeButtons(range);
}

function getStartDate(range) {
    if (!AppState.dataPoints) return null;
    const latestTimeStamp = new Date(AppState.dataPoints[AppState.dataPoints.length-1].date);
    let startRangeTimeStamp = new Date(latestTimeStamp);

    switch (range) {
        case '1d':
            startRangeTimeStamp.setUTCDate(startRangeTimeStamp.getUTCDate() - 1);
            break;
        case '1w':
            startRangeTimeStamp.setUTCDate(startRangeTimeStamp.getUTCDate() - 7);
            break;
        case '1m':
            startRangeTimeStamp.setUTCMonth(startRangeTimeStamp.getUTCMonth() - 1);
            break;
        case '3m':
            startRangeTimeStamp.setUTCMonth(startRangeTimeStamp.getUTCMonth() - 3);
            break;
        case '1y':
            startRangeTimeStamp.setUTCFullYear(startRangeTimeStamp.getUTCFullYear() - 1);
            break;
        case '2y':
            startRangeTimeStamp.setUTCFullYear(startRangeTimeStamp.getUTCFullYear() - 2);
            break;
        case '3y':
            startRangeTimeStamp.setUTCFullYear(startRangeTimeStamp.getUTCFullYear() - 3);
            break;
        case 'all':
            return null;
        default:
            return null;
    }
    return startRangeTimeStamp.getTime();
}

function updateRangeButtons(activeRange) {
    const buttons = document.querySelectorAll('#rangeSelector button');

    for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const btnRange = btn.dataset.range;

        if (btnRange === activeRange) {
            btn.classList.add('is-active');
        } else {
            btn.classList.remove('is-active');
        }
    }
}

function initRangeSelector() {
    if (AppState.rangeSelectorInitialized) return;
    AppState.rangeSelectorInitialized = true;
    document.getElementById('rangeSelector').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-range]');
        if (btn) {
            void setRange(btn.dataset.range, { fromRangeSelector: true });
        }
    });
}

const HOLDINGS_SIDEBAR_SETTINGS_STORAGE_KEY = 'folioscout.holdingsSidebarSettings';
const DEFAULT_HOLDINGS_SIDEBAR_SETTINGS = Object.freeze({
    changeMode: 'today',
    showDollar: true,
    showPercent: true
});

function normalizeHoldingsSidebarSettings(value) {
    const normalized = {
        changeMode: value?.changeMode === 'alltime' ? 'alltime' : 'today',
        showDollar: value?.showDollar !== false,
        showPercent: value?.showPercent !== false
    };

    if (!normalized.showDollar && !normalized.showPercent) {
        normalized.showPercent = true;
    }

    return normalized;
}

function loadHoldingsSidebarSettings() {
    try {
        const raw = localStorage.getItem(HOLDINGS_SIDEBAR_SETTINGS_STORAGE_KEY);
        if (!raw) return { ...DEFAULT_HOLDINGS_SIDEBAR_SETTINGS };
        return normalizeHoldingsSidebarSettings(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_HOLDINGS_SIDEBAR_SETTINGS };
    }
}

function saveHoldingsSidebarSettings() {
    try {
        localStorage.setItem(
            HOLDINGS_SIDEBAR_SETTINGS_STORAGE_KEY,
            JSON.stringify(AppState.holdingsSidebarSettings)
        );
    } catch {
        // localStorage is best-effort only
    }
}

function syncHoldingsSettingsUI() {
    if (UI.holdingsSettingsButton) {
        UI.holdingsSettingsButton.setAttribute('aria-expanded', UI.holdingsSettingsPanel?.hidden ? 'false' : 'true');
    }
    if (!UI.holdingsSettingsPanel) return;

    const { changeMode, showDollar, showPercent } = AppState.holdingsSidebarSettings;
    const changeModeInputs = UI.holdingsSettingsPanel.querySelectorAll('input[name="holdingsChangeMode"]');
    for (const input of changeModeInputs) {
        input.checked = input.value === changeMode;
    }

    const dollarInput = UI.holdingsSettingsPanel.querySelector('input[name="holdingsMetricDollar"]');
    const percentInput = UI.holdingsSettingsPanel.querySelector('input[name="holdingsMetricPercent"]');
    if (dollarInput) dollarInput.checked = showDollar;
    if (percentInput) percentInput.checked = showPercent;
}

function applyHoldingsSidebarSettings(nextSettings) {
    AppState.holdingsSidebarSettings = normalizeHoldingsSidebarSettings(nextSettings);
    saveHoldingsSidebarSettings();
    syncHoldingsSettingsUI();

    if (AppState.portfolioDataPoints.length > 0) {
        updateHoldingsWeights(AppState.portfolioDataPoints.length - 1);
    } else {
        updateHoldingsWeights(null);
    }

    if (AppState.currentView !== 'portfolio' && typeof window.resetSelectedHoldingMetricsToLatest === 'function') {
        window.resetSelectedHoldingMetricsToLatest();
    }
}

function initHoldingsSettings() {
    if (AppState.holdingsSettingsInitialized) return;
    AppState.holdingsSettingsInitialized = true;
    AppState.holdingsSidebarSettings = loadHoldingsSidebarSettings();
    syncHoldingsSettingsUI();

    if (UI.holdingsSettingsButton && UI.holdingsSettingsPanel) {
        UI.holdingsSettingsButton.addEventListener('click', (event) => {
            event.stopPropagation();
            UI.holdingsSettingsPanel.hidden = !UI.holdingsSettingsPanel.hidden;
            syncHoldingsSettingsUI();
        });
    }

    if (UI.holdingsSettingsPanel) {
        UI.holdingsSettingsPanel.addEventListener('click', (event) => {
            event.stopPropagation();
        });

        UI.holdingsSettingsPanel.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;

            const current = AppState.holdingsSidebarSettings;
            if (target.name === 'holdingsChangeMode') {
                applyHoldingsSidebarSettings({
                    ...current,
                    changeMode: target.value === 'alltime' ? 'alltime' : 'today'
                });
                return;
            }

            if (target.name === 'holdingsMetricDollar' || target.name === 'holdingsMetricPercent') {
                const nextSettings = {
                    ...current,
                    showDollar: target.name === 'holdingsMetricDollar' ? target.checked : current.showDollar,
                    showPercent: target.name === 'holdingsMetricPercent' ? target.checked : current.showPercent
                };
                applyHoldingsSidebarSettings(nextSettings);
            }
        });
    }

    document.addEventListener('click', (event) => {
        if (!UI.holdingsSettingsPanel || UI.holdingsSettingsPanel.hidden) return;
        if (UI.holdingsSettingsPanel.contains(event.target) || UI.holdingsSettingsButton?.contains(event.target)) return;
        UI.holdingsSettingsPanel.hidden = true;
        syncHoldingsSettingsUI();
    });
}

function getLatestPortfolioPoint() {
    for (let i = AppState.portfolioDataPoints.length - 1; i >= 0; i--) {
        const point = AppState.portfolioDataPoints[i];
        if (point?.holdingsValueByTicker && point?.holdingsWeightByTicker) return point;
    }
    return null;
}

function getHoldingMetricSnapshot(ticker, point) {
    const settings = AppState.holdingsSidebarSettings || DEFAULT_HOLDINGS_SIDEBAR_SETTINGS;
    const metricDollarByTicker = settings.changeMode === 'today'
        ? point?.dailyChangeDollarByTicker
        : point?.returnDollarByTicker;
    const metricPercentByTicker = settings.changeMode === 'today'
        ? point?.dailyChangePercentByTicker
        : point?.returnPercentByTicker;

    return {
        dollar: metricDollarByTicker?.[ticker],
        percent: metricPercentByTicker?.[ticker]
    };
}

function getSelectedHoldingMetricsForDataIndex(index) {
    const ticker = AppState.currentView;
    if (!ticker || ticker === 'portfolio') return null;

    const hoveredPoint = typeof index === 'number' ? AppState.dataPoints[index] : null;
    if (!hoveredPoint) return null;

    const portfolioIndex = AppState.portfolioIndexByDateStr?.[hoveredPoint.dateStr];
    const portfolioPoint = typeof portfolioIndex === 'number'
        ? AppState.portfolioDataPoints?.[portfolioIndex]
        : null;
    if (!portfolioPoint) return null;

    const baseValue = portfolioPoint.holdingsValueByTicker?.[ticker] ?? 0;
    const dailyClosePrice = getStockPrice(ticker, hoveredPoint.dateStr);
    const hoveredPrice = hoveredPoint.netWorth;
    const shares = (dailyClosePrice > 0 && baseValue > 0) ? (baseValue / dailyClosePrice) : 0;
    const hoveredValue = shares > 0 ? shares * hoveredPrice : baseValue;

    const totalPortfolioValue = Object.values(portfolioPoint.holdingsValueByTicker || {}).reduce((sum, value) => {
        return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    const adjustedTotalValue = Math.max(0, totalPortfolioValue - baseValue + hoveredValue);
    const weightPercent = adjustedTotalValue > 0 ? (hoveredValue / adjustedTotalValue) * 100 : 0;

    const settings = AppState.holdingsSidebarSettings || DEFAULT_HOLDINGS_SIDEBAR_SETTINGS;
    if (settings.changeMode === 'today') {
        const previousClose = getPreviousDailyClose(ticker, hoveredPoint.dateStr);
        const metricDollar = (shares > 0 && previousClose > 0)
            ? shares * (hoveredPrice - previousClose)
            : null;
        const metricPercent = (previousClose > 0)
            ? (((hoveredPrice / previousClose) - 1) * 100)
            : null;
        return {
            weightPercent,
            value: hoveredValue,
            metricDollar,
            metricPercent
        };
    }

    const baseReturnDollar = portfolioPoint.returnDollarByTicker?.[ticker];
    const baseReturnPercent = portfolioPoint.returnPercentByTicker?.[ticker];
    let metricDollar = baseReturnDollar;
    let metricPercent = baseReturnPercent;

    if (typeof baseReturnDollar === 'number' && Number.isFinite(baseReturnDollar) && shares > 0) {
        metricDollar = baseReturnDollar + (hoveredValue - baseValue);
        if (typeof baseReturnPercent === 'number' && Number.isFinite(baseReturnPercent) && baseReturnPercent !== 0) {
            const totalCost = baseReturnDollar / (baseReturnPercent / 100);
            if (Number.isFinite(totalCost) && totalCost > 0) {
                metricPercent = (metricDollar / totalCost) * 100;
            }
        }
    }

    return {
        weightPercent,
        value: hoveredValue,
        metricDollar,
        metricPercent
    };
}

function formatHoldingMetricText(metricDollar, metricPercent) {
    const settings = AppState.holdingsSidebarSettings || DEFAULT_HOLDINGS_SIDEBAR_SETTINGS;
    const percentText = settings.showPercent && typeof metricPercent === 'number' && Number.isFinite(metricPercent)
        ? formatReturnPercent(metricPercent)
        : '';
    const shouldUseCompactDollar =
        settings.showDollar &&
        settings.showPercent &&
        settings.changeMode === 'alltime';
    const dollarText = settings.showDollar && typeof metricDollar === 'number' && Number.isFinite(metricDollar)
        ? (shouldUseCompactDollar ? formatSignedCurrencyCompact(metricDollar) : formatSignedCurrency(metricDollar))
        : '';

    if (!dollarText && !percentText) {
        return {
            text: ''
        };
    }

    if (dollarText && percentText) {
        return {
            text: `${dollarText} (${percentText})`
        };
    }

    return {
        text: dollarText || percentText
    };
}

function prepareLogos(tickers) {
    AppState.logosByTicker = {};
    for (const ticker of tickers) {
        AppState.logosByTicker[ticker] = `data/logos/${ticker}.png`;
    }
    return AppState.logosByTicker;
}

async function initHoldingsPanel() {
    if (!UI.holdingsPanel) return;

    initHoldingsPanelDelegation();
    initHoldingsSettings();

    const trades = await extractData('data/trades.json');
    const holdings = getTickersFromTrades(trades);

    if (!Object.keys(AppState.logosByTicker).length) {
        prepareLogos(holdings);
    }

    renderHoldingsPanel(holdings);
}

function initHoldingsPanelDelegation() {
    if (!UI.holdingsPanel) return;
    if (AppState.holdingsPanelDelegationInitialized) return;
    AppState.holdingsPanelDelegationInitialized = true;
    UI.holdingsPanel.addEventListener('click', (e) => {
        const item = e.target.closest('.holding-item');
        if (item?.dataset.ticker) loadStock(item.dataset.ticker);
    });
}

function renderHoldingsPanel(holdings) {
    const header = UI.holdingsPanel.querySelector('.holdings-header');
    const settingsPanel = UI.holdingsPanel.querySelector('.holdings-settings-panel');
    UI.holdingsPanel.innerHTML = '';
    if (header) UI.holdingsPanel.appendChild(header);
    if (settingsPanel) UI.holdingsPanel.appendChild(settingsPanel);
    AppState.holdingWeightElByTicker = {};
    AppState.holdingValueElByTicker = {};
    AppState.holdingReturnElByTicker = {};

    let tickersToRender = holdings.filter((ticker) => shouldShowTicker(ticker));
    if (AppState.dataPoints.length > 0) {
        tickersToRender = sortTickersByWeightAtIndex(tickersToRender, AppState.dataPoints.length - 1);
    }
    const shouldShowLogoImages = Object.keys(AppState.latestReturnPercentByTicker).length > 0;

    const fragment = document.createDocumentFragment();

    for (const ticker of tickersToRender) {
        const logoUrl = AppState.logosByTicker[ticker];
        const isBlack = shouldUseBlackLogoBox(ticker);

        const item = document.createElement('div');
        item.className = 'holding-item';
        item.dataset.ticker = ticker;
        item.innerHTML = `
            <div class="holding-logo-box ${isBlack ? 'is-black' : ''}">
                ${logoUrl && shouldShowLogoImages
                    ? `<img src="${logoUrl}" alt="${ticker} logo" class="holding-logo">`
                    : `<div class="holding-logo-fallback">${ticker[0]}</div>`}
            </div>
            <div class="holding-label-wrap">
                <div class="holding-label">${ticker}</div>
                <div class="holding-weight"></div>
            </div>
            <div class="holding-metrics">
                <div class="holding-value"></div>
                <div class="holding-return"></div>
            </div>
        `;

        const img = item.querySelector('.holding-logo');
        if (img) {
            img.addEventListener('error', () => {
                const logoBox = item.querySelector('.holding-logo-box');
                logoBox.replaceWith(createHoldingLogoFallback(ticker));
            });
        }

        AppState.holdingWeightElByTicker[ticker] = item.querySelector('.holding-weight');
        AppState.holdingValueElByTicker[ticker] = item.querySelector('.holding-value');
        AppState.holdingReturnElByTicker[ticker] = item.querySelector('.holding-return');

        fragment.appendChild(item);
    }

    UI.holdingsPanel.appendChild(fragment);
    syncHoldingsSettingsUI();

    if (AppState.currentView === 'portfolio' && AppState.dataPoints.length > 0) {
        updateHoldingsWeights(AppState.dataPoints.length - 1);
    } else {
        updateHoldingsWeights(null);
    }
}

function createHoldingLogoFallback(ticker) {
    const fallback = document.createElement('div');
    fallback.className = 'holding-logo-fallback';
    fallback.textContent = (ticker && ticker[0]) ? ticker[0].toUpperCase() : '?';
    fallback.setAttribute('aria-hidden', 'true');
    return fallback;
}

function shouldUseBlackLogoBox(ticker) {
    if (!ticker) return false;
    const list =
        (Array.isArray(window.blackBoxLogos) && window.blackBoxLogos) ||
        (typeof blackBoxLogos !== 'undefined' && Array.isArray(blackBoxLogos) && blackBoxLogos) ||
        [];
    return list.includes(ticker);
}

function shouldShowTicker(ticker) {
    if (Object.keys(AppState.latestReturnPercentByTicker).length === 0) return true;

    const percent = AppState.latestReturnPercentByTicker[ticker];
    if (typeof percent !== 'number') return false;
    if (Math.abs(percent) < 1e-9) return false;
    return true;
}

function sortTickersByWeightAtIndex(tickers, index) {
    const point = AppState.dataPoints[index];
    const weightByTicker = point?.holdingsWeightByTicker || {};

    return [...tickers].sort((a, b) => {
        const weightA = weightByTicker[a] || 0;
        const weightB = weightByTicker[b] || 0;
        if (weightB !== weightA) return weightB - weightA;
        return a.localeCompare(b);
    });
}

function updateHoldingMetricElements(ticker, weightPercent, value, metricDollar, metricPercent) {
    const settings = AppState.holdingsSidebarSettings || DEFAULT_HOLDINGS_SIDEBAR_SETTINGS;
    if (AppState.holdingWeightElByTicker[ticker]) {
        const weightText = formatWeightPercent(weightPercent);
        AppState.holdingWeightElByTicker[ticker].textContent = (settings.showDollar && settings.showPercent)
            ? weightText
            : `Weight: ${weightText}`;
    }
    if (AppState.holdingValueElByTicker[ticker]) {
        AppState.holdingValueElByTicker[ticker].textContent = formatCurrency(value);
    }
    if (AppState.holdingReturnElByTicker[ticker]) {
        const el = AppState.holdingReturnElByTicker[ticker];
        const metricDisplay = formatHoldingMetricText(metricDollar, metricPercent);
        const colorMetric = (typeof metricPercent === 'number' && Number.isFinite(metricPercent))
            ? metricPercent
            : metricDollar;
        if (metricDisplay.text) {
            el.textContent = metricDisplay.text;
            el.classList.remove('is-stacked');
            el.classList.toggle('is-positive', Number(colorMetric) >= 0);
            el.classList.toggle('is-negative', Number(colorMetric) < 0);
        } else {
            el.textContent = '';
            el.classList.remove('is-stacked');
            el.classList.remove('is-positive', 'is-negative');
        }
    }
}

function clearHoldingMetricElements() {
    for (const ticker in AppState.holdingWeightElByTicker) {
        AppState.holdingWeightElByTicker[ticker].textContent = '';
    }
    for (const ticker in AppState.holdingValueElByTicker) {
        AppState.holdingValueElByTicker[ticker].textContent = '';
    }
    for (const ticker in AppState.holdingReturnElByTicker) {
        AppState.holdingReturnElByTicker[ticker].textContent = '';
        AppState.holdingReturnElByTicker[ticker].classList.remove('is-positive', 'is-negative');
    }
}

function updateHoldingsWeights(index) {
    const latestPortfolioPoint = getLatestPortfolioPoint();

    if (!latestPortfolioPoint) {
        clearHoldingMetricElements();
        return;
    }

    for (const ticker in AppState.holdingWeightElByTicker) {
        const weightPercent = latestPortfolioPoint.holdingsWeightByTicker?.[ticker] ?? 0;
        const value = latestPortfolioPoint.holdingsValueByTicker?.[ticker] ?? 0;
        const metric = getHoldingMetricSnapshot(ticker, latestPortfolioPoint);
        updateHoldingMetricElements(ticker, weightPercent, value, metric.dollar, metric.percent);
    }
}

window.updateHoldingsWeights = updateHoldingsWeights;

function updateSelectedHoldingMetricsByDataIndex(index) {
    const ticker = AppState.currentView;
    if (!ticker || ticker === 'portfolio') return;
    if ((AppState.holdingsSidebarSettings?.changeMode || 'today') !== 'alltime') return;

    const metrics = getSelectedHoldingMetricsForDataIndex(index);
    if (!metrics) return;

    updateHoldingMetricElements(
        ticker,
        metrics.weightPercent,
        metrics.value,
        metrics.metricDollar,
        metrics.metricPercent
    );
}

window.updateSelectedHoldingMetricsByDataIndex = updateSelectedHoldingMetricsByDataIndex;

function resetSelectedHoldingMetricsToLatest() {
    const ticker = AppState.currentView;
    if (!ticker || ticker === 'portfolio') return;

    const latestPortfolioPoint = getLatestPortfolioPoint();
    if (!latestPortfolioPoint) return;

    const weightPercent = latestPortfolioPoint.holdingsWeightByTicker?.[ticker] ?? 0;
    const value = latestPortfolioPoint.holdingsValueByTicker?.[ticker] ?? 0;
    const metric = getHoldingMetricSnapshot(ticker, latestPortfolioPoint);

    updateHoldingMetricElements(ticker, weightPercent, value, metric.dollar, metric.percent);
}

window.resetSelectedHoldingMetricsToLatest = resetSelectedHoldingMetricsToLatest;

function initBackButton() {
    if (!UI.backButton) return;
    UI.backButton.addEventListener('click', backToPortfolio);
}

async function loadStock(ticker) {
    const targetRange = AppState.currentView === 'portfolio'
        ? 'all'
        : (AppState.activeRange || 'all');
    const desiredInterval = getPreferredStockIntervalForRange(targetRange);
    const hasData = await setStockDataForInterval(ticker, desiredInterval);
    if (!hasData) {
        console.error(`No price data available for ${ticker}`);
        return;
    }

    AppState.currentView = ticker;

    UI.backButton.hidden = false;

    const items = UI.holdingsPanel.querySelectorAll('.holding-item');
    for (const item of items) {
        item.classList.toggle('active', item.dataset.ticker === ticker);
    }

    if (AppState.chart) AppState.chart.destroy();
    createChart();
    await setRange(targetRange);
}

async function backToPortfolio() {
    AppState.dataPoints = AppState.portfolioDataPoints.slice();
    AppState.currentView = 'portfolio';
    AppState.activeStockInterval = 'daily';
    AppState.activeRange = 'all';
    updateHoldingsWeights(AppState.dataPoints.length - 1);

    UI.backButton.hidden = true;

    const items = UI.holdingsPanel.querySelectorAll('.holding-item');
    for (const item of items) {
        item.classList.remove('active');
    }

    if (AppState.chart) AppState.chart.destroy();
    createChart();
    await setRange('all');
}
