import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', '..');

const DATA_DIR = path.join(ROOT_DIR, 'data');
const WS_DIR = path.join(ROOT_DIR, 'csvs', 'wealthsimple', 'monthly_csvs');
const NBDB_DIR = path.join(ROOT_DIR, 'csvs', 'nbdb');
const FX_FILE = path.join(DATA_DIR, 'forex', 'usdcad.json');
const DIVIDENDS_FILE = path.join(DATA_DIR, 'calculatedDividends.json');
const FX_FALLBACK = 1.35;

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
        return null;
    }
}

function parseCSVLine(line, delimiter = ',') {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === delimiter && !inQuotes) {
            result.push(current.trim().replace(/^"|"$/g, ''));
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim().replace(/^"|"$/g, ''));
    return result;
}

function parseNbdbDate(dateStr) {
    const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;
    return `${match[3]}-${match[2]}-${match[1]}`;
}

function loadFxRates() {
    const data = loadJSON(FX_FILE);
    if (!data) return {};
    const rates = {};
    for (const [date, rate] of data) {
        rates[date] = rate;
    }
    return rates;
}

function getFxRate(fxRates, dateStr) {
    if (fxRates[dateStr]) return fxRates[dateStr];
    const dates = Object.keys(fxRates).sort();
    let closestRate = FX_FALLBACK;
    for (const d of dates) {
        if (d <= dateStr) closestRate = fxRates[d];
        else break;
    }
    return closestRate;
}

function loadDividendsFromCSVs(fxRates) {
    const dividendsByDate = {};

    // Parse NBDB (semicolon CSV, Operation = Dividend)
    try {
        const files = fs.readdirSync(NBDB_DIR).filter(f => f.endsWith('.csv'));
        for (const file of files) {
            const content = fs.readFileSync(path.join(NBDB_DIR, file), 'utf8');
            const lines = content.split('\n');
            const header = parseCSVLine(lines[0], ';');
            const opIdx = header.indexOf('Operation');
            const dateIdx = header.indexOf('Trade date');
            const amountIdx = header.indexOf('Net amount');
            const accountIdx = header.indexOf('Account description');

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                const cols = parseCSVLine(line, ';');
                const op = cols[opIdx];
                if (op !== 'Dividend') continue;

                const date = parseNbdbDate(cols[dateIdx]);
                if (!date) continue;

                let amount = parseFloat(cols[amountIdx]?.replace(',', '') || '0');
                if (isNaN(amount) || amount <= 0) continue;

                // USD conversion
                const account = (cols[accountIdx] || '').toUpperCase();
                if (account.includes('USD')) {
                    amount *= getFxRate(fxRates, date);
                }

                if (!dividendsByDate[date]) dividendsByDate[date] = 0;
                dividendsByDate[date] += amount;
            }
        }
    } catch (e) { /* ignore */ }

    // Parse Wealthsimple (comma CSV, DIV = dividend)
    const wsDirs = [WS_DIR];

    for (const csvDir of wsDirs) {
        try {
            const files = fs.readdirSync(csvDir).filter(f => f.endsWith('.csv'));
            for (const file of files) {
                const content = fs.readFileSync(path.join(csvDir, file), 'utf8');
                const lines = content.split('\n');

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    const cols = parseCSVLine(line, ',');
                    const date = cols[0];
                    const txType = (cols[1] || '').toUpperCase();
                    if (txType !== 'DIV') continue;

                    let amount = parseFloat(cols[3] || '0');
                    if (isNaN(amount) || amount <= 0) continue;

                    // Already in CAD per the CSV (FX conversion done by brokerage)
                    if (!dividendsByDate[date]) dividendsByDate[date] = 0;
                    dividendsByDate[date] += amount;
                }
            }
        } catch (e) { /* ignore */ }
    }

    return dividendsByDate;
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

function saveJSON(filePath, data) {
    const lines = data.map(entry => JSON.stringify(entry));
    const output = '[\n' + lines.join(',\n') + '\n]\n';
    fs.writeFileSync(filePath, output);
    console.log(`Saved: ${filePath}`);
}

function calculateDividends() {
    const args = parseArgs();

    if (fileHasData(DIVIDENDS_FILE) && !args.force) {
        console.error('Error: calculatedDividends.json already contains data.');
        console.error('Running this script will overwrite the existing data.');
        console.error('Use --force if you are sure you want to continue.');
        process.exit(1);
    }

    // Load FX rates
    const fxRates = loadFxRates();
    console.log(`Loaded ${Object.keys(fxRates).length} FX rates`);

    // Load dividends from CSVs
    const dividendsByDate = loadDividendsFromCSVs(fxRates);
    const divDates = Object.keys(dividendsByDate).sort();
    console.log(`Found dividends on ${divDates.length} dates`);

    if (divDates.length === 0) {
        console.log('No dividend data found');
        return;
    }

    // Generate date range
    const firstDate = divDates[0];
    const today = new Date().toISOString().slice(0, 10);
    const allDates = generateDateRange(firstDate, today);

    console.log(`Processing ${allDates.length} dates from ${firstDate} to ${today}`);

    // Build cumulative dividend data
    let cumulativeDividends = 0;
    const dividendData = [];

    for (const dateStr of allDates) {
        if (dividendsByDate[dateStr]) {
            cumulativeDividends += dividendsByDate[dateStr];
        }
        const cumDiv = Math.round(cumulativeDividends * 100) / 100;
        dividendData.push([dateStr, cumDiv]);
    }

    // Save results
    saveJSON(DIVIDENDS_FILE, dividendData);

    // Summary
    const lastEntry = dividendData[dividendData.length - 1];
    console.log('\n--- Summary ---');
    console.log(`Latest date: ${lastEntry[0]}`);
    console.log(`Total dividend income: $${lastEntry[1].toLocaleString()}`);
}

calculateDividends();
