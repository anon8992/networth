let resetHeadlineTimeoutId = null;
const sharedConfig = globalThis.FolioScoutConfig || {};
const chartStartCapDateStr = normalizeChartStartDate(sharedConfig.chartStartDate);
const chartStartCapMs = chartStartCapDateStr ? Date.parse(`${chartStartCapDateStr}T00:00:00Z`) : null;
const useIntradayCharts = sharedConfig.useIntraday === true;

const STOCK_INTERVAL_BY_RANGE = {
    '1d': 'quarterhourly',
    '1w': 'semihourly',
    '1m': 'hourly'
};

const STOCK_PRICE_PATHS_BY_INTERVAL = {
    daily: (ticker) => [
        `data/stockPriceHistory/${ticker}.json`
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
            const rows = normalizePriceSeriesRows(data);
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

async function setStockDataForInterval(ticker, interval) {
    let effectiveInterval = interval;
    let seriesRows = await loadStockSeriesForInterval(ticker, interval);

    if (seriesRows.length === 0 && interval !== 'daily') {
        effectiveInterval = 'daily';
        seriesRows = await loadStockSeriesForInterval(ticker, 'daily');
    }

    if (seriesRows.length === 0) return false;

    AppState.dataPoints = buildStockDataPointsFromSeries(seriesRows);
    AppState.activeStockInterval = effectiveInterval;
    return true;
}

async function ensureStockIntervalForRange(range) {
    if (!useIntradayCharts) return;
    if (AppState.currentView === 'portfolio') return;

    const desiredInterval = getPreferredStockIntervalForRange(range);
    if (desiredInterval === AppState.activeStockInterval) return;

    const ticker = AppState.currentView;
    const changed = await setStockDataForInterval(ticker, desiredInterval);
    if (!changed) return;

    if (AppState.chart) AppState.chart.destroy();
    createChart();
}

async function init() {
    initUI();
    warmHeaderFromLatestData();
    const initialHoldingsPromise = initHoldingsPanel();
    await prepareData();
    AppState.portfolioDataPoints = AppState.dataPoints.slice();
    initRangeSelector();
    await initialHoldingsPromise;
    await initHoldingsPanel();
    initBackButton();
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

        let totalHoldingsValue = 0;
        for (const ticker of AppState.portfolioTickers) {
            const position = positionsByTicker[ticker];
            const price = getStockPrice(ticker, dateStr);
            const value = position?.shares > 0.0001 ? position.shares * price : 0;
            valueByTicker[ticker] = value;
            totalHoldingsValue += value;
            returnPercentByTicker[ticker] = calculateTotalReturnPercent(position, price);
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
            returnPercentByTicker: returnPercentByTicker
        };
        AppState.dataPoints.push(point);
    }

    const lastDateStr = netWorthData.at(-1)?.[0];
    AppState.latestReturnPercentByTicker = {};
    if (lastDateStr) {
        for (const ticker in positionsByTicker) {
            const position = positionsByTicker[ticker];
            const currentPrice = getStockPrice(ticker, lastDateStr);
            AppState.latestReturnPercentByTicker[ticker] = calculateTotalReturnPercent(position, currentPrice);
        }
    }

    AppState.portfolioIndexByDateStr = {};
    for (let i = 0; i < AppState.dataPoints.length; i++) {
        AppState.portfolioIndexByDateStr[AppState.dataPoints[i].dateStr] = i;
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

    let gain, twrr;

    if (startIndex === 0) {
        gain = hoverPoint.netGain;
        twrr = hoverPoint.TWRR;
    } else {
        const startPoint = AppState.dataPoints[startIndex];
        const valChange = hoverPoint.netWorth - startPoint.netWorth;
        const contributionsChange = hoverPoint.contribution - startPoint.contribution;

        gain = valChange - contributionsChange;
        twrr = calculateTWRR(startIndex, hoverIndex);
    }

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

    const startPoint = AppState.dataPoints[startIndex];
    const endPoint = AppState.dataPoints[endIndex];

    const valChange = endPoint.netWorth - startPoint.netWorth;
    const contributionsChange = endPoint.contribution - startPoint.contribution;
    const gain = valChange - contributionsChange;
    const twrr = calculateTWRR(startIndex, endIndex);

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

async function setRange(range) {
    AppState.activeRange = range;
    await ensureStockIntervalForRange(range);

    if (!AppState.chart || !AppState.dataPoints.length) return;
    const axis = AppState.chart.xAxis[0];

    let startMs = getStartDate(range);
    const endMs = AppState.dataPoints[AppState.dataPoints.length - 1].date;
    const firstDataMs = AppState.dataPoints[0]?.date;

    if (Number.isFinite(chartStartCapMs)) {
        if (!Number.isFinite(startMs) || startMs < chartStartCapMs) {
            startMs = chartStartCapMs;
        }
    }

    // Never start before the actual first point; avoids large empty pre-listing areas.
    if (Number.isFinite(firstDataMs)) {
        if (!Number.isFinite(startMs) || startMs < firstDataMs) {
            startMs = firstDataMs;
        }
    }

    if (!Number.isFinite(startMs)) {
        axis.setExtremes(null, null);
    } else {
        axis.setExtremes(Math.min(startMs, endMs), endMs);
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
            void setRange(btn.dataset.range);
        }
    });
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
    const title = UI.holdingsPanel.querySelector('.holdings-title');
    UI.holdingsPanel.innerHTML = '';
    if (title) UI.holdingsPanel.appendChild(title);
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

function updateHoldingMetricElements(ticker, weightPercent, value, returnPercent) {
    if (AppState.holdingWeightElByTicker[ticker]) {
        AppState.holdingWeightElByTicker[ticker].textContent = `Weight: ${formatWeightPercent(weightPercent)}`;
    }
    if (AppState.holdingValueElByTicker[ticker]) {
        AppState.holdingValueElByTicker[ticker].textContent = formatCurrency(value);
    }
    if (AppState.holdingReturnElByTicker[ticker]) {
        const el = AppState.holdingReturnElByTicker[ticker];
        if (typeof returnPercent === 'number') {
            el.textContent = formatReturnPercent(returnPercent);
            el.classList.toggle('is-positive', returnPercent > 0);
            el.classList.toggle('is-negative', returnPercent < 0);
            if (returnPercent === 0) el.classList.remove('is-positive', 'is-negative');
        } else {
            el.textContent = '';
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
    let latestPortfolioPoint = null;
    for (let i = AppState.portfolioDataPoints.length - 1; i >= 0; i--) {
        const p = AppState.portfolioDataPoints[i];
        if (p?.holdingsValueByTicker && p?.holdingsWeightByTicker) {
            latestPortfolioPoint = p;
            break;
        }
    }

    if (!latestPortfolioPoint) {
        clearHoldingMetricElements();
        return;
    }

    for (const ticker in AppState.holdingWeightElByTicker) {
        const weightPercent = latestPortfolioPoint.holdingsWeightByTicker?.[ticker] ?? 0;
        const value = latestPortfolioPoint.holdingsValueByTicker?.[ticker] ?? 0;
        const returnPercent = AppState.latestReturnPercentByTicker[ticker];
        updateHoldingMetricElements(ticker, weightPercent, value, returnPercent);
    }
}

window.updateHoldingsWeights = updateHoldingsWeights;

function updateSelectedHoldingMetricsByDateStr(dateStr) {
    const ticker = AppState.currentView;
    if (!ticker || ticker === 'portfolio') return;
    if (!dateStr) return;

    const index = AppState.portfolioIndexByDateStr[dateStr];
    const point = typeof index === 'number' ? AppState.portfolioDataPoints[index] : null;
    if (!point) return;

    const weightPercent = point.holdingsWeightByTicker?.[ticker] ?? 0;
    const value = point.holdingsValueByTicker?.[ticker] ?? 0;
    const returnPercent = point.returnPercentByTicker?.[ticker];

    updateHoldingMetricElements(ticker, weightPercent, value, returnPercent);
}

window.updateSelectedHoldingMetricsByDateStr = updateSelectedHoldingMetricsByDateStr;

function resetSelectedHoldingMetricsToLatest() {
    const ticker = AppState.currentView;
    if (!ticker || ticker === 'portfolio') return;

    let latestPortfolioPoint = null;
    for (let i = AppState.portfolioDataPoints.length - 1; i >= 0; i--) {
        const p = AppState.portfolioDataPoints[i];
        if (p?.holdingsValueByTicker && p?.holdingsWeightByTicker) {
            latestPortfolioPoint = p;
            break;
        }
    }
    if (!latestPortfolioPoint) return;

    const weightPercent = latestPortfolioPoint.holdingsWeightByTicker?.[ticker] ?? 0;
    const value = latestPortfolioPoint.holdingsValueByTicker?.[ticker] ?? 0;
    const returnPercent = AppState.latestReturnPercentByTicker[ticker];

    updateHoldingMetricElements(ticker, weightPercent, value, returnPercent);
}

window.resetSelectedHoldingMetricsToLatest = resetSelectedHoldingMetricsToLatest;

function initBackButton() {
    if (!UI.backButton) return;
    UI.backButton.addEventListener('click', backToPortfolio);
}

async function loadStock(ticker) {
    AppState.activeRange = 'all';
    const desiredInterval = getPreferredStockIntervalForRange('all');
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
    await setRange('all');
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
