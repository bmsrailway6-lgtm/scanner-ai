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

function setup(ltp, atrVal) {
  if(!ltp||ltp<=0) return {entry:'--',sl:'--',target1:'--',target2:'--',riskReward:'1:2'};
  // Dynamic ATR-based levels: tighter SL for low-vol, wider for high-vol
  const pctVol = atrVal>0 ? atrVal/ltp : 0.02;
  // SL: 1.5x ATR below entry (min 1%, max 8%)
  const slPct = Math.min(0.08, Math.max(0.01, pctVol*1.5));
  const sl = +(ltp*(1-slPct)).toFixed(2);
  const risk = ltp - sl;
  // Targets: 2:1 and 3:1 reward:risk
  const t1 = +(ltp + risk*2).toFixed(2);
  const t2 = +(ltp + risk*3).toFixed(2);
  // Additional: pivot target (round number resistance)
  const mag = Math.pow(10, Math.floor(Math.log10(ltp))-1);
  const pivotT1 = +(Math.ceil((ltp + risk*1.5)/mag)*mag).toFixed(2);
  return {
    entry: ltp.toFixed(2),
    sl: sl.toFixed(2),
    target1: t1.toFixed(2),
    target2: t2.toFixed(2),
    riskReward: '1:2',
    slPct: (slPct*100).toFixed(1)+'%',
  };
}

// ── Scanner universe — always non-empty ───────────────────────
function uni() {
  // 600Cr filter
  const _all300=liveData.getAllQuotes().filter(q=>q.ltp>0&&q.turnoverCr>=300);
  if(_all300.length>=20) return _all300;
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

// ── IPO SCAN — Listing day to 2 years, all breakout patterns ──
// Covers: Stage 2 Launch, VCP, Base Breakout, Pocket Pivot, Gap & Go
async function runIPOScan(cb) {
  const u = uni(); cb?.(`IPO Scan — ${u.length} stocks…`);
  const syms = u.map(candleKey);
  const cm = await getCandles(syms, 750); // 2 years = ~730 trading days
  const results = [];
  const twoYears = Date.now() - 730*86400000; // 2 years

  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    // Listed within 2 years (listing day to 730 candles)
    if (!c || c.length < 1 || c.length > 735) continue;
    if (c[0].time < twoYears) continue;

    const closes = c.map(x=>x.close);
    const highs  = c.map(x=>x.high);
    const lows   = c.map(x=>x.low);
    const vols   = c.map(x=>x.volume);
    const ltp    = q.ltp || closes[closes.length-1];
    if (!ltp || ltp < 1) continue;

    const n       = closes.length - 1;
    const curVol  = q.volume > 0 ? q.volume : (vols[n]||0);
    const avgV    = avgVol(vols, Math.min(20, n)) || 1;
    const at      = atr14(c) || ltp * 0.025;
    const r       = rsi14(closes);
    const listHigh = Math.max(...highs.slice(0, Math.min(5, n)));
    const listOpen = c[0]?.open || closes[0];
    const listClose = closes[0];
    const allLow   = Math.min(...lows);
    const allHigh  = Math.max(...highs);
    const prevClose = q.prevClose || closes[Math.max(0, n-1)];

    let score = 55;
    let pattern = 'IPO_MOMENTUM';
    let sigs = [`Listed ${c.length}d`];

    // ── Pattern 1: Listing day (1-3 days) ────────────────────
    if (c.length <= 3) {
      score += 15; pattern = 'LISTING_DAY';
      sigs.push('Listing day momentum');
      if (ltp > listOpen) { score += 10; sigs.push('Above issue price'); }
    }

    // ── Pattern 2: Stage 2 Launch (above listing high) ───────
    if (ltp > listHigh && c.length > 3) {
      score += 15; pattern = 'STAGE2_LAUNCH';
      sigs.push(`Above listing high ₹${listHigh.toFixed(0)}`);
    }

    // ── Pattern 3: VCP (Volatility Contraction Pattern) ──────
    if (n >= 15) {
      const segs = [];
      const segSize = Math.max(3, Math.floor(n/5));
      for (let i = segSize; i < n; i += segSize) {
        const h2 = Math.max(...highs.slice(i-segSize,i));
        const l2 = Math.min(...lows.slice(i-segSize,i));
        segs.push(h2 > 0 ? (h2-l2)/h2*100 : 99);
      }
      if (segs.length >= 3 && segs.every((v,i) => i===0 || v < segs[i-1]*1.05)) {
        score += 12; pattern = 'VCP';
        sigs.push(`VCP ${segs.length} contractions`);
      }
    }

    // ── Pattern 4: Base breakout (recovering from IPO low) ───
    const fromLow = allLow > 0 ? (ltp - allLow) / allLow * 100 : 0;
    if (fromLow > 15 && ltp > closes[Math.max(0,n-5)] && c.length > 10) {
      score += 8; if(pattern==='IPO_MOMENTUM') pattern='BASE_BREAKOUT';
      sigs.push(`+${fromLow.toFixed(0)}% from base`);
    }

    // ── Pattern 5: Pocket Pivot (vol > any down day in 10d) ──
    if (n >= 10 && curVol > 0) {
      const downVols = vols.slice(n-10,n).filter((_,i,a)=>closes[n-10+i]<(closes[n-10+i-1]||closes[n-10+i]));
      const maxDownVol = downVols.length ? Math.max(...downVols) : 0;
      if (maxDownVol > 0 && curVol > maxDownVol && ltp > closes[n-1]) {
        score += 8; sigs.push('Pocket Pivot');
      }
    }

    // ── Boost: volume surge ───────────────────────────────────
    const volRatio = avgV > 0 ? curVol / avgV : 1;
    if (volRatio >= 2.5) { score += 10; sigs.push(`Vol ${volRatio.toFixed(1)}x`); }
    else if (volRatio >= 1.5) { score += 5; sigs.push(`Vol ${volRatio.toFixed(1)}x`); }

    // ── Boost: RSI ────────────────────────────────────────────
    if (r && r > 60) { score += 6; sigs.push(`RSI ${r.toFixed(0)}`); }
    else if (r && r > 50) score += 3;

    // ── Boost: today's performance ────────────────────────────
    if (q.pChange > 5) { score += 6; sigs.push(`+${q.pChange.toFixed(1)}% today`); }
    else if (q.pChange > 2) { score += 3; sigs.push(`+${q.pChange.toFixed(1)}%`); }
    else if (q.pChange < -5) { score -= 8; }

    // ── Boost: recent listing (<30d) ─────────────────────────
    if (c.length <= 30) score += 5;

    // ── Near 52W high (upper 15%) ────────────────────────────
    if (allHigh > 0 && ltp > allHigh * 0.85) {
      score += 5; sigs.push(`Near ${c.length}d high`);
    }

    if (score < 60) continue;
    if (q.pChange < -8) continue;

    sigs.push(`₹${q.turnoverCr}Cr`);

    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2),
      pChange: q.pChange, change: +(ltp - prevClose).toFixed(2),
      high: q.high||highs[n], low: q.low||lows[n],
      volume: q.volume, turnoverCr: q.turnoverCr,
      circuit: q.circuit, isIPO: true,
      score: Math.min(100, score),
      strength: score >= 80 ? 'STRONG' : 'MODERATE',
      breakoutType: pattern, daysListed: c.length,
      listHigh: +listHigh.toFixed(2), allLow: +allLow.toFixed(2),
      allHigh: +allHigh.toFixed(2), fromLow: +fromLow.toFixed(1),
      signals: sigs, rsi: r?.toFixed(1),
      ...setup(ltp, at),
      scannedAt: new Date().toISOString()
    });
  }
  return results.sort((a,b) => b.score - a.score);
}


// ── BIGGEST 5 DAYS (1 WEEK) GAINER ───────────────────────────
// close/min(5,low) >= 1.08, above SMA200, SMA50>SMA200, ATR% >= 3
async function runBiggest5Day(cb) {
  const u = uni(); cb?.(`Biggest 5Days — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 400);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 60) continue;
    const closes = c.map(x=>x.close), lows = c.map(x=>x.low), highs = c.map(x=>x.high), vols = c.map(x=>x.volume);
    const ltp = q.ltp || closes[closes.length-1]; if (!ltp || ltp < 10 || ltp > 25000) continue;
    const low5 = minOf(lows.slice(-5), 5); if (!low5||low5<=0) continue;
    if (ltp/low5 < 1.08) continue;
    const low52 = minOf(lows.slice(-252), Math.min(252,lows.length));
    if (ltp < low52*1.5) continue;
    const s200 = sma(closes, Math.min(200,closes.length)); if (!s200||ltp<=s200) continue;
    const s50  = sma(closes, Math.min(50,closes.length));  if (!s50||s50<=s200) continue;
    if (ltp <= s50*0.95) continue;
    const recentRange = highs.slice(-20).reduce((sum,h,i)=>{const l=lows[lows.length-20+i];return sum+(l>0?h/l:1);},0)/20;
    if ((recentRange-1)*100 < 3) continue;
    const avgV50 = sma(vols.slice(0,-1), Math.min(50,vols.length-1))||0;
    if (avgV50*ltp < 10000000) continue;
    const at = atr14(c), r = rsi14(closes);
    const gain = +((ltp/low5-1)*100).toFixed(1);
    results.push({
      symbol:q.symbol, companyName:q.name, ltp:+ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit,
      score:Math.min(100,72+gain*0.5), strength:gain>=12?'STRONG':'MODERATE',
      breakoutType:'BIGGEST_5DAY',
      signals:[`+${gain}% in 5d`,`SMA50>SMA200`,`52WL*1.5✓`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi:r?.toFixed(1), fiveDayGain:gain, ...setup(ltp,at||ltp*0.02), scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── BULL SNORT (Oliver Kell) ──────────────────────────────────
// Green candle, volume surge >= 200% vs 20/50d avg, upper wick <= 40%
// Above SMA200, SMA50>SMA200, 52WL*1.5, ATR% >= 3
async function runBullSnort(cb) {
  const u = uni(); cb?.(`Bull_SNORT — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 300);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 50) continue;
    const closes=c.map(x=>x.close), opens=c.map(x=>x.open), highs=c.map(x=>x.high), lows=c.map(x=>x.low), vols=c.map(x=>x.volume);
    const n = closes.length-1;
    const ltp = q.ltp || closes[n]; if (!ltp||ltp<10||ltp>25000) continue;
    if (closes[n] < opens[n] || closes[n] < closes[n-1]) continue; // must be green
    const av20 = avgVol(vols.slice(0,n), 20)||1, av50 = avgVol(vols.slice(0,n), 50)||1;
    const curVol = q.volume > 0 ? q.volume : vols[n];
    const surge = Math.max((curVol-av20)/av20*100, (curVol-av50)/av50*100);
    if (surge < 200) continue;
    const rangeBar = (highs[n]||ltp) - (lows[n]||ltp);
    if (rangeBar > 0 && ((highs[n]||ltp)-closes[n])/rangeBar > 0.40) continue;
    const s200 = sma(closes, Math.min(200,closes.length)); if (!s200||ltp<=s200) continue;
    const s50  = sma(closes, Math.min(50,closes.length));  if (!s50||s50<=s200) continue;
    if (ltp < s50*0.95) continue;
    const low52 = minOf(lows.slice(-252), Math.min(252,lows.length));
    if (ltp < low52*1.5) continue;
    const recentRange = highs.slice(-20).reduce((sum,h,i)=>{const l=lows[lows.length-20+i];return sum+(l>0?h/l:1);},0)/20;
    if ((recentRange-1)*100 < 3) continue;
    const at = atr14(c), r = rsi14(closes);
    results.push({
      symbol:q.symbol, companyName:q.name, ltp:+ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit,
      score:Math.min(100,85+Math.min(surge/100,10)), strength:'STRONG',
      breakoutType:'BULL_SNORT',
      signals:['🟢 Green candle',`Vol+${surge.toFixed(0)}%`,`SMA200✓`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      volumeSurge:true, volSurgePct:+surge.toFixed(0), rsi:r?.toFixed(1),
      ...setup(ltp,at||ltp*0.02), scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── MY UNIVERSE (Accuracy_invst without FNO) ─────────────────
// close >= 20, sma20c*sma20v >= 10Cr, close >= ema50, close >= ema200
// (sum(high,20)/sum(low,20)-1)*100 > 3
async function runMyUniverse(cb) {
  const u = uni(); cb?.(`My Universe — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 300);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 60) continue;
    const closes=c.map(x=>x.close), highs=c.map(x=>x.high), lows=c.map(x=>x.low), vols=c.map(x=>x.volume);
    const ltp = q.ltp || closes[closes.length-1]; if (!ltp||ltp<20) continue;
    const s20c = sma(closes,20)||0, s20v = sma(vols,20)||0;
    if (s20c*s20v < 100000000) continue;
    const e50  = ema(closes, Math.min(50,closes.length));
    const e200 = ema(closes, Math.min(200,closes.length));
    if (!e50||!e200||ltp<e50||ltp<e200) continue;
    const sumH20 = highs.slice(-20).reduce((a,b)=>a+b,0);
    const sumL20 = lows.slice(-20).reduce((a,b)=>a+b,0);
    if (sumL20<=0 || (sumH20/sumL20-1)*100<=3) continue;
    const at = atr14(c), r = rsi14(closes);
    results.push({
      symbol:q.symbol, companyName:q.name, ltp:+ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit,
      score:75+(r&&r>60?8:0)+(ltp>e50*1.05?5:0), strength:r&&r>60?'STRONG':'MODERATE',
      breakoutType:'MY_UNIVERSE',
      signals:[`Liq₹${(s20c*s20v/1e7).toFixed(0)}Cr`,`EMA50✓`,`EMA200✓`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi:r?.toFixed(1), ...setup(ltp,at||ltp*0.02), scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── STOCK NEAR 5% OF 52 WEEK HIGH ────────────────────────────
// close >= max(252,high)*0.95, ema20>ema50, close>ema21, positive 3M trend
async function runNear52WH(cb) {
  const u = uni(); cb?.(`Near 52W High — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 400);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 65) continue;
    const closes=c.map(x=>x.close), highs=c.map(x=>x.high);
    const ltp = q.ltp || closes[closes.length-1]; if (!ltp||ltp<10) continue;
    const h252 = maxOf(highs, Math.min(252,highs.length)); if (!h252||ltp<h252*0.95) continue;
    if (closes.length > 65 && ltp <= closes[closes.length-66]) continue;
    const e20 = ema(closes,20), e50 = ema(closes,Math.min(50,closes.length));
    if (!e20||!e50||e20<=e50) continue;
    const e21 = ema(closes,21); if (!e21||ltp<=e21) continue;
    const at = atr14(c), r = rsi14(closes);
    const pct = +((ltp/h252-1)*100).toFixed(1);
    results.push({
      symbol:q.symbol, companyName:q.name, ltp:+ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit,
      score:82+(r&&r>60?5:0), strength:'STRONG', breakoutType:'NEAR_52WH',
      signals:[`${pct}% from 52WH(${h252.toFixed(0)})`,`EMA20>EMA50`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      fromHigh:pct, rsi:r?.toFixed(1), ...setup(ltp,at||ltp*0.015), scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── BREAKOUTS IN SHORT TERM ───────────────────────────────────
// max(5,close) > 6d ago max(120,close)*1.05, vol > sma(5), close > prev
async function runBreakoutShort(cb) {
  const u = uni(); cb?.(`Breakouts Short Term — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 200);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 127) continue;
    const closes=c.map(x=>x.close), vols=c.map(x=>x.volume);
    const ltp = q.ltp || closes[closes.length-1]; if (!ltp) continue;
    const max5 = maxOf(closes.slice(-5), 5);
    const max120prev = maxOf(closes.slice(-127,-6), 121);
    if (!max120prev || max5 <= max120prev*1.05) continue;
    const avgV5 = avgVol(vols, 5)||1;
    const curVol = q.volume>0 ? q.volume : vols[vols.length-1];
    if (curVol > 0 && curVol <= avgV5) continue;
    if (closes[closes.length-1] <= closes[closes.length-2]) continue;
    const at = atr14(c), r = rsi14(closes);
    const pct = +((max5/max120prev-1)*100).toFixed(1);
    results.push({
      symbol:q.symbol, companyName:q.name, ltp:+ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit,
      score:80+(pct>10?5:0), strength:pct>8?'STRONG':'MODERATE',
      breakoutType:'BREAKOUT_SHORT',
      signals:[`+${pct}% above 6M high`,`Vol>5d avg`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi:r?.toFixed(1), ...setup(ltp,at||ltp*0.02), scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── STaRS (Short-Term Relative Strength) ─────────────────────
// close > 30, prev day red, today > prev high, pChange < 7%, turnover >= 3Cr
async function runSTaRS(cb) {
  const u = uni(); cb?.(`STaRS — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 100);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 52) continue;
    const closes=c.map(x=>x.close), opens=c.map(x=>x.open), highs=c.map(x=>x.high), vols=c.map(x=>x.volume);
    const n = closes.length-1;
    const ltp = q.ltp || closes[n]; if (!ltp||ltp<30) continue;
    if (closes[n-1] >= opens[n-1]) continue;         // prev must be red
    if (ltp <= highs[n-1]) continue;                  // must break prev high
    if (q.pChange >= 7) continue;
    const s50v = sma(vols.slice(0,n), Math.min(50,n))||0;
    const s50c = sma(closes.slice(0,n), Math.min(50,n))||ltp;
    if (s50v*s50c/1e7 < 3) continue;
    const pct = closes[n-1]>0 ? +((ltp-closes[n-1])/closes[n-1]*100).toFixed(1) : 0;
    const at = atr14(c), r = rsi14(closes);
    results.push({
      symbol:q.symbol, companyName:q.name, ltp:+ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit,
      score:83+(pct>3?5:0), strength:'STRONG', breakoutType:'STARS',
      signals:[`+${pct}% above prev high`,`Red→Green`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi:r?.toFixed(1), ...setup(ltp,at||ltp*0.02), scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── WEEKLY BREAKOUT ───────────────────────────────────────────
// weekly max(5) > 6d ago max(120,daily)*1.04, week close > prev week, vol>20W avg, RSI>50
async function runWeeklyBreakout(cb) {
  const u = uni(); cb?.(`Weekly Breakout — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 400);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 130) continue;
    const closes=c.map(x=>x.close), vols=c.map(x=>x.volume);
    const ltp = q.ltp || closes[closes.length-1]; if (!ltp) continue;
    const wkC=[], wkV=[];
    for (let i=4; i<closes.length; i+=5) {
      wkC.push(closes[i]);
      wkV.push(vols.slice(i-4,i+1).reduce((a,b)=>a+b,0));
    }
    if (wkC.length < 25) continue;
    const wMax5 = maxOf(wkC.slice(-5), 5);
    const prev120daily = maxOf(closes.slice(-127,-6), 121);
    if (!prev120daily || wMax5 <= prev120daily*1.04) continue;
    if (wkC[wkC.length-1] <= wkC[wkC.length-2]) continue;
    const avgWkV = sma(wkV.slice(0,-1), Math.min(20,wkV.length-1))||0;
    if (avgWkV > 0 && wkV[wkV.length-1] <= avgWkV) continue;
    const r = rsi14(closes); if (!r||r<50) continue;
    const at = atr14(c);
    const pct = +((wMax5/prev120daily-1)*100).toFixed(1);
    results.push({
      symbol:q.symbol, companyName:q.name, ltp:+ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit,
      score:84+(r>60?5:0), strength:'STRONG', breakoutType:'WEEKLY_BREAKOUT',
      signals:[`+${pct}% wkly BO`,`RSI${r.toFixed(0)}`,`Vol>20W avg`,`₹${q.turnoverCr}Cr`],
      rsi:r.toFixed(1), ...setup(ltp,at||ltp*0.02), scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── LEGACY SCANNER ────────────────────────────────────────────
// close >= max(250,high)*0.75, close >= ema50, close >= ema200
async function runLegacy(cb) {
  const u = uni(); cb?.(`Legacy Scanner — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 400);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 200) continue;
    const closes=c.map(x=>x.close), highs=c.map(x=>x.high);
    const ltp = q.ltp || closes[closes.length-1]; if (!ltp) continue;
    const h250 = maxOf(highs.slice(-250), 250); if (!h250||ltp<h250*0.75) continue;
    const e50  = ema(closes,50), e200 = ema(closes,200);
    if (!e50||!e200||ltp<e50||ltp<e200) continue;
    const at = atr14(c), r = rsi14(closes);
    const pct = +((ltp/h250-1)*100).toFixed(1);
    results.push({
      symbol:q.symbol, companyName:q.name, ltp:+ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit,
      score:76+(r&&r>55?5:0), strength:'MODERATE', breakoutType:'LEGACY',
      signals:[`${pct}% from 52WH`,`EMA50✓`,`EMA200✓`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`].filter(Boolean),
      rsi:r?.toFixed(1), ...setup(ltp,at||ltp*0.015), scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── BREAKOUT (Main) ───────────────────────────────────────────
// 20d high breakout, above EMA20, SMA50 rising, RSI 50-82, vol surge
async function runBreakout(cb) {
  const u = uni(); cb?.(`Breakout Scanner — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 200);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 50) continue;
    const closes=c.map(x=>x.close), vols=c.map(x=>x.volume), highs=c.map(x=>x.high), lows=c.map(x=>x.low);
    const ltp = q.ltp || closes[closes.length-1]; if (!ltp) continue;
    const e20 = ema(closes,20), s50 = sma(closes, Math.min(50,closes.length));
    if (!e20||!s50||ltp<=e20||ltp<=s50) continue;
    const s50_5 = sma(closes.slice(0,-5), Math.min(50,closes.length-5));
    if (!s50_5||s50<=s50_5) continue;
    const max20prev = maxOf(closes.slice(-21,-1), 20);
    if (ltp <= max20prev*1.002) continue;
    const r = rsi14(closes); if (!r||r<50||r>82) continue;
    const avgV = avgVol(vols,20)||1;
    const curVol = q.volume>0 ? q.volume : vols[vols.length-1];
    if (curVol > 0 && curVol <= avgV*1.3) continue;
    const h52 = maxOf(highs, Math.min(252,highs.length));
    if (!h52||ltp<h52*0.80||ltp>h52*1.05) continue;
    const at = atr14(c);
    const pct = +((ltp/max20prev-1)*100).toFixed(1);
    results.push({
      symbol:q.symbol, companyName:q.name, ltp:+ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit,
      score:Math.min(100,72+pct+(r-52)*0.3),
      strength:r>65&&curVol>avgV*2?'STRONG':'MODERATE',
      breakoutType:'BREAKOUT',
      signals:[`+${pct}% 20d BO`,`RSI${r.toFixed(0)}`,`Vol ${avgV>0?(curVol/avgV).toFixed(1):'N/A'}×avg`,`EMA20✓`,`₹${q.turnoverCr}Cr`],
      rsi:r.toFixed(1), volumeSurge:curVol>avgV*2,
      ...setup(ltp,at||ltp*0.015), scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── IPO DSS (Rajput_007) ─────────────────────────────────────
// New listing, forming demand zone below listing high, vol pickup
async function runIPODSS(cb) {
  const u = uni(); cb?.(`IPO DSS — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 400);
  const results = [], oneYear = Date.now() - 365*86400000;
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c||c.length<5||c.length>260) continue;
    if (c[0].time < oneYear) continue;
    const closes=c.map(x=>x.close), vols=c.map(x=>x.volume);
    const ltp = q.ltp || closes[closes.length-1]; if (!ltp||ltp<1) continue;
    if (q.volume > 0 && q.volume < 5000) continue;
    const listHigh = Math.max(...c.slice(0,Math.min(3,c.length)).map(x=>x.high));
    if (ltp > listHigh*0.90) continue;
    const avgV = avgVol(vols, Math.min(10,vols.length-1))||1;
    const curVol = q.volume>0?q.volume:vols[vols.length-1];
    if (curVol > 0 && curVol < avgV*1.2) continue;
    const at = atr14(c)||ltp*0.02;
    const distFromHigh = +((ltp/listHigh-1)*100).toFixed(1);
    results.push({
      symbol:q.symbol, companyName:q.name, ltp:+ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit, isIPO:true,
      score:65, strength:'MODERATE', breakoutType:'IPO_DSS',
      signals:[`${c.length}d listed`,`${distFromHigh}% from list high`,'DSS zone',`₹${q.turnoverCr}Cr`],
      daysListed:c.length, distFromListHigh:distFromHigh,
      ...setup(ltp,at), scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── UPPER CIRCUIT (live — no candles needed) ──────────────────
function runUpperCircuit() {
  const uc = liveData.getUC();
  const src = uc.length ? uc : liveData.getAllQuotes().filter(q=>q.ltp>0&&q.pChange>0&&(
    (Math.abs(q.pChange-2)<0.4)||(Math.abs(q.pChange-5)<0.5)||
    (Math.abs(q.pChange-10)<0.6)||(Math.abs(q.pChange-20)<0.7)
  ));
  return src.sort((a,b)=>b.pChange-a.pChange).map(q=>({
    symbol:q.symbol, companyName:q.name, ltp:+q.ltp.toFixed(2), pChange:q.pChange,
    turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit||'UC',
    score:Math.min(100,65+q.pChange*2), strength:q.pChange>=10?'STRONG':'MODERATE',
    breakoutType:'UPPER_CIRCUIT',
    signals:[`+${q.pChange.toFixed(1)}% UC🔼`,`₹${q.turnoverCr}Cr`],
    entry:q.ltp.toFixed(2), sl:(q.prevClose*0.97).toFixed(2),
    target1:(q.ltp*1.05).toFixed(2), target2:(q.ltp*1.10).toFixed(2), riskReward:'1:2',
    scannedAt:new Date().toISOString()
  }));
}

// ── INTRA SCANNER (live — no candles needed) ──────────────────
// pChange > 3, volume > 300000, market cap > 100Cr
function runIntra() {
  return liveData.getAllQuotes()
    .filter(q=>q.pChange>=3&&(q.volume>=300000||q.volume===0))
    .sort((a,b)=>b.pChange-a.pChange)
    .map(q=>({
      symbol:q.symbol, companyName:q.name, ltp:+q.ltp.toFixed(2), pChange:q.pChange,
      turnoverCr:q.turnoverCr, volume:q.volume, circuit:q.circuit,
      score:Math.min(100,68+q.pChange*3), strength:q.pChange>=5?'STRONG':'MODERATE',
      breakoutType:'INTRA',
      signals:[`+${q.pChange.toFixed(1)}%`,`Vol${(q.volume/1e5).toFixed(1)}L`,`₹${q.turnoverCr}Cr`],
      entry:q.ltp.toFixed(2), sl:(q.prevClose*0.98).toFixed(2),
      target1:(q.ltp*1.03).toFixed(2), target2:(q.ltp*1.05).toFixed(2), riskReward:'1:2',
      scannedAt:new Date().toISOString()
    }));
}

// ── PRE-BREAKOUT SCANNER ──────────────────────────────────────
// Stocks within 0.3–3% of resistance — about to break out (not already broken)
async function runPreBreakout(cb) {
  const u = uni(); cb?.(`Pre-Breakout — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 300);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 60) continue;
    const closes=c.map(x=>x.close), highs=c.map(x=>x.high), lows=c.map(x=>x.low), vols=c.map(x=>x.volume);
    const n = closes.length-1;
    const ltp = q.ltp || closes[n]; if (!ltp||ltp<10) continue;
    // Resistance = max of last 20d highs (excluding today)
    const res20 = maxOf(highs.slice(-21,-1), 20);
    const res6m  = maxOf(highs.slice(-126), Math.min(126,highs.length));
    const res3m  = maxOf(highs.slice(-63),  Math.min(63,highs.length));
    const resistanceCandidates = [res20,res6m,res3m].filter(r=>r>ltp*1.001);
    if (!resistanceCandidates.length) continue;
    const resistance = Math.min(...resistanceCandidates);
    const distToRes = (resistance-ltp)/ltp*100;
    if (distToRes<0.3||distToRes>3.0) continue;
    // Must NOT have recently broken this level
    if (highs.slice(-4,-1).some(h=>h>=resistance*0.999)) continue;
    // RSI filter
    const r = rsi14(closes); if(!r||r<40||r>72) continue;
    // Must be above EMA50
    const e50 = ema(closes,Math.min(50,closes.length));
    if(!e50||ltp<e50) continue;
    // Volume building
    const avgV5  = avgVol(vols.slice(-6,-1),5)||1;
    const avgV15 = avgVol(vols.slice(-16,-6),10)||1;
    const volBuilding = avgV5>avgV15*1.1;
    // BB squeeze
    const smaN20=sma(closes,20)||ltp;
    const std20=Math.sqrt(closes.slice(-20).reduce((s,v)=>{const d=v-smaN20;return s+d*d;},0)/20);
    const bbWidth=(std20*4)/smaN20*100;
    const isSqueeze=bbWidth<8;
    // Score
    let score=60+(distToRes<1?12:distToRes<2?6:0)+(volBuilding?8:0)+(isSqueeze?7:0)+(r>55&&r<65?5:0);
    score=Math.min(100,score);
    if(score<65) continue;
    const at=atr14(c)||ltp*0.02;
    const entryLevel=resistance*1.001;
    const sl=Math.max(ltp*0.97,e50*0.99);
    const risk=entryLevel-sl;
    const rr=r>60?3:2.5;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score,strength:score>=80?'STRONG':'MODERATE',
      breakoutType:'PRE_BREAKOUT',
      breakoutLevel:+resistance.toFixed(2),
      distToBreakout:+distToRes.toFixed(2),
      isSqueeze,volBuilding,rsi:r?.toFixed(1),
      signals:[`${distToRes.toFixed(1)}% below ₹${resistance.toFixed(0)}`,volBuilding?'Vol↑':'',isSqueeze?'Squeeze':'',`RSI${r.toFixed(0)}`,`₹${q.turnoverCr}Cr`].filter(Boolean),
      entry:entryLevel.toFixed(2),sl:sl.toFixed(2),
      target1:(entryLevel+risk*1.5).toFixed(2),target2:(entryLevel+risk*rr).toFixed(2),
      target3:(entryLevel+risk*(rr+1.5)).toFixed(2),riskReward:`1:${rr}`,
      note:`Buy above ₹${resistance.toFixed(2)} with volume surge`,
      scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── REGISTRY ──────────────────────────────────────────────────
const MAP = {
  BREAKOUT:             runBreakout,
  'PRE_BREAKOUT':       runPreBreakout,
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
};

async function runScan(type, cb) {
  const t0 = Date.now();
  type = (type||'BREAKOUT').toUpperCase();
  console.log(`[SCANNER] Starting: ${type}`);
  // FIX: Clear candle cache on every manual run = always fresh data
  candleCache.clear();
  let results = [];
  try {
    const fn = MAP[type];
    if (!fn) throw new Error(`Unknown scanner: ${type}`);
    const isLive = ['UPPER_CIRCUIT','NEAR_UPPER_CIRCUIT','INTRA','INTRA_SCANNER'].includes(type);
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
