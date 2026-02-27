import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', '..');

const DATA_DIR = path.join(ROOT_DIR, 'data');
const LOGOS_DIR = path.join(DATA_DIR, 'logos');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');

function loadJSON(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function getTickersFromTrades() {
    const trades = loadJSON(TRADES_FILE);
    if (!trades) return [];
    const tickers = new Set();
    for (const trade of trades) {
        if (trade?.ticker) tickers.add(trade.ticker);
    }
    return [...tickers].sort();
}

function downloadLogo(symbol, outputTicker, apiKey) {
    const url = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png?apikey=${apiKey}`;
    const filePath = path.join(LOGOS_DIR, `${outputTicker}.png`);

    return new Promise((resolve) => {
        https.get(url, (res) => {
            if (res.statusCode === 200) {
                const fileStream = fs.createWriteStream(filePath);
                res.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    if (symbol === outputTicker) {
                        console.log(`  ✓ ${outputTicker}`);
                    } else {
                        console.log(`  ✓ ${outputTicker} (${symbol})`);
                    }
                    resolve(true);
                });
            } else {
                console.log(`  ✗ ${outputTicker} (${symbol}: ${res.statusCode})`);
                res.resume();
                resolve(false);
            }
        }).on('error', (err) => {
            console.log(`  ✗ ${outputTicker} (${symbol}: ${err.message})`);
            resolve(false);
        });
    });
}

async function fetchLogos() {
    const apiKey = process.env.FMP_API_KEY;
    if (!apiKey) {
        console.error('Missing FMP_API_KEY env var. Run: export FMP_API_KEY=your_key');
        process.exit(1);
    }

    const tickers = getTickersFromTrades();
    if (!tickers.length) {
        console.error('No tickers found in trades.json');
        process.exit(1);
    }

    if (!fs.existsSync(LOGOS_DIR)) {
        fs.mkdirSync(LOGOS_DIR, { recursive: true });
    }

    // Check which logos we already have
    const existing = new Set(
        fs.readdirSync(LOGOS_DIR)
            .filter(f => f.endsWith('.png'))
            .map(f => f.replace('.png', ''))
    );

    const toDownload = tickers.filter(t => !existing.has(t));

    console.log(`Found ${tickers.length} tickers, ${existing.size} logos exist, ${toDownload.length} to download\n`);

    if (toDownload.length === 0) {
        console.log('All logos already downloaded.');
        return;
    }

    let success = 0;
    for (const ticker of toDownload) {
        let ok = await downloadLogo(ticker, ticker, apiKey);
        if (!ok && !ticker.includes('.')) {
            ok = await downloadLogo(`${ticker}.TO`, ticker, apiKey);
        }
        if (ok) success++;
        await new Promise(r => setTimeout(r, 100)); // rate limit
    }

    console.log(`\nDownloaded ${success}/${toDownload.length} logos`);
}

fetchLogos();
