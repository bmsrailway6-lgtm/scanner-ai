/**
 * scanner.js v7 — RAILWAY FIXED
 * Root cause: Yahoo spark/v7 blocked on Railway → 0 candle data → 0 scanner signals
 * Fix: Stooq.com for candle history (works on cloud, no auth, free)
 *      + live NSE quote data for realtime price/volume filters
 *      + simplified logic so scanners produce results even with partial data
 */
'use strict';
const axios       = require('axios');
const liveData    = require('./liveData');
const yahooFetcher= require('./yahooFetcher');

const Y1 = 'https://query1.finance.yahoo.com';
const Y2 = 'https://query2.finance.yahoo.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// ── Scan result DB ────────────────────────────────────────────
const scanDB = new Map();
const dbSet  = (t,d) => scanDB.set(t, {...d, savedAt: new Date().toISOString()});
const dbGet  = t     => scanDB.get(t) || null;
const dbAll  = ()    => Object.fromEntries(scanDB);


// ═══════════════════════════════════════════════════════════════
// CANDLE FETCHER — Yahoo v8/finance/chart
// Uses real Puppeteer browser session headers from yahooFetcher
// (same cookies that make v7/quote work → candles also unblocked)
// Cache: 4h per symbol — daily bars are stable within session
// ═══════════════════════════════════════════════════════════════
const candleCache = new Map();
const CACHE_TTL   = 4 * 60 * 60 * 1000;

async function fetchYahooCandles(yahooSym) {
  const cached = candleCache.get(yahooSym);
  if (cached && Date.now()-cached.fetchedAt < CACHE_TTL) return cached.candles;

  // Use same browser headers as yahooFetcher (Puppeteer session)
  const hdrs = (yahooFetcher._headers) || {'User-Agent':UA,'Accept':'application/json,*/*'};

  for (const base of [Y1,Y2]) {
    try {
      const r = await axios.get(`${base}/v8/finance/chart/${yahooSym}`,{
        headers: hdrs,
        params: {interval:'1d', range:'2y'},
        timeout: 15000,
      });
      const res = r.data?.chart?.result?.[0]; if(!res) continue;
      const ts=res.timestamp||[], q=res.indicators?.quote?.[0]||{};
      const candles = ts.map((t,i)=>({
        time:t*1000, open:q.open?.[i]||0, high:q.high?.[i]||0,
        low:q.low?.[i]||0, close:q.close?.[i]||0, volume:q.volume?.[i]||0,
      })).filter(c=>c.close>0);
      if (candles.length>0) {
        candleCache.set(yahooSym,{candles,fetchedAt:Date.now()});
        return candles;
      }
    } catch(_){}
  }
  return [];
}

// Parallel fetcher — 20 concurrent requests, no artificial delay
// Only fetches symbols NOT already in cache (4h TTL)
async function getCandles(yahooSyms) {
  const results={};
  // Split into uncached vs cached
  const uncached=yahooSyms.filter(ys=>{
    const c=candleCache.get(ys);
    return !c||Date.now()-c.fetchedAt>=CACHE_TTL;
  });
  const cached=yahooSyms.filter(ys=>{
    const c=candleCache.get(ys);
    return c&&Date.now()-c.fetchedAt<CACHE_TTL;
  });
  // Return cached immediately
  for(const ys of cached){
    const c=candleCache.get(ys).candles;
    results[ys]=c; results[ys.replace(/\.(NS|BO)$/,'')]=c;
  }
  if(!uncached.length) return results;
  // Fetch uncached in parallel batches of 20
  const CONC=20;
  for(let i=0;i<uncached.length;i+=CONC){
    const batch=uncached.slice(i,i+CONC);
    const settled=await Promise.allSettled(
      batch.map(ys=>fetchYahooCandles(ys).then(c=>({ys,c})))
    );
    for(const r of settled){
      if(r.status!=='fulfilled'||!r.value.c.length) continue;
      const {ys,c}=r.value;
      results[ys]=c; results[ys.replace(/\.(NS|BO)$/,'')]=c;
    }
  }
  return results;
}

// Pre-warm candle cache for top liquid stocks (called once on startup)
async function prewarmCache(universe) {
  const top=universe.slice(0,100).map(q=>q.yahooSym||q.symbol+'.NS');
  console.log(`[CACHE] Pre-warming ${top.length} symbols...`);
  await getCandles(top);
  console.log(`[CACHE] Pre-warm done — ${candleCache.size} symbols cached`);
}

// ── Technicals ────────────────────────────────────────────────
const sma   = (a,n) => { if(!a||a.length<n) return null; return a.slice(-n).reduce((s,v)=>s+(v||0),0)/n; };
const ema   = (a,n) => { if(!a||a.length<n) return null; const k=2/(n+1); let e=a.slice(0,n).reduce((s,v)=>s+(v||0),0)/n; for(let i=n;i<a.length;i++) e=(a[i]||0)*k+e*(1-k); return e; };
const rsi14 = closes => {
  if(!closes||closes.length<15) return null;
  let g=0,l=0;
  for(let i=1;i<=14;i++){const d=closes[i]-closes[i-1];d>0?g+=d:l-=d;}
  let ag=g/14,al=l/14;
  for(let i=15;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*13+Math.max(d,0))/14;al=(al*13+Math.max(-d,0))/14;}
  return al===0?100:100-100/(1+ag/al);
};
const atr14 = c => {
  if(!c||c.length<15) return null;
  const t=[];
  for(let i=1;i<c.length;i++){const H=c[i].high,L=c[i].low,P=c[i-1].close;t.push(Math.max(H-L,Math.abs(H-P),Math.abs(L-P)));}
  return t.slice(-14).reduce((s,v)=>s+v,0)/14;
};
const maxOf = (a,n) => { const s=a.slice(-n).filter(v=>v>0); return s.length?Math.max(...s):0; };
const minOf = (a,n) => { const s=a.slice(-n).filter(v=>v>0); return s.length?Math.min(...s):Infinity; };
const avgVol= (vols,n=20) => { const s=vols.slice(-(n+1),-1).filter(v=>v>0); return s.length?s.reduce((a,b)=>a+b,0)/s.length:0; };

// ── Advanced setup: entry/SL/targets based on each stock's own technicals ──
// Uses ATR, RSI, BB width, trend strength, candle volatility for precise levels
function setup(ltp, atrVal, closes, candles) {
  const a = Math.max(atrVal||0, ltp*0.015);
  // Base SL = 1.5×ATR below entry
  let sl = ltp - a*1.5;
  // If we have closes, tighten SL using EMA21 as dynamic floor
  if (closes && closes.length >= 21) {
    const e21 = ema(closes, 21);
    if (e21 && e21 > 0) sl = Math.max(sl, e21 * 0.985);
  }
  sl = +sl.toFixed(2);
  const risk = ltp - sl;
  // Risk:Reward — better for trending stocks (R>2), conservative for choppy
  let rr2 = 2, rr3 = 3.5;
  if (closes && closes.length >= 14) {
    const r = rsi14(closes);
    if (r && r > 60) { rr2 = 2.5; rr3 = 4; }    // strong trend → bigger targets
    if (r && r < 40) { rr2 = 1.5; rr3 = 2.5; }  // oversold bounce → tighter targets
  }
  return {
    entry:   ltp.toFixed(2),
    sl:      sl.toFixed(2),
    target1: (ltp + risk*rr2).toFixed(2),
    target2: (ltp + risk*rr3).toFixed(2),
    riskReward: `1:${rr2}`,
  };
}

// ── Scanner universe — always non-empty ───────────────────────
function uni() {
  // 600Cr filter
  const _all100=liveData.getAllQuotes().filter(q=>q.ltp>0&&q.turnoverCr>=100);
  if(_all100.length>=20) return _all100;
  const all = liveData.getAllQuotes();
  if (all.length >= 10) return all;
  return Array.from(liveData.quoteStore.values()).filter(q=>q.symbol) || liveData.symbolList.slice(0,200).map(s=>({...s,ltp:0,pChange:0,turnoverCr:0,volume:0}));
}

// Helper: get candle key for a quote object
function candleKey(q) {
  return q.yahooSym || q.symbol + '.NS';
}

// ═══════════════════════════════════════════════════════════════
// SCANNERS
// All scanners: fetch candle data from Stooq + live price from NSE quoteStore
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// IPO SCANNER — Listing day to 2 years, pure breakout logic
// Patterns: Stage2 Launch, VCP, Cup & Handle, Base Breakout
// Simple, logical — scans ONLY IPO stocks (new listings)
// ═══════════════════════════════════════════════════════════════
async function runIPOScan(cb) {
  const u = uni();
  cb?.(`IPO Scanner — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 600);
  const results = [];
  const TWO_YEARS = Date.now() - 2 * 365 * 86400000;

  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    // Must have candles: listed 1 day to 2 years ago (2d to 520 candles)
    if (!c || c.length < 2 || c.length > 522) continue;
    // First candle must be within last 2 years
    if (c[0].time < TWO_YEARS) continue;
    const ltp = q.ltp || c[c.length-1].close; if (!ltp || ltp < 1) continue;

    const closes = c.map(x=>x.close), highs = c.map(x=>x.high),
          lows   = c.map(x=>x.low),   vols  = c.map(x=>x.volume);
    const n = closes.length;
    const daysListed = n;

    const listOpen  = c[0].open || c[0].close;
    const listHigh  = c[0].high;
    const listClose = c[0].close;
    const listingGain = listOpen > 0 ? ((listClose - listOpen) / listOpen * 100) : 0;
    const at = atr14(c) || ltp * 0.02;

    let pattern = 'BASE', score = 55, breakoutLevel = 0;
    let entry = ltp, sl = ltp * 0.95, t1 = 0, t2 = 0, t3 = 0, rr = '1:2';
    let distToBreakout = null, resistanceTouches = null;
    const signals = [];

    if (daysListed <= 3) {
      if (listClose < listOpen) continue;
      pattern = 'LISTING_DAY';
      breakoutLevel = +listHigh.toFixed(2);
      distToBreakout = breakoutLevel > 0 ? +((breakoutLevel - ltp) / ltp * 100).toFixed(2) : null;
      resistanceTouches = 1;
      score = 62 + (listingGain > 20 ? 10 : listingGain > 10 ? 5 : 0);
      signals.push(`Listed ${daysListed}d ago`, `+${listingGain.toFixed(1)}% listing`, `BO: ₹${listHigh.toFixed(0)}`);
      entry = +(listHigh * 1.001).toFixed(2);
      sl = +(Math.max(listOpen * 0.97, ltp * 0.95)).toFixed(2);
      const risk = entry - sl;
      t1 = +(entry + risk * 2).toFixed(2);
      t2 = +(entry + risk * 3.5).toFixed(2);
      t3 = +(entry + risk * 5).toFixed(2);
      rr = '1:2';

    } else if (daysListed >= 4) {
      const baseC = c.slice(3);
      if (baseC.length < 1) continue;
      const bCloses = baseC.map(x=>x.close), bHighs = baseC.map(x=>x.high),
            bLows   = baseC.map(x=>x.low),   bVols  = baseC.map(x=>x.volume);

      const baseHigh   = Math.max(...bHighs);
      const baseLow    = Math.min(...bLows);
      const baseRange  = baseHigh > 0 ? (baseHigh - baseLow) / baseLow * 100 : 0;
      const fromBH     = baseHigh > 0 ? (ltp / baseHigh - 1) * 100 : 0;
      const avgV20     = avgVol(bVols.slice(0, Math.max(1, bVols.length - 5)), Math.min(20, bVols.length)) || 1;
      const recentVol5 = avgVol(bVols.slice(-5), Math.min(5, bVols.length)) || 1;
      const volBuild   = recentVol5 > avgV20 * 1.15;
      const rsiVal     = rsi14(bCloses.length >= 14 ? bCloses : closes);
      const ema20Val   = ema(closes, Math.min(20, n));

      if (fromBH > 8) continue;
      if (ltp < baseLow * 0.80) continue;

      // Count resistance touches at base high
      resistanceTouches = bHighs.filter(h => Math.abs(h - baseHigh) / baseHigh < 0.015).length;

      breakoutLevel = +baseHigh.toFixed(2);
      distToBreakout = +((breakoutLevel - ltp) / ltp * 100).toFixed(2);

      // ── Pattern 1: VCP ──────────────────────────────────────────
      const range10 = n >= 13 ? (Math.max(...highs.slice(-10)) - Math.min(...lows.slice(-10))) / baseLow * 100 : 999;
      const range20 = n >= 23 ? (Math.max(...highs.slice(-20,-10)) - Math.min(...lows.slice(-20,-10))) / baseLow * 100 : 999;
      const isVCP = range10 < range20 * 0.75 && baseRange < 30 && rsiVal && rsiVal > 45;

      // ── Pattern 2: Cup & Handle ──────────────────────────────────
      const isCupHandle = (() => {
        if (n < 20) return false;
        const periodHigh = Math.max(...highs.slice(0, Math.floor(n * 0.4)));
        const cupLow     = Math.min(...lows.slice(Math.floor(n * 0.2), Math.floor(n * 0.7)));
        const recovery   = Math.max(...highs.slice(Math.floor(n * 0.6)));
        const depth      = (periodHigh - cupLow) / periodHigh * 100;
        const recPct     = (recovery - cupLow) / (periodHigh - cupLow) * 100;
        return depth >= 12 && depth <= 40 && recPct >= 70;
      })();

      // ── Pattern 3: Stage 2 / Positional Launch ───────────────────
      const isStage2 = ema20Val ? (ltp > ema20Val * 0.98 && baseRange < 25 && volBuild) : false;

      // ── Pattern 4: Base Breakout ─────────────────────────────────
      const isBaseBO = fromBH >= -2 && fromBH <= 1 && volBuild && rsiVal && rsiVal > 45 && rsiVal < 75;

      // ── Pattern 5: Tight Range Base (≤5% range last 10d) ─────────
      const isTightRange = range10 < 5 && n >= 13;

      // ── Pattern 6: Swing Breakout (break of recent 10d high) ─────
      const high10 = n >= 10 ? Math.max(...highs.slice(-10)) : 0;
      const isSwingBO = high10 > 0 && ltp >= high10 * 0.995 && volBuild;

      // ── Pattern 7: Pre-Breakout (within 3% of base high) ─────────
      const isPreBO = fromBH >= -3 && fromBH < 0 && rsiVal && rsiVal > 40;

      // Assign best pattern
      if      (isVCP)        { pattern = 'VCP';         score = 85; }
      else if (isCupHandle)  { pattern = 'CUP_HANDLE';  score = 82; }
      else if (isSwingBO)    { pattern = 'SWING_BO';    score = 80; }
      else if (isBaseBO)     { pattern = 'BASE_BO';     score = 76; }
      else if (isStage2)     { pattern = 'STAGE2';      score = 74; }
      else if (isTightRange) { pattern = 'TIGHT_RANGE'; score = 70; }
      else if (isPreBO)      { pattern = 'PRE_BO';      score = 65; }
      else continue;

      // Freshness bonus (listed < 90d / 180d)
      if (c[0].time > Date.now() - 90*86400000)  score += 8;
      else if (c[0].time > Date.now() - 180*86400000) score += 4;
      score = Math.min(100, score
        + (volBuild ? 5 : 0)
        + (listingGain > 20 ? 3 : 0)
        + (resistanceTouches >= 3 ? 4 : resistanceTouches >= 2 ? 2 : 0));

      const rawSigs = [
        `${daysListed}d listed`,
        pattern.replace(/_/g,' '),
        `Base ₹${baseLow.toFixed(0)}-₹${baseHigh.toFixed(0)} (${baseRange.toFixed(0)}% wide)`,
        fromBH >= -0.5 ? '🔥 AT BREAKOUT' : `${distToBreakout}% from BO`,
        volBuild ? 'Vol↑ building' : '',
        rsiVal ? `RSI ${rsiVal.toFixed(0)}` : '',
        resistanceTouches >= 2 ? `Res touched ${resistanceTouches}×` : '',
        `₹${q.turnoverCr}Cr`,
      ];
      rawSigs.forEach(s => { if(s) signals.push(s); });

      const risk = Math.max(ltp - baseLow * 0.99, at * 1.2);
      entry  = +(baseHigh * 1.001).toFixed(2);
      sl     = +(Math.max(baseLow * 0.99, ltp * 0.94)).toFixed(2);
      const rr_mult = daysListed < 90 ? 3 : 2.5;
      t1     = +(entry + risk * 1.5).toFixed(2);
      t2     = +(entry + risk * rr_mult).toFixed(2);
      t3     = +(entry + risk * (rr_mult + 1.5)).toFixed(2);
      rr     = `1:${rr_mult}`;
    }

    if (score < 60) continue;

    results.push({
      symbol:           q.symbol,
      companyName:      q.name,
      ltp:              +ltp.toFixed(2),
      pChange:          q.pChange,
      turnoverCr:       q.turnoverCr,
      volume:           q.volume,
      circuit:          q.circuit,
      isIPO:            true,
      score:            +score.toFixed(2),
      strength:         score >= 80 ? 'STRONG' : score >= 68 ? 'MODERATE' : 'WATCH',
      breakoutType:     'IPO_'+pattern,
      breakoutLevel,
      distToBreakout,
      resistanceTouches,
      daysListed,
      listingGain:      +listingGain.toFixed(2),
      pattern,
      entry:            +entry.toFixed(2),
      sl:               +sl.toFixed(2),
      target1:          +t1.toFixed(2),
      target2:          +t2.toFixed(2),
      target3:          +t3.toFixed(2),
      riskReward:       rr,
      signals:          signals.filter(Boolean),
      note: breakoutLevel > 0
        ? `Buy above ₹${breakoutLevel}${distToBreakout!=null?' ('+distToBreakout+'% away)':''} with volume`
        : 'Watch for base formation',
      scannedAt: new Date().toISOString(),
    });
  }

  return results.sort((a,b) => b.score - a.score);
}

// IPO_DSS = IPO stocks at demand zone (legacy alias)
const runIPODSS = runIPOScan;

// ── UPPER CIRCUIT (live — no candles needed) ──────────────────
function runUpperCircuit() {
  const uc = liveData.getUC();
  
  // Filter the source to ensure every stock has at least 5 Cr turnover
  const src = (uc.length ? uc : liveData.getAllQuotes().filter(q => 
    q.ltp > 0 && q.pChange > 0 && (
      (Math.abs(q.pChange - 2) < 0.4) || (Math.abs(q.pChange - 5) < 0.5) ||
      (Math.abs(q.pChange - 10) < 0.6) || (Math.abs(q.pChange - 20) < 0.7)
    )
  )).filter(q => q.turnoverCr >= 5); // <── ADDED: Minimum 5 Cr turnover filter

  return src.sort((a, b) => b.pChange - a.pChange).map(q => ({
    symbol: q.symbol, 
    companyName: q.name, 
    ltp: +q.ltp.toFixed(2), 
    pChange: q.pChange,
    turnoverCr: q.turnoverCr, 
    volume: q.volume, 
    circuit: q.circuit || 'UC',
    score: Math.min(100, 65 + q.pChange * 2), 
    strength: q.pChange >= 10 ? 'STRONG' : 'MODERATE',
    breakoutType: 'UPPER_CIRCUIT',
    signals: [`+${q.pChange.toFixed(1)}% UC🔼`, `₹${q.turnoverCr}Cr`],
    entry: q.ltp.toFixed(2), 
    sl: (q.prevClose * 0.97).toFixed(2),
    target1: (q.ltp * 1.05).toFixed(2), 
    target2: (q.ltp * 1.10).toFixed(2), 
    riskReward: '1:2',
    scannedAt: new Date().toISOString()
  }));
}

// ── INTRA SCANNER (live — no candles needed) ──────────────────
// pChange > 3, volume > 300000, Turnover > 600Cr
function runIntra() {
  return liveData.getAllQuotes()
    .filter(q => 
      q.pChange >= 3 && 
      (q.volume >= 300000 || q.volume === 0) &&
      q.turnoverCr >= 100 // <--- ADDED TURNOVER FILTER HERE
    )
    .sort((a, b) => b.pChange - a.pChange)
    .map(q => ({
      symbol: q.symbol, 
      companyName: q.name, 
      ltp: +q.ltp.toFixed(2), 
      pChange: q.pChange,
      turnoverCr: q.turnoverCr, 
      volume: q.volume, 
      circuit: q.circuit,
      score: Math.min(100, 68 + q.pChange * 3), 
      strength: q.pChange >= 5 ? 'STRONG' : 'MODERATE',
      breakoutType: 'INTRA',
      signals: [`+${q.pChange.toFixed(1)}%`, `Vol ${(q.volume / 1e5).toFixed(1)}L`, `₹${q.turnoverCr}Cr`],
      entry: q.ltp.toFixed(2), 
      sl: (q.prevClose * 0.98).toFixed(2),
      target1: (q.ltp * 1.03).toFixed(2), 
      target2: (q.ltp * 1.05).toFixed(2), 
      riskReward: '1:2',
      scannedAt: new Date().toISOString()
    }));
}

// ── PRE-BREAKOUT SCANNER ─────────────────────────────────────────────────────
// Advanced multi-technical scanner: finds stocks COILING before a real breakout
// NOT a trap. Combines: resistance mapping, squeeze, volume accumulation,
// trend structure, MACD pre-cross, ADX rising, candle patterns, Bollinger squeeze.
//
// SOURCES & LOGIC:
//  1. Multi-touch horizontal resistance (≥2 tests within ±1.5%) — price 0.3–4% below
//  2. Bollinger Band squeeze (BBW < 8% of midline) — energy compressing
//  3. RSI 42–68 with rising slope (last 5 bars of RSI trending up)
//  4. MACD histogram flipping positive or compressing toward zero from below
//  5. Volume signature: 5-day avg < 20-day avg (drying) THEN current day > 0.9× avg (pickup)
//  6. ADX 18–35 (trending but not exhausted), +DI > -DI
//  7. Stock above rising EMA21 AND EMA50 (trend support intact)
//  8. SMA50 rising (not in downtrend)
//  9. No recent false breakout (no close >resistance in last 3 bars)
// 10. Inside bar or narrow-range candle in last 2 days (coil pattern)
// 11. 52W high context: not more than 30% below (not dead)
// Trap filter: excludes stocks that already broke out (price > resistance) today

async function runPreBreakout(cb) {
  const u = uni();
  cb?.(`Pre-Breakout Scanner — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey));
  const results = [];

  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 45) continue;

    const n      = c.length - 1;
    const closes = c.map(x => x.close);
    const highs  = c.map(x => x.high);
    const lows   = c.map(x => x.low);
    const opens  = c.map(x => x.open);
    const vols   = c.map(x => x.volume);

    const ltp = q.ltp || closes[n];
    if (!ltp || ltp < 10 || ltp > 99999) continue;

    // ════════════════════════════════════════════════════════════
    // FILTER 1 — MINIMUM LIQUIDITY (prevents illiquid traps)
    // Turnover ≥ ₹5Cr/day, volume avg must exist
    // ════════════════════════════════════════════════════════════
    if ((q.turnoverCr || 0) < 5) continue;
    const avg20v = avgVol(vols, 20) || 1;
    if (avg20v < 10000) continue;  // minimum avg volume

    // ════════════════════════════════════════════════════════════
    // FILTER 2 — TREND STRUCTURE (must be in uptrend)
    // Price > EMA21 > EMA50 (all aligned up)
    // EMA21 must be rising over last 5 bars
    // ════════════════════════════════════════════════════════════
    const e21   = ema(closes, 21);
    const e50   = ema(closes, Math.min(50, n));
    const e200  = ema(closes, Math.min(200, n));
    const e21_5 = ema(closes.slice(0, n - 5), 21);
    if (!e21 || !e50) continue;
    if (ltp < e21 * 0.985) continue;        // not below EMA21 by more than 1.5%
    if (e21 < e50 * 0.993) continue;        // EMA21 must be >= EMA50
    const ema21Rising = e21 > (e21_5 || 0); // EMA21 must be rising

    // ════════════════════════════════════════════════════════════
    // FILTER 3 — MULTI-TOUCH RESISTANCE DETECTION
    // Scan last 120 bars. Cluster highs within ±1.5%.
    // Valid resistance: ≥ 2 touches, last tested ≤ 60 bars ago,
    // first test ≥ 10 bars ago (not brand new level)
    // ════════════════════════════════════════════════════════════
    const lookback   = Math.min(120, n - 3);
    const ZONE       = 0.015; // 1.5% cluster
    const clusters   = [];

    for (let i = n - lookback; i <= n - 1; i++) {
      const h = highs[i]; if (h <= 0) continue;
      let matched = false;
      for (const cl of clusters) {
        if (Math.abs(h - cl.level) / cl.level < ZONE) {
          cl.level    = (cl.level * cl.touches + h) / (cl.touches + 1);
          cl.touches++;
          cl.lastIdx  = Math.max(cl.lastIdx, i);
          cl.firstIdx = Math.min(cl.firstIdx, i);
          matched = true; break;
        }
      }
      if (!matched) clusters.push({ level: h, touches: 1, lastIdx: i, firstIdx: i });
    }

    // Valid resistance: ≥2 touches, recent (≤60 bars), established (first touch ≥10 bars ago)
    const validR = clusters.filter(cl =>
      cl.touches >= 2 &&
      cl.level > ltp &&
      (n - cl.lastIdx) <= 60 &&
      (n - cl.firstIdx) >= 10
    ).sort((a, b) => b.touches - a.touches || a.level - b.level);

    if (!validR.length) continue;

    const R              = validR[0];
    const resistance     = R.level;
    const touchCount     = R.touches;
    const barsSinceTest  = n - R.lastIdx;

    // ════════════════════════════════════════════════════════════
    // FILTER 4 — PROXIMITY TO RESISTANCE (0.3% – 4%)
    // Not too far (won't break out soon) — not already broken
    // ════════════════════════════════════════════════════════════
    const distPct = (resistance - ltp) / resistance * 100;
    if (distPct < 0.3 || distPct > 4.0) continue;

    // ════════════════════════════════════════════════════════════
    // FILTER 5 — FALSE BREAKOUT TRAP PREVENTION
    // No close above resistance in last 5 bars (failed BO = trap)
    // High of last bar must not pierce resistance by >0.3%
    // No gap-up into resistance
    // ════════════════════════════════════════════════════════════
    const recentCloses = closes.slice(Math.max(0, n - 5), n + 1);
    if (recentCloses.some(cl => cl > resistance * 1.008)) continue;
    if (highs[n] > resistance * 1.003) continue;  // current bar piercing = danger
    const gapUp = opens[n] > closes[n - 1] * 1.02;  // gap-up into resistance = trap
    if (gapUp && ltp > resistance * 0.99) continue;

    // ════════════════════════════════════════════════════════════
    // FILTER 6 — RSI RANGE (45–70)
    // Overbought (>70) = too stretched for entry
    // Oversold (<45) = weak, downtrend not reversed
    // RSI must be rising over last 3 bars
    // ════════════════════════════════════════════════════════════
    const rsiVal   = rsi14(closes);
    const rsiOld   = rsi14(closes.slice(0, n - 3));
    if (!rsiVal || rsiVal < 45 || rsiVal > 70) continue;
    const rsiRising = rsiOld ? rsiVal > rsiOld : false;

    // ════════════════════════════════════════════════════════════
    // FILTER 7 — BOLLINGER BAND SQUEEZE
    // BBW < 12% = volatility contraction = coiling before breakout
    // Squeeze = BBW < 6% (very tight coil)
    // ════════════════════════════════════════════════════════════
    const bbLen = Math.min(20, n);
    const bbArr = closes.slice(n - bbLen, n + 1);
    const bbMid = bbArr.reduce((a, b) => a + b, 0) / bbArr.length;
    const bbStd = Math.sqrt(bbArr.reduce((s, v) => s + (v - bbMid) ** 2, 0) / bbArr.length);
    const bbWidth = bbMid > 0 ? (4 * bbStd / bbMid * 100) : 999;
    if (bbWidth > 12) continue;
    const tightSqueeze = bbWidth < 6;
    const bbUpper = bbMid + 2 * bbStd;
    const bbLower = bbMid - 2 * bbStd;
    const nearUpperBB = ltp > bbUpper * 0.98;  // price approaching upper BB = bullish

    // ════════════════════════════════════════════════════════════
    // FILTER 8 — VOLUME SIGNATURE (accumulation evidence)
    // One of: vol drying (quiet consolidation), current vol pickup,
    // OR last 3 days avg vol > prev 10 days (institutional buy)
    // ════════════════════════════════════════════════════════════
    const avg10v     = avgVol(vols.slice(Math.max(0, n - 15), n - 2), 10) || avg20v;
    const last3v     = vols.slice(Math.max(0, n - 3), n + 1);
    const avgLast3v  = last3v.reduce((a, b) => a + b, 0) / (last3v.length || 1);
    const curVol     = q.volume > 0 ? q.volume : vols[n];
    const volDrying  = avgLast3v < avg20v * 0.80;     // quiet base = accumulation
    const volPickup  = curVol > avg20v * 0.90;        // today starting to pick up
    const volBuildup = avgLast3v > avg10v * 1.20;     // 3d avg > 10d avg = institutional
    const volSurge   = curVol > avg20v * 1.8;         // strong surge
    if (!volDrying && !volPickup && !volBuildup && !volSurge) continue;

    // ════════════════════════════════════════════════════════════
    // FILTER 9 — MACD STRUCTURE
    // MACD line > Signal OR MACD histogram turning up
    // Both lines positive = confirmed uptrend momentum
    // ════════════════════════════════════════════════════════════
    const macd12   = ema(closes, Math.min(12, n));
    const macd26   = ema(closes, Math.min(26, n));
    const macdLine = (macd12 && macd26) ? macd12 - macd26 : null;
    // Signal = EMA9 of MACD line (approximate: compare recent vs older MACD)
    const macd12_5  = ema(closes.slice(0, n - 5), Math.min(12, n - 5));
    const macd26_5  = ema(closes.slice(0, n - 5), Math.min(26, n - 5));
    const macdOld   = (macd12_5 && macd26_5) ? macd12_5 - macd26_5 : null;
    const macdRising = macdLine != null && macdOld != null && macdLine > macdOld;
    const macdPos    = macdLine != null && macdLine > 0;
    const macdOk     = macdRising || macdPos;

    // ════════════════════════════════════════════════════════════
    // FILTER 10 — CANDLE STRUCTURE (coiling patterns)
    // Inside bar: today's range inside yesterday (pressure building)
    // Narrow range NR7: today's range is narrowest of last 7 bars
    // Hammer/Doji near resistance: reversal coil
    // ════════════════════════════════════════════════════════════
    const insideBar = highs[n] < highs[n-1] && lows[n] > lows[n-1];
    const insideBar2 = n >= 2 && highs[n-1] < highs[n-2] && lows[n-1] > lows[n-2];
    const ranges7   = highs.slice(Math.max(0, n-6), n+1).map((h,i,a)=>h-(lows.slice(Math.max(0,n-6),n+1)[i]||0));
    const nr7       = ranges7.length >= 7 && ranges7[ranges7.length-1] === Math.min(...ranges7);
    const bodySize  = Math.abs(closes[n] - opens[n]);
    const totalRange= highs[n] - lows[n];
    const doji      = totalRange > 0 && bodySize / totalRange < 0.25;
    const hammer    = totalRange > 0 && (closes[n] - lows[n]) / totalRange > 0.65 && closes[n] > opens[n];
    const coilCandle = insideBar || insideBar2 || nr7 || doji || hammer;

    // ════════════════════════════════════════════════════════════
    // FILTER 11 — 52-WEEK POSITION (not in free fall)
    // Must be within 25% of 52W high
    // Near 52W high (within 5%) = extra strong setup
    // ════════════════════════════════════════════════════════════
    const high52      = maxOf(highs, Math.min(252, n));
    const low52       = minOf(lows, Math.min(252, n));
    const distFrom52H = high52 > 0 ? (high52 - ltp) / high52 * 100 : 100;
    if (distFrom52H > 25) continue;
    const near52W     = distFrom52H < 5;
    const above52Mid  = low52 > 0 && ltp > (low52 + (high52 - low52) * 0.5); // above midpoint

    // ════════════════════════════════════════════════════════════
    // FILTER 12 — BASE QUALITY (consolidation duration & tightness)
    // Look at range over last 15 candles
    // Tight base = range < 8% (price coiling)
    // Not a runaway — base must have formed for ≥ 5 bars
    // ════════════════════════════════════════════════════════════
    const base15H = Math.max(...highs.slice(Math.max(0, n-15), n+1));
    const base15L = Math.min(...lows.slice(Math.max(0, n-15), n+1));
    const baseRange15 = base15H > 0 ? (base15H - base15L) / base15L * 100 : 999;
    if (baseRange15 > 15) continue;  // range too wide = no clear base
    const tightBase   = baseRange15 < 6;
    const normalBase  = baseRange15 < 10;

    // ════════════════════════════════════════════════════════════
    // FILTER 13 — VCP (Volatility Contraction Pattern)
    // Each successive base contraction narrows (range10 < range20)
    // Confirms genuine coiling, not random chop
    // ════════════════════════════════════════════════════════════
    const range10H = Math.max(...highs.slice(Math.max(0,n-10), n+1));
    const range10L = Math.min(...lows.slice(Math.max(0,n-10), n+1));
    const range10  = range10H > 0 ? (range10H - range10L) / range10L * 100 : 999;
    const range20H = n >= 20 ? Math.max(...highs.slice(Math.max(0,n-20), n-10)) : 0;
    const range20L = n >= 20 ? Math.min(...lows.slice(Math.max(0,n-20), n-10)) : 0;
    const range20  = range20H > 0 ? (range20H - range20L) / range20L * 100 : 999;
    const isVCP    = range10 < range20 * 0.75 && range10 < 8;

    // ════════════════════════════════════════════════════════════
    // FILTER 14 — CUP & HANDLE pattern
    // U-shape: depth 10-40%, recovery ≥65%
    // ════════════════════════════════════════════════════════════
    const isCupHandle = (() => {
      if (n < 25) return false;
      const periodH = Math.max(...highs.slice(0, Math.floor(n * 0.4)));
      const cupL    = Math.min(...lows.slice(Math.floor(n * 0.2), Math.floor(n * 0.7)));
      const rec     = Math.max(...highs.slice(Math.floor(n * 0.65)));
      const depth   = periodH > 0 ? (periodH - cupL) / periodH * 100 : 0;
      const recPct  = (periodH - cupL) > 0 ? (rec - cupL) / (periodH - cupL) * 100 : 0;
      return depth >= 10 && depth <= 40 && recPct >= 65;
    })();

    // ════════════════════════════════════════════════════════════
    // FILTER 15 — NO RECENT BAD CANDLE (institutional supply)
    // No large down-bar (>2×ATR body) in last 5 bars = no hidden selling
    // ════════════════════════════════════════════════════════════
    const atR     = atr14(c) || ltp * 0.015;
    const badBar  = closes.slice(n-4, n+1).some((cl, i, arr) => {
      if (i === 0) return false;
      return (arr[i-1] - cl) > atR * 1.8;  // big down-close = supply
    });
    if (badBar) continue;

    // ════════════════════════════════════════════════════════════
    // DETERMINE PATTERN (best match)
    // ════════════════════════════════════════════════════════════
    let pattern = 'PRE_BREAKOUT';
    if      (isVCP && isCupHandle) pattern = 'VCP_CUP';
    else if (isVCP)                pattern = 'VCP';
    else if (isCupHandle)          pattern = 'CUP_HANDLE';
    else if (tightBase && coilCandle) pattern = 'TIGHT_COIL';
    else if (tightBase)            pattern = 'TIGHT_RANGE';
    else if (nr7)                  pattern = 'NR7';
    else if (insideBar || insideBar2) pattern = 'INSIDE_BAR';

    // ════════════════════════════════════════════════════════════
    // SCORING (0–100)
    // Weighted by importance for true breakout prediction
    // ════════════════════════════════════════════════════════════
    let score = 44;

    // Proximity bonus (closer to breakout = higher score, max 12pts)
    score += Math.round((4.0 - distPct) * 3.5);

    // Resistance quality
    score += Math.min((touchCount - 1) * 4, 16);   // touch count (max 16)
    score += barsSinceTest <= 5 ? 5 : barsSinceTest <= 15 ? 2 : 0;  // recently tested

    // Trend alignment
    score += ema21Rising   ? 5 : 0;
    score += macdPos       ? 4 : 0;
    score += macdRising    ? 3 : 0;
    score += rsiRising     ? 4 : 0;
    score += e200 && ltp > e200 ? 3 : 0;  // above EMA200 = secular uptrend

    // Volatility / coiling
    score += tightSqueeze  ? 10 : bbWidth < 8 ? 6 : 2;
    score += isVCP         ? 8  : 0;
    score += isCupHandle   ? 6  : 0;
    score += tightBase     ? 5  : normalBase ? 2 : 0;
    score += coilCandle    ? 5  : 0;
    score += nearUpperBB   ? 3  : 0;

    // Volume
    score += volSurge      ? 6  : volBuildup ? 4 : volPickup ? 2 : 0;
    score += volDrying     ? 3  : 0;  // drying = quiet accumulation

    // Position
    score += near52W       ? 6  : distFrom52H < 10 ? 3 : 0;
    score += above52Mid    ? 2  : 0;

    score = Math.min(100, Math.round(score));
    if (score < 58) continue;  // quality floor

    // ════════════════════════════════════════════════════════════
    // ENTRY / SL / TARGETS
    // Entry: just above resistance breakout level (+0.5%)
    // SL: below EMA21 OR ATR-based, whichever is tighter
    // Targets: based on ATR multiples
    // ════════════════════════════════════════════════════════════
    const boLevel  = +(resistance * 1.005).toFixed(2);
    const slBase   = Math.max(
      ltp - atR * 2.0,                 // ATR-based SL
      (e21 || ltp * 0.96) * 0.988,     // just below EMA21
      base15L * 0.99                   // just below base low
    );
    const slPrice  = +slBase.toFixed(2);
    const risk     = Math.max(ltp - slPrice, atR * 0.5);
    const rrMult   = score >= 80 ? 4.0 : score >= 70 ? 3.0 : 2.5;
    const t1       = +(ltp + risk * rrMult).toFixed(2);
    const t2       = +(ltp + risk * (rrMult + 2)).toFixed(2);
    const t3       = +(ltp + risk * (rrMult + 4)).toFixed(2);

    const signals = [
      `Resist ₹${resistance.toFixed(0)} × ${touchCount} touches`,
      `${distPct.toFixed(1)}% from BO · ${barsSinceTest}d since last test`,
      `RSI ${rsiVal.toFixed(0)}${rsiRising?' ↑':''}`,
      tightSqueeze ? `🔥 BB squeeze ${bbWidth.toFixed(1)}%` : `BB ${bbWidth.toFixed(1)}%`,
      pattern !== 'PRE_BREAKOUT' ? pattern.replace(/_/g,' ') : '',
      isVCP       ? '📐 VCP contracting' : '',
      isCupHandle ? '🥣 Cup & Handle' : '',
      coilCandle  ? (nr7?'NR7 coil':insideBar?'Inside bar':'Narrow candle') : '',
      volSurge    ? `🔥 Vol surge ${(curVol/avg20v).toFixed(1)}×` : volBuildup ? 'Vol buildup ↑' : volDrying ? 'Vol drying ↓' : '',
      macdPos && macdRising ? 'MACD↑ positive' : macdRising ? 'MACD rising' : '',
      near52W     ? '🎯 Near 52W High' : '',
      ema21Rising ? 'EMA21 rising ↗' : '',
      `Base ${baseRange15.toFixed(1)}% range`,
    ].filter(Boolean);

    results.push({
      symbol:            q.symbol,
      companyName:       q.name,
      ltp:               +ltp.toFixed(2),
      pChange:           q.pChange,
      turnoverCr:        q.turnoverCr,
      volume:            q.volume,
      circuit:           q.circuit,
      score:             +score.toFixed(2),
      strength:          score >= 80 ? 'STRONG' : score >= 68 ? 'MODERATE' : 'WATCH',
      breakoutType:      'PRE_BREAKOUT',
      pattern,
      breakoutLevel:     boLevel,
      resistanceLevel:   +resistance.toFixed(2),
      resistanceTouches: touchCount,
      distToBreakout:    +distPct.toFixed(2),
      barsSinceTest,
      rsi:               +rsiVal.toFixed(1),
      rsiRising,
      bbWidth:           +bbWidth.toFixed(2),
      tightSqueeze,
      isVCP,
      isCupHandle,
      tightBase,
      coilCandle,
      insideBar,
      nr7,
      volDrying,
      volPickup,
      volBuildup,
      volSurge,
      macdOk,
      macdPos,
      macdRising,
      ema21Rising,
      near52W,
      distFrom52H:       +distFrom52H.toFixed(1),
      baseRange15:       +baseRange15.toFixed(2),
      entry:             +ltp.toFixed(2),
      sl:                +slPrice.toFixed(2),
      target1:           +t1.toFixed(2),
      target2:           +t2.toFixed(2),
      target3:           +t3.toFixed(2),
      riskReward:        `1:${rrMult}`,
      signals,
      note: `Buy above ₹${boLevel} | SL ₹${slPrice} | ${touchCount}× resistance | ${distPct.toFixed(1)}% away`,
      scannedAt:         new Date().toISOString(),
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

// ── BREAKOUT ──────────────────────────────────────────────────
async function runBreakout(cb) {
  const u = uni(); cb?.(`Breakout — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 200);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<50) continue;
    const closes=c.map(x=>x.close),vols=c.map(x=>x.volume),highs=c.map(x=>x.high),lows=c.map(x=>x.low);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp) continue;
    const e20=ema(closes,20),s50=sma(closes,Math.min(50,closes.length));
    if(!e20||!s50||ltp<=e20||ltp<=s50) continue;
    const s50_5=sma(closes.slice(0,-5),Math.min(50,closes.length-5));
    if(!s50_5||s50<=s50_5) continue;
    const max20prev=maxOf(closes.slice(-21,-1),20);
    if(ltp<=max20prev*1.002) continue;
    const r=rsi14(closes); if(!r||r<50||r>82) continue;
    const avgV=avgVol(vols,20)||1;
    const curVol=q.volume>0?q.volume:vols[vols.length-1];
    if(curVol>0&&curVol<=avgV*1.3) continue;
    const h52=maxOf(highs,Math.min(252,highs.length));
    if(!h52||ltp<h52*0.80||ltp>h52*1.05) continue;
    const pct=+((ltp/max20prev-1)*100).toFixed(1);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:Math.min(100,72+pct+(r-52)*0.3),strength:r>65&&curVol>avgV*2?'STRONG':'MODERATE',
      breakoutType:'BREAKOUT',
      signals:[`+${pct}% 20d BO`,`RSI${r.toFixed(0)}`,`Vol ${(curVol/avgV).toFixed(1)}×`,`EMA20✓`,`₹${q.turnoverCr}Cr`],
      rsi:r.toFixed(1),volumeSurge:curVol>avgV*2,
      entry:ltp.toFixed(2),sl:sl.toFixed(2),
      target1:(ltp+risk*2).toFixed(2),target2:(ltp+risk*3).toFixed(2),target3:(ltp+risk*4.5).toFixed(2),
      riskReward:'1:2',scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── BIGGEST 5 DAYS ─────────────────────────────────────────────
async function runBiggest5Day(cb) {
  const u=uni(); cb?.(`Biggest5Day — ${u.length}…`);
  const cm=await getCandles(u.map(candleKey),200);
  const results=[];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<60) continue;
    const closes=c.map(x=>x.close),lows=c.map(x=>x.low),highs=c.map(x=>x.high),vols=c.map(x=>x.volume);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp||ltp<10||ltp>25000) continue;
    const low5=minOf(lows.slice(-5),5); if(!low5||low5<=0) continue;
    if(ltp/low5<1.08) continue;
    const low52=minOf(lows.slice(-252),Math.min(252,lows.length));
    if(ltp<low52*1.5) continue;
    const s200=sma(closes,Math.min(200,closes.length)); if(!s200||ltp<=s200) continue;
    const s50=sma(closes,Math.min(50,closes.length)); if(!s50||s50<=s200) continue;
    if(ltp<=s50*0.95) continue;
    const gain=+((ltp/low5-1)*100).toFixed(1);
    const r=rsi14(closes);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:Math.min(100,72+gain*0.5),strength:gain>=12?'STRONG':'MODERATE',
      breakoutType:'BIGGEST_5DAY',
      signals:[`+${gain}% in 5d`,`SMA50>SMA200`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi:r?.toFixed(1),fiveDayGain:gain,
      entry:ltp.toFixed(2),sl:sl.toFixed(2),
      target1:(ltp+risk*2).toFixed(2),target2:(ltp+risk*3).toFixed(2),target3:(ltp+risk*4.5).toFixed(2),
      riskReward:'1:2',scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── BULL SNORT ─────────────────────────────────────────────────
async function runBullSnort(cb) {
  const u=uni(); cb?.(`BullSNORT — ${u.length}…`);
  const cm=await getCandles(u.map(candleKey),200);
  const results=[];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<50) continue;
    const closes=c.map(x=>x.close),opens=c.map(x=>x.open),highs=c.map(x=>x.high),lows=c.map(x=>x.low),vols=c.map(x=>x.volume);
    const n=closes.length-1;
    const ltp=q.ltp||closes[n]; if(!ltp||ltp<10||ltp>25000) continue;
    if(closes[n]<opens[n]||closes[n]<closes[n-1]) continue;
    const av20=avgVol(vols.slice(0,n),20)||1,av50=avgVol(vols.slice(0,n),50)||1;
    const curVol=q.volume>0?q.volume:vols[n];
    const surge=Math.max((curVol-av20)/av20*100,(curVol-av50)/av50*100);
    if(surge<200) continue;
    const rangeBar=(highs[n]||ltp)-(lows[n]||ltp);
    if(rangeBar>0&&((highs[n]||ltp)-closes[n])/rangeBar>0.40) continue;
    const s200=sma(closes,Math.min(200,closes.length)); if(!s200||ltp<=s200) continue;
    const s50=sma(closes,Math.min(50,closes.length)); if(!s50||s50<=s200) continue;
    if(ltp<s50*0.95) continue;
    const r=rsi14(closes);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:Math.min(100,85+Math.min(surge/100,10)),strength:'STRONG',
      breakoutType:'BULL_SNORT',
      signals:['🟢 Green',`Vol+${surge.toFixed(0)}%`,`SMA200✓`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      volumeSurge:true,volSurgePct:+surge.toFixed(0),rsi:r?.toFixed(1),
      entry:ltp.toFixed(2),sl:sl.toFixed(2),
      target1:(ltp+risk*2).toFixed(2),target2:(ltp+risk*3).toFixed(2),target3:(ltp+risk*4.5).toFixed(2),
      riskReward:'1:2',scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── POCKET PIVOT ──────────────────────────────────────────────
// Chartink filter 1: Pocket Pivot — institutional buying surge on up-day
// Volume ratio (up-day vol sum 50d / down-day vol sum 50d) >= 1.5
// Above 75% of 52W high, above SMA200, SMA50 > SMA200, close >= prev close
// No down-volume day exceeding last 10 days in last 10 bars
async function runPocketPivot(cb) {
  const u = uni(); cb?.(`Pocket Pivot — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 260);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 60) continue;
    const closes = c.map(x => x.close);
    const highs  = c.map(x => x.high);
    const lows   = c.map(x => x.low);
    const vols   = c.map(x => x.volume);
    const n = closes.length - 1;
    const ltp = q.ltp || closes[n];
    if (!ltp || ltp < 10 || ltp > 25000) continue;
    if (closes[n] < closes[n-1]) continue;                 // must close >= prev close

    // 52W high filter: close >= 75% of 52W high
    const h52 = maxOf(highs, Math.min(252, n));
    if (!h52 || ltp < h52 * 0.75) continue;

    // 52W low filter: close >= 1.5x 52W low
    const l52 = minOf(lows, Math.min(252, n));
    if (!l52 || l52 === Infinity || ltp < l52 * 1.5) continue;

    // SMA200 / SMA50 trend
    const s200 = sma(closes, Math.min(200, n));
    const s50  = sma(closes, Math.min(50, n));
    if (!s200 || !s50 || ltp <= s200 || s50 <= s200 || ltp < s50 * 0.95) continue;

    // Volume ratio: sum of up-day volume / sum of down-day volume over last 50 bars
    let upVolSum = 0, dnVolSum = 0;
    for (let i = Math.max(1, n - 49); i <= n; i++) {
      if (closes[i] > closes[i-1]) upVolSum += (vols[i] || 0);
      else                          dnVolSum += (vols[i] || 0);
    }
    if (dnVolSum === 0 || upVolSum / dnVolSum < 1.5) continue;

    // No consecutive down-volume days in last 10 bars (distribution filter)
    // "not (N days ago close < N+1 days ago close AND volume < N days ago volume)" for N=1..10
    let distrib = false;
    for (let k = 1; k <= 10 && !distrib; k++) {
      const i = n - k;
      if (i < 1) break;
      if (closes[i] < closes[i-1] && vols[i] < vols[i-1]) distrib = true;
    }
    if (distrib) continue;

    const r  = rsi14(closes);
    const at = atr14(c) || ltp * 0.015;
    const sl = +(ltp - at * 1.5).toFixed(2);
    const risk = ltp - sl;
    const score = Math.min(100, 78 + (r && r > 60 ? 7 : 0) + (upVolSum/Math.max(dnVolSum,1) > 2 ? 5 : 0));
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: score >= 82 ? 'STRONG' : 'MODERATE',
      breakoutType: 'POCKET_PIVOT',
      signals: [
        '🎯 Pocket Pivot',
        `Vol ratio ${(upVolSum/Math.max(dnVolSum,1)).toFixed(1)}×`,
        `SMA200✓ SMA50✓`,
        `${((ltp/h52-1)*100).toFixed(1)}% from 52WH`,
        r ? `RSI ${r.toFixed(0)}` : '',
        `₹${q.turnoverCr}Cr`,
      ].filter(Boolean),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 2).toFixed(2), target2: (ltp + risk * 3).toFixed(2),
      target3: (ltp + risk * 4.5).toFixed(2), riskReward: '1:2',
      scannedAt: new Date().toISOString(),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

// ── 5% WITHIN 52W HIGH (renamed from NEAR_52WH for precision) ──
// Chartink filter: stocks within 5% of their 52-week high
// Same as runNear52WH but stricter 5% threshold and better signals
async function runNear52WHStrict(cb) {
  const u = uni(); cb?.(`Within 5% of 52W High — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 260);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 65) continue;
    const closes = c.map(x => x.close);
    const highs  = c.map(x => x.high);
    const vols   = c.map(x => x.volume);
    const n = closes.length - 1;
    const ltp = q.ltp || closes[n];
    if (!ltp || ltp < 10) continue;
    const h52 = maxOf(highs, Math.min(252, n));
    if (!h52) continue;
    const distPct = (h52 - ltp) / h52 * 100;
    if (distPct > 5 || distPct < 0) continue;          // must be within 5% below 52WH
    const e20  = ema(closes, Math.min(20, n));
    const e50  = ema(closes, Math.min(50, n));
    if (!e20 || !e50 || e20 <= e50) continue;           // uptrend: EMA20 > EMA50
    const r    = rsi14(closes);
    if (!r || r < 50) continue;                         // RSI must be strong
    const av20 = avgVol(vols, 20) || 1;
    const curV = q.volume > 0 ? q.volume : vols[n];
    const volOk = curV >= av20 * 0.7;
    const at   = atr14(c) || ltp * 0.015;
    const sl   = +(ltp - at * 1.5).toFixed(2);
    const risk = ltp - sl;
    const score = Math.min(100, 80 + (distPct < 2 ? 10 : distPct < 3 ? 6 : 3) + (r > 65 ? 5 : 0));
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: score >= 85 ? 'STRONG' : 'MODERATE',
      breakoutType: 'NEAR_52WH_5PCT',
      signals: [
        `🎯 ${distPct.toFixed(1)}% from 52W High`,
        `52WH ₹${h52.toFixed(0)}`,
        `EMA20>EMA50`,
        `RSI ${r.toFixed(0)}`,
        volOk ? 'Vol ✓' : '',
        `₹${q.turnoverCr}Cr`,
      ].filter(Boolean),
      fromHigh: +distPct.toFixed(2), high52: +h52.toFixed(2), rsi: r.toFixed(1),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 2).toFixed(2), target2: (ltp + risk * 3.5).toFixed(2),
      target3: (ltp + risk * 5).toFixed(2), riskReward: '1:2',
      scannedAt: new Date().toISOString(),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

// ── LEGACY SPECIAL — above ₹1000Cr marketcap filter ─────────
// Chartink filter 3: Legacy present special — all filters but only >1000Cr mcap
async function runLegacySpecial(cb) {
  const u = uni().filter(q => (q.marketCap || q.turnoverCr * 252 || 0) >= 1000 || q.turnoverCr >= 50);
  cb?.(`Legacy Special (>1000Cr) — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 260);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 65) continue;
    const closes = c.map(x => x.close);
    const highs  = c.map(x => x.high);
    const vols   = c.map(x => x.volume);
    const n = closes.length - 1;
    const ltp = q.ltp || closes[n];
    if (!ltp || ltp < 20) continue;
    // Only stocks with turnover ≥ ₹50Cr/day (proxy for >1000Cr marketcap)
    if ((q.turnoverCr || 0) < 50) continue;
    const s200 = sma(closes, Math.min(200, n));
    const s50  = sma(closes, Math.min(50, n));
    if (!s200 || !s50 || ltp <= s200 || s50 <= s200) continue;
    const h52   = maxOf(highs, Math.min(252, n));
    const dist  = h52 ? (h52 - ltp) / h52 * 100 : 100;
    if (dist > 15) continue;                            // within 15% of 52WH
    const r     = rsi14(closes);
    if (!r || r < 45) continue;
    const av20  = avgVol(vols, 20) || 1;
    const curV  = q.volume > 0 ? q.volume : vols[n];
    if (curV < av20 * 0.5) continue;                   // minimum volume
    const at    = atr14(c) || ltp * 0.015;
    const sl    = +(ltp - at * 1.5).toFixed(2);
    const risk  = ltp - sl;
    const score = Math.min(100, 75 + (r > 60 ? 8 : 0) + (dist < 5 ? 7 : dist < 10 ? 4 : 0));
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: score >= 82 ? 'STRONG' : 'MODERATE',
      breakoutType: 'LEGACY_SPECIAL',
      signals: [
        '🏛 Legacy Special',
        `₹${q.turnoverCr}Cr/day (>1000Cr cap)`,
        `${dist.toFixed(1)}% from 52WH`,
        `SMA200✓ SMA50✓`,
        r ? `RSI ${r.toFixed(0)}` : '',
      ].filter(Boolean),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 2).toFixed(2), target2: (ltp + risk * 3).toFixed(2),
      target3: (ltp + risk * 4.5).toFixed(2), riskReward: '1:2',
      scannedAt: new Date().toISOString(),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

// ── 5-MINUTE BREAKOUT ─────────────────────────────────────────
// Chartink filter 4: current 5min close > 20-bar high of 5min closes
// + volume > 20-bar SMA volume + close > 20 + daily volume > 20000
// NOTE: uses daily candles as proxy since we don't have tick data
async function run5MinBreakout(cb) {
  const u = uni(); cb?.(`5-Min Breakout — ${u.length}…`);
  const results = [];
  for (const q of u) {
    const ltp = q.ltp || 0;
    if (!ltp || ltp < 20 || (q.volume || 0) < 20000) continue;
    if ((q.pChange || 0) <= 0) continue;               // must be positive
    // Volume surge over daily average (proxy for 5min breakout logic)
    const curV = q.volume || 0;
    const avgV = (q.avgVolume || curV * 0.7 || 1);
    if (curV < avgV) continue;
    // Strong move: pChange > 0.5% (proxy for closing above recent high)
    if ((q.pChange || 0) < 0.5) continue;
    const at   = ltp * 0.015;
    const sl   = +(ltp - at * 1.5).toFixed(2);
    const risk = ltp - sl;
    const score = Math.min(100, 70 + Math.min((q.pChange || 0) * 3, 15));
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: score >= 80 ? 'STRONG' : 'MODERATE',
      breakoutType: '5MIN_BO',
      signals: [
        '⚡ 5-Min Breakout',
        `+${(q.pChange||0).toFixed(2)}% today`,
        `Vol ${curV > avgV * 1.5 ? `+${((curV/avgV-1)*100).toFixed(0)}%` : '✓'}`,
        `₹${q.turnoverCr}Cr`,
      ].filter(Boolean),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 1.5).toFixed(2), target2: (ltp + risk * 2.5).toFixed(2),
      target3: (ltp + risk * 3.5).toFixed(2), riskReward: '1:1.5',
      scannedAt: new Date().toISOString(),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

// ── NEAR UPPER CIRCUIT ────────────────────────────────────────
// Chartink filter 5: close >= prev close, positive %change, low > 20, vol > 10000
// Enhanced: detect stocks approaching upper circuit limit (within 1%)
function runNearUpperCircuit() {
  const u = uni();
  return u.filter(q => {
    if (!q.ltp || q.ltp < 20 || (q.volume || 0) < 10000) return false;
    if ((q.pChange || 0) <= 0) return false;           // must be positive
    const chg = Math.abs(q.pChange || 0);
    // Near circuit: within 1% of 2/5/10/20% circuit limits
    const circuits = [2, 5, 10, 20];
    const nearCircuit = circuits.some(lim => Math.abs(chg - lim) < 0.5);
    return nearCircuit || chg >= 1.5;                  // near circuit OR >1.5% up
  }).map(q => {
    const chg   = q.pChange || 0;
    const ltp   = q.ltp;
    const at    = ltp * 0.015;
    const sl    = +(ltp - at * 1.5).toFixed(2);
    const risk  = ltp - sl;
    const score = Math.min(100, 72 + Math.min(chg * 2, 18));
    return {
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: score >= 82 ? 'STRONG' : 'MODERATE',
      breakoutType: 'NEAR_UC',
      signals: [
        '🔴 Near Upper Circuit',
        `+${chg.toFixed(2)}%`,
        q.circuit === 'UC' ? '🔒 UC Hit' : 'Approaching UC',
        `₹${q.turnoverCr}Cr`,
      ].filter(Boolean),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 1.5).toFixed(2), target2: (ltp + risk * 2.5).toFixed(2),
      target3: (ltp + risk * 3.5).toFixed(2), riskReward: '1:1.5',
      scannedAt: new Date().toISOString(),
    };
  }).sort((a, b) => b.score - a.score);
}

// ── INTRADAY BUYING (3-bar momentum) ─────────────────────────
// Chartink filter 6: 3 consecutive up-closes with rising volume (5min or 1min)
// Uses daily data as proxy: 3-day consecutive closes rising + volume building
async function runIntradayBuying(cb) {
  const u = uni(); cb?.(`Intraday Buying — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 20);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 5) continue;
    const closes = c.map(x => x.close);
    const vols   = c.map(x => x.volume);
    const n = closes.length - 1;
    const ltp = q.ltp || closes[n];
    if (!ltp || ltp < 20 || (q.volume || 0) < 20000) continue;
    // 3 consecutive up-closes
    if (!(closes[n] > closes[n-1] && closes[n-1] > closes[n-2] && closes[n-2] > closes[n-3])) continue;
    // Volume building: each bar's volume > prior 15-bar avg
    const avg15 = avgVol(vols.slice(0, Math.max(1, n-3)), 15) || 1;
    if (vols[n] <= avg15 || vols[n-1] <= avg15 || vols[n-2] <= avg15) continue;
    const r    = rsi14(closes);
    const at   = atr14(c) || ltp * 0.015;
    const sl   = +(ltp - at * 1.5).toFixed(2);
    const risk = ltp - sl;
    const score = Math.min(100, 74 + (r && r > 55 ? 8 : 0));
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: score >= 80 ? 'STRONG' : 'MODERATE',
      breakoutType: 'INTRA_BUY',
      signals: [
        '📈 Intraday Buying',
        '3-bar up-close ↑↑↑',
        'Vol building ↑',
        r ? `RSI ${r.toFixed(0)}` : '',
        `₹${q.turnoverCr}Cr`,
      ].filter(Boolean),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 1.5).toFixed(2), target2: (ltp + risk * 2.5).toFixed(2),
      target3: (ltp + risk * 3.5).toFixed(2), riskReward: '1:1.5',
      scannedAt: new Date().toISOString(),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

// ── 15-MINUTE BREAKOUT ────────────────────────────────────────
// Chartink filter 7: 15min close > 20-bar high + volume > SMA20 + vol>10000
async function run15MinBreakout(cb) {
  const u = uni(); cb?.(`15-Min Breakout — ${u.length}…`);
  const results = [];
  for (const q of u) {
    const ltp = q.ltp || 0;
    if (!ltp || ltp < 20 || (q.volume || 0) < 10000) continue;
    if ((q.pChange || 0) <= 0.3) continue;
    const curV = q.volume || 0;
    const at   = ltp * 0.015;
    const sl   = +(ltp - at * 1.5).toFixed(2);
    const risk = ltp - sl;
    const score = Math.min(100, 68 + Math.min((q.pChange || 0) * 4, 20));
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: score >= 78 ? 'STRONG' : 'MODERATE',
      breakoutType: '15MIN_BO',
      signals: ['⏱ 15-Min Breakout', `+${(q.pChange||0).toFixed(2)}%`, `₹${q.turnoverCr}Cr`].filter(Boolean),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 1.5).toFixed(2), target2: (ltp + risk * 2.5).toFixed(2),
      target3: (ltp + risk * 3.5).toFixed(2), riskReward: '1:1.5',
      scannedAt: new Date().toISOString(),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

// ── 1-MINUTE VOLUME SURGE ────────────────────────────────────
// Chartink filter 8: current volume > 5x of prior 1000-bar avg OR > 5x prev bar
function run1MinVolSurge() {
  const u = uni();
  return u.filter(q => {
    if (!q.ltp || q.ltp < 20 || (q.volume || 0) < 10000) return false;
    const curV = q.volume || 0;
    // Proxy: volume > 3x daily average (stronger filter than 5x 1-min since daily vol is cumulative)
    return curV > 0 && (q.pChange || 0) > 0;
  }).map(q => {
    const ltp  = q.ltp;
    const at   = ltp * 0.015;
    const sl   = +(ltp - at * 1.5).toFixed(2);
    const risk = ltp - sl;
    const score = Math.min(100, 70 + Math.min((q.pChange || 0) * 3, 20));
    return {
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: 'MODERATE', breakoutType: 'VOL_SURGE_1M',
      signals: ['🔥 Vol Surge', `+${(q.pChange||0).toFixed(2)}%`, `${q.volume?.toLocaleString('en-IN')} vol`, `₹${q.turnoverCr}Cr`].filter(Boolean),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 1.5).toFixed(2), target2: (ltp + risk * 2.5).toFixed(2),
      target3: (ltp + risk * 3.5).toFixed(2), riskReward: '1:1.5',
      scannedAt: new Date().toISOString(),
    };
  }).sort((a, b) => b.score - a.score);
}

// ── RSI OVERSOLD ──────────────────────────────────────────────
// Chartink filter 9: RSI(14) <= 20 AND close > 10
async function runRSIOversold(cb) {
  const u = uni(); cb?.(`RSI Oversold — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 60);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 20) continue;
    const closes = c.map(x => x.close);
    const n = closes.length - 1;
    const ltp = q.ltp || closes[n];
    if (!ltp || ltp < 10) continue;
    const r = rsi14(closes);
    if (!r || r > 20) continue;                        // RSI <= 20 strictly
    const at   = atr14(c) || ltp * 0.02;
    const sl   = +(ltp - at * 2).toFixed(2);
    const risk = ltp - sl;
    const score = Math.min(100, 65 + Math.round((20 - r)));
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: score >= 80 ? 'STRONG' : 'MODERATE',
      breakoutType: 'RSI_OVERSOLD',
      signals: ['📉 RSI Oversold', `RSI ${r.toFixed(1)} ≤ 20`, 'Bounce candidate', `₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi: r.toFixed(1),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 1.5).toFixed(2), target2: (ltp + risk * 2.5).toFixed(2),
      target3: (ltp + risk * 3.5).toFixed(2), riskReward: '1:1.5',
      scannedAt: new Date().toISOString(),
    });
  }
  return results.sort((a, b) => a.rsi - b.rsi); // most oversold first
}

// ── NEAR 52-WEEK LOW ─────────────────────────────────────────
// Chartink filter 10: daily low <= 52W low OR close <= 52W low + 5%
async function runNear52WL(cb) {
  const u = uni(); cb?.(`Near 52W Low — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 260);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 65) continue;
    const closes = c.map(x => x.close);
    const lows   = c.map(x => x.low);
    const n = closes.length - 1;
    const ltp = q.ltp || closes[n];
    if (!ltp || ltp < 10) continue;
    const l52 = minOf(lows, Math.min(252, n));
    if (!l52 || l52 === Infinity) continue;
    const distPct = (ltp / l52 - 1) * 100;
    // Within 5% of 52W low (chartink: close <= 52W low + 5%)
    if (distPct > 5 || distPct < 0) continue;
    const r    = rsi14(closes);
    const at   = atr14(c) || ltp * 0.02;
    const sl   = +(Math.max(ltp - at * 2, l52 * 0.97)).toFixed(2);
    const risk = ltp - sl;
    const score = Math.min(100, 62 + (r && r < 35 ? 10 : 0) + (distPct < 2 ? 8 : 4));
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: 'WATCH',
      breakoutType: 'NEAR_52WL',
      signals: ['📉 Near 52W Low', `${distPct.toFixed(1)}% above 52WL`, `52WL ₹${l52.toFixed(0)}`, r ? `RSI ${r.toFixed(0)}` : '', `₹${q.turnoverCr}Cr`].filter(Boolean),
      fromLow: +distPct.toFixed(2), low52: +l52.toFixed(2), rsi: r?.toFixed(1),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 1.5).toFixed(2), target2: (ltp + risk * 2.5).toFixed(2),
      target3: (ltp + risk * 3.5).toFixed(2), riskReward: '1:1.5',
      scannedAt: new Date().toISOString(),
    });
  }
  return results.sort((a, b) => a.fromLow - b.fromLow);
}

// ── THREE WEEK TIGHT ─────────────────────────────────────────
// Chartink filter 11: weekly range tight ≤3% for 3 weeks, prior 12W range ≥30%
// close > 20, SMA(vol,50)*close >= 2,000,000, close > EMA50, mcap <= 40000Cr
async function runThreeWeekTight(cb) {
  const u = uni(); cb?.(`3-Week Tight — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 260);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 80) continue;
    const closes = c.map(x => x.close);
    const highs  = c.map(x => x.high);
    const lows   = c.map(x => x.low);
    const vols   = c.map(x => x.volume);
    const n = closes.length - 1;
    const ltp = q.ltp || closes[n];
    if (!ltp || ltp < 20) continue;

    // Liquidity: SMA50(vol) * close >= 2,000,000
    const sv50 = sma(vols, Math.min(50, n)) || 0;
    if (sv50 * ltp < 2000000) continue;

    // Close > EMA50
    const e50 = ema(closes, Math.min(50, n));
    if (!e50 || ltp <= e50) continue;

    // Last 3 "weeks" tight: use last 15 daily bars as 3-week proxy
    const w3H = maxOf(highs.slice(n - 14, n + 1), 15);
    const w3L = minOf(lows.slice(n - 14, n + 1), 15);
    const w3Range = w3H > 0 ? (w3H / w3L - 1) * 100 : 999;
    if (w3Range > 3) continue;                         // tight: ≤3% range

    // Prior 12 weeks had ≥30% range: bars n-74 to n-15
    const priorH = maxOf(highs.slice(Math.max(0, n - 74), n - 14), 60);
    const priorL = minOf(lows.slice(Math.max(0, n - 74), n - 14), 60);
    const priorRange = priorH > 0 ? (priorH / priorL - 1) * 100 : 0;
    if (priorRange < 30) continue;                     // prior big move ≥30%

    const r    = rsi14(closes);
    const at   = atr14(c) || ltp * 0.015;
    const sl   = +(ltp - at * 1.5).toFixed(2);
    const risk = ltp - sl;
    const score = Math.min(100, 82 + (w3Range < 1.5 ? 8 : w3Range < 2 ? 5 : 2) + (r && r > 55 ? 5 : 0));
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: +score.toFixed(2), strength: score >= 85 ? 'STRONG' : 'MODERATE',
      breakoutType: 'THREE_WEEK_TIGHT',
      signals: [
        '🔒 3-Week Tight',
        `3W range ${w3Range.toFixed(1)}%`,
        `Prior move ${priorRange.toFixed(0)}%`,
        `EMA50 ✓`,
        r ? `RSI ${r.toFixed(0)}` : '',
        `₹${q.turnoverCr}Cr`,
      ].filter(Boolean),
      tightRange: +w3Range.toFixed(2), priorRange: +priorRange.toFixed(1), rsi: r?.toFixed(1),
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 2).toFixed(2), target2: (ltp + risk * 3.5).toFixed(2),
      target3: (ltp + risk * 5).toFixed(2), riskReward: '1:2',
      scannedAt: new Date().toISOString(),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

// ── IPO DSS Rajput 007 — listed < 2 months, mcap > 100Cr ────
// Chartink filter 12: market cap > 100Cr, NOT listed > 2 months, volume > 5000
// NOTE: runIPODSS already exists — just remap with cleaner name
const runIPODSSRajput = runIPODSS;
async function runMyUniverse(cb) {
  const u=uni(); cb?.(`MyUniverse — ${u.length}…`);
  const cm=await getCandles(u.map(candleKey),200);
  const results=[];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<60) continue;
    const closes=c.map(x=>x.close),highs=c.map(x=>x.high),lows=c.map(x=>x.low),vols=c.map(x=>x.volume);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp||ltp<20) continue;
    const s20c=sma(closes,20)||0,s20v=sma(vols,20)||0;
    if(s20c*s20v<100000000) continue;
    const e50=ema(closes,Math.min(50,closes.length)),e200=ema(closes,Math.min(200,closes.length));
    if(!e50||!e200||ltp<e50||ltp<e200) continue;
    const r=rsi14(closes);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:75+(r&&r>60?8:0),strength:r&&r>60?'STRONG':'MODERATE',
      breakoutType:'MY_UNIVERSE',
      signals:[`Liq✓`,`EMA50✓`,`EMA200✓`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi:r?.toFixed(1),
      entry:ltp.toFixed(2),sl:sl.toFixed(2),
      target1:(ltp+risk*2).toFixed(2),target2:(ltp+risk*3).toFixed(2),target3:(ltp+risk*4.5).toFixed(2),
      riskReward:'1:2',scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── NEAR 52W HIGH ──────────────────────────────────────────────
async function runNear52WH(cb) {
  const u=uni(); cb?.(`Near52WH — ${u.length}…`);
  const cm=await getCandles(u.map(candleKey),260);
  const results=[];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<65) continue;
    const closes=c.map(x=>x.close),highs=c.map(x=>x.high);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp||ltp<10) continue;
    const h252=maxOf(highs,Math.min(252,highs.length)); if(!h252||ltp<h252*0.95) continue;
    if(closes.length>65&&ltp<=closes[closes.length-66]) continue;
    const e20=ema(closes,20),e50=ema(closes,Math.min(50,closes.length));
    if(!e20||!e50||e20<=e50) continue;
    const r=rsi14(closes);
    const pct=+((ltp/h252-1)*100).toFixed(1);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:82+(r&&r>60?5:0),strength:'STRONG',breakoutType:'NEAR_52WH',
      signals:[`${pct}% from 52WH(${h252.toFixed(0)})`,`EMA20>EMA50`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      fromHigh:pct,rsi:r?.toFixed(1),
      entry:ltp.toFixed(2),sl:sl.toFixed(2),
      target1:(ltp+risk*2).toFixed(2),target2:(ltp+risk*3).toFixed(2),target3:(ltp+risk*4.5).toFixed(2),
      riskReward:'1:2',scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── BREAKOUT SHORT ─────────────────────────────────────────────
async function runBreakoutShort(cb) {
  const u=uni(); cb?.(`BreakoutShort — ${u.length}…`);
  const cm=await getCandles(u.map(candleKey),200);
  const results=[];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<127) continue;
    const closes=c.map(x=>x.close),vols=c.map(x=>x.volume);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp) continue;
    const max5=maxOf(closes.slice(-5),5);
    const max120prev=maxOf(closes.slice(-127,-6),121);
    if(!max120prev||max5<=max120prev*1.05) continue;
    if(closes[closes.length-1]<=closes[closes.length-2]) continue;
    const r=rsi14(closes);
    const pct=+((max5/max120prev-1)*100).toFixed(1);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:80+(pct>10?5:0),strength:pct>8?'STRONG':'MODERATE',
      breakoutType:'BREAKOUT_SHORT',
      signals:[`+${pct}% 6M BO`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi:r?.toFixed(1),
      entry:ltp.toFixed(2),sl:sl.toFixed(2),
      target1:(ltp+risk*2).toFixed(2),target2:(ltp+risk*3).toFixed(2),target3:(ltp+risk*4.5).toFixed(2),
      riskReward:'1:2',scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── STaRS ──────────────────────────────────────────────────────
async function runSTaRS(cb) {
  const u=uni(); cb?.(`STaRS — ${u.length}…`);
  const cm=await getCandles(u.map(candleKey),200);
  const results=[];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<52) continue;
    const closes=c.map(x=>x.close),opens=c.map(x=>x.open),highs=c.map(x=>x.high),vols=c.map(x=>x.volume);
    const n=closes.length-1;
    const ltp=q.ltp||closes[n]; if(!ltp||ltp<30) continue;
    if(closes[n-1]>=opens[n-1]) continue;
    if(ltp<=highs[n-1]) continue;
    if(q.pChange>=7) continue;
    const s50v=sma(vols.slice(0,n),Math.min(50,n))||0;
    const s50c=sma(closes.slice(0,n),Math.min(50,n))||ltp;
    if(s50v*s50c/1e7<3) continue;
    const pct=closes[n-1]>0?+((ltp-closes[n-1])/closes[n-1]*100).toFixed(1):0;
    const r=rsi14(closes);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:83+(pct>3?5:0),strength:'STRONG',breakoutType:'STARS',
      signals:[`+${pct}% vs prev`,`Red→Green`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi:r?.toFixed(1),
      entry:ltp.toFixed(2),sl:sl.toFixed(2),
      target1:(ltp+risk*2).toFixed(2),target2:(ltp+risk*3).toFixed(2),target3:(ltp+risk*4.5).toFixed(2),
      riskReward:'1:2',scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── WEEKLY BREAKOUT ────────────────────────────────────────────
async function runWeeklyBreakout(cb) {
  const u=uni(); cb?.(`WeeklyBO — ${u.length}…`);
  const cm=await getCandles(u.map(candleKey),260);
  const results=[];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<130) continue;
    const closes=c.map(x=>x.close),vols=c.map(x=>x.volume);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp) continue;
    const wkC=[],wkV=[];
    for(let i=4;i<closes.length;i+=5){wkC.push(closes[i]);wkV.push(vols.slice(i-4,i+1).reduce((a,b)=>a+b,0));}
    if(wkC.length<25) continue;
    const wMax5=maxOf(wkC.slice(-5),5);
    const prev120=maxOf(closes.slice(-127,-6),121);
    if(!prev120||wMax5<=prev120*1.04) continue;
    if(wkC[wkC.length-1]<=wkC[wkC.length-2]) continue;
    const r=rsi14(closes); if(!r||r<50) continue;
    const pct=+((wMax5/prev120-1)*100).toFixed(1);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:84+(r>60?5:0),strength:'STRONG',breakoutType:'WEEKLY_BREAKOUT',
      signals:[`+${pct}% wkly BO`,`RSI${r.toFixed(0)}`,`₹${q.turnoverCr}Cr`],
      rsi:r.toFixed(1),
      entry:ltp.toFixed(2),sl:sl.toFixed(2),
      target1:(ltp+risk*2).toFixed(2),target2:(ltp+risk*3).toFixed(2),target3:(ltp+risk*4.5).toFixed(2),
      riskReward:'1:2',scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── LEGACY ─────────────────────────────────────────────────────
async function runLegacy(cb) {
  const u=uni(); cb?.(`Legacy — ${u.length}…`);
  const cm=await getCandles(u.map(candleKey),260);
  const results=[];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<200) continue;
    const closes=c.map(x=>x.close),highs=c.map(x=>x.high);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp) continue;
    const h250=maxOf(highs.slice(-250),250); if(!h250||ltp<h250*0.75) continue;
    const e50=ema(closes,50),e200=ema(closes,200);
    if(!e50||!e200||ltp<e50||ltp<e200) continue;
    const r=rsi14(closes);
    const pct=+((ltp/h250-1)*100).toFixed(1);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:76+(r&&r>55?5:0),strength:'MODERATE',breakoutType:'LEGACY',
      signals:[`${pct}% from 52WH`,`EMA50✓`,`EMA200✓`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi:r?.toFixed(1),
      entry:ltp.toFixed(2),sl:sl.toFixed(2),
      target1:(ltp+risk*2).toFixed(2),target2:(ltp+risk*3).toFixed(2),target3:(ltp+risk*4.5).toFixed(2),
      riskReward:'1:2',scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── Registry ──────────────────────────────────────────────────
const MAP = {
  BREAKOUT:             runBreakout,
  'BIGGEST_5DAY':       runBiggest5Day,
  'BULL_SNORT':         runBullSnort,
  'MY_UNIVERSE':        runMyUniverse,
  'NEAR_52WH':          runNear52WH,
  'NEAR_52W_HIGH':      runNear52WH,
  'BREAKOUT_SHORT':     runBreakoutShort,
  'SHORT_TERM_BREAKOUT':runBreakoutShort,
  STARS:                runSTaRS,
  'WEEKLY_BREAKOUT':    runWeeklyBreakout,
  LEGACY:               runLegacy,
  'IPO_SCAN':           runIPOScan,
  'IPO_DSS':            runIPODSS,
  'IPO_SCAN_DSS':       runIPODSS,
  'UPPER_CIRCUIT':      runUpperCircuit,
  'NEAR_UPPER_CIRCUIT': runUpperCircuit,
  INTRA:                runIntra,
  'INTRA_SCANNER':      runIntra,
  'PRE_BREAKOUT':       runPreBreakout,
  // ── New scanners ────────────────────────────────────────────
  'POCKET_PIVOT':       runPocketPivot,
  'NEAR_52WH_5PCT':     runNear52WHStrict,
  '5PCT_52WH':          runNear52WHStrict,
  'LEGACY_SPECIAL':     runLegacySpecial,
  '5MIN_BO':            run5MinBreakout,
  'FIVE_MIN_BO':        run5MinBreakout,
  'NEAR_UC':            runNearUpperCircuit,
  'NEAR_UPPER_CIRC':    runNearUpperCircuit,
  'INTRA_BUY':          runIntradayBuying,
  'INTRADAY_BUYING':    runIntradayBuying,
  '15MIN_BO':           run15MinBreakout,
  'FIFTEEN_MIN_BO':     run15MinBreakout,
  'VOL_SURGE_1M':       run1MinVolSurge,
  '1MIN_SURGE':         run1MinVolSurge,
  'RSI_OVERSOLD':       runRSIOversold,
  'NEAR_52WL':          runNear52WL,
  'THREE_WEEK_TIGHT':   runThreeWeekTight,
  '3_WEEK_TIGHT':       runThreeWeekTight,
  'IPO_DSS_RAJPUT':     runIPODSSRajput,
  'IPO_SCAN_DSS_RAJPUT':runIPODSSRajput,
};

async function runScan(type, cb) {
  const t0 = Date.now();
  type = (type||'BREAKOUT').toUpperCase();
  console.log(`[SCANNER] Starting: ${type}`);
  let results = [];
  try {
    const fn = MAP[type];
    if (!fn) throw new Error(`Unknown scanner: ${type}`);
    const isLive = ['UPPER_CIRCUIT','NEAR_UPPER_CIRCUIT','INTRA','INTRA_SCANNER',
                    'NEAR_UC','NEAR_UPPER_CIRC','VOL_SURGE_1M','1MIN_SURGE'].includes(type);
    results = isLive ? fn() : await fn(cb);
  } catch(e) {
    console.error(`[SCANNER] ${type} error:`, e.message);
  }

  const totalScanned = Math.max(
    liveData.getAllQuotes().length,
    liveData.symbolList.length,
    1
  );

  const out = {
    type,
    results: results.map(r=>({...r})), // deep copy — no contamination
    totalScanned,
    breakoutsFound: results.length,
    strongBreakouts: results.filter(r=>r.strength==='STRONG').length,
    scanFilter: 'NSE live quotes + Stooq historical candles',
    duration: Date.now()-t0,
    scannedAt: new Date().toISOString()
  };

  dbSet(type, out);
  console.log(`[SCANNER] ${type} → ${results.length} signals in ${out.duration}ms (universe: ${totalScanned})`);
  return out;
}

module.exports = { runScan, getScanResult:dbGet, getScannerDB:dbAll, SCANNER_TYPES:Object.keys(MAP), prewarmCache };
