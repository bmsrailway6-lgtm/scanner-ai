'use strict';

const axios = require('axios');
const AdmZip = require('adm-zip');
const https = require('https');

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// ─────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────

const NSE_URL = 'https://api.shoonya.com/NSE_symbols.txt.zip';
const BSE_URL = 'https://api.shoonya.com/BSE_symbols.txt.zip';

const BATCH_SIZE = 400;
const MAX_PAR = 25;
const SCAN_MS = 2000;

const NSE_GROUPS = ['EQ', 'BE', 'BZ', 'SM', 'ST', 'SZ'];
const BSE_GROUPS = ['A', 'B', 'T', 'X', 'XT', 'Z', 'ZP', 'M', 'MT', 'MS', 'TS'];

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────

let symbols = [];
let symbolMeta = {};

let quoteStore = new Map();

let headers = null;
let crumb = '';

let sessionOk = false;
let scanRunning = false;

let lastScanTime = null;
let scanCount = 0;

// ─────────────────────────────────────────────────────────────
// AXIOS INSTANCE
// ─────────────────────────────────────────────────────────────

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: MAX_PAR,
});

const axInst = axios.create({
  httpsAgent: agent,
  timeout: 10000,
});

// ─────────────────────────────────────────────────────────────
// LOAD SYMBOLS
// ─────────────────────────────────────────────────────────────

async function fetchAndFilterSymbols(url, allowedGroups) {

  console.log(`[YAHOO] Downloading: ${url}`);

  const r = await axInst.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  const zip = new AdmZip(Buffer.from(r.data));

  const csv = zip
    .getEntries()[0]
    .getData()
    .toString('utf8');

  const lines = csv.split('\n');

  const hdrs = lines[0]
    .split(',')
    .map(h => h.trim().replace(/"/g, ''));

  const symIdx = hdrs.findIndex(h =>
    ['Symbol', 'TckrSymb', 'SYMBOL'].includes(h)
  );

  const serIdx = hdrs.findIndex(h =>
    ['Instrument', 'Series', 'SctySrs', 'SERIES'].includes(h)
  );

  const nameIdx = hdrs.findIndex(h =>
    ['CompanyName', 'CmNm', 'ShortName', 'NAME OF COMPANY'].includes(h)
  );

  const rows = [];

  for (let i = 1; i < lines.length; i++) {

    const cols = lines[i]
      .split(',')
      .map(x => x.trim().replace(/"/g, ''));

    const sym = cols[symIdx]?.trim().toUpperCase();

    if (!sym) continue;
    if (sym === 'NAN') continue;
    if (sym === 'NONE') continue;
    if (sym === 'SYMBOL') continue;

    const ser =
      serIdx >= 0
        ? cols[serIdx]?.trim()
        : 'EQ';

    if (
      allowedGroups.length &&
      !allowedGroups.includes(ser)
    ) continue;

    const name =
      nameIdx >= 0
        ? cols[nameIdx]?.trim()
        : sym;

    rows.push({
      sym,
      ser,
      name: name || sym,
    });
  }

  return rows;
}

async function loadSymbols() {

  const [nseRes, bseRes] = await Promise.allSettled([
    fetchAndFilterSymbols(NSE_URL, NSE_GROUPS),
    fetchAndFilterSymbols(BSE_URL, BSE_GROUPS),
  ]);

  const nseRows =
    nseRes.status === 'fulfilled'
      ? nseRes.value
      : [];

  const bseRows =
    bseRes.status === 'fulfilled'
      ? bseRes.value
      : [];

  symbols = [];
  symbolMeta = {};

  const seen = new Set();

  // NSE FIRST

  for (const { sym, ser, name } of nseRows) {

    if (!sym) continue;
    if (seen.has(sym)) continue;

    seen.add(sym);

    const yahooSym =
      ['SM', 'ST', 'SME'].includes(ser)
        ? `${sym}-SM.NS`
        : `${sym}.NS`;

    symbolMeta[yahooSym] = {
      symbol: sym,
      name,
      exchange: 'NSE',
      yahooSym,
    };

    symbols.push(yahooSym);
  }

  // BSE SECOND

  for (const { sym, name } of bseRows) {

    if (!sym) continue;
    if (seen.has(sym)) continue;

    seen.add(sym);

    const yahooSym = `${sym}.BO`;

    symbolMeta[yahooSym] = {
      symbol: sym,
      name,
      exchange: 'BSE',
      yahooSym,
    };

    symbols.push(yahooSym);
  }

  console.log(
    `[YAHOO] TOTAL UNIQUE VALID STOCKS LOADED: ${symbols.length}`
  );

  for (const ys of symbols) {

    if (!quoteStore.has(ys)) {

      const m = symbolMeta[ys];

      quoteStore.set(ys, {
        symbol: m.symbol,
        name: m.name,
        yahooSym: ys,
        exchange: m.exchange,
        ltp: 0,
        prevClose: 0,
        change: 0,
        pChange: 0,
        open: 0,
        high: 0,
        low: 0,
        volume: 0,
        turnoverCr: 0,
        circuit: '',
      });
    }
  }

  return symbols.length;
}

// ─────────────────────────────────────────────────────────────
// YAHOO SESSION
// ─────────────────────────────────────────────────────────────

async function getSession() {

  console.log('[YAHOO] Connecting to Yahoo...');

  try {

    const executablePath =
      await chromium.executablePath();

    const browser = await puppeteer.launch({

      args: chromium.args,

      defaultViewport:
        chromium.defaultViewport,

      executablePath,

      headless: true,

    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
    );

    await page.goto(
      'https://finance.yahoo.com',
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }
    );

    const cookies = await page.cookies();

    await browser.close();

    const cookieStr = cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',

      'Cookie': cookieStr,

      'Accept':
        'application/json, text/plain, */*',

      'Accept-Language':
        'en-US,en;q=0.9',
    };

    try {

      const cr = await axInst.get(
        'https://query1.finance.yahoo.com/v1/test/getcrumb',
        {
          headers,
          timeout: 10000,
        }
      );

      crumb =
        (cr.data || '')
          .toString()
          .trim();

    } catch (_) {

      crumb = '';

    }

    sessionOk = true;

    console.log('[YAHOO] Session OK');

    return true;

  } catch (e) {

    console.error(
      '[YAHOO] Puppeteer failed:',
      e.message
    );

    sessionOk = false;

    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// FETCH BATCH
// ─────────────────────────────────────────────────────────────

async function fetchBatch(batch) {

  for (const base of [
    'https://query1.finance.yahoo.com',
    'https://query2.finance.yahoo.com',
  ]) {

    try {

      const params = {
        symbols: batch.join(','),
        region: 'IN',
        lang: 'en-IN',
      };

      if (crumb) {
        params.crumb = crumb;
      }

      const r = await axInst.get(
        `${base}/v7/finance/quote`,
        {
          headers,
          params,
        }
      );

      const result =
        r.data?.quoteResponse?.result || [];

      if (result.length > 0) {
        return result;
      }

    } catch (e) {

      if (
        e.response?.status === 401 ||
        e.response?.status === 403
      ) {
        sessionOk = false;
      }
    }
  }

  return [];
}

// ─────────────────────────────────────────────────────────────
// CIRCUIT DETECTION
// ─────────────────────────────────────────────────────────────

function detectCircuit(ltp, high, low, chg) {

  const pctVal = Math.abs(chg);

  const nearLimit =
    (pctVal >= 1.9 && pctVal <= 2.1) ||
    (pctVal >= 4.9 && pctVal <= 5.1) ||
    (pctVal >= 9.9 && pctVal <= 10.1) ||
    (pctVal >= 19.9 && pctVal <= 20.1);

  if (!nearLimit) return '';

  if (
    chg > 0 &&
    high > 0 &&
    Math.abs(ltp - high) / high <= 0.0015
  ) {
    return 'UC';
  }

  if (
    chg < 0 &&
    low > 0 &&
    Math.abs(ltp - low) / low <= 0.0015
  ) {
    return 'LC';
  }

  return '';
}

// ─────────────────────────────────────────────────────────────
// SCAN
// ─────────────────────────────────────────────────────────────

async function scan() {

  if (scanRunning) return;
  if (!sessionOk) return;

  scanRunning = true;

  try {

    const batches = [];

    for (
      let i = 0;
      i < symbols.length;
      i += BATCH_SIZE
    ) {
      batches.push(
        symbols.slice(i, i + BATCH_SIZE)
      );
    }

    const groups = [];

    for (
      let i = 0;
      i < batches.length;
      i += MAX_PAR
    ) {
      groups.push(
        batches.slice(i, i + MAX_PAR)
      );
    }

    for (const grp of groups) {

      const settled =
        await Promise.allSettled(
          grp.map(b => fetchBatch(b))
        );

      for (const res of settled) {

        if (res.status !== 'fulfilled') {
          continue;
        }

        for (const stock of res.value) {

          const ys = stock.symbol || '';

          if (!ys) continue;
          if (!symbolMeta[ys]) continue;

          const ltp =
            stock.regularMarketPrice || 0;

          if (ltp <= 0) continue;

          const prevClose =
            stock.regularMarketPreviousClose || 0;

          const chg =
            prevClose > 0
              ? ((ltp - prevClose) / prevClose) * 100
              : stock.regularMarketChangePercent || 0;

          const high =
            stock.regularMarketDayHigh || 0;

          const low =
            stock.regularMarketDayLow || 0;

          const vol =
            stock.regularMarketVolume || 0;

          const turnoverCr =
            vol > 0
              ? +(ltp * vol / 1e7).toFixed(2)
              : 0;

          const circuit =
            detectCircuit(
              ltp,
              high,
              low,
              chg
            );

          quoteStore.set(ys, {

            symbol:
              symbolMeta[ys].symbol,

            name:
              stock.shortName ||
              symbolMeta[ys].name,

            yahooSym: ys,

            exchange:
              symbolMeta[ys].exchange,

            ltp: +ltp.toFixed(2),

            prevClose:
              +prevClose.toFixed(2),

            change:
              +(ltp - prevClose).toFixed(2),

            pChange:
              +chg.toFixed(2),

            open: 0,

            high:
              +high.toFixed(2),

            low:
              +low.toFixed(2),

            volume: vol,

            turnoverCr,

            circuit,
          });
        }
      }
    }

    lastScanTime =
      new Date().toISOString();

    scanCount++;

    if (scanCount % 10 === 0) {

      console.log(
        `[YAHOO] Scan #${scanCount} | Live Quotes: ${getAllQuotes().length}`
      );
    }

  } catch (e) {

    console.error(
      '[YAHOO] Scan error:',
      e.message
    );

  }

  scanRunning = false;
}

// ─────────────────────────────────────────────────────────────
// LOOP
// ─────────────────────────────────────────────────────────────

let loopTimer = null;

async function startLoop() {

  await loadSymbols();

  await getSession();

  console.log(
    '[YAHOO] Live scanner started'
  );

  async function loop() {

    try {

      if (!sessionOk) {

        console.log(
          '[YAHOO] Reconnecting session...'
        );

        await getSession();
      }

      await scan();

    } catch (e) {

      console.error(
        '[YAHOO] Loop error:',
        e.message
      );

      sessionOk = false;
    }

    loopTimer =
      setTimeout(loop, SCAN_MS);
  }

  loop();
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

function getAllQuotes() {
  return Array.from(quoteStore.values())
    .filter(q => q.ltp > 0);
}

function getQuoteStore() {
  return quoteStore;
}

function getSymbols() {
  return symbols;
}

function getSymbolMeta() {
  return symbolMeta;
}

function getStockInfo() {
  return {
    total: symbols.length,
    liveQuotes: getAllQuotes().length,
    lastScanTime,
    scanCount,
  };
}

function getQuote(sym) {

  if (quoteStore.has(sym)) {
    return quoteStore.get(sym);
  }

  const ns =
    sym.replace(/\.(NS|BO)$/,'');

  return (
    quoteStore.get(ns + '.NS') ||
    quoteStore.get(ns + '.BO') ||
    null
  );
}

module.exports = {
  startLoop,
  getSession,
  getAllQuotes,
  getQuoteStore,
  getSymbols,
  getSymbolMeta,
  getStockInfo,
  getQuote,

  get _headers() {
    return headers;
  },
};
