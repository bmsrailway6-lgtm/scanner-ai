/**
 * yahooFetcher.js — Exact Node.js port of yahoo_live_auto.py
 * =============================================================
 * Python used: Playwright (browser) → cookies + crumb → Yahoo v7/finance/quote
 * Node uses:   Puppeteer (browser) → cookies + crumb → Yahoo v7/finance/quote
 * 
 * Fetches every 2s: symbol, name, ltp, high, low, volume, turnoverCr, circuit tag
 * Everything else (candles/MAs) fetched separately via Yahoo spark API
 */
'use strict';

const axios   = require('axios');
const AdmZip  = require('adm-zip');
const http    = require('http');
const https   = require('https');

// ── Settings (same as Python) ─────────────────────────────────
const NSE_URL    = 'https://api.shoonya.com/NSE_symbols.txt.zip';
const BSE_URL    = 'https://api.shoonya.com/BSE_symbols.txt.zip';
const BATCH_SIZE = 400;
const MAX_PAR    = 25;
const SCAN_MS    = 2000; // 2 seconds like Python

const NSE_GROUPS = ['EQ','BE','BZ','SM','ST','SZ'];
const BSE_GROUPS = ['A','B','T','X','XT','Z','ZP','M','MT','MS','TS'];

// ── State ─────────────────────────────────────────────────────
let symbols     = [];   // ['RELIANCE.NS', 'TCS.NS', ...]
let symbolMeta  = {};   // yahooSym → { symbol, name, exchange }
let quoteStore  = new Map(); // yahooSym → quote object
let headers     = null;
let crumb       = '';
let sessionOk   = false;
let scanRunning = false;
let lastScanTime = null;
let scanCount   = 0;

// Reuse TCP connections exactly like Python's HTTPAdapter
const agent = new https.Agent({ keepAlive: true, maxSockets: MAX_PAR });
const axInst = axios.create({ httpsAgent: agent, timeout: 8000 });

// ═══════════════════════════════════════════════════════════════
// STEP 1: LOAD SYMBOLS — exact port of Python fetch_and_filter_symbols
// ═══════════════════════════════════════════════════════════════
async function fetchAndFilterSymbols(url, allowedGroups) {
  console.log(`[YAHOO] Downloading: ${url}`);
  const r = await axInst.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const zip = new AdmZip(Buffer.from(r.data));
  const csv = zip.getEntries()[0].getData().toString('utf8');
  const lines = csv.split('\n');
  const hdrs = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

  // Find columns
  const symIdx  = hdrs.findIndex(h => ['Symbol','TckrSymb','SYMBOL'].includes(h));
  const serIdx  = hdrs.findIndex(h => ['Instrument','Series','SctySrs','SERIES'].includes(h));
  const nameIdx = hdrs.findIndex(h => ['CompanyName','CmNm','ShortName','NAME OF COMPANY'].includes(h));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(x => x.trim().replace(/"/g, ''));
    const sym  = cols[symIdx]?.trim().toUpperCase();
    if (!sym || sym === 'NAN' || sym === 'NONE' || sym === 'SYMBOL') continue;
    const ser  = serIdx >= 0 ? cols[serIdx]?.trim() : 'EQ';
    if (allowedGroups.length && !allowedGroups.includes(ser)) continue;
    const name = nameIdx >= 0 ? cols[nameIdx]?.trim() : sym;
    rows.push({ sym, ser, name: name || sym });
  }
  return rows;
}

async function loadSymbols() {
  const [nseRes, bseRes] = await Promise.allSettled([
    fetchAndFilterSymbols(NSE_URL, NSE_GROUPS),
    fetchAndFilterSymbols(BSE_URL, BSE_GROUPS),
  ]);

  const nseRows = nseRes.status === 'fulfilled' ? nseRes.value : [];
  const bseRows = bseRes.status === 'fulfilled' ? bseRes.value : [];

  symbols = [];
  symbolMeta = {};
  const seen = new Set();

  // NSE FIRST (priority) — exact same logic as Python
  for (const { sym, ser, name } of nseRows) {
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    // FORCED SME FIX — exact same as Python
    const yahooSym = ['SM','ST','SME'].includes(ser) ? `${sym}-SM.NS` : `${sym}.NS`;
    if (!symbolMeta[yahooSym]) {
      symbolMeta[yahooSym] = { symbol: sym, name, exchange: 'NSE', yahooSym };
      symbols.push(yahooSym);
    }
  }

  // BSE — skip if already in NSE (exact same as Python)
  for (const { sym, name } of bseRows) {
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    const yahooSym = `${sym}.BO`;
    if (!symbolMeta[yahooSym]) {
      symbolMeta[yahooSym] = { symbol: sym, name, exchange: 'BSE', yahooSym };
      symbols.push(yahooSym);
    }
  }

  console.log(`[YAHOO] TOTAL UNIQUE VALID STOCKS LOADED (NSE + BSE): ${symbols.length}`);
  
  // Pre-fill quoteStore with empty entries
  for (const ys of symbols) {
    if (!quoteStore.has(ys)) {
      const m = symbolMeta[ys];
      quoteStore.set(ys, { symbol: m.symbol, name: m.name, yahooSym: ys, exchange: m.exchange,
        ltp: 0, prevClose: 0, change: 0, pChange: 0, high: 0, low: 0, open: 0,
        volume: 0, turnoverCr: 0, circuit: '' });
    }
  }
  return symbols.length;
}

// ═══════════════════════════════════════════════════════════════
// STEP 2: GET SESSION — Puppeteer port of Python get_session()
// Uses real browser to get Yahoo cookies + crumb
// ═══════════════════════════════════════════════════════════════
async function getSession() {
  console.log('[YAHOO] Connecting to Yahoo & Fetching Cookies...');
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch(e) {
    // puppeteer not installed — try puppeteer-core
    try { puppeteer = require('puppeteer-core'); } catch(_) { puppeteer = null; }
  }

  if (puppeteer) {
    // Exact port of Python playwright get_session()
    try {
      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
               '--disable-gpu','--no-first-run','--no-zygote','--single-process'],
        executablePath: process.env.PUPPETEER_EXEC_PATH || undefined,
      });
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await page.goto('https://finance.yahoo.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      const cookies = await page.cookies();
      await browser.close();

      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookieStr,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      };

      try {
        const cr = await axInst.get('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers, timeout: 10000 });
        crumb = (cr.data || '').toString().trim();
      } catch(_) { crumb = ''; }

      sessionOk = true;
      console.log(`[YAHOO] Session OK — crumb: ${crumb ? crumb.slice(0,8)+'...' : 'empty'}`);
      return true;
    } catch(e) {
      console.warn('[YAHOO] Puppeteer failed:', e.message);
    }
  }

  // Fallback: no-browser cookie fetch (works when Yahoo not fully blocking)
  return getSessionNoBrowser();
}

async function getSessionNoBrowser() {
  console.log('[YAHOO] Trying no-browser session...');
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  ];
  for (const ua of UAS) {
    try {
      const r = await axios.get('https://finance.yahoo.com', {
        headers: { 'User-Agent': ua, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        timeout: 15000, maxRedirects: 5,
      });
      const raw = r.headers['set-cookie'] || [];
      if (!raw.length) continue;
      const cookieStr = raw.map(c => c.split(';')[0]).join('; ');
      headers = { 'User-Agent': ua, 'Cookie': cookieStr, 'Accept': 'application/json,*/*' };
      try {
        const cr = await axInst.get('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers, timeout: 10000 });
        crumb = (cr.data || '').toString().trim();
      } catch(_) { crumb = ''; }
      sessionOk = true;
      console.log(`[YAHOO] No-browser session OK — crumb: ${crumb ? crumb.slice(0,8)+'...' : 'empty'}`);
      return true;
    } catch(_) {}
  }
  // Last resort — no cookies, just UA
  headers = { 'User-Agent': UAS[0], 'Accept': 'application/json,*/*' };
  crumb = '';
  sessionOk = true;
  console.log('[YAHOO] Minimal session (no cookies)');
  return true;
}

// ═══════════════════════════════════════════════════════════════
// STEP 3: FETCH ONE BATCH — exact port of Python fetch_batch()
// ═══════════════════════════════════════════════════════════════
async function fetchBatch(batch) {
  // Try both query1 and query2 (same as Python fallback)
  for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const params = {
        symbols: batch.join(','),
        fields: 'shortName,regularMarketPrice,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,regularMarketChangePercent,regularMarketPreviousClose',
        region: 'IN',
        lang: 'en-IN',
      };
      if (crumb) params.crumb = crumb;
      const r = await axInst.get(`${base}/v7/finance/quote`, { headers, params });
      const result = r.data?.quoteResponse?.result || [];
      if (result.length > 0) return result;
    } catch(e) {
      if (e.response?.status === 401 || e.response?.status === 403) {
        sessionOk = false; // trigger re-login
      }
    }
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════
// STEP 4: SCAN — exact port of Python scan()
// Pre-open fix: 9:00–9:15 IST only — use prevClose as LTP
// ═══════════════════════════════════════════════════════════════
function detectCircuit(ltp, high, low, chg) {
  // Exact same logic as Python
  const pctVal = Math.abs(chg);
  const nearLimit = (pctVal>=1.9&&pctVal<=2.1)||(pctVal>=4.9&&pctVal<=5.1)||
                    (pctVal>=9.9&&pctVal<=10.1)||(pctVal>=19.9&&pctVal<=20.1);
  if (!nearLimit) return '';
  if (chg > 0 && high > 0 && Math.abs(ltp-high)/high <= 0.0015) return 'UC';
  if (chg < 0 && low  > 0 && Math.abs(ltp-low)/low  <= 0.0015) return 'LC';
  return '';
}

function isPreOpenNow() {
  const d = new Date(), day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
  return m >= 540 && m < 555; // 9:00–9:15 IST only
}

async function scan() {
  if (scanRunning || !sessionOk) return;
  scanRunning = true;
  // Check pre-open ONCE per full scan cycle
  const inPreOpen = isPreOpenNow();
  try {
    // Build batches of 400 (same as Python)
    const batches = [];
    for (let i = 0; i < symbols.length; i += BATCH_SIZE) batches.push(symbols.slice(i, i+BATCH_SIZE));

    // Fetch all in parallel (same as Python ThreadPoolExecutor)
    const groups = [];
    for (let i = 0; i < batches.length; i += MAX_PAR) groups.push(batches.slice(i, i+MAX_PAR));

    for (const grp of groups) {
      const settled = await Promise.allSettled(grp.map(b => fetchBatch(b)));
      for (const res of settled) {
        if (res.status !== 'fulfilled') continue;
        for (const stock of res.value) {
          const ys = stock.symbol || '';
          if (!ys || !symbolMeta[ys]) continue;

          const prevClose = stock.regularMarketPreviousClose || 0;

          // PRE-OPEN: Yahoo returns IEP as regularMarketPrice (= prev day high).
          // Use prevClose instead so LTP is stable and correct during 9:00–9:15.
          // Outside pre-open: use regularMarketPrice exactly as before.
          const ltp = inPreOpen
            ? (prevClose || stock.regularMarketPrice || 0)
            : (stock.regularMarketPrice || 0);
          if (ltp <= 0) continue;

          const name      = stock.shortName || symbolMeta[ys]?.name || ys;
          const chg       = prevClose > 0 ? (ltp - prevClose)/prevClose*100 : (stock.regularMarketChangePercent||0);
          const high      = stock.regularMarketDayHigh || 0;
          const low       = stock.regularMarketDayLow  || 0;
          const vol       = stock.regularMarketVolume  || 0;
          const turnoverCr = vol > 0 ? +(ltp*vol/1e7).toFixed(2) : 0;
          const circuit   = detectCircuit(ltp, high, low, chg);

          quoteStore.set(ys, {
            symbol:     symbolMeta[ys].symbol,
            name,
            yahooSym:   ys,
            exchange:   symbolMeta[ys].exchange,
            ltp:        +ltp.toFixed(2),
            prevClose:  +prevClose.toFixed(2),
            change:     +(ltp-prevClose).toFixed(2),
            pChange:    +chg.toFixed(2),
            open:       0,
            high:       +high.toFixed(2),
            low:        +low.toFixed(2),
            volume:     vol,
            turnoverCr,
            circuit,
          });
        }
      }
    }

    lastScanTime = new Date().toISOString();
    scanCount++;
    const live = Array.from(quoteStore.values()).filter(q=>q.ltp>0).length;
    if (scanCount % 10 === 0) { // log every 10 scans to avoid spam
      console.log(`[YAHOO] Scan #${scanCount} — ${live} live quotes${inPreOpen?' [PRE-OPEN]':''}`);
    }
  } catch(e) {
    console.error('[YAHOO] Scan error:', e.message);
  }
  scanRunning = false;
}

// ═══════════════════════════════════════════════════════════════
// STEP 5: LOOP — port of Python while True
// ═══════════════════════════════════════════════════════════════
let loopTimer = null;

async function startLoop() {
  // Load symbols first
  await loadSymbols();

  // Get session (browser cookies + crumb) — same as Python get_session()
  await getSession();
  console.log('[YAHOO] Live scanner started... Bracing for lightspeed fetch!');

  // Run scan loop every 2s (same as Python SCAN_INTERVAL = 2)
  async function loop() {
    try {
      if (!sessionOk) {
        console.log('[YAHOO] Session lost. Reconnecting...');
        await getSession();
      }
      await scan();
    } catch(e) {
      console.error('[YAHOO] Connection Interrupted. Reconnecting...', e.message);
      sessionOk = false;
      await new Promise(r => setTimeout(r, 2000));
      await getSession();
    }
    loopTimer = setTimeout(loop, SCAN_MS);
  }
  loop();
}

// ── Exports for liveData.js ───────────────────────────────────
function getAllQuotes()   { return Array.from(quoteStore.values()).filter(q=>q.ltp>0); }
function getQuoteStore() { return quoteStore; }
function getSymbols()    { return symbols; }
function getSymbolMeta() { return symbolMeta; }
function getStockInfo()  {
  return { total: symbols.length, liveQuotes: getAllQuotes().length, lastScanTime, scanCount };
}
function getQuote(sym) {
  if (quoteStore.has(sym)) return quoteStore.get(sym);
  const ns = sym.replace(/\.(NS|BO)$/,'');
  return quoteStore.get(ns+'.NS') || quoteStore.get(ns+'.BO') || null;
}

module.exports = { startLoop, getSession, getAllQuotes, getQuoteStore, getSymbols, getSymbolMeta, getStockInfo, getQuote,
  get _headers(){ return headers; },
};
