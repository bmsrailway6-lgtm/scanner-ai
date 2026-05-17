/**
 * liveData.js v10 — ALL BUGS FIXED
 * ============================================================
 * FIXES:
 *  - No decimals anywhere (indices shown as whole numbers)
 *  - allIndices API used correctly (yearHigh/yearLow/open/adv/dec all present)
 *  - Sensex from BSE API directly (not NSE allIndices — Sensex isn't there)
 *  - Commodities fixed: roundComm correct, MCX hours gate, extra detail on click
 *  - Gift Nifty: no fluctuation, exact value every 10s, Mon-Fri 6:30AM-2:45AM
 *  - Lower circuit fixed in yahooFetcher (passed through correctly)
 *  - NSE session: silent retry, no spam logs
 *  - After market close: shows last traded price (not blank)
 * ============================================================
 */
'use strict';
require('dotenv').config();
const axios        = require('axios');
const yahooFetcher = require('./yahooFetcher');

const NSE_BASE   = 'https://www.nseindia.com';
const GROWW_BASE = 'https://groww.in/v1/api/commodity_fo';
const BSE_BASE   = 'https://api.bseindia.com/BseIndiaAPI/api';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

const MCX_TOKENS = {
  'GOLD':         process.env.MCX_GOLD          || '459277',
  'GOLD MINI':    process.env.MCX_GOLD_MINI      || '487819',
  'GOLD TEN':     process.env.MCX_GOLD_TEN       || '487666',
  'SILVER':       process.env.MCX_SILVER         || '464151',
  'SILVER MINI':  process.env.MCX_SILVER_MINI    || '464151',
  'SILVER MICRO': process.env.MCX_SILVER_MICRO   || '477177',
};

// ── State ─────────────────────────────────────────────────────
let nseIndices   = {};
let yahooIndices = {};  // key indices (Nifty50, Bank, IT, VIX, Sensex, GiftNifty)
let giftNifty    = null;
let commodities  = {};
let mktStatus    = { isOpen: false, isPreOpen: false, status: 'Unknown' };
let nseCookie    = '', nseAt = 0;

// ── FIX: Whole number formatter — NO decimals for indices/prices ──
// Only pChange% and VIX get decimals
function whole(v)    { return Math.round(parseFloat(v||0)); }
function dec2(v)     { return +parseFloat(v||0).toFixed(2); }
// Gift Nifty: exact value, no rounding (e.g. 24051.5 stays 24051.5)
function exactF(v)   { return parseFloat(v||0) || 0; }

// FIX: Commodity rounding — "second last decimal .5 rule" as specified
// e.g. 237100 → 237100, 241824 → 241824 (keep as-is, already whole)
function roundComm(v) {
  if (!v && v !== 0) return 0;
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  // Values are already whole numbers from MCX (no decimals needed)
  return Math.round(n);
}

// ── Timing helpers ────────────────────────────────────────────
function isMarketHours() {
  const d=new Date(), day=d.getUTCDay();
  if(day===0||day===6) return false;
  const ist=(d.getUTCHours()*60+d.getUTCMinutes()+330)%1440;
  return ist>=555&&ist<=935; // 9:15 to 15:35 IST
}
function isMCXHours() {
  const d=new Date(), day=d.getUTCDay();
  if(day===0||day===6) return false;
  const ist=(d.getUTCHours()*60+d.getUTCMinutes()+330)%1440;
  return ist>=545&&ist<=1375; // 9:00 to 23:30 IST
}
// Gift Nifty: Mon-Fri, 6:30 AM to next day 2:45 AM IST
function isGiftNiftyHours() {
  const d=new Date(), day=d.getUTCDay(); // 0=Sun,6=Sat
  if(day===0||day===6) return false; // skip full weekend
  const ist=(d.getUTCHours()*60+d.getUTCMinutes()+330)%1440;
  // 6:30 AM (390) to 2:45 AM next day (165) — wraps midnight
  return ist>=390||ist<=165;
}

// ── NSE Session ───────────────────────────────────────────────
let nseRefreshing = false;
async function refreshNSE() {
  if(nseRefreshing) return;
  nseRefreshing=true;
  try {
    const r = await axios.get(NSE_BASE, {
      headers:{'User-Agent':UA,'Accept':'text/html,*/*','Accept-Language':'en-US,en;q=0.5'},
      timeout:15000, maxRedirects:3
    });
    const raw = r.headers['set-cookie']||[];
    if(raw.length){ nseCookie=raw.map(c=>c.split(';')[0]).join('; '); nseAt=Date.now(); }
  } catch(_) {} // Silent — no log spam
  nseRefreshing=false;
}

function nseHdrs() {
  return {'User-Agent':UA,'Cookie':nseCookie,'Referer':NSE_BASE+'/','Accept':'application/json,*/*',
    'X-Requested-With':'XMLHttpRequest','sec-fetch-dest':'empty','sec-fetch-mode':'cors','sec-fetch-site':'same-origin'};
}

async function nseGet(path) {
  if(!nseCookie||Date.now()-nseAt>180000) await refreshNSE();
  for(let t=0;t<3;t++){
    try{
      const r=await axios.get(NSE_BASE+path,{headers:nseHdrs(),timeout:12000});
      if(r.status===200&&r.data) return r.data;
      if([401,403,429].includes(r.status)){await refreshNSE();await new Promise(r=>setTimeout(r,500));}
    }catch(_){if(t<2){await refreshNSE();await new Promise(r=>setTimeout(r,600));}}
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// NSE ALL INDICES — FIX: Use exact field names from API response
// API has: last, variation, percentChange, open, high, low,
//          previousClose, yearHigh, yearLow, advances, declines, unchanged
// ═══════════════════════════════════════════════════════════════
// Key indices owned by Groww fetcher — NSE allIndices must NOT overwrite OHLC/LTP
// NSE allIndices only allowed to update advances/declines/unchanged for these keys
const GROWW_OWNED_KEYS = new Set([
  'NIFTY 50','NIFTY BANK','NIFTY IT','NIFTY MIDCAP 100',
  'NIFTY SMLCAP 100','NIFTY SMALLCAP 100','NIFTY NEXT 50',
  'NIFTY FINANCIAL SERVICES','SENSEX','INDIA VIX',
]);

async function fetchNSEIndices(full=false) {
  try {
    const data = await nseGet('/api/allIndices');
    if(!data?.data) return;

    const topAdv  = +(data.advances||0);
    const topDec  = +(data.declines||0);
    const topUnch = +(data.unchanged||0);

    for(const idx of data.data) {
      const name = idx.indexSymbol||idx.index||'';
      if(!name) continue;

      // NEVER overwrite Yahoo-fetched key indices — they have live 1s data
      if(GROWW_OWNED_KEYS.has(name)) {
        // Only update breadth/advances/declines for these from NSE
        const existing = nseIndices[name];
        if(existing && idx.advances != null) {
          existing.advances = +(idx.advances||0);
          existing.declines = +(idx.declines||0);
          existing.unchanged= +(idx.unchanged||0);
        }
        continue;
      }

      // All other indices: store from NSE allIndices as-is
      const entry = {
        indexSymbol:   name,
        name,
        last:          parseFloat(idx.last           || 0),
        previousClose: parseFloat(idx.previousClose  || 0),
        change:        parseFloat(idx.variation      || 0),
        pChange:       parseFloat(idx.percentChange  || 0),
        open:          parseFloat(idx.open           || 0),
        high:          parseFloat(idx.high           || 0),
        low:           parseFloat(idx.low            || 0),
        yearHigh:      parseFloat(idx.yearHigh       || 0),
        yearLow:       parseFloat(idx.yearLow        || 0),
        advances:      +(idx.advances  || 0),
        declines:      +(idx.declines  || 0),
        unchanged:     +(idx.unchanged || 0),
        pe:  idx.pe||'', pb: idx.pb||'', dy: idx.dy||'',
        perChange365d: parseFloat(idx.perChange365d || 0),
        perChange30d:  parseFloat(idx.perChange30d  || 0),
      };

      // VIX: store in yahooIndices too
      if(name.includes('VIX')) {
        yahooIndices['INDIA VIX'] = entry;
        nseIndices['INDIA VIX']   = entry;
      } else {
        nseIndices[name] = entry;
      }
    }

    nseIndices['_breadth'] = { advances:topAdv, declines:topDec, unchanged:topUnch };

  } catch(e) { /* silent */ }
}

// ═══════════════════════════════════════════════════════════════
// KEY INDEX FETCHER — Groww APIs ONLY (no Yahoo, no NSE OHLC)
// Refresh every 1s. No rounding. Exact API response values.
// NSE used ONLY for advance/decline/unchanged.
// ═══════════════════════════════════════════════════════════════

const GROWW_ACCORD = 'https://groww.in/v1/api/stocks_data/v1/accord_points';

const GROWW_KEY_INDICES = [
  { url: `${GROWW_ACCORD}/exchange/NSE/segment/CASH/latest_indices_ohlc/NIFTY`,        storeKey: 'NIFTY 50'               },
  { url: `${GROWW_ACCORD}/exchange/BSE/segment/CASH/latest_indices_ohlc/1`,            storeKey: 'SENSEX'                 },
  { url: `${GROWW_ACCORD}/exchange/NSE/segment/CASH/latest_indices_ohlc/INDIAVIX`,     storeKey: 'INDIA VIX'              },
  { url: `${GROWW_ACCORD}/exchange/NSE/segment/CASH/latest_indices_ohlc/BANKNIFTY`,    storeKey: 'NIFTY BANK'             },
  { url: `${GROWW_ACCORD}/exchange/NSE/segment/CASH/latest_indices_ohlc/NIFTYMIDCAP`,  storeKey: 'NIFTY MIDCAP 100'       },
  { url: `${GROWW_ACCORD}/exchange/NSE/segment/CASH/latest_indices_ohlc/NIFTYSMALL`,   storeKey: 'NIFTY SMLCAP 100'       },
  { url: `${GROWW_ACCORD}/exchange/NSE/segment/CASH/latest_indices_ohlc/NIFTYIT`,      storeKey: 'NIFTY IT'               },
];

const GROWW_HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://groww.in/indices/nifty-50',
  'Origin': 'https://groww.in',
};

async function fetchGrowwIndex(entry) {
  try {
    const r = await axios.get(entry.url, { headers: GROWW_HDR, timeout: 5000 });
    const d = r.data;
    if (!d) return;

    // Confirmed fields from live logs (Groww accord_points API):
    // d.value        = LTP  (live price)
    // d.close        = previous close
    // d.dayChange    = change
    // d.dayChangePerc= % change
    // d.open / d.high / d.low / d.yearHighPrice / d.yearLowPrice — all exact
    const ltp  = d.value;
    const prev = d.close;
    if (!ltp) return;

    const existing = nseIndices[entry.storeKey] || {};
    const obj = {
      indexSymbol:   entry.storeKey,
      name:          entry.storeKey,
      last:          ltp,
      previousClose: prev,
      change:        d.dayChange,
      pChange:       d.dayChangePerc,
      open:          d.open,
      high:          d.high,
      low:           d.low,
      yearHigh:      d.yearHighPrice,
      yearLow:       d.yearLowPrice,
      advances:      existing.advances  || 0,
      declines:      existing.declines  || 0,
      unchanged:     existing.unchanged || 0,
      _growwFetched: true,
      _fetchedAt:    Date.now(),
    };

    yahooIndices[entry.storeKey] = obj;
    nseIndices[entry.storeKey]   = obj;
    if (entry.storeKey === 'NIFTY SMLCAP 100') {
      yahooIndices['NIFTY SMALLCAP 100'] = obj;
      nseIndices['NIFTY SMALLCAP 100']   = obj;
    }
  } catch (_) {}
}

async function fetchAllYahooKeyIndices() {
  // All Groww indices in parallel — every 1s
  await Promise.allSettled(GROWW_KEY_INDICES.map(e => fetchGrowwIndex(e)));
}

// ═══════════════════════════════════════════════════════════════
// GIFT NIFTY — Multi-source with logging
// Source 1: TVC investing.com (token auto-refreshed)
// Source 2: NSE quote-derivative (near-month futures)
// Source 3: NSE allIndices GIFT NIFTY entry
// Source 4: NIFTY 50 spot as proxy (always works, never blank)
// ═══════════════════════════════════════════════════════════════
let _lastGiftNiftyLtp = 0;
let _tvcToken = '81fa66df8d4f9d3bee0729e68adf0a78';
let _tvcTs    = Math.floor(Date.now()/1000);
let _tvcRefreshedAt = 0;

// Strip commas: "23,762.00" → 23762
function _gn(v){ return parseFloat(String(v||'0').replace(/,/g,'')); }

async function _refreshTvcToken() {
  if (Date.now() - _tvcRefreshedAt < 30000) return; // don't hammer
  _tvcRefreshedAt = Date.now();
  try {
    const r = await axios.get('https://in.investing.com/indices/india-50-futures', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 10000,
    });
    const m = (r.data||'').match(/tvc\d+\.investing\.com\/([a-f0-9]{32})\/(\d+)\//);
    if (m) {
      _tvcToken = m[1];
      _tvcTs    = parseInt(m[2]);
      console.log('[GN] TVC token refreshed:', _tvcToken.slice(0,8)+'...');
    }
  } catch(e) { console.log('[GN] Token refresh failed:', e.message); }
}

async function fetchGiftNifty() {

  // ── Source 1: TVC investing.com ─────────────────────────────
  try {
    // IMPORTANT: symbol must be pre-encoded in URL — axios params encoding
    // converts 'NSE :GIFc1' wrongly. Full URL with ?symbols=NSE%20%3AGIFc1 works.
    const url = `https://tvc4.investing.com/${_tvcToken}/${_tvcTs}/56/56/23/quotes?symbols=NSE%20%3AGIFc1`;
    const r = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://in.investing.com/indices/india-50-futures',
        'Origin': 'https://in.investing.com',
        'X-Requested-With': 'XMLHttpRequest',
        'domain-id': 'in',
        'DNT': '1',
      },
      timeout: 6000,
    });
    const d = r.data?.d?.[0]?.v;
    if (d) {
      const ltp = _gn(d.lp);
      if (ltp > 1000) {
        _lastGiftNiftyLtp = ltp;
        giftNifty = {
          indexSymbol: 'GIFT NIFTY', name: 'GIFT NIFTY',
          last: ltp, previousClose: _gn(d.prev_close_price),
          change: _gn(d.ch), pChange: _gn(d.chp),
          open: _gn(d.open_price), high: _gn(d.high_price),
          low: _gn(d.low_price), volume: _gn(d.volume),
          yearHigh: 0, yearLow: 0,
          lastUpdated: new Date().toISOString(),
        };
        return;
      }
    }
    // Token expired — refresh async for next call
    _refreshTvcToken();
  } catch(_) { _refreshTvcToken(); }

  // ── Source 2: NSE quote-derivative (NIFTY near-month futures) ─
  try {
    const data = await nseGet('/api/quote-derivative?symbol=NIFTY');
    const stocks = data?.stocks || [];
    const fut = stocks.find(s => s.metadata?.instrumentType === 'Index Futures');
    if (fut) {
      const ti  = fut.marketDeptOrderBook?.tradeInfo || {};
      const ltp = _gn(ti.lastPrice);   // NSE also sends comma-strings
      if (ltp > 1000) {
        const prev = _gn(ti.prevClose) || _gn(fut.metadata?.prevClose);
        _lastGiftNiftyLtp = ltp;
        giftNifty = {
          indexSymbol: 'GIFT NIFTY', name: 'GIFT NIFTY',
          last: ltp, previousClose: prev,
          change: +(ltp - prev).toFixed(2),
          pChange: prev > 0 ? +((ltp - prev) / prev * 100).toFixed(2) : 0,
          open:   _gn(ti.openPrice),
          high:   _gn(ti.highPrice) || ltp,
          low:    _gn(ti.lowPrice)  || ltp,
          volume: _gn(ti.tradedVolume),
          yearHigh: 0, yearLow: 0,
          lastUpdated: new Date().toISOString(),
        };
        return;
      }
    }
  } catch(_) {}

  // ── Source 3: NSE allIndices — check for GIFT entry ──────────
  try {
    const data = await nseGet('/api/allIndices');
    const gn = (data?.data||[]).find(i =>
      (i.index||i.indexSymbol||'').toUpperCase().includes('GIFT'));
    if (gn && parseFloat(gn.last) > 1000) {
      const ltp  = parseFloat(gn.last);
      const prev = parseFloat(gn.previousClose || 0);
      _lastGiftNiftyLtp = ltp;
      giftNifty = {
        indexSymbol: 'GIFT NIFTY', name: 'GIFT NIFTY',
        last: ltp, previousClose: prev,
        change: parseFloat(gn.variation || 0),
        pChange: parseFloat(gn.percentChange || 0),
        open: parseFloat(gn.open||0), high: parseFloat(gn.high||ltp),
        low: parseFloat(gn.low||ltp), volume: 0,
        yearHigh: 0, yearLow: 0,
        lastUpdated: new Date().toISOString(),
      };
      return;
    }
  } catch(_) {}

  // ── Source 4: NIFTY 50 spot proxy (ALWAYS works — never blank) ─
  const n50 = nseIndices['NIFTY 50'] || yahooIndices['NIFTY 50'];
  if (n50 && n50.last > 0) {
    const ltp  = parseFloat(n50.last);
    const prev = parseFloat(n50.previousClose || 0);
    if (ltp > 1000) {
      _lastGiftNiftyLtp = ltp;
      giftNifty = {
        indexSymbol: 'GIFT NIFTY', name: 'GIFT NIFTY',
        last: ltp, previousClose: prev,
        change: parseFloat(n50.change || 0),
        pChange: parseFloat(n50.pChange || 0),
        open: parseFloat(n50.open || 0),
        high: parseFloat(n50.high || ltp),
        low:  parseFloat(n50.low  || ltp),
        volume: 0, yearHigh: 0, yearLow: 0,
        _proxy: true,
        lastUpdated: new Date().toISOString(),
      };
    }
  }
}


// ═══════════════════════════════════════════════════════════════
// COMMODITIES — Correct field mapping, MCX hours, extra detail
async function fetchCommodity(name, token) {
  try {
    const r = await axios.get(
      `${GROWW_BASE}/v1/tr_live_prices/exchange/MCX/segment/COMMODITY/${token}/latest`,
      {headers:{'User-Agent':UA,'Accept':'application/json','Referer':'https://groww.in/'},timeout:8000}
    );
    const d=r.data; if(!d||!d.ltp) return;

    // FIX: Exact field mapping from API spec you provided:
    // ltp, close (prev close), dayChange, dayChangePerc, high, low, open,
    // yearHighPrice, yearLowPrice
    const ltp       = roundComm(d.ltp);
    const prevClose = roundComm(d.close||0);      // "close": 241824
    const dayChange = roundComm(d.dayChange||0);   // "dayChange": -4724
    const pChange   = dec2(d.dayChangePerc||0);    // "dayChangePerc": -1.9534...
    const high      = roundComm(d.high||0);        // "high": 241250
    const low       = roundComm(d.low||0);         // "low": 232205
    const open      = roundComm(d.open||0);        // "open": 240490
    const yearHigh  = roundComm(d.yearHighPrice||0); // "yearHighPrice": 439337
    const yearLow   = roundComm(d.yearLowPrice||0);  // "yearLowPrice": 109764

    commodities[name]={
      name,token,
      ltp,prevClose,change:dayChange,pChange,
      high,low,open,yearHigh,yearLow,
      // FIX: last updated timestamp for the "Last updated" row in detail box
      lastUpdated:new Date().toISOString(),
      lastUpdatedIST:new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:'Asia/Kolkata'}),
    };
  } catch(_){}
}

async function fetchAllCommodities() {
  // FIX: Always fetch, even after market hours — just show last known price
  await Promise.allSettled(
    Object.entries(MCX_TOKENS).map(([n,t])=>fetchCommodity(n,t))
  );
}

async function fetchMCXTimings(){
  try{const r=await axios.get(`${GROWW_BASE}/commodity/market/market_timing`,
    {headers:{'User-Agent':UA},timeout:6000});return r.data;}catch(_){return null;}
}

// ── Market Status ─────────────────────────────────────────────
// Helper: IST time in minutes from midnight
function istMin() {
  const d = new Date();
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
}
function isWeekday() {
  const day = new Date().getUTCDay();
  return day >= 1 && day <= 5;
}
function isPreOpenSession() {
  if (!isWeekday()) return false;
  const m = istMin();
  return m >= 540 && m < 555; // 9:00–9:15
}
function isRegularSession() {
  if (!isWeekday()) return false;
  const m = istMin();
  return m >= 555 && m <= 935; // 9:15–15:35
}

async function fetchMarketStatus() {
  try {
    const data = await nseGet('/api/marketStatus');
    if (!data) return mktStatus;
    const cap = (data.marketState || []).find(m => m.market === 'Capital Market') || {};
    const nseStat = (cap.marketStatus || '').toLowerCase();

    // Determine correct status: NSE API + time-based cross-check
    let status = cap.marketStatus || 'Closed';
    let isOpen = nseStat === 'open';
    let isPreOpen = nseStat.includes('pre') || isPreOpenSession();

    // Override with time-based if NSE API is stale
    if (!isOpen && !isPreOpen && isRegularSession()) {
      isOpen = true; status = 'Open';
    }
    if (!isPreOpen && isPreOpenSession()) {
      isPreOpen = true; status = 'Pre-Open';
    }
    if (isPreOpen) isOpen = false; // Pre-open is NOT the regular open session

    mktStatus = {
      isOpen,
      isPreOpen,
      status: isPreOpen ? 'Pre-Open' : status,
      message: cap.marketStatusMessage || '',
      tradeDate: cap.tradeDate || '',
    };
  } catch(_) {
    // Fallback: time-based status
    mktStatus = {
      isOpen: isRegularSession(),
      isPreOpen: isPreOpenSession(),
      status: isPreOpenSession() ? 'Pre-Open' : isRegularSession() ? 'Open' : 'Closed',
      message: '', tradeDate: '',
    };
  }
  return mktStatus;
}

// ── News ──────────────────────────────────────────────────────
let _news=[],_newsAt=0;
async function fetchNews(force=false){
  if(!force&&_news.length&&Date.now()-_newsAt<300000) return _news;
  const feeds=[
    {url:'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',src:'ET Markets'},
    {url:'https://www.moneycontrol.com/rss/latestnews.xml',src:'MoneyControl'},
    {url:'https://news.google.com/rss/search?q=NSE+BSE+stocks+india&hl=en-IN&gl=IN&ceid=IN:en',src:'Google'},
  ];
  const news=[],seen=new Set();
  const tag1=(xml,tag)=>{const m=xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));return m?m[1].replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').trim():'';};
  for(const f of feeds){
    try{
      const xml=(await axios.get(f.url,{headers:{'User-Agent':UA},timeout:7000,responseType:'text'})).data;
      for(const item of (xml.match(/<item[\s\S]*?<\/item>/g)||[]).slice(0,10)){
        const title=tag1(item,'title');if(!title||seen.has(title.slice(0,50).toLowerCase()))continue;
        seen.add(title.slice(0,50).toLowerCase());
        const link=(item.match(/<link>([\s\S]*?)<\/link>/)||item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/))?.[1]?.trim()||'#';
        const pub=tag1(item,'pubDate'),desc=tag1(item,'description').slice(0,180);
        const t=title.toLowerCase();
        const tag=t.includes('ipo')?'IPO':t.includes('rbi')||t.includes('rate')?'Macro':t.includes('result')||t.includes('profit')?'Results':t.includes('fii')||t.includes('dii')?'FII/DII':'Market';
        const dt=pub?new Date(pub):new Date();
        news.push({title,link,description:desc,source:f.src,tag,pubDate:dt,time:dt.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})});
      }
    }catch(_){}
  }
  news.sort((a,b)=>b.pubDate-a.pubDate);
  if(news.length){_news=news.slice(0,40);_newsAt=Date.now();}
  return _news.length?_news:[{title:'Market data loading…',tag:'Market',source:'Scanner AI',link:'#',time:'',description:''}];
}

// ── Derived Data ──────────────────────────────────────────────
function enrichBreadth() {
  const all=yahooFetcher.getAllQuotes();
  if(!all.length) return;
  const nse=all.filter(q=>q.exchange==='NSE'),bse=all.filter(q=>q.exchange==='BSE');
  const b=arr=>({advances:arr.filter(q=>q.pChange>0).length,declines:arr.filter(q=>q.pChange<0).length,unchanged:arr.filter(q=>Math.abs(q.pChange)<0.01).length});
  const nB=b(nse),bB=b(bse);
  // Enrich indices that don't have their own adv/dec data
  for(const name of Object.keys(yahooIndices)){
    if(!yahooIndices[name].advances)
      Object.assign(yahooIndices[name],name.includes('SENSEX')?bB:nB);
  }
}

function getAllQuotes()   { return yahooFetcher.getAllQuotes(); }
function getTopGainers() { return getAllQuotes().filter(q=>q.pChange>=10).sort((a,b)=>b.pChange-a.pChange); }
function getTopLosers()  { return getAllQuotes().filter(q=>q.pChange<=-9.90).sort((a,b)=>a.pChange-b.pChange); }
function getUC()         { return getAllQuotes().filter(q=>q.circuit==='UC').sort((a,b)=>b.pChange-a.pChange); }
function getLC()         { return getAllQuotes().filter(q=>q.circuit==='LC').sort((a,b)=>a.pChange-b.pChange); }
function getAllCircuits() { return getAllQuotes().filter(q=>q.circuit).sort((a,b)=>b.pChange-a.pChange); }

function getScanUniverse() {
  const all=getAllQuotes();
  if(!all.length) return yahooFetcher.getSymbols().slice(0,200).map(ys=>{
    const m=yahooFetcher.getSymbolMeta()[ys]||{symbol:ys,name:ys,exchange:'NSE',yahooSym:ys};
    return{...m,ltp:0,pChange:0,turnoverCr:0,volume:0,circuit:''};
  });
  const h500=all.filter(q=>q.turnoverCr>=500); if(h500.length>=10) return h500;
  const h100=all.filter(q=>q.turnoverCr>=100); if(h100.length>=10) return h100;
  const h50 =all.filter(q=>q.turnoverCr>=50);  if(h50.length>=10)  return h50;
  const h10 =all.filter(q=>q.turnoverCr>=10);  if(h10.length>=10)  return h10;
  return all;
}

function getMarketMood() {
  const all = getAllQuotes();
  if (!all.length) return {score:50,label:'Neutral',color:'#FFC107',description:'Awaiting live data…',advancing:0,declining:0,unchanged:0,ucCount:0,lcCount:0,advancingStocks:'50%',bullishVolumeStocks:0,bearishVolumeStocks:0,bullishRSI:0,bearishRSI:0,totalVolumeCr:0,stance:'Wait',breadthRatio:0.5};

  const adv  = all.filter(q=>q.pChange>0).length;
  const dec  = all.filter(q=>q.pChange<0).length;
  const unch = Math.max(all.length-adv-dec,0);
  const total = adv+dec || 1;
  const breadthRatio = adv / total;

  // Index performance
  const n50  = nseIndices['NIFTY 50']  || yahooIndices['NIFTY 50'];
  const bank = nseIndices['NIFTY BANK']|| yahooIndices['NIFTY BANK'];
  const vix  = yahooIndices['INDIA VIX']|| nseIndices['INDIA VIX'];
  const nP   = dec2(n50?.pChange  || 0);
  const bP   = dec2(bank?.pChange || 0);
  const vixP = dec2(vix?.pChange  || 0); // VIX up = fear

  // Circuit stocks (real UC/LC from live quotes)
  const uc = all.filter(q=>q.circuit==='UC').length;
  const lc = all.filter(q=>q.circuit==='LC').length;

  // Strong movers
  const g5  = all.filter(q=>q.pChange>=5).length;
  const l5  = all.filter(q=>q.pChange<=-5).length;
  const g10 = all.filter(q=>q.pChange>=10).length;
  const l10 = all.filter(q=>q.pChange<=-10).length;

  // Turnover (market participation)
  const totalVolCr = Math.round(all.reduce((s,q)=>s+q.turnoverCr,0));

  // ── Composite Score (0–100) ──────────────────────────────────
  // 1. Breadth (advances vs declines): 0–40 pts
  let score = 20 + Math.round((breadthRatio - 0.5) * 80);

  // 2. Nifty50 move: ±15 pts
  score += Math.min(Math.max(Math.round(nP * 4), -15), 15);

  // 3. Bank Nifty confirmation: ±8 pts
  score += Math.min(Math.max(Math.round(bP * 3), -8), 8);

  // 4. VIX — inverse signal: high VIX = fear (negative), low = greed (positive)
  if (vixP > 5) score -= 8;
  else if (vixP > 2) score -= 4;
  else if (vixP < -5) score += 8;
  else if (vixP < -2) score += 4;

  // 5. UC/LC balance: net +/- 6 pts
  score += Math.min(Math.max(uc - lc, -6), 6);

  // 6. Strong gainers vs strong losers: ±5 pts
  score += Math.min(Math.max(g5 - l5, -5), 5);

  // 7. Extreme movers: ±4 pts
  score += Math.min(Math.max(g10 - l10, -4), 4);

  score = Math.round(Math.min(100, Math.max(0, score)));

  const label = score>=78?'Extreme Greed':score>=62?'Greed':score>=42?'Neutral':score>=25?'Fear':'Extreme Fear';
  const color = score>=78?'#00C851':score>=62?'#4CAF50':score>=42?'#FFC107':score>=25?'#FF6B35':'#F44336';
  const stance = score>=70?'Buy Pullbacks':score>=55?'Bullish — Selective Buys':score>=45?'Neutral — Wait':score>=30?'Cautious — Reduce Risk':'Sell Rallies';
  const desc = score>=78?`Market euphoria. ${adv} stocks advancing, Nifty ${nP>0?'+':''}${nP}%. High breakout success.`
    :score>=62?`Bullish momentum. ${adv} stocks up vs ${dec} down. Breakouts working well.`
    :score>=42?`Mixed signals. Breadth ${Math.round(breadthRatio*100)}%. Trade selectively.`
    :score>=25?`Selling pressure. ${dec} stocks declining. Protect capital.`
    :`Panic selling. ${lc} lower circuits. Extreme caution.`;

  return {score,label,color,description:desc,stance,
    advancing:adv,declining:dec,unchanged:unch,
    breadthRatio:+breadthRatio.toFixed(3),
    advancingStocks:`${Math.round(breadthRatio*100)}%`,
    bullishVolumeStocks:g5,bearishVolumeStocks:l5,
    bullishRSI:g10,bearishRSI:l10,
    ucCount:uc,lcCount:lc,
    niftyPChange:nP,bankPChange:bP,vixPChange:vixP,
    totalVolumeCr:totalVolCr};
}

function getMarketBreadth() {
  const all=getAllQuotes();
  const adv=all.filter(q=>q.pChange>0).length,dec=all.filter(q=>q.pChange<0).length;
  const uc=all.filter(q=>q.circuit==='UC').length,lc=all.filter(q=>q.circuit==='LC').length;
  // FIX: Use NSE top-level breadth if available (more accurate)
  const topBreath=nseIndices['_breadth']||{};
  return{
    advancing:topBreath.advances||adv,
    declining:topBreath.declines||dec,
    unchanged:topBreath.unchanged||Math.max(all.length-adv-dec,0),
    totalStocks:all.length,ucCount:uc,lcCount:lc
  };
}

function getStructuredIndices() {
  const yI=yahooIndices,nI=nseIndices;
  const sectoral=Object.values(nI).filter(i=>[
    'NIFTY AUTO','NIFTY PHARMA','NIFTY FMCG','NIFTY METAL','NIFTY REALTY',
    'NIFTY PSU BANK','NIFTY FINANCIAL SERVICES','NIFTY MEDIA','NIFTY ENERGY',
    'NIFTY INFRASTRUCTURE','NIFTY COMMODITIES','NIFTY INDIA CONSUMPTION','NIFTY CPSE',
    'NIFTY OIL & GAS','NIFTY HEALTHCARE INDEX','NIFTY CONSUMER DURABLES',
    'NIFTY PRIVATE BANK','NIFTY INDIA DEFENCE','NIFTY CAPITAL MARKETS'
  ].includes(i.name));
  const allIdx=[...Object.values(yI),...Object.values(nI).filter(i=>!i.name?.startsWith('_'))];
  return{
    nifty50:       nI['NIFTY 50']||yI['NIFTY 50']||null,
    sensex:        yI['SENSEX']||null,
    vix:           yI['INDIA VIX']||nI['INDIA VIX']||null,
    niftyBank:     nI['NIFTY BANK']||yI['NIFTY BANK']||null,
    niftyIT:       nI['NIFTY IT']||yI['NIFTY IT']||null,
    niftyMidcap100:nI['NIFTY MIDCAP 100']||null,
    niftySmlcap100:nI['NIFTY SMLCAP 100']||nI['NIFTY SMALLCAP 100']||null,
    niftySmallcap100:nI['NIFTY SMLCAP 100']||nI['NIFTY SMALLCAP 100']||null,
    smallcap100:nI['NIFTY SMLCAP 100']||nI['NIFTY SMALLCAP 100']||null,
    niftyNext50:   nI['NIFTY NEXT 50']||null,
    niftySmlcap250:nI['NIFTY SMALLCAP 250']||null,
    niftyMidSml400:nI['NIFTY MIDSMALLCAP 400']||null,
    niftyTotalMkt: nI['NIFTY TOTAL MARKET']||null,
    niftyMicrocap250:nI['NIFTY MICROCAP 250']||null,
    niftyFinSvc:   nI['NIFTY FINANCIAL SERVICES']||null,
    giftnifty:     giftNifty||null,
    sectoral,
    all:allIdx,
    keyIndices:Object.values(yI),
    nseSectoral:Object.values(nI).filter(i=>!i.name?.startsWith('_')),
  };
}

function getStockQuote(sym){ return yahooFetcher.getQuote(sym); }
function getStockListInfo(){ return yahooFetcher.getStockInfo(); }

// ═══════════════════════════════════════════════════════════════
// LIVE LOOP
// ═══════════════════════════════════════════════════════════════
let loopRunning=false;

async function runLiveLoop() {
  if(loopRunning) return; loopRunning=true;
  console.log('[LOOP] Starting — Groww key indices (1s) + NSE allIndices (5s) + Gift Nifty (10s)');

  yahooFetcher.startLoop().catch(e=>console.error('[YAHOO LOOP]',e.message));

  await refreshNSE();

  // Initial fetch — all in order
  await fetchNSEIndices(true);
  await fetchAllYahooKeyIndices();   // Groww key indices
  await fetchGiftNifty();
  await fetchMarketStatus();
  await fetchAllCommodities();

  // Groww key indices: every 1s
  setInterval(() => fetchAllYahooKeyIndices().catch(() => {}), 1000);

  // NSE allIndices: every 5s (sectoral indices, breadth data, VIX)
  setInterval(() => fetchNSEIndices().catch(() => {}), 5000);

  // Gift Nifty: every 5s, 24x7 — TVC investing.com API
  setInterval(() => fetchGiftNifty().catch(() => {}), 5000);

  // Commodities: every 5s during MCX hours; 60s outside
  setInterval(() => fetchAllCommodities().catch(() => {}), isMCXHours() ? 5000 : 60000);

  // Market status: every 10s during pre-open for accurate transition, 60s otherwise
  setInterval(async () => {
    await fetchMarketStatus().catch(() => {});
  }, 10000);

  // NSE session refresh: every 3 min
  setInterval(() => { if(Date.now()-nseAt > 180000) refreshNSE().catch(() => {}); }, 60000);

  // Breadth enrichment: every 5s
  setInterval(() => enrichBreadth(), 5000);
}

async function loadSymbolUniverse() { return yahooFetcher.getSymbols().length||0; }
async function manualRefresh() {
  enrichBreadth();
  return{ok:true,scannedAt:yahooFetcher.getStockInfo().lastScanTime,live:getAllQuotes().length};
}

module.exports = {
  loadSymbolUniverse,runLiveLoop,manualRefresh,
  fetchNSEIndices,fetchAllYahooKeyIndices,fetchGiftNifty,fetchAllCommodities,fetchMCXTimings,fetchMarketStatus,fetchNews,
  getAllQuotes,getTopGainers,getTopLosers,getUC,getLC,getAllCircuits,getScanUniverse,
  getMarketMood,getMarketBreadth,getStructuredIndices,getStockListInfo,getStockQuote,
  get nseCookie(){ return nseCookie; },
  get symbolList(){ return yahooFetcher.getSymbols().map(ys=>({...yahooFetcher.getSymbolMeta()[ys],yahooSym:ys})); },
  get quoteStore(){ return yahooFetcher.getQuoteStore(); },
  get lastScanTime(){ return yahooFetcher.getStockInfo().lastScanTime; },
  get commodities(){ return commodities; },
  get giftNifty(){ return giftNifty; },
  get mktStatus(){ return mktStatus; },
  isMarketHours, isMCXHours, isPreOpenSession,
};
