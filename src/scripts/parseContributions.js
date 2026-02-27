import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', '..');

const DATA_DIR = path.join(ROOT_DIR, 'data');
const WS_MONTHLY_DIR = path.join(ROOT_DIR, 'csvs', 'wealthsimple', 'monthly_csvs');
const WS_MONTHLY_BULK_DIR = path.join(ROOT_DIR, 'csvs', 'wealthsimple', 'monthly-statements-2017-01-to-2026-02');
const NBDB_DIR = path.join(ROOT_DIR, 'csvs', 'nbdb');
const RBC_DIR = path.join(ROOT_DIR, 'csvs', 'rbc');
const FX_FILE = path.join(DATA_DIR, 'forex', 'usdcad.json');
const FX_FALLBACK = 1.35;

const MONTH_TO_NUM = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
};

const RBC_ACTIVITY_RE = /(?:^|\b)(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\.?\s*(\d{1,2})\s+([A-Z]+)\b\s*(.*)$/i;
const RBC_STATEMENT_DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;
const RBC_FX_RE = /Exchange rate 1USD = ([0-9.]+) CAD/i;
const MONEY_TOKEN_RE = /\$?(?:\d{1,3}(?:,\d{3})+|\d+\.\d+)-?/g;

function loadJSON(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function saveJSON(filePath, data) {
    const lines = data.map(entry => JSON.stringify(entry));
    const output = '[\n' + lines.join(',\n') + '\n]\n';
    fs.writeFileSync(filePath, output);
    console.log(`Saved: ${filePath}`);
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

function normalizeSpace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function parseMoney(text) {
    if (text == null) return null;
    let cleaned = String(text).replace(/\$/g, '').replace(/,/g, '').trim();
    if (!cleaned) return null;
    // RBC sometimes prints accounting negative as trailing minus.
    if (cleaned.endsWith('-')) cleaned = `-${cleaned.slice(0, -1)}`;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

function extractMoneyValues(text) {
    const values = [];
    const matches = String(text || '').match(MONEY_TOKEN_RE) || [];
    for (const m of matches) {
        const n = parseMoney(m);
        if (Number.isFinite(n)) values.push(n);
    }
    return values;
}

function monthTokenToNumber(token) {
    let m = String(token || '').toUpperCase().replace(/\./g, '');
    if (m.startsWith('SEPT')) m = 'SEP';
    m = m.slice(0, 3);
    return MONTH_TO_NUM[m] || null;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function getWealthsimpleDirToParse() {
    const candidates = [WS_MONTHLY_DIR, WS_MONTHLY_BULK_DIR];
    for (const dir of candidates) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'));
        if (files.length) return { dir, files };
    }
    return null;
}

function listRbcPdfFiles() {
    if (!fs.existsSync(RBC_DIR)) return [];
    const names = fs.readdirSync(RBC_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
    const nameSet = new Set(names);
    const deduped = names.filter((name) => {
        const m = name.match(/^(.*)-\d+\.pdf$/i);
        if (!m) return true;
        const base = `${m[1]}.pdf`;
        return !nameSet.has(base);
    });
    return deduped.map((name) => path.join(RBC_DIR, name));
}

function extractPdfPagesWithSwift(pdfPaths) {
    if (!pdfPaths.length) return {};

    const script = `
import Foundation
import PDFKit

for filePath in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: filePath)
    guard let doc = PDFDocument(url: url) else { continue }
    var pages: [String] = []
    pages.reserveCapacity(doc.pageCount)
    for i in 0..<doc.pageCount {
        pages.append(doc.page(at: i)?.string ?? "")
    }
    let row: [String: Any] = ["file": filePath, "pages": pages]
    if let data = try? JSONSerialization.data(withJSONObject: row),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}
`;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folioscout-rbc-'));
    const scriptPath = path.join(tempDir, 'extract.swift');
    fs.writeFileSync(scriptPath, script, 'utf8');

    const moduleCache = '/tmp/folioscout-swift-module-cache';
    fs.mkdirSync(moduleCache, { recursive: true });

    const res = spawnSync(
        'swift',
        ['-module-cache-path', moduleCache, scriptPath, ...pdfPaths],
        {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        }
    );

    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
        // no-op
    }

    if (res.error) {
        throw new Error(`Swift PDF extraction failed: ${res.error.message}`);
    }
    if (res.status !== 0) {
        throw new Error(`Swift PDF extraction failed: ${res.stderr?.slice(0, 800) || 'unknown error'}`);
    }

    const byFile = {};
    const lines = (res.stdout || '').split('\n');
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith('{')) continue;
        try {
            const row = JSON.parse(line);
            const fileKey = path.resolve(row.file || '');
            if (fileKey && Array.isArray(row.pages)) {
                byFile[fileKey] = row.pages;
            }
        } catch (_) {
            // skip invalid JSON lines
        }
    }

    return byFile;
}

function getRbcStatementDateParts(pdfPath) {
    const m = path.basename(pdfPath).match(RBC_STATEMENT_DATE_RE);
    if (!m) return null;
    return {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
    };
}

function getRbcStatementFxRate(pages) {
    for (const page of pages || []) {
        const m = String(page || '').match(RBC_FX_RE);
        if (!m) continue;
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

function classifyRbcContributionActivity(activity, restUpper) {
    if (activity === 'CONTRIB' || activity === 'CONTRIBUTION' || activity === 'CONT') return 1;
    if (activity === 'TFRIN' || activity === 'TRFIN' || activity === 'TRFINTF') return 1;
    if (activity === 'TFR' && restUpper.startsWith('IN ')) return 1;

    if (activity === 'WD' || activity === 'WITHDRAWAL') return -1;
    if (activity === 'TRFOUT' || activity === 'TFROUT') return -1;
    if (activity === 'TFR' && restUpper.startsWith('OUT ')) return -1;

    return 0;
}

function isRbcInternalFxTransfer(activity, restUpper) {
    if (activity === 'TRF' && restUpper.includes('FOREIGNEXCHANGE')) return true;
    if (activity === 'TRF' && restUpper.includes('FOREIGN EXCHANGE')) return true;
    if (activity === 'TFR' && restUpper.includes('FOREIGNEXCHANGE')) return true;
    if (activity === 'TFR' && restUpper.includes('FOREIGN EXCHANGE')) return true;
    return false;
}

function parseRbcContributions(fxRates) {
    const pdfPaths = listRbcPdfFiles();
    if (!pdfPaths.length) return [];

    let pagesByFile = {};
    try {
        pagesByFile = extractPdfPagesWithSwift(pdfPaths);
    } catch (e) {
        console.warn(`Failed to parse RBC PDFs: ${e.message}`);
        return [];
    }

    const contributions = [];

    for (const pdfPath of pdfPaths) {
        const key = path.resolve(pdfPath);
        const pages = pagesByFile[key];
        if (!Array.isArray(pages) || !pages.length) continue;

        const dateParts = getRbcStatementDateParts(pdfPath);
        if (!dateParts) continue;

        const statementFx = getRbcStatementFxRate(pages);
        let inActivity = false;
        let current = null;
        let recentStandaloneValues = [];

        const rememberStandaloneValues = (line) => {
            if (!line) return;
            // We only use this for odd RBC layouts where debit/credit values
            // are printed on lines adjacent to, not on, the activity line.
            if (/[A-Za-z]/.test(line)) return;
            const values = extractMoneyValues(line).map((v) => Math.abs(v));
            if (!values.length) return;
            recentStandaloneValues.push(...values);
            if (recentStandaloneValues.length > 8) {
                recentStandaloneValues = recentStandaloneValues.slice(-8);
            }
        };

        const flushCurrent = () => {
            if (!current) return;
            if (!Number.isFinite(current.amount) || current.amount <= 0) {
                current = null;
                return;
            }

            let amountCad = current.amount;
            if (current.currency === 'USD') {
                const fx = (Number.isFinite(statementFx) && statementFx > 0)
                    ? statementFx
                    : getFxRate(fxRates, current.dateStr);
                amountCad = amountCad * fx;
            }

            contributions.push([current.dateStr, round2(current.sign * amountCad)]);
            current = null;
        };

        for (const page of pages) {
            const pageCurrency = page.includes('Statement (U.S.$)') ? 'USD' : 'CAD';
            const lines = page.split('\n').map(normalizeSpace).filter(Boolean);

            for (const line of lines) {
                if (line.includes('FOOTNOTES')) {
                    flushCurrent();
                    inActivity = false;
                    recentStandaloneValues = [];
                    continue;
                }
                if (line.includes('Account Activity')) {
                    flushCurrent();
                    inActivity = true;
                    recentStandaloneValues = [];
                    continue;
                }
                if (!inActivity) continue;

                if (line.startsWith('Closing Balance')) {
                    flushCurrent();
                    inActivity = false;
                    recentStandaloneValues = [];
                    continue;
                }

                rememberStandaloneValues(line);

                const m = line.match(RBC_ACTIVITY_RE);
                if (m) {
                    flushCurrent();

                    const monthNum = monthTokenToNumber(m[1]);
                    const dayNum = Number(m[2]);
                    const activity = String(m[3] || '').toUpperCase();
                    const rest = normalizeSpace(m[4] || '');
                    const restUpper = rest.toUpperCase();

                    if (!monthNum || !Number.isFinite(dayNum)) {
                        current = null;
                        recentStandaloneValues = [];
                        continue;
                    }

                    const sign = classifyRbcContributionActivity(activity, restUpper);
                    if (!sign || isRbcInternalFxTransfer(activity, restUpper)) {
                        current = null;
                        recentStandaloneValues = [];
                        continue;
                    }

                    let year = dateParts.year;
                    if (dateParts.month === 1 && monthNum === 12) year -= 1;
                    const dateStr = `${year}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;

                    const restValues = extractMoneyValues(rest).map((v) => Math.abs(v));
                    let amount = restValues.length ? Math.max(...restValues) : null;

                    // Some RBC transfer rows place the true debit/credit value
                    // on adjacent standalone-number lines rather than on the
                    // TFR/TFRIN line itself.
                    const isTransferEvent = activity === 'TFR' || activity === 'TFRIN' || activity === 'TRFIN' || activity === 'TRFINTF' || activity === 'TFRIN';
                    if (isTransferEvent && recentStandaloneValues.length) {
                        const nearbyMax = Math.max(...recentStandaloneValues);
                        if (!Number.isFinite(amount) || nearbyMax > (amount * 5)) {
                            amount = nearbyMax;
                        }
                    }

                    current = {
                        dateStr,
                        sign,
                        currency: pageCurrency,
                        amount,
                    };
                    recentStandaloneValues = [];
                    continue;
                }

                if (!current) continue;
                if (
                    line === 'PRICE' ||
                    line === 'DATE ACTIVITY DESCRIPTION' ||
                    line === 'QUANTITY \\RATE DEBIT CREDIT' ||
                    line.startsWith('Opening Balance')
                ) {
                    continue;
                }

                const values = extractMoneyValues(line).map((v) => Math.abs(v));
                if (!values.length) continue;

                const candidate = Math.max(...values);
                if (!Number.isFinite(current.amount) || candidate > current.amount) {
                    current.amount = candidate;
                }
            }
        }

        flushCurrent();
    }

    console.log(`Parsed RBC contributions from ${pdfPaths.length} statements`);
    return contributions;
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

function parseContributions() {
    const fxRates = loadFxRates();
    console.log(`Loaded ${Object.keys(fxRates).length} FX rates`);

    const contributions = [];

    // Parse NBDB
    try {
        if (fs.existsSync(NBDB_DIR)) {
            const files = fs.readdirSync(NBDB_DIR).filter(f => f.endsWith('.csv'));
            for (const file of files) {
                const content = fs.readFileSync(path.join(NBDB_DIR, file), 'utf8');
                const lines = content.split('\n');
                const header = parseCSVLine(lines[0], ';');
                const opIdx = header.indexOf('Operation');
                const dateIdx = header.indexOf('Trade date');
                const amountIdx = header.indexOf('Net amount');
                const currencyIdx = header.indexOf('Currency');
                const marketIdx = header.indexOf('Market');
                const accountIdx = header.indexOf('Account description');

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;
                    const cols = parseCSVLine(line, ';');
                    const op = cols[opIdx];
                    if (op !== 'Contribution' && op !== 'Withdrawal') continue;

                    const date = parseNbdbDate(cols[dateIdx]);
                    if (!date) continue;

                    let amount = Math.abs(parseFloat(cols[amountIdx]?.replace(',', '') || '0'));
                    if (isNaN(amount)) continue;

                    const currency = (cols[currencyIdx] || '').toUpperCase();
                    const market = (cols[marketIdx] || '').toUpperCase();
                    const account = (cols[accountIdx] || '').toUpperCase();
                    if (currency === 'USD' || market === 'USA' || account.includes('USD')) {
                        amount *= getFxRate(fxRates, date);
                    }

                    const signedAmount = op === 'Contribution' ? amount : -amount;
                    contributions.push([date, Math.round(signedAmount * 100) / 100]);
                }
            }
            console.log(`Parsed NBDB: ${files.length} files`);
        }
    } catch (e) {
        console.warn(`Failed to parse NBDB: ${e.message}`);
    }

    // Parse Wealthsimple
    const inTypes = ['CONT', 'TRFIN'];
    const outTypes = ['TRFOUT', 'WD'];
    const wsDirInfo = getWealthsimpleDirToParse();
    if (wsDirInfo) {
        const { dir: csvDir, files } = wsDirInfo;
        try {
            for (const file of files) {
                const content = fs.readFileSync(path.join(csvDir, file), 'utf8');
                const lines = content.split('\n');

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    const cols = parseCSVLine(line, ',');
                    const date = cols[0];
                    const txType = (cols[1] || '').toUpperCase();
                    let amount = Math.abs(parseFloat(cols[3] || '0'));
                    if (isNaN(amount)) continue;

                    const currency = (cols[5] || '').toUpperCase();
                    if (currency === 'USD') amount *= getFxRate(fxRates, date);

                    if (inTypes.includes(txType)) {
                        contributions.push([date, round2(amount)]);
                    } else if (outTypes.includes(txType)) {
                        contributions.push([date, round2(-amount)]);
                    }
                }
            }
            console.log(`Parsed WS (${path.basename(csvDir)}): ${files.length} files`);
        } catch (e) {
            console.warn(`Failed to parse ${csvDir}: ${e.message}`);
        }
    } else {
        console.log('Parsed WS: no monthly statement CSV folder found');
    }

    // Parse RBC statement cashflow events (contributions/withdrawals)
    const rbcContributions = parseRbcContributions(fxRates);
    contributions.push(...rbcContributions);

    contributions.sort((a, b) => a[0].localeCompare(b[0]));

    saveJSON(path.join(DATA_DIR, 'individualContributions.json'), contributions);

    const total = contributions.reduce((sum, [, amt]) => sum + amt, 0);
    console.log(`\nTotal: ${contributions.length} contributions, $${total.toFixed(2)}`);
}

parseContributions();
