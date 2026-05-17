'use strict';
require('dotenv').config();
const express  = require('express');
const http     = require('http');
const WS       = require('ws');
const cors     = require('cors');
const path     = require('path');
const cron     = require('node-cron');
const crypto   = require('crypto');

const liveData = require('./liveData');
const scanner  = require('./scanner');
const aiEngine = require('./aiEngine');

const app    = express();
const server = http.createServer(app);
const wss    = new WS.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname,'../public')));

// ── Watchlist per-user (in-memory) ──────────────────────────
const watchlistDB = new Map();
const getWL = uid => { if(!watchlistDB.has(uid)) watchlistDB.set(uid,[]); return watchlistDB.get(uid); };

// ── Clients ──────────────────────────────────────────────────
const clients = new Map(); // ws → { userId }

function send(ws,type,data){ if(ws.readyState===WS.OPEN) ws.send(JSON.stringify({type,data,ts:Date.now()})); }
function broadcast(type,data){ const m=JSON.stringify({type,data,ts:Date.now()}); for(const [ws] of clients) if(ws.readyState===WS.OPEN) ws.send(m); }

// ── 2-second broadcast loop ──────────────────────────────────
function startBroadcastLoop() {
  // Every 1s — live market data
  setInterval(()=>{
    if(clients.size===0) return;
    // Indices always (for Gift Nifty 24x7)
    const idx=liveData.getStructuredIndices();
    broadcast('INDICES_UPDATE',idx);
    if(idx.giftnifty) broadcast('GIFT_NIFTY',idx.giftnifty);

    // FIX: Always broadcast market data — not gated by market hours
    // (Data is valid even after hours; gates were causing 0-result displays)
    const liveCount = liveData.getAllQuotes().length;
    if(liveCount > 0) {
      broadcast('TOP_GAINERS',   liveData.getTopGainers());
      broadcast('TOP_LOSERS',    liveData.getTopLosers());
      broadcast('UPPER_CIRCUIT', liveData.getUC());
      broadcast('LOWER_CIRCUIT', liveData.getLC());
      broadcast('ALL_CIRCUITS',  liveData.getAllCircuits());
      broadcast('MARKET_MOOD',   liveData.getMarketMood());
      broadcast('MARKET_BREADTH',liveData.getMarketBreadth());
    }
  },1000);

  // Every 5s — commodities always (show last price even after MCX closes)
  setInterval(()=>{
    if(clients.size===0) return;
    const comm=liveData.commodities;
    if(Object.keys(comm).length>0) broadcast('COMMODITIES',comm);
    // Gift Nifty: dedicated 5s push (TVC API fetches every 5s)
    const gn=liveData.giftNifty;
    if(gn&&gn.last) broadcast('GIFT_NIFTY',gn);
  },5000);

  // Every 30s — all quotes for search cache
  setInterval(()=>{
    if(clients.size===0) return;
    const quotes=liveData.getAllQuotes();
    if(quotes.length>0) broadcast('ALL_QUOTES',quotes);
  },30000);

  // Every 10s — market status broadcast (covers pre-open 9:00–9:15 transition)
  setInterval(() => {
    if (clients.size === 0) return;
    broadcast('MARKET_STATUS', liveData.mktStatus);
  }, 10000);
}

// ── Initial data on connect ──────────────────────────────────
async function sendInitial(ws) {
  send(ws,'INDICES_UPDATE',  liveData.getStructuredIndices());
  send(ws,'GIFT_NIFTY',      liveData.giftNifty);
  if(Object.keys(liveData.commodities).length>0) send(ws,'COMMODITIES',liveData.commodities);
  send(ws,'TOP_GAINERS',     liveData.getTopGainers());
  send(ws,'TOP_LOSERS',      liveData.getTopLosers());
  send(ws,'UPPER_CIRCUIT',   liveData.getUC());
  send(ws,'LOWER_CIRCUIT',   liveData.getLC());
  send(ws,'ALL_CIRCUITS',    liveData.getAllCircuits());
  send(ws,'MARKET_MOOD',     liveData.getMarketMood());
  send(ws,'MARKET_BREADTH',  liveData.getMarketBreadth());
  send(ws,'STOCK_LIST_INFO', liveData.getStockListInfo());
  send(ws,'SCANNER_DB',      scanner.getScannerDB());
  send(ws,'COMMODITIES',     liveData.commodities);
  liveData.fetchMarketStatus().then(ms=>{ if(ms) send(ws,'MARKET_STATUS',ms); }).catch(()=>{});
  liveData.fetchNews().then(news=>{ if(news&&news.length) send(ws,'NEWS_UPDATE',news); }).catch(()=>{});
}

// ── WebSocket ────────────────────────────────────────────────
wss.on('connection',(ws,req)=>{
  const uid=req.headers['x-user-id']||crypto.randomBytes(8).toString('hex');
  clients.set(ws,{userId:uid});
  console.log(`[WS] +client (total ${clients.size})`);
  sendInitial(ws);

  ws.on('message',async raw=>{
    let msg; try{msg=JSON.parse(raw);}catch(_){return;}
    await handleMsg(ws,msg,uid).catch(e=>console.error('[WS msg]',e.message));
  });
  ws.on('close',()=>{ clients.delete(ws); console.log(`[WS] -client (total ${clients.size})`); });
  ws.on('error',e=>{ clients.delete(ws); console.error('[WS]',e.message); });
});

// ── Message Handler ──────────────────────────────────────────
async function handleMsg(ws,{action,payload},uid){
  const reply=(type,data)=>send(ws,type,data);

  switch(action){

    // ── SCANNER ───────────────────────────────────────────────
    case 'RUN_KEY_SCAN':{
      const type=(payload?.type||'BREAKOUT').toUpperCase();
      reply('SCAN_STARTED',{type});
      try{
        const r=await scanner.runScan(type,msg=>reply('SCAN_PROGRESS',{type,msg}));
        // Send as KEY_BREAKOUT_RESULTS so dashboard handles separately from scanner page
        reply('KEY_BREAKOUT_RESULTS',r);
        reply('SCAN_RESULTS',r);
      }catch(e){ reply('KEY_BREAKOUT_RESULTS',{type,error:e.message,results:[],totalScanned:0,breakoutsFound:0}); }
      break;
    }
    case 'RUN_SCAN':{
      const type=(payload?.type||'BREAKOUT').toUpperCase();
      reply('SCAN_STARTED',{type});
      try{
        const r=await scanner.runScan(type,msg=>reply('SCAN_PROGRESS',{type,msg}));
        reply('SCAN_RESULTS',r);
        reply('NAMED_SCAN_RESULTS',r);
        broadcast('SCANNER_DB',scanner.getScannerDB());
      }catch(e){ reply('SCAN_RESULTS',{type,error:e.message,results:[],totalScanned:0,breakoutsFound:0}); }
      break;
    }
    case 'GET_IPO_SCANS':{
      const type=(payload?.type||'IPO_SCAN').toUpperCase();
      // Ensure the specific Rajput 007 scanner string is preserved exactly as requested
      const actualType = type === 'IPO_DSS' ? 'IPO-scan-DSS_Rajput_007' : type;
      reply('SCAN_STARTED',{type:actualType});
      try{
        const r=await scanner.runScan(actualType);
        reply(actualType === 'IPO-scan-DSS_Rajput_007' ? 'IPO-scan-DSS_Rajput_007_RESULTS' : 'IPO_SCAN_RESULTS', r);
        broadcast('SCANNER_DB',scanner.getScannerDB());
      }catch(e){ reply('IPO_SCAN_RESULTS',{type:actualType,error:e.message,results:[],totalScanned:0,breakoutsFound:0}); }
      break;
    }
    case 'GET_SCANNER_DB':   reply('SCANNER_DB',scanner.getScannerDB()); break;
    case 'GET_SCANNER_RESULT':reply('SCANNER_RESULT',scanner.getScanResult((payload?.type||'').toUpperCase())); break;

    // ── MANUAL REFRESH ────────────────────────────────────────
    case 'MANUAL_REFRESH':{
      reply('REFRESH_STARTED',{});
      try{
        const r=await liveData.manualRefresh();
        reply('INDICES_UPDATE',  liveData.getStructuredIndices());
        reply('TOP_GAINERS',     liveData.getTopGainers());
        reply('TOP_LOSERS',      liveData.getTopLosers());
        reply('UPPER_CIRCUIT',   liveData.getUC());
        reply('LOWER_CIRCUIT',   liveData.getLC());
        reply('ALL_CIRCUITS',    liveData.getAllCircuits());
        reply('MARKET_MOOD',     liveData.getMarketMood());
        reply('MARKET_BREADTH',  liveData.getMarketBreadth());
        reply('GIFT_NIFTY',      liveData.giftNifty);
        reply('COMMODITIES',     liveData.commodities);
        reply('REFRESH_COMPLETE',r);
      }catch(e){ reply('REFRESH_COMPLETE',{error:e.message}); }
      break;
    }

    // ── MARKET DATA QUERIES ───────────────────────────────────
    case 'GET_INDICES':
    case 'GET_ALL_INDICES':     reply('INDICES_UPDATE',   liveData.getStructuredIndices()); break;
    case 'GET_GIFT_NIFTY':      reply('GIFT_NIFTY',       liveData.giftNifty);              break;
    case 'GET_TOP_GAINERS':     reply('TOP_GAINERS',      liveData.getTopGainers());        break;
    case 'GET_TOP_LOSERS':      reply('TOP_LOSERS',       liveData.getTopLosers());         break;
    case 'GET_UPPER_CIRCUIT':   reply('UPPER_CIRCUIT',    liveData.getUC());                break;
    case 'GET_LOWER_CIRCUIT':   reply('LOWER_CIRCUIT',    liveData.getLC());                break;
    case 'GET_ALL_CIRCUITS':    reply('ALL_CIRCUITS',     liveData.getAllCircuits());        break;
    case 'GET_MARKET_MOOD':     reply('MARKET_MOOD',      liveData.getMarketMood());        break;
    case 'GET_MARKET_BREADTH':  reply('MARKET_BREADTH',   liveData.getMarketBreadth());     break;
    case 'GET_ALL_QUOTES':      reply('ALL_QUOTES',       liveData.getAllQuotes());           break;
    case 'GET_STOCK_LIST_INFO': reply('STOCK_LIST_INFO',  liveData.getStockListInfo());     break;
    case 'GET_COMMODITIES':     reply('COMMODITIES',      liveData.commodities);            break;
    case 'GET_MCX_TIMINGS':{const t=await liveData.fetchMCXTimings().catch(()=>null);reply('MCX_TIMINGS',t);break;}
    case 'GET_STOCK_DETAIL':{const q=liveData.getStockQuote(payload?.symbol||'');reply('STOCK_DETAIL',q||{error:'Not found'});break;}
    case 'GET_ALL_STOCKS':      reply('ALL_STOCKS',liveData.getScanUniverse().slice(0,200)); break;
    case 'GET_MARKET_STATUS':{const ms=await liveData.fetchMarketStatus().catch(()=>null);reply('MARKET_STATUS',ms||{isOpen:false,status:'Closed'});break;}

    // ── NEWS ──────────────────────────────────────────────────
    case 'GET_NEWS':
    case 'GET_MARKET_NEWS':{const n=await liveData.fetchNews(true).catch(()=>[]);reply('NEWS_UPDATE',n);break;}

    // ── WATCHLIST ─────────────────────────────────────────────
    case 'ADD_WATCHLIST':{const sym=(payload?.symbol||'').toUpperCase();if(sym){const wl=getWL(uid);if(!wl.find(x=>x.symbol===sym)) wl.push({symbol:sym,...(payload||{})});}reply('WATCHLIST',getWL(uid));break;}
    case 'REMOVE_WATCHLIST':{const wl=getWL(uid);const i=wl.findIndex(x=>x.symbol===(payload?.symbol||'').toUpperCase());if(i>=0) wl.splice(i,1);reply('WATCHLIST',getWL(uid));break;}
    case 'GET_WATCHLIST':       reply('WATCHLIST',getWL(uid)); break;

    // ── AI ────────────────────────────────────────────────────
    case 'AI_QUERY':{
      const ctx={...(payload?.context||{}),gainers:liveData.getTopGainers().slice(0,10),losers:liveData.getTopLosers().slice(0,10),ucStocks:liveData.getUC().slice(0,10),lcStocks:liveData.getLC().slice(0,10),breadth:liveData.getMarketBreadth(),mood:liveData.getMarketMood(),totalScanned:liveData.quoteStore.size,commodities:liveData.commodities};
      const r=await aiEngine.query(payload?.question||'',ctx).catch(e=>({response:e.message,source:'error'}));
      reply('AI_RESPONSE',r);
      break;
    }

    // ── SETTINGS ──────────────────────────────────────────────
    case 'SET_API_KEY':    if(payload?.key) process.env.ANTHROPIC_API_KEY=payload.key; reply('SETTINGS_SAVED',{ok:true}); break;
    case 'SET_INTERVAL':   reply('INTERVAL_SET',{seconds:Math.max(10,parseInt(payload?.seconds||30))}); reply('INTERVAL_CHANGED',{seconds:Math.max(10,parseInt(payload?.seconds||30))}); break;
    case 'UPDATE_MCX_TOKEN':{
      if(payload?.name&&payload?.token){ process.env[`MCX_${payload.name.toUpperCase().replace(' ','_')}`]=payload.token; reply('SETTINGS_SAVED',{ok:true,msg:`MCX ${payload.name} token updated`}); }
      break;
    }

    default: console.warn('[WS] Unknown action:',action);
  }
}

// ── NSE ALL INDICES PROXY — bypasses browser CORS for NSE India API ──────────
// ── GIFT NIFTY PROXY — Cloudflare bypass (server-side fetch) ────────────────
app.get('/api/gift-nifty', (req, res) => {
  const gn = liveData.giftNifty;
  if (gn && gn.last > 0) {
    res.setHeader('Cache-Control','no-cache');
    return res.json(gn);
  }
  res.status(204).end(); // No data yet
});

// ── ALL INDICES NSE — server-side cached, instant response ──────────────────
let _nseIdxCache = null, _nseIdxCacheAt = 0;
async function refreshNseIdxCache() {
  try {
    const axios = require('axios');
    const r = await axios.get('https://www.nseindia.com/api/allIndices', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'application/json,*/*',
        'Referer': 'https://www.nseindia.com/market-data/live-market-indices',
      },
      timeout: 10000
    });
    if (r.data?.data?.length) { _nseIdxCache = r.data; _nseIdxCacheAt = Date.now(); }
  } catch(_) {}
}
// Pre-warm on startup + refresh every 25s
refreshNseIdxCache();
setInterval(refreshNseIdxCache, 25000);

app.get('/api/all-indices-nse', async (req, res) => {
  if (_nseIdxCache) {
    res.setHeader('Cache-Control','no-cache');
    return res.json(_nseIdxCache);
  }
  // Not cached yet — fetch now
  await refreshNseIdxCache();
  if (_nseIdxCache) return res.json(_nseIdxCache);
  // Fallback to liveData in-memory
  const si = liveData.getStructuredIndices();
  res.json({ data: si.all || [], source: 'liveData_cache' });
});

// ── YAHOO CHART PROXY — bypasses browser CORS for Yahoo Finance v8 ──────────
// Browser cannot call Yahoo directly (CORS blocked). Server proxies it.
// Route: GET /api/chart/:symbol?range=1y&interval=1d
app.get('/api/chart/:symbol', async (req, res) => {
  const sym      = req.params.symbol;
  const range    = req.query.range    || '1y';
  const interval = req.query.interval || '1d';
  if (!sym) return res.status(400).json({ error: 'symbol required' });

  const hdrs = yahooFetcher._headers || {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept': 'application/json,*/*',
  };

  const axios = require('axios');
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await axios.get(
        `${base}/v8/finance/chart/${encodeURIComponent(sym)}`,
        {
          headers: hdrs,
          params:  { range, interval, includePrePost: false },
          timeout: 12000,
        }
      );
      if (r.data?.chart?.result) {
        res.setHeader('Cache-Control', 'no-cache');
        return res.json(r.data);
      }
    } catch (_) {}
  }
  res.status(502).json({ error: 'Failed to fetch chart data from Yahoo Finance' });
});

// ── yahooFetcher reference for proxy ─────────────────────────
const yahooFetcher = require('./yahooFetcher');
app.get('/api/health',(_, res)=>res.json({status:'OK',uptime:process.uptime(),clients:clients.size,stockInfo:liveData.getStockListInfo(),marketOpen:liveData.isMarketHours()}));
app.get('/api/indices',        (_,res)=>res.json(liveData.getStructuredIndices()));
app.get('/api/all-indices',    (_,res)=>res.json(liveData.getStructuredIndices()));
app.get('/api/gift-nifty',     (_,res)=>res.json(liveData.giftNifty||{}));
app.get('/api/gainers',        (_,res)=>res.json(liveData.getTopGainers()));
app.get('/api/losers',         (_,res)=>res.json(liveData.getTopLosers()));
app.get('/api/upper-circuit',  (_,res)=>res.json(liveData.getUC()));
app.get('/api/lower-circuit',  (_,res)=>res.json(liveData.getLC()));
app.get('/api/all-circuits',   (_,res)=>res.json(liveData.getAllCircuits()));
app.get('/api/market-mood',    (_,res)=>res.json(liveData.getMarketMood()));
app.get('/api/market-breadth', (_,res)=>res.json(liveData.getMarketBreadth()));
app.get('/api/stock-list',     (_,res)=>res.json(liveData.getStockListInfo()));
app.get('/api/scan-universe',  (_,res)=>res.json(liveData.getScanUniverse().slice(0,500)));
app.get('/api/commodities',    (_,res)=>res.json(liveData.commodities));
app.get('/api/news',           async(_,res)=>{ const n=await liveData.fetchNews().catch(()=>[]); res.json(n); });
app.get('/api/market-status',  async(_,res)=>{ const ms=await liveData.fetchMarketStatus().catch(()=>null); res.json(ms||{isOpen:false,status:'Closed'}); });
app.get('/api/stock/:symbol',  (req,res)=>{ const q=liveData.getStockQuote(req.params.symbol); q?res.json(q):res.status(404).json({error:'Not found'}); });
app.post('/api/refresh',       async(_,res)=>{ try{res.json(await liveData.manualRefresh());}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/refresh-stocks',async(_,res)=>{ try{await liveData.loadSymbolUniverse();const i=liveData.getStockListInfo();broadcast('STOCK_LIST_INFO',{...i,refreshed:true});res.json({ok:true,...i,totalNSE:liveData.symbolList.filter(s=>s.exchange==='NSE').length,totalBSE:liveData.symbolList.filter(s=>s.exchange==='BSE').length});}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/scan',          async(req,res)=>{ const type=(req.body?.type||'BREAKOUT').toUpperCase();try{res.json(await scanner.runScan(type));}catch(e){res.status(500).json({error:e.message,results:[]});} });
app.get('/api/scanner-db',     (_,res)=>res.json(scanner.getScannerDB()));
app.get('/api/scanner-db/:type',(req,res)=>{ const r=scanner.getScanResult(req.params.type.toUpperCase()); r?res.json(r):res.status(404).json({error:'No scan data yet'}); });
app.post('/api/settings',      (req,res)=>{ if(req.body.apiKey) process.env.ANTHROPIC_API_KEY=req.body.apiKey; if(req.body.mcxToken) Object.assign(process.env,req.body.mcxToken); res.json({ok:true}); });
app.post('/api/ai',            async(req,res)=>{ const ctx={gainers:liveData.getTopGainers().slice(0,10),losers:liveData.getTopLosers().slice(0,10),mood:liveData.getMarketMood(),breadth:liveData.getMarketBreadth(),commodities:liveData.commodities,totalScanned:liveData.quoteStore.size,...(req.body.context||{})};try{res.json(await aiEngine.query(req.body.question,ctx));}catch(e){res.status(500).json({error:e.message});} });
app.get('/api/watchlist',      (req,res)=>res.json(getWL(req.headers['x-user-id']||'default')));
app.post('/api/watchlist',     (req,res)=>{ const uid=req.headers['x-user-id']||'default';const sym=(req.body?.symbol||'').toUpperCase();if(sym){const wl=getWL(uid);if(!wl.find(x=>x.symbol===sym))wl.push({symbol:sym});}res.json(getWL(uid)); });
app.delete('/api/watchlist/:symbol',(req,res)=>{ const uid=req.headers['x-user-id']||'default';const wl=getWL(uid);const i=wl.findIndex(x=>x.symbol===req.params.symbol.toUpperCase());if(i>=0)wl.splice(i,1);res.json(getWL(uid)); });

for(const type of scanner.SCANNER_TYPES){
  app.get(`/api/scan/${type.toLowerCase().replace(/_/g,'-')}`,async(_,res)=>{
    try{const r=await scanner.runScan(type);broadcast('SCANNER_DB',scanner.getScannerDB());res.json(r);}
    catch(e){res.status(500).json({error:e.message,results:[]});}
  });
}
app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

// ── CRON: 8:55 AM IST = 3:25 UTC Mon–Fri ─────────────────────
cron.schedule('25 3 * * 1-5',async()=>{
  console.log('[CRON 8:55 IST] Reloading symbols…');
  try{
    await liveData.loadSymbolUniverse();
    const i=liveData.getStockListInfo();
    broadcast('STOCK_LIST_INFO',{...i,refreshed:true});
    console.log(`[CRON] Done: ${i.total} stocks`);
  }catch(e){console.error('[CRON]',e.message);}
},{timezone:'UTC'});

// ── STARTUP ──────────────────────────────────────────────────
(async()=>{
  console.log('[STARTUP] Loading Shoonya symbol universe…');
  await liveData.loadSymbolUniverse();
  console.log('[STARTUP] Starting live data loop…');
  await liveData.runLiveLoop();
  startBroadcastLoop();
  // Pre-warm candle cache 45s after startup (quotes will be live by then)
  setTimeout(async()=>{
    try{
      const u=liveData.getScanUniverse();
      if(u.length>0) await scanner.prewarmCache(u);
    }catch(_){}
  },45000);

  const PORT=process.env.PORT||3000;
  server.listen(PORT,()=>{
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║  Scanner AI v5 — NSE+BSE Cash Market                             ║
║  Port ${String(PORT).padEnd(4)} | Shoonya ZIP → Yahoo Finance quotes          ║
║  Stocks: every 1s | Yahoo Indices: every 1s | NSE Other: 1min    ║
║  Gift Nifty: investing.com every 10s 24x7                        ║
║  Commodities: Groww MCX every 5s (MCX hours)                     ║
║  Gainers>=10%, Losers<=-9.90%, UC/LC: live from quotes           ║
║  Scanners: on-demand, each own DB, ₹500Cr+ filter                ║
╚═══════════════════════════════════════════════════════════════════╝`);
  });
})();
