'use strict';

const axios   = require('axios');
const AdmZip  = require('adm-zip');
const http    = require('http');
const https   = require('https');

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// ── Settings ─────────────────────────────────────────────────
const NSE_URL    = 'https://api.shoonya.com/NSE_symbols.txt.zip';
const BSE_URL    = 'https://api.shoonya.com/BSE_symbols.txt.zip';

const BATCH_SIZE = 400;
const MAX_PAR    = 25;
const SCAN_MS    = 2000;

const NSE_GROUPS = ['EQ','BE','BZ','SM','ST','SZ'];
const BSE_GROUPS = ['A','B','T','X','XT','Z','ZP','M','MT','MS','TS'];

// ── State ─────────────────────────────────────────────────────
let symbols       = [];
let symbolMeta    = {};
let quoteStore    = new Map();

let headers       = null;
let crumb         = '';

let sessionOk     = false;
let scanRunning   = false;
let lastScanTime  = null;
let scanCount     = 0;

// ── Axios Instance ────────────────────────────────────────────
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: MAX_PAR
});

const axInst = axios.create({
  httpsAgent: agent,
  timeout: 8000
});

// ═══════════════════════════════════════════════════════════════
// STEP 1: LOAD SYMBOLS
// ═══════════════════════════════════════════════════════════════

async function fetchAndFilterSymbols(url, allowedGroups) {

  console.log(`[YAHOO] Downloading: ${url}`);

  const r = await axInst.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000
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
    ['Symbol','TckrSymb','SYMBOL'].includes(h)
  );

  const serIdx = hdrs.findIndex(h =>
    ['Instrument','Series','SctySrs','SERIES'].includes(h)
  );

  const nameIdx = hdrs.findIndex(h =>
    ['CompanyName','CmNm','ShortName','NAME OF COMPANY'].includes(h)
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

    const ser = serIdx >= 0
      ? cols[serIdx]?.trim()
      : 'EQ';

    if (
      allowedGroups.length &&
      !allowedGroups.includes(ser)
    ) continue;

    const name = nameIdx >= 0
      ? cols[nameIdx]?.trim()
      : sym;

    rows.push({
      sym,
      ser,
      name: name || sym
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
      ['SM','ST','SME'].includes(ser)
        ? `${sym}-SM.NS`
        : `${sym}.NS`;

    symbolMeta[yahooSym] = {
      symbol: sym,
      name,
      exchange: 'NSE',
      yahooSym
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
      yahooSym
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
        high: 0,
        low: 0,
        open: 0,
        volume: 0,
        turnoverCr: 0,
        circuit: ''
      });
    }
  }

  return symbols.length;
}

// ═══════════════════════════════════════════════════════════════
// STEP 2: GET SESSION
// ═══════════════════════════════════════════════════════════════

async function getSession() {

  console.log(
    '[YAHOO] Connecting to Yahoo & Fetching Cookies...'
  );

  try {

    const browser = await puppeteer.launch({

      args: chromium.args,

      defaultViewport:
        chromium.defaultViewport,

      executablePath:
        await chromium.executablePath(),

      headless: true

    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
    );

    await page.goto(
      'https://finance.yahoo.com',
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
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
          timeout: 10000
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

    console.log(
      `[YAHOO] Session OK`
    );

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
