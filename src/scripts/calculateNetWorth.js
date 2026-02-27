import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', '..');

const DATA_DIR = path.join(ROOT_DIR, 'data');
const STOCK_PRICE_DIR = path.join(DATA_DIR, 'stockPriceHistory');
const NET_WORTH_FILE = path.join(DATA_DIR, 'networth.json');
const CONTRIBUTIONS_FILE = path.join(DATA_DIR, 'contributions.json');

function parseArgs() {
    return {
        force: process.argv.includes('--force'),
    };
}

function fileHasData(filePath) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(data) && data.length > 0;
    } catch {
        return false;
    }
}

function loadJSON(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.error(`Error loading ${filePath}:`, e.message);
        return null;
    }
}

function saveJSON(filePath, data) {
    const lines = data.map(entry => JSON.stringify(entry));
    const output = '[\n' + lines.join(',\n') + '\n]\n';
    fs.writeFileSync(filePath, output);
    console.log(`Saved: ${filePath}`);
}

function getTickersFromTrades(trades) {
    const tickers = new Set();
    for (const trade of trades || []) {
        if (trade?.ticker) tickers.add(trade.ticker);
    }
    return [...tickers].sort();
}

function loadStockPrices(tickers) {
    const stockPrices = {};
    for (const ticker of tickers) {
        const filePath = path.join(STOCK_PRICE_DIR, `${ticker}.json`);
        const data = loadJSON(filePath);
        if (data) {
            stockPrices[ticker] = {};
            for (const row of data) {
                const date = row?.[0];
                const price = row?.[1];
                if (typeof date === 'string' && typeof price === 'number') {
                    stockPrices[ticker][date] = price;
                }
            }
        }
    }
    return stockPrices;
}

function getStockPrice(stockPrices, ticker, dateStr) {
    if (!stockPrices[ticker]) return 0;
    if (stockPrices[ticker][dateStr]) return stockPrices[ticker][dateStr];

    const dates = Object.keys(stockPrices[ticker]).sort();
    let closestPrice = 0;
    for (const d of dates) {
        if (d <= dateStr) closestPrice = stockPrices[ticker][d];
        else break;
    }
    return closestPrice;
}

function getAllDates(trades, stockPrices) {
    const dateSet = new Set();
    for (const trade of trades) {
        dateSet.add(trade.date);
    }
    for (const ticker in stockPrices) {
        for (const date in stockPrices[ticker]) {
            dateSet.add(date);
        }
    }
    return [...dateSet].sort();
}

function generateDateRange(startDate, endDate) {
    const dates = [];
    const current = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');

    while (current <= end) {
        const yyyy = current.getUTCFullYear();
        const mm = String(current.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(current.getUTCDate()).padStart(2, '0');
        dates.push(`${yyyy}-${mm}-${dd}`);
        current.setUTCDate(current.getUTCDate() + 1);
    }

    return dates;
}

function groupContributionsByDate(contributions) {
    const byDate = {};
    for (const [date, amount] of contributions) {
        if (!byDate[date]) byDate[date] = 0;
        byDate[date] += amount;
    }
    return byDate;
}

function calculateNetWorth() {
    const args = parseArgs();

    const existingFiles = [];
    if (fileHasData(NET_WORTH_FILE)) existingFiles.push('networth.json');
    if (fileHasData(CONTRIBUTIONS_FILE)) existingFiles.push('contributions.json');

    if (existingFiles.length > 0 && !args.force) {
        console.error(`Error: ${existingFiles.join(' and ')} already contain data.`);
        console.error('Running this script will overwrite the existing data.');
        console.error('Use --force if you are sure you want to continue.');
        process.exit(1);
    }

    const trades = loadJSON(path.join(DATA_DIR, 'trades.json'));
    if (!trades) {
        console.error('Could not load trades.json');
        process.exit(1);
    }

    const individualContributions = loadJSON(path.join(DATA_DIR, 'individualContributions.json'));
    if (!individualContributions) {
        console.error('Could not load individualContributions.json - run parseContributions.js first');
        process.exit(1);
    }

    const tickers = getTickersFromTrades(trades);
    console.log(`Found ${tickers.length} tickers:`, tickers.join(', '));

    const stockPrices = loadStockPrices(tickers);
    console.log(`Loaded price data for ${Object.keys(stockPrices).length} tickers`);

    const missingTickers = tickers.filter(t => !stockPrices[t]);
    if (missingTickers.length > 0) {
        console.warn('Missing price data for:', missingTickers.join(', '));
    }

    const tradesByDate = {};
    for (const trade of trades) {
        if (!tradesByDate[trade.date]) tradesByDate[trade.date] = [];
        tradesByDate[trade.date].push(trade);
    }

    const contributionsByDate = groupContributionsByDate(individualContributions);
    console.log(`Loaded ${individualContributions.length} contributions on ${Object.keys(contributionsByDate).length} dates`);

    const allDates = getAllDates(trades, stockPrices);
    const firstTradeDate = trades.map(t => t.date).sort()[0];
    const lastDate = allDates[allDates.length - 1];
    const relevantDates = generateDateRange(firstTradeDate, lastDate);

    console.log(`Processing ${relevantDates.length} dates from ${firstTradeDate} to ${lastDate}`);

    const positions = {};
    let cashBalance = 0;
    let cumulativeContributions = 0;

    const netWorthData = [];
    const contributionsData = [];

    for (const dateStr of relevantDates) {
        if (contributionsByDate[dateStr]) {
            cashBalance += contributionsByDate[dateStr];
            cumulativeContributions += contributionsByDate[dateStr];
        }

        const todaysTrades = tradesByDate[dateStr] || [];
        for (const trade of todaysTrades) {
            const price = getStockPrice(stockPrices, trade.ticker, dateStr);
            if (price > 0) {
                const sharesDelta = trade.amount / price;

                if (!positions[trade.ticker]) {
                    positions[trade.ticker] = { shares: 0, costBasis: 0 };
                }
                const pos = positions[trade.ticker];

                if (trade.side === 'BUY') {
                    pos.shares += sharesDelta;
                    pos.costBasis += trade.amount;
                    cashBalance -= trade.amount;
                } else {
                    const sharesBefore = pos.shares;
                    if (sharesBefore > 0) {
                        const sharesSold = Math.min(sharesDelta, sharesBefore);
                        const costPerShare = pos.costBasis / sharesBefore;
                        const soldCost = costPerShare * sharesSold;

                        pos.shares -= sharesSold;
                        pos.costBasis -= soldCost;
                        cashBalance += trade.amount;
                    }
                }
            }
        }

        let stocksValue = 0;
        for (const ticker in positions) {
            const pos = positions[ticker];
            if (pos.shares > 0.0001) {
                const price = getStockPrice(stockPrices, ticker, dateStr);
                stocksValue += pos.shares * price;
            }
        }

        const netWorth = Math.round((stocksValue + cashBalance) * 100) / 100;
        const contributions = Math.round(cumulativeContributions * 100) / 100;

        netWorthData.push([dateStr, netWorth]);
        contributionsData.push([dateStr, contributions]);
    }

    saveJSON(NET_WORTH_FILE, netWorthData);
    saveJSON(CONTRIBUTIONS_FILE, contributionsData);

    const lastEntry = netWorthData[netWorthData.length - 1];
    const lastContrib = contributionsData[contributionsData.length - 1];
    console.log('\n--- Summary ---');
    console.log(`Latest date: ${lastEntry[0]}`);
    console.log(`Net worth: $${lastEntry[1].toLocaleString()}`);
    console.log(`Contributions: $${lastContrib[1].toLocaleString()}`);
    console.log(`Gain/Loss: $${(lastEntry[1] - lastContrib[1]).toLocaleString()}`);
}

calculateNetWorth();
