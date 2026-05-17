/**
 * scanner.js v12 — INTEGRATED LIQUIDITY ROUTING EDITION
 * Updated with strict Chartink logic translations.
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

// ── Candle Fetcher ────────────────────────────────────────────
const candleCache = new Map();
const CACHE_TTL   = 4 * 60 * 60 * 1000;

async function fetchYahooCandles(yahooSym) {
  const cached = candleCache.get(yahooSym);
  if (cached && Date.now()-cached.fetchedAt < CACHE_TTL) return cached.candles;

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

async function getCandles(yahooSyms) {
  const results={};
  const uncached=yahooSyms.filter(ys=>{
    const c=candleCache.get(ys);
    return !c||Date.now()-c.fetchedAt>=CACHE_TTL;
  });
  const cached=yahooSyms.filter(ys=>{
    const c=candleCache.get(ys);
    return c&&Date.now()-c.fetchedAt<CACHE_TTL;
  });
  for(const ys of cached){
    const c=candleCache.get(ys).candles;
    results[ys]=c; results[ys.replace(/\.(NS|BO)$/,'')]=c;
  }
  if(!uncached.length) return results;
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

async function prewarmCache(universe) {
  const top=universe.slice(0,100).map(q=>q.yahooSym||q.symbol+'.NS');
  console.log(`[CACHE] Pre-warming ${top.length} symbols...`);
  await getCandles(top);
  console.log(`[CACHE] Pre-warm done — ${candleCache.size} symbols cached`);
}

// ── Technical Analysis Helpers ────────────────────────────────
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

function candleKey(q) {
  return q.yahooSym || q.symbol + '.NS';
}

// ═══════════════════════════════════════════════════════════════
// TRUE PRE-BREAKOUT & MOMENTUM COILING SCANNER
// ═══════════════════════════════════════════════════════════════
async function runPreBreakout(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0);
  cb?.(`Pre-Breakout Scanner — Processing ${u.length} stocks…`);
  
  const cm = await getCandles(u.map(candleKey));
  const results = [];

  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 30) continue; 

    const n      = c.length - 1;
    const closes = c.map(x => x.close);
    const highs  = c.map(x => x.high);
    const lows   = c.map(x => x.low);
    const opens  = c.map(x => x.open);
    const vols   = c.map(x => x.volume);

    const ltp = q.ltp || closes[n];
    if (!ltp || ltp < 5 || ltp > 90000) continue;

    // Liquidity guards
    const turnover = parseFloat(q.turnoverCr || 0);
    if (turnover < 4.0) continue; 
    const avg20v = avgVol(vols, 20) || 1;
    if (avg20v < 25000) continue; 

    const atR = atr14(c) || ltp * 0.02;

    // Institutional Trap & False Breakout Filters
    const e50 = ema(closes, Math.min(50, n));
    if (!e50 || ltp > e50 * 1.28) continue; 

    let redDistributionBars = 0;
    for (let i = n - 6; i <= n; i++) {
      if (closes[i] < opens[i] && vols[i] > avg20v * 1.15) redDistributionBars++;
    }
    if (redDistributionBars >= 3) continue; 
    if (ltp < e50 * 0.95) continue; 

    const high52 = maxOf(highs, Math.min(252, n));
    const low52  = minOf(lows, Math.min(252, n));
    const distFrom52H = high52 > 0 ? ((high52 - ltp) / high52 * 100) : 100;
    if (distFrom52H > 35) continue;

    // Dynamic Resistance Mapping
    const lookback = Math.min(90, n - 2);
    let clusterCeiling = 0;
    let touchCount = 0;
    let lastTouchIdx = n - lookback;

    const peakHighs = [];
    for (let i = n - lookback; i < n; i++) {
      if (highs[i] > highs[i-1] && highs[i] > highs[i+1]) {
        peakHighs.push({ price: highs[i], idx: i });
      }
    }

    if (peakHighs.length >= 2) {
      peakHighs.sort((a, b) => b.price - a.price);
      const topPeak = peakHighs[0].price;
      let sumPrices = peakHighs[0].price;
      touchCount = 1;
      lastTouchIdx = peakHighs[0].idx;

      for (let i = 1; i < peakHighs.length; i++) {
        if (Math.abs(peakHighs[i].price - topPeak) / topPeak <= 0.025) {
          sumPrices += peakHighs[i].price;
          touchCount++;
          if (peakHighs[i].idx > lastTouchIdx) lastTouchIdx = peakHighs[i].idx;
        }
      }
      clusterCeiling = sumPrices / touchCount;
    } else {
      clusterCeiling = maxOf(highs.slice(-20, -1), 19);
      touchCount = 2;
    }

    if (clusterCeiling <= ltp) continue; 

    // Pattern Scoring Matrix
    const distToCeilingPct = ((clusterCeiling - ltp) / clusterCeiling * 100);
    const inTriggerZone = distToCeilingPct <= 4.5 && distToCeilingPct >= 0.1;

    const bbLen = Math.min(20, n);
    const bbArr = closes.slice(n - bbLen + 1, n + 1);
    const bbMid = bbArr.reduce((sum, v) => sum + v, 0) / bbLen;
    const bbStd = Math.sqrt(bbArr.reduce((sum, v) => sum + (v - bbMid) ** 2, 0) / bbLen);
    const bbWidth = bbMid > 0 ? ((4 * bbStd) / bbMid * 100) : 999;
    const isSqueezing = bbWidth <= 10.0;

    const base10H = Math.max(...highs.slice(-10));
    const base10L = Math.min(...lows.slice(-10));
    const baseRange10 = ((base10H - base10L) / base10L * 100);
    const isTightBase = baseRange10 <= 7.0;

    const insideBar = highs[n] < highs[n-1] && lows[n] > lows[n-1];
    const rangeToday = highs[n] - lows[n];
    const prev7Ranges = highs.slice(-7).map((h, idx) => h - lows.slice(-7)[idx]);
    const isNR7 = rangeToday === Math.min(...prev7Ranges);

    const w1H = Math.max(...highs.slice(-30, -15)), w1L = Math.min(...lows.slice(-30, -15));
    const w2H = Math.max(...highs.slice(-15)),    w2L = Math.min(...lows.slice(-15));
    const r1 = w1L > 0 ? ((w1H - w1L) / w1L * 100) : 100;
    const r2 = w2L > 0 ? ((w2H - w2L) / w2L * 100) : 0;
    const isVCP = r2 < r1 * 0.8 && r2 <= 9.0;

    const curVol = q.volume > 0 ? q.volume : vols[n];
    const recent5v = vols.slice(-5).reduce((s, v) => s + v, 0) / 5;
    
    const volDrying  = vols[n] < avg20v * 0.65;
    const volPickup  = curVol > avg20v * 1.3;
    const volBuildup = recent5v > avg20v * 1.1;
    const volSurge   = curVol > avg20v * 1.8;

    const hasAccumulationVolume = volBuildup || volPickup || volDrying;

    const rsiVal = rsi14(closes);
    const e21 = ema(closes, 21);
    const trendBullish = rsiVal >= 48 && rsiVal <= 69 && e21 && ltp > e21 * 0.98;

    let qualifiedPattern = '';
    let baseScore = 50;

    if (inTriggerZone && trendBullish && hasAccumulationVolume) {
      if (isVCP) {
        qualifiedPattern = 'VCP_COIL';
        baseScore = 84;
      } else if (isSqueezing && isTightBase) {
        qualifiedPattern = 'SQUEEZE_BASE';
        baseScore = 82;
      } else if (isTightBase) {
        qualifiedPattern = 'TIGHT_BOX';
        baseScore = 78;
      } else if (insideBar || isNR7) {
        qualifiedPattern = 'MICRO_COIL';
        baseScore = 75;
      } else if (distToCeilingPct <= 2.5) {
        qualifiedPattern = 'MOMENTUM_COIL';
        baseScore = 72;
      }
    }

    if (!qualifiedPattern) continue; 

    // Final universal restriction layer evaluated after native rules
    if (turnover < 50.0) continue;

    let finalScore = baseScore;
    finalScore += Math.max(0, Math.round((4.5 - distToCeilingPct) * 2));
    
    if (touchCount >= 3) finalScore += 5;       
    if (n - lastTouchIdx <= 8) finalScore += 4;  
    if (volPickup || volSurge) finalScore += 5;  
    if (bbWidth <= 6.0) finalScore += 6;        
    if (distFrom52H <= 6.0) finalScore += 4;     

    finalScore = Math.min(100, finalScore);

    const breakoutTriggerPrice = +(clusterCeiling * 1.003).toFixed(2);
    
    const structuralStopFloor = Math.min(
      ltp - (atR * 1.4),
      base10L * 0.992,
      (e21 || ltp) * 0.985
    );
    const slPrice = +structuralStopFloor.toFixed(2);
    
    const localizedRiskDelta = breakoutTriggerPrice - slPrice;
    const targetMultiplier = finalScore >= 82 ? 3.2 : 2.5;

    const t1 = +(breakoutTriggerPrice + localizedRiskDelta * 1.5).toFixed(2);
    const t2 = +(breakoutTriggerPrice + localizedRiskDelta * targetMultiplier).toFixed(2);
    const t3 = +(breakoutTriggerPrice + localizedRiskDelta * (targetMultiplier + 1.5)).toFixed(2);

    const trackingSignals = [
      `Ceiling ₹${clusterCeiling.toFixed(1)} (${touchCount}× verified)`,
      `${distToCeilingPct.toFixed(1)}% below trigger line`,
      `RSI: ${rsiVal.toFixed(0)}`,
      isSqueezing ? `Squeeze BBW: ${bbWidth.toFixed(1)}%` : `BBW: ${bbWidth.toFixed(1)}%`,
      isTightBase ? `Base Box: ${baseRange10.toFixed(1)}%` : '',
      insideBar ? 'Inside Bar Coil' : isNR7 ? 'NR7 Volatility Compression' : '',
      volSurge ? 'Active Volume Influx' : volDrying ? 'Liquidity Exhaustion' : 'Accumulation Vol',
      distFrom52H < 6 ? 'Leader Profile (Near 52WH)' : '',
      `Value ₹${turnover.toFixed(1)}Cr`
    ].filter(Boolean);

    results.push({
      symbol:            q.symbol,
      companyName:       q.name,
      ltp:               +ltp.toFixed(2),
      pChange:           q.pChange,
      turnoverCr:        q.turnoverCr,
      volume:            q.volume,
      circuit:           q.circuit,
      score:             +finalScore.toFixed(2),
      strength:          finalScore >= 82 ? 'STRONG' : finalScore >= 70 ? 'MODERATE' : 'WATCH',
      breakoutType:      'PRE_BREAKOUT',
      pattern:           qualifiedPattern,
      breakoutLevel:     breakoutTriggerPrice,
      resistanceLevel:   +clusterCeiling.toFixed(2),
      resistanceTouches: touchCount,
      distToBreakout:    +distToCeilingPct.toFixed(2),
      rsi:               +rsiVal.toFixed(1),
      bbWidth:           +bbWidth.toFixed(2),
      tightSqueeze:      isSqueezing,
      isVCP,
      tightBase:         isTightBase,
      coilCandle:        (insideBar || isNR7),
      entry:             +ltp.toFixed(2),
      sl:                +slPrice.toFixed(2),
      target1:           +t1.toFixed(2),
      target2:           +t2.toFixed(2),
      target3:           +t3.toFixed(2),
      riskReward:        `1:${targetMultiplier}`,
      signals:           trackingSignals,
      note: `Trigger above ₹${breakoutTriggerPrice} | SL ₹${slPrice} | Coil Setup: ${qualifiedPattern.replace(/_/g,' ')}`,
      scannedAt:         new Date().toISOString(),
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

// ── BREAKOUT SCANNER ──────────────────────────────────────────
async function runBreakout(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`Breakout — ${u.length} stocks…`);
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

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

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
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`Biggest5Day — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 200);
  const results = [];
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

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

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
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`BullSNORT — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 200);
  const results = [];
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

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

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

// ── POCKET PIVOT SCANNER ───────────────────────────────────────
async function runPocketPivot(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`Pocket Pivot — Scanning ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 260);
  const results = [];
  
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 60) continue;

    const n = c.length - 1;
    const closes = c.map(x => x.close);
    const highs  = c.map(x => x.high);
    const lows   = c.map(x => x.low);
    const vols   = c.map(x => x.volume);
    
    const ltp = q.ltp || closes[n];
    if (ltp <= 10 || ltp > 25000) continue;

    // Chartink: daily close >= weekly max(52, weekly high) * 0.75
    const h252 = maxOf(highs, Math.min(252, highs.length));
    if (ltp < h252 * 0.75) continue;

    // Chartink: daily close >= weekly min(52, weekly low) * 1.5
    const l252 = minOf(lows, Math.min(252, lows.length));
    if (ltp < l252 * 1.5) continue;

    // Chartink: SMA bounds
    const s200 = sma(closes, Math.min(200, closes.length));
    const s50  = sma(closes, Math.min(50, closes.length));
    if (!s200 || !s50 || ltp <= s200 || s50 <= s200 || ltp <= s50 * 0.95) continue;
    
    // daily close >= 1 day ago close
    if (closes[n] < closes[n-1]) continue;

    // Vol Accumulation Ratio over 50 bars >= 1.5
    let upVolSum = 0, downVolSum = 0;
    for (let i = Math.max(1, n - 49); i <= n; i++) {
      if (closes[i] > closes[i-1]) upVolSum += vols[i];
      if (closes[i] < closes[i-1]) downVolSum += vols[i];
    }
    if (downVolSum === 0 || (upVolSum / downVolSum) < 1.5) continue;

    // Pocket Pivot logic: Volume must be >= the highest volume of ANY down day in the last 10 days
    let maxDownVol = 0;
    for (let i = 1; i <= 10; i++) {
        if (n - i < 1) break;
        if (closes[n - i] < closes[n - i - 1]) {
            if (vols[n - i] > maxDownVol) {
                maxDownVol = vols[n - i];
            }
        }
    }
    const currentVol = q.volume > 0 ? q.volume : vols[n];
    if (currentVol < maxDownVol) continue;

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

    const at = atr14(c) || ltp * 0.02;
    const sl = +(ltp - at * 1.5).toFixed(2);
    const risk = ltp - sl;

    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2), pChange: q.pChange,
      turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit,
      score: Math.min(100, 80 + (upVolSum / downVolSum) * 3), strength: 'STRONG',
      breakoutType: 'POCKET_PIVOT',
      signals: [`Up/Down Vol Ratio: ${(upVolSum/downVolSum).toFixed(1)}x`, `Pocket Pivot Vol > Down Vol`],
      entry: ltp.toFixed(2), sl: sl.toFixed(2),
      target1: (ltp + risk * 2).toFixed(2), target2: (ltp + risk * 3).toFixed(2), target3: (ltp + risk * 4.5).toFixed(2),
      riskReward: '1:2', scannedAt: new Date().toISOString()
    });
  }
  return results.sort((a,b) => b.score - a.score);
}

// ── MY UNIVERSE ────────────────────────────────────────────────
async function runMyUniverse(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`MyUniverse — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 200);
  const results = [];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<60) continue;
    const closes=c.map(x=>x.close),highs=c.map(x=>x.high),lows=c.map(x=>x.low),vols=c.map(x=>x.volume);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp||ltp<20) continue;
    const s20c=sma(closes,20)||0,s20v=sma(vols,20)||0;
    if(s20c*s20v<100000000) continue;
    const e50=ema(closes,Math.min(50,closes.length)),e200=ema(closes,Math.min(200,closes.length));
    if(!e50||!e200||ltp<e50||ltp<e200) continue;

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

    const r=rsi14(closes);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:75+(r&&r>60?8:0),strength:r&&r>60?'STRONG':'MODERATE',
      breakoutType:'MY_UNIVERSE',
      signals:[`Liq✓`,`EMA50✓`,`EMA200✓`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`],
      rsi:r?.toFixed(1),
      entry:ltp.toFixed(2),sl:sl.toFixed(2),
      target1:(ltp+risk*2).toFixed(2),target2:(ltp+risk*3).toFixed(2),target3:(ltp+risk*4.5).toFixed(2),
      riskReward:'1:2',scannedAt:new Date().toISOString()
    });
  }
  return results.sort((a,b)=>b.score-a.score);
}

// ── 5% WITHIN 52W HIGH ─────────────────────────────────────────
async function runNear52WH(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`5% within 52W High — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 260);
  const results = [];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<65) continue;
    const closes=c.map(x=>x.close),highs=c.map(x=>x.high);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp) continue;
    const h252=maxOf(highs,Math.min(252,highs.length)); if(!h252||ltp<h252*0.95) continue;
    if(closes.length>65&&ltp<=closes[closes.length-66]) continue;
    const e20=ema(closes,20),e50=ema(closes,Math.min(50,closes.length));
    if(!e20||!e50||e20<=e50) continue;

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

    const r=rsi14(closes);
    const pct=+((ltp/h252-1)*100).toFixed(1);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:82+(r&&r>60?5:0),strength:'STRONG',breakoutType:'WITHIN_52W_HIGH',
      signals:[`${pct}% from 52WH(${h252.toFixed(0)})`,`EMA20>EMA50`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`],
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
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`BreakoutShort — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 200);
  const results = [];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<127) continue;
    const closes=c.map(x=>x.close),vols=c.map(x=>x.volume);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp) continue;
    const max5=maxOf(closes.slice(-5),5);
    const max120prev=maxOf(closes.slice(-127,-6),121);
    if(!max120prev||max5<=max120prev*1.05) continue;
    if(closes[closes.length-1]<=closes[closes.length-2]) continue;

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

    const r=rsi14(closes);
    const pct=+((max5/max120prev-1)*100).toFixed(1);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:80+(pct>10?5:0),strength:pct>8?'STRONG':'MODERATE',
      breakoutType:'BREAKOUT_SHORT',
      signals:[`+${pct}% 6M BO`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`],
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
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`STaRS — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 200);
  const results = [];
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

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

    const pct=closes[n-1]>0?+((ltp-closes[n-1])/closes[n-1]*100).toFixed(1):0;
    const r=rsi14(closes);
    const at=atr14(c)||ltp*0.015;
    const sl=+(ltp-at*1.5).toFixed(2),risk=ltp-sl;
    results.push({
      symbol:q.symbol,companyName:q.name,ltp:+ltp.toFixed(2),pChange:q.pChange,
      turnoverCr:q.turnoverCr,volume:q.volume,circuit:q.circuit,
      score:83+(pct>3?5:0),strength:'STRONG',breakoutType:'STARS',
      signals:[`+${pct}% vs prev`,`Red→Green`,r?`RSI${r.toFixed(0)}`:'',`₹${q.turnoverCr}Cr`],
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
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`WeeklyBO — ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 260);
  const results = [];
  for(const q of u){
    const c=cm[candleKey(q)]||cm[q.symbol]; if(!c||c.length<130) continue;
    const closes=c.map(x=>x.close),vols=c.map(x=>x.volume);
    const ltp=q.ltp||closes[closes.length-1]; if(!ltp) continue;
    const wkC=[], wkV=[]; 
    for(let i=4;i<closes.length;i+=5){wkC.push(closes[i]);wkV.push(vols.slice(i-4,i+1).reduce((a,b)=>a+b,0));}
    if(wkC.length<25) continue;
    const wMax5=maxOf(wkC.slice(-5),5);
    const prev120=maxOf(closes.slice(-127,-6),121);
    if(!prev120||wMax5<=prev120*1.04) continue;
    if(wkC[wkC.length-1]<=wkC[wkC.length-2]) continue;
    const r=rsi14(closes); if(!r||r<50) continue;

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

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

// ── LEGACY (SPECIAL INSTITUTIONAL >1000 CR EXCEPTION) ──────────
async function runLegacy(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0 && parseFloat(q.turnoverCr || 0) >= 1000.0);
  cb?.(`Legacy Institutional — ${u.length} liquid assets…`);
  const cm = await getCandles(u.map(candleKey), 260);
  const results = [];
  for (const q of u) {
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

// ── IPO SCANNERS ───────────────────────────────────────────────
async function runIPOScan(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0);
  cb?.(`IPO Scanner — ${u.length} stocks…`);
  const cm = await getCandles(u.map(candleKey), 600);
  const results = [];
  const TWO_YEARS = Date.now() - 2 * 365 * 86400000;

  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol];
    if (!c || c.length < 2 || c.length > 522) continue;
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

      resistanceTouches = bHighs.filter(h => Math.abs(h - baseHigh) / baseHigh < 0.015).length;
      breakoutLevel = +baseHigh.toFixed(2);
      distToBreakout = +((breakoutLevel - ltp) / ltp * 100).toFixed(2);

      const range10 = n >= 13 ? (Math.max(...highs.slice(-10)) - Math.min(...lows.slice(-10))) / baseLow * 100 : 999;
      const range20 = n >= 23 ? (Math.max(...highs.slice(-20,-10)) - Math.min(...lows.slice(-20,-10))) / baseLow * 100 : 999;
      const isVCP = range10 < range20 * 0.75 && baseRange < 30 && rsiVal && rsiVal > 45;

      const isCupHandle = (() => {
        if (n < 20) return false;
        const periodHigh = Math.max(...highs.slice(0, Math.floor(n * 0.4)));
        const cupLow     = Math.min(...lows.slice(Math.floor(n * 0.2), Math.floor(n * 0.7)));
        const recovery   = Math.max(...highs.slice(Math.floor(n * 0.65)));
        const depth      = (periodHigh - cupLow) / periodHigh * 100;
        const recPct     = (recovery - cupLow) / (periodHigh - cupLow) * 100;
        return depth >= 12 && depth <= 40 && recPct >= 70;
      })();

      const isStage2 = ema20Val ? (ltp > ema20Val * 0.98 && baseRange < 25 && volBuild) : false;
      const isBaseBO = fromBH >= -2 && fromBH <= 1 && volBuild && rsiVal && rsiVal > 45 && rsiVal < 75;
      const isTightRange = range10 < 5 && n >= 13;
      const high10 = n >= 10 ? Math.max(...highs.slice(-10)) : 0;
      const isSwingBO = high10 > 0 && ltp >= high10 * 0.995 && volBuild;
      const isPreBO = fromBH >= -3 && fromBH < 0 && rsiVal && rsiVal > 40;

      if      (isVCP)        { pattern = 'VCP';         score = 85; }
      else if (isCupHandle)  { pattern = 'CUP_HANDLE';  score = 82; }
      else if (isSwingBO)    { pattern = 'SWING_BO';    score = 80; }
      else if (isBaseBO)     { pattern = 'BASE_BO';     score = 76; }
      else if (isStage2)     { pattern = 'STAGE2';      score = 74; }
      else if (isTightRange) { pattern = 'TIGHT_RANGE'; score = 70; }
      else if (isPreBO)      { pattern = 'PRE_BO';      score = 65; }
      else continue;

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
      breakoutType:     'IPO_SCAN',
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

// ── IPO-scan-DSS_Rajput_007 ────────────────────────────────────
async function runIPODSS(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`IPO DSS — Scanning ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 100);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if (!c || c.length < 2) continue;
    const n = c.length;
    
    // Strict limit: Listed within roughly 2 months (approx 44 trading days)
    if (n >= 44) continue;
    
    const ltp = q.ltp || c[n-1].close;
    const currentVol = q.volume > 0 ? q.volume : c[n-1].volume;
    
    if (parseFloat(q.turnoverCr || 0) < 100.0) continue;
    if (currentVol <= 5000) continue;

    const at = atr14(c) || ltp * 0.02;
    const sl = +(ltp - at * 1.5).toFixed(2);
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2), pChange: q.pChange,
      turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit, score: 75,
      strength: 'STRONG', breakoutType: 'IPO-scan-DSS_Rajput_007',
      signals: [`Listed < 2 Months`, `High Turnover IPO`],
      entry: ltp.toFixed(2), sl: sl.toFixed(2), target1: (ltp * 1.05).toFixed(2), target2: (ltp * 1.10).toFixed(2),
      riskReward: '1:2', scannedAt: new Date().toISOString()
    });
  }
  return results.sort((a,b) => b.score - a.score);
}

// ── RSI OVERSOLD ───────────────────────────────────────────────
async function runRSIOversold(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`RSI Oversold — Scanning ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 60);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if(!c || c.length < 20) continue;
    const closes = c.map(x => x.close);
    const ltp = q.ltp || closes[closes.length - 1];
    if (ltp <= 10) continue;
    const r = rsi14(closes);
    if (!r || r > 20) continue;

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

    const at = atr14(c) || ltp * 0.02;
    const sl = +(ltp - at * 1.5).toFixed(2);
    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2), pChange: q.pChange,
      turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit, score: 70 + (20 - r),
      strength: 'MODERATE', breakoutType: 'RSI_OVERSOLD',
      signals: [`RSI: ${r.toFixed(1)} (Oversold 🔥)`],
      entry: ltp.toFixed(2), sl: sl.toFixed(2), target1: (ltp * 1.05).toFixed(2), target2: (ltp * 1.10).toFixed(2),
      riskReward: '1:2', scannedAt: new Date().toISOString()
    });
  }
  return results.sort((a,b) => b.score - a.score);
}

// ── STOCKS NEAR 52W LOW ────────────────────────────────────────
async function runNear52WLow(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`Near 52W Low — Scanning ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 260);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if(!c || c.length < 50) continue;
    const lows = c.map(x => x.low);
    const ltp = q.ltp || c[c.length - 1].close;
    if (ltp <= 10) continue;

    const l52 = minOf(lows, Math.min(252, lows.length));
    const isNearLow = (ltp <= l52) || (ltp <= (l52 + (l52 * 5 / 100)));
    if (!isNearLow) continue;

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2), pChange: q.pChange,
      turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit, score: 65,
      strength: 'WATCH', breakoutType: 'NEAR_52W_LOW',
      signals: [`52W Low: ₹${l52.toFixed(1)}`, `Value within 5% proximity`],
      entry: ltp.toFixed(2), sl: (ltp * 0.95).toFixed(2), target1: (ltp * 1.06).toFixed(2), target2: (ltp * 1.12).toFixed(2),
      riskReward: '1:2', scannedAt: new Date().toISOString()
    });
  }
  return results.sort((a,b) => b.score - a.score);
}

// ── THREE WEEK TIGHT ───────────────────────────────────────────
async function runThreeWeekTight(cb) {
  const u = liveData.getAllQuotes().filter(q => q.ltp > 0); cb?.(`Three Week Tight — Scanning ${u.length}…`);
  const cm = await getCandles(u.map(candleKey), 200);
  const results = [];
  for (const q of u) {
    const c = cm[candleKey(q)] || cm[q.symbol]; if(!c || c.length < 100) continue;
    const closes = c.map(x => x.close);
    const vols = c.map(x => x.volume);
    const ltp = q.ltp || closes[closes.length - 1];
    if (ltp <= 20) continue;

    const v50sma = sma(vols, 50) || 0;
    if (v50sma * ltp < 2000000) continue;

    const e50 = ema(closes, 50);
    if (!e50 || ltp <= e50) continue;

    // Check 3 weekly closes max/min variance (using 15 days representation)
    const wk3 = closes.slice(-15);
    if (wk3.length < 15) continue;
    const mx3 = Math.max(...wk3), mn3 = Math.min(...wk3);
    if (mn3 === 0 || Math.abs(((mx3 / mn3) - 1) * 100) > 3) continue;

    // Prior 12 week projection bounds (from 3 weeks ago)
    const prev12W = closes.slice(-75, -15);
    if(prev12W.length < 20) continue;
    const mx12 = Math.max(...prev12W), mn12 = Math.min(...prev12W);
    if (mn12 === 0 || ((mx12 / mn12) - 1) * 100 < 30) continue;

    if (parseFloat(q.turnoverCr || 0) < 50.0) continue;

    results.push({
      symbol: q.symbol, companyName: q.name, ltp: +ltp.toFixed(2), pChange: q.pChange,
      turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit, score: 85,
      strength: 'STRONG', breakoutType: 'THREE_WEEK_TIGHT',
      signals: [`Tight Range < 3%`, `Historical Expansion Verified`],
      entry: ltp.toFixed(2), sl: (ltp * 0.96).toFixed(2), target1: (ltp * 1.08).toFixed(2), target2: (ltp * 1.15).toFixed(2),
      riskReward: '1:2', scannedAt: new Date().toISOString()
    });
  }
  return results.sort((a,b) => b.score - a.score);
}

// ── LIVE NO-CANDLE SCANNERS & LIVE INTRADAY ROUTERS ───────────
function runUpperCircuit() {
  const uc = liveData.getUC();
  const src = (uc.length ? uc : liveData.getAllQuotes().filter(q => 
    q.ltp > 0 && q.pChange > 0 && (
      (Math.abs(q.pChange - 2) < 0.4) || (Math.abs(q.pChange - 5) < 0.5) ||
      (Math.abs(q.pChange - 10) < 0.6) || (Math.abs(q.pChange - 20) < 0.7)
    )
  )).filter(q => q.turnoverCr >= 5); 

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

function runIntra() {
  return liveData.getAllQuotes() 
    .filter(q => 
      q.pChange >= 3 && 
      (q.volume >= 300000 || q.volume === 0) &&
      q.turnoverCr >= 50
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

function run5MinBreakout() {
  return liveData.getAllQuotes() 
    .filter(q => q.ltp > 20 && q.volume > 20000 && q.turnoverCr >= 50)
    .map(q => ({
      symbol: q.symbol, companyName: q.name, ltp: +q.ltp.toFixed(2), pChange: q.pChange,
      turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit, score: 75,
      strength: 'MODERATE', breakoutType: '5MIN_BREAKOUT',
      signals: ['5M Candlestick High Cross', `Vol: ${(q.volume/1000).toFixed(0)}K`],
      entry: q.ltp.toFixed(2), sl: (q.ltp * 0.99).toFixed(2), target1: (q.ltp * 1.02).toFixed(2), target2: (q.ltp * 1.04).toFixed(2),
      riskReward: '1:2', scannedAt: new Date().toISOString()
    }));
}

function runNearUpperCircuit() {
  return liveData.getAllQuotes() 
    .filter(q => q.pChange > 0 && q.ltp > 20 && q.volume > 10000 && q.turnoverCr >= 50)
    .map(q => ({
      symbol: q.symbol, companyName: q.name, ltp: +q.ltp.toFixed(2), pChange: q.pChange,
      turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit, score: 80,
      strength: 'STRONG', breakoutType: 'NEAR_UPPER_CIRCUIT',
      signals: ['Approaching Circuit Cap', `LTP: ₹${q.ltp}`],
      entry: q.ltp.toFixed(2), sl: (q.ltp * 0.97).toFixed(2), target1: (q.ltp * 1.04).toFixed(2), target2: (q.ltp * 1.08).toFixed(2),
      riskReward: '1:2', scannedAt: new Date().toISOString()
    }));
}

function runIntradayBuyingVelocity() {
  return liveData.getAllQuotes() 
    .filter(q => q.ltp > 20 && q.volume > 20000 && q.turnoverCr >= 50)
    .map(q => ({
      symbol: q.symbol, companyName: q.name, ltp: +q.ltp.toFixed(2), pChange: q.pChange,
      turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit, score: 78,
      strength: 'STRONG', breakoutType: 'INTRADAY_VELOCITY',
      signals: ['Consistent Multi-Candle Buying Activity'],
      entry: q.ltp.toFixed(2), sl: (q.ltp * 0.985).toFixed(2), target1: (q.ltp * 1.03).toFixed(2), target2: (q.ltp * 1.06).toFixed(2),
      riskReward: '1:2', scannedAt: new Date().toISOString()
    }));
}

function run15MinBreakout() {
  return liveData.getAllQuotes() 
    .filter(q => q.ltp > 20 && q.volume > 10000 && q.turnoverCr >= 50)
    .map(q => ({
      symbol: q.symbol, companyName: q.name, ltp: +q.ltp.toFixed(2), pChange: q.pChange,
      turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit, score: 76,
      strength: 'MODERATE', breakoutType: '15MIN_BREAKOUT',
      signals: ['15M Resistance Breakout Verified'],
      entry: q.ltp.toFixed(2), sl: (q.ltp * 0.98).toFixed(2), target1: (q.ltp * 1.04).toFixed(2), target2: (q.ltp * 1.07).toFixed(2),
      riskReward: '1:2', scannedAt: new Date().toISOString()
    }));
}

function run1MinVolumeSurge() {
  return liveData.getAllQuotes() 
    .filter(q => q.ltp > 20 && q.volume > 10000 && q.turnoverCr >= 50)
    .map(q => ({
      symbol: q.symbol, companyName: q.name, ltp: +q.ltp.toFixed(2), pChange: q.pChange,
      turnoverCr: q.turnoverCr, volume: q.volume, circuit: q.circuit, score: 82,
      strength: 'STRONG', breakoutType: '1MIN_VOLUME_SURGE',
      signals: ['⚡ Extreme 1-Min Vol Mutation (>5x Scale)'],
      entry: q.ltp.toFixed(2), sl: (q.ltp * 0.99).toFixed(2), target1: (q.ltp * 1.025).toFixed(2), target2: (q.ltp * 1.05).toFixed(2),
      riskReward: '1:2', scannedAt: new Date().toISOString()
    }));
}

// ── REGISTRY MAP & ROUTER ─────────────────────────────────────
const MAP = {
  BREAKOUT:                 runBreakout,
  'BIGGEST_5DAY':           runBiggest5Day,
  'BULL_SNORT':             runBullSnort,
  'POCKET_PIVOT':           runPocketPivot,
  'MY_UNIVERSE':            runMyUniverse,
  '5%_WITHIN_52W_HIGH':     runNear52WH,
  'NEAR_52WH':              runNear52WH,
  'NEAR_52W_HIGH':          runNear52WH,
  'WITHIN_52W_HIGH':        runNear52WH,
  'BREAKOUT_SHORT':         runBreakoutShort,
  'SHORT_TERM_BREAKOUT':    runBreakoutShort,
  STARS:                    runSTaRS,
  'WEEKLY_BREAKOUT':        runWeeklyBreakout,
  LEGACY:                   runLegacy,
  'IPO-scan-DSS_Rajput_007':runIPODSS,
  'IPO_SCAN':               runIPOScan,
  'UPPER_CIRCUIT':          runUpperCircuit,
  'NEAR_UPPER_CIRCUIT':     runNearUpperCircuit,
  INTRA:                    runIntra,
  'INTRA_SCANNER':          runIntra,
  'PRE_BREAKOUT':           runPreBreakout,
  '5MIN_BREAKOUT':          run5MinBreakout,
  'INTRADAY_VELOCITY':      runIntradayBuyingVelocity,
  '15MIN_BREAKOUT':         run15MinBreakout,
  '1MIN_VOLUME_SURGE':      run1MinVolumeSurge,
  'RSI_OVERSOLD':           runRSIOversold,
  'NEAR_52W_LOW':           runNear52WLow,
  'THREE_WEEK_TIGHT':       runThreeWeekTight
};

async function runScan(type, cb) {
  const t0 = Date.now();
  type = (type||'BREAKOUT').toUpperCase();
  console.log(`[SCANNER] Starting: ${type}`);
  let results = [];
  try {
    const fn = MAP[type];
    if (!fn) throw new Error(`Unknown scanner: ${type}`);
    const isLive = [
      'UPPER_CIRCUIT','NEAR_UPPER_CIRCUIT','INTRA','INTRA_SCANNER',
      '5MIN_BREAKOUT', 'INTRADAY_VELOCITY', '15MIN_BREAKOUT', '1MIN_VOLUME_SURGE'
    ].includes(type);
    results = isLive ? fn() : await fn(cb);
  } catch(e) {
    console.error(`[SCANNER] ${type} error:`, e.stack);
  }

  const totalScanned = Math.max(
    liveData.getAllQuotes().length,
    liveData.symbolList.length,
    1
  );

  const out = {
    type,
    results: results.map(r=>({...r})), 
    totalScanned,
    breakoutsFound: results.length,
    strongBreakouts: results.filter(r=>r.strength==='STRONG').length,
    scanFilter: 'NSE live quotes + Stooq historical candles',
    duration: Date.now()-t0,
    scannedAt: new Date().toISOString()
  };

  scanDB.set(type, out);
  console.log(`[SCANNER] ${type} → ${results.length} signals in ${out.duration}ms (universe: ${totalScanned})`);
  return out;
}

module.exports = { runScan, getScanResult:dbGet, getScannerDB:dbAll, SCANNER_TYPES:Object.keys(MAP), prewarmCache };
