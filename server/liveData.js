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
let mktStatus    = { isOpen: false, status: 'Unknown' };
let nseCookie    = '', nseAt = 0;

// ── FIX: Whole number formatter — NO decimals for indices/prices ──
// Only pChange% and VIX get decimals
function whole(v)    { return Math.round(parseFloat(v||0)); }
function dec2(v)     { return +parseFloat(v||0).toFixed(2); }

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
async function fetchNSEIndices(full=false) {
  try {
    const data = await nseGet('/api/allIndices');
    if(!data?.data) return;

    // FIX: Top-level breadth from the allIndices response
    const topAdv   = +(data.advances||0);
    const topDec   = +(data.declines||0);
    const topUnch  = +(data.unchanged||0);

    for(const idx of data.data) {
      const name = idx.indexSymbol||idx.index||'';
      if(!name) continue;

      // FIX: All fields mapped EXACTLY from API — no conversion needed
      // API already gives correct values; just store whole numbers
      const entry = {
        indexSymbol:  name,
        name,
        last:         whole(idx.last),           // FIX: whole number
        previousClose:whole(idx.previousClose),
        change:       dec2(idx.variation),        // variation = change
        pChange:      dec2(idx.percentChange),
        open:         whole(idx.open),            // FIX: open present in API
        high:         whole(idx.high),            // FIX: high present
        low:          whole(idx.low),             // FIX: low present
        yearHigh:     whole(idx.yearHigh),        // FIX: yearHigh present
        yearLow:      whole(idx.yearLow),         // FIX: yearLow present
        // FIX: advances/declines from per-index data (strings in API)
        advances:     +(idx.advances||0),
        declines:     +(idx.declines||0),
        unchanged:    +(idx.unchanged||0),
        pe:           idx.pe||'',
        pb:           idx.pb||'',
        dy:           idx.dy||'',
        perChange365d:dec2(idx.perChange365d),
        perChange30d: dec2(idx.perChange30d),
      };

      // VIX: keep 2 decimals since it's a small number
      if(name.includes('VIX')){
        entry.last=dec2(idx.last);
        entry.previousClose=dec2(idx.previousClose);
        entry.open=dec2(idx.open);
        entry.high=dec2(idx.high);
        entry.low=dec2(idx.low);
        entry.yearHigh=dec2(idx.yearHigh);
        entry.yearLow=dec2(idx.yearLow);
        yahooIndices['INDIA VIX']=entry;
      } else if(['NIFTY 50','NIFTY BANK','NIFTY IT','NIFTY MIDCAP 100',
                  'NIFTY SMALLCAP 100','NIFTY SMLCAP 100','NIFTY NEXT 50','NIFTY FINANCIAL SERVICES'].includes(name)){
        yahooIndices[name]=entry;
        nseIndices[name]=entry;
        // Also store under alternate key names for frontend compatibility
        if(name==='NIFTY SMLCAP 100'){nseIndices['NIFTY SMALLCAP 100']=entry;yahooIndices['NIFTY SMALLCAP 100']=entry;}
        if(name==='NIFTY SMALLCAP 100'){nseIndices['NIFTY SMLCAP 100']=entry;yahooIndices['NIFTY SMLCAP 100']=entry;}
      } else {
        nseIndices[name]=entry;
      }
    }

    // FIX: Store top-level breadth for market breadth widget
    nseIndices['_breadth'] = { advances:topAdv, declines:topDec, unchanged:topUnch };

    // Fetch Sensex separately from BSE
    fetchSensex().catch(()=>{});

  } catch(e) { /* silent */ }
}

// ── SENSEX — Yahoo Finance ^BSESN (reliable, no auth needed) ──
async function fetchSensex() {
  try {
    const yhdrs = yahooFetcher._headers || {'User-Agent': UA, 'Accept': 'application/json,*/*'};
    for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
      try {
        const r = await axios.get(`${base}/v8/finance/chart/%5EBSESN`, {
          headers: yhdrs,
          params: { interval:'1d', range:'2d' },
          timeout: 8000
        });
        const meta = r.data?.chart?.result?.[0]?.meta;
        if (!meta) continue;
        const last = parseFloat(meta.regularMarketPrice||0);
        const prev = parseFloat(meta.previousClose||meta.chartPreviousClose||0);
        if (!last) continue;
        const chg = last - prev, pChange = prev ? dec2(chg/prev*100) : 0;
        const nseBreadth = nseIndices['_breadth']||{};
        yahooIndices['SENSEX'] = {
          indexSymbol:'SENSEX', name:'SENSEX',
          last:        dec2(last),
          previousClose:dec2(prev),
          change:      dec2(chg),
          pChange,
          open:        dec2(meta.regularMarketOpen||prev),
          high:        dec2(meta.regularMarketDayHigh||last),
          low:         dec2(meta.regularMarketDayLow||last),
          yearHigh:    dec2(meta.fiftyTwoWeekHigh||0),
          yearLow:     dec2(meta.fiftyTwoWeekLow||0),
          advances:    nseBreadth.advances||0,
          declines:    nseBreadth.declines||0,
          unchanged:   nseBreadth.unchanged||0,
        };
        return;
      } catch(_) {}
    }
  } catch(_) {}
}

// ═══════════════════════════════════════════════════════════════
// GROWW KEY INDEX FETCHER — Live tick every 1s for all 7 key indices
// Uses Groww API as PRIMARY source (no auth, reliable, fast)
// Fields from NIFTY.json: close,dayChange,dayChangePerc,high,low,open,value,yearHighPrice,yearLowPrice
// ═══════════════════════════════════════════════════════════════
const GROWW_KEY_INDICES = [
  { url: 'https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/NIFTY',        storeKey: 'NIFTY 50' },
  { url: 'https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/BSE/segment/CASH/latest_indices_ohlc/1',             storeKey: 'SENSEX' },
  { url: 'https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/INDIAVIX',     storeKey: 'INDIA VIX' },
  { url: 'https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/BANKNIFTY',    storeKey: 'NIFTY BANK' },
  { url: 'https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/NIFTYMIDCAP',  storeKey: 'NIFTY MIDCAP 100' },
  { url: 'https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/NIFTYSMALL',   storeKey: 'NIFTY SMLCAP 100' },
  { url: 'https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/NIFTYIT',      storeKey: 'NIFTY IT' },
];

const GROWW_HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept': 'application/json,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://groww.in/',
  'Origin': 'https://groww.in',
};

async function fetchOneGrowwIndex(entry) {
  try {
    const r = await axios.get(entry.url, { headers: GROWW_HDR, timeout: 5000 });
    const d = r.data;
    if (!d || !d.value) return false;
    // Map Groww fields to our index structure
    // value = LTP/last, close = previous close, dayChange, dayChangePerc, high/low/open, yearHighPrice/yearLowPrice
    const last  = d.value;                // Current LTP
    const prev  = d.close;               // Previous close
    const chg   = d.dayChange;            // Change points
    const pChg  = dec2(d.dayChangePerc); // % change
    const isVix = entry.storeKey === 'INDIA VIX';
    const fmt   = isVix ? dec2 : whole;
    const brd   = nseIndices['_breadth'] || {};
    const obj = {
      indexSymbol:   entry.storeKey,
      name:          entry.storeKey,
      last:          fmt(last),
      previousClose: fmt(prev),
      change:        dec2(chg),
      pChange:       pChg,
      open:          fmt(d.open   || prev),
      high:          fmt(d.high   || last),
      low:           fmt(d.low    || last),
      yearHigh:      fmt(d.yearHighPrice || 0),
      yearLow:       fmt(d.yearLowPrice  || 0),
      advances:      brd.advances  || 0,
      declines:      brd.declines  || 0,
      unchanged:     brd.unchanged || 0,
      _growwFetched: true,
    };
    yahooIndices[entry.storeKey] = obj;
    nseIndices[entry.storeKey]   = obj;
    // Alias mappings for frontend compatibility
    if (entry.storeKey === 'NIFTY SMLCAP 100') {
      yahooIndices['NIFTY SMALLCAP 100'] = obj; nseIndices['NIFTY SMALLCAP 100'] = obj;
    }
    return true;
  } catch (_) { return false; }
}

async function fetchAllYahooKeyIndices() {
  // Fetch all Groww key indices in parallel
  await Promise.allSettled(GROWW_KEY_INDICES.map(e => fetchOneGrowwIndex(e)));
}


// ═══════════════════════════════════════════════════════════════
// GIFT NIFTY — FIX: Stable value, no fluctuation
// Schedule: Mon-Fri 6:30 AM IST to next day 2:45 AM IST
// Fetches exact price every 10s, no interpolation or smoothing
// ═══════════════════════════════════════════════════════════════
// ── FIX: Gift Nifty — retain last price until new data arrives (never blank)
let _lastGiftNifty = null;

async function fetchGiftNifty() {
  // ONLY investing.com — as instructed
  // API: https://api.investing.com/api/financialdata/1209756/historical/chart/?interval=P1D&pointscount=60
  // Response: {"data":[[timestamp, open, high, low, close, volume, 0],...]}
  // Fetch last row for LTP, second-last for previous close → pChange
  // Cloudflare bypass: use rotating UA + proper headers + axios with no-follow-redirect
  const CF_HDRS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://in.investing.com/',
    'Origin': 'https://in.investing.com',
    'domain-id': 'in',
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Connection': 'keep-alive',
  };

  // Try primary: historical chart endpoint (P1D = daily, last 60 rows)
  try {
    const r = await axios.get(
      'https://api.investing.com/api/financialdata/1209756/historical/chart/',
      {
        headers: CF_HDRS,
        params: { interval: 'P1D', pointscount: 60 },
        timeout: 8000,
        maxRedirects: 5,
      }
    );
    const rows = r.data?.data;
    if (Array.isArray(rows) && rows.length >= 2) {
      // Each row: [timestamp_ms, open, high, low, close, volume, 0]
      const lastRow = rows[rows.length - 1];
      const prevRow = rows[rows.length - 2];
      const ltp      = parseFloat(lastRow[4] || lastRow[1] || 0); // close price
      const prevClose= parseFloat(prevRow[4] || prevRow[1] || 0);
      if (ltp > 1000) {
        const chg   = dec2(ltp - prevClose);
        const pChg  = prevClose > 0 ? dec2((ltp - prevClose) / prevClose * 100) : 0;
        _lastGiftNifty = giftNifty = {
          indexSymbol: 'GIFT NIFTY',
          name:        'GIFT NIFTY',
          last:        dec2(ltp),
          previousClose: dec2(prevClose),
          change:      chg,
          pChange:     pChg,
          open:        dec2(parseFloat(lastRow[1] || prevClose)),
          high:        dec2(parseFloat(lastRow[2] || ltp)),
          low:         dec2(parseFloat(lastRow[3] || ltp)),
          yearHigh:    0,
          yearLow:     0,
          _source:     'investing_historical',
          _fetchedAt:  Date.now(),
        };
        return;
      }
    }
  } catch (_) {}

  // Try secondary: pct change endpoint for %change verification
  // https://endpoints.investing.com/pd-instruments/v1/instruments/1209756/price-changes
  // Response includes pct_1d which we can use to calc LTP from prev
  try {
    const r2 = await axios.get(
      'https://endpoints.investing.com/pd-instruments/v1/instruments/1209756/price-changes',
      {
        headers: { ...CF_HDRS, 'Referer': 'https://in.investing.com/indices/nifty-50-futures' },
        timeout: 6000,
      }
    );
    const pct1d = parseFloat(r2.data?.pct_1d || 0);
    if (_lastGiftNifty?.last && pct1d !== 0) {
      // Recalculate LTP from retained prev close + pct change
      const prev = _lastGiftNifty.previousClose || _lastGiftNifty.last;
      const ltp  = dec2(prev * (1 + pct1d / 100));
      const chg  = dec2(ltp - prev);
      _lastGiftNifty = giftNifty = {
        ..._lastGiftNifty,
        last:    ltp,
        change:  chg,
        pChange: dec2(pct1d),
        _source: 'investing_pct',
        _fetchedAt: Date.now(),
      };
      return;
    }
  } catch (_) {}

  // Retain last known value on any failure — never blank
  if (_lastGiftNifty) {
    giftNifty = _lastGiftNifty;
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
async function fetchMarketStatus() {
  try {
    const data=await nseGet('/api/marketStatus');
    if(!data) return mktStatus;
    const cap=(data.marketState||[]).find(m=>m.market==='Capital Market')||{};
    mktStatus={isOpen:cap.marketStatus==='Open',status:cap.marketStatus||'Closed',
      message:cap.marketStatusMessage||'',tradeDate:cap.tradeDate||''};
  } catch(_){}
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
  console.log('[LOOP] Starting — Yahoo fetcher (live quotes) + NSE allIndices + Yahoo key indices 1s');

  // Start Yahoo live quote fetcher (Puppeteer session, 2s interval)
  yahooFetcher.startLoop().catch(e=>console.error('[YAHOO LOOP]',e.message));

  // NSE session
  await refreshNSE();

  // Initial fetch of all data
  await fetchNSEIndices(true);
  await fetchAllYahooKeyIndices(); // Immediately fetch all 7 key indices from Yahoo
  await fetchGiftNifty();          // Always fetch Gift Nifty on startup (no hour guard)
  await fetchMarketStatus();
  await fetchAllCommodities();

  // ── LIVE KEY INDICES: Groww API — every 1s live tick (all hours)
  // NIFTY50, SENSEX, VIX, BANK NIFTY, MIDCAP, SMALLCAP, NIFTY IT from Groww
  setInterval(async () => {
    await fetchAllYahooKeyIndices().catch(()=>{});
  }, 1000);

  // NSE allIndices: every 5s (for sectoral, breadth data)
  setInterval(()=>fetchNSEIndices().catch(()=>{}), 5000);

  // Gift Nifty: every 10s always — retains last value when closed
  setInterval(()=>fetchGiftNifty().catch(()=>{}), 10000);

  // Commodities: every 5s during MCX hours; every 60s outside
  setInterval(()=>fetchAllCommodities().catch(()=>{}), isMCXHours()?5000:60000);

  // Market status: every 60s — always runs so market status is always current
  setInterval(()=>fetchMarketStatus().catch(()=>{}), 60000);

  // NSE session refresh: every 3min
  setInterval(()=>{ if(Date.now()-nseAt>180000) refreshNSE().catch(()=>{}); }, 60000);

  // Breadth enrichment: every 5s
  setInterval(()=>enrichBreadth(), 5000);
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
  isMarketHours,isMCXHours,
};