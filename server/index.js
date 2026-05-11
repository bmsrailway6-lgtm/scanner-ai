'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const WS = require('ws');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');

const liveData = require('./liveData');
const scanner = require('./scanner');
const aiEngine = require('./aiEngine');
const yahooFetcher = require('./yahooFetcher');

const app = express();
const server = http.createServer(app);

const wss = new WS.Server({ server });

// ─────────────────────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────────────────────

app.use(cors());

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, '../public')
  )
);

// ─────────────────────────────────────────────────────────────
// WATCHLIST
// ─────────────────────────────────────────────────────────────

const watchlistDB = new Map();

function getWL(uid) {

  if (!watchlistDB.has(uid)) {
    watchlistDB.set(uid, []);
  }

  return watchlistDB.get(uid);
}

// ─────────────────────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────────────────────

const clients = new Map();

function send(ws, type, data) {

  if (ws.readyState !== WS.OPEN) {
    return;
  }

  ws.send(
    JSON.stringify({
      type,
      data,
      ts: Date.now(),
    })
  );
}

function broadcast(type, data) {

  const msg = JSON.stringify({
    type,
    data,
    ts: Date.now(),
  });

  for (const [ws] of clients) {

    if (ws.readyState === WS.OPEN) {
      ws.send(msg);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// BROADCAST LOOP
// ─────────────────────────────────────────────────────────────

function startBroadcastLoop() {

  setInterval(() => {

    if (clients.size === 0) {
      return;
    }

    try {

      const idx =
        liveData.getStructuredIndices();

      broadcast('INDICES_UPDATE', idx);

      if (idx?.giftnifty) {
        broadcast(
          'GIFT_NIFTY',
          idx.giftnifty
        );
      }

      const liveQuotes =
        liveData.getAllQuotes();

      if (liveQuotes.length > 0) {

        broadcast(
          'TOP_GAINERS',
          liveData.getTopGainers()
        );

        broadcast(
          'TOP_LOSERS',
          liveData.getTopLosers()
        );

        broadcast(
          'UPPER_CIRCUIT',
          liveData.getUC()
        );

        broadcast(
          'LOWER_CIRCUIT',
          liveData.getLC()
        );

        broadcast(
          'ALL_CIRCUITS',
          liveData.getAllCircuits()
        );

        broadcast(
          'MARKET_MOOD',
          liveData.getMarketMood()
        );

        broadcast(
          'MARKET_BREADTH',
          liveData.getMarketBreadth()
        );
      }

    } catch (e) {

      console.error(
        '[Broadcast]',
        e.message
      );
    }

  }, 1000);
}

// ─────────────────────────────────────────────────────────────
// INITIAL DATA
// ─────────────────────────────────────────────────────────────

async function sendInitial(ws) {

  try {

    send(
      ws,
      'INDICES_UPDATE',
      liveData.getStructuredIndices()
    );

    send(
      ws,
      'GIFT_NIFTY',
      liveData.giftNifty
    );

    send(
      ws,
      'TOP_GAINERS',
      liveData.getTopGainers()
    );

    send(
      ws,
      'TOP_LOSERS',
      liveData.getTopLosers()
    );

    send(
      ws,
      'UPPER_CIRCUIT',
      liveData.getUC()
    );

    send(
      ws,
      'LOWER_CIRCUIT',
      liveData.getLC()
    );

    send(
      ws,
      'ALL_CIRCUITS',
      liveData.getAllCircuits()
    );

    send(
      ws,
      'MARKET_MOOD',
      liveData.getMarketMood()
    );

    send(
      ws,
      'MARKET_BREADTH',
      liveData.getMarketBreadth()
    );

    send(
      ws,
      'STOCK_LIST_INFO',
      liveData.getStockListInfo()
    );

    send(
      ws,
      'SCANNER_DB',
      scanner.getScannerDB()
    );

  } catch (e) {

    console.error(
      '[Initial]',
      e.message
    );
  }
}

// ─────────────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {

  const uid =
    req.headers['x-user-id'] ||
    crypto.randomBytes(8).toString('hex');

  clients.set(ws, {
    userId: uid,
  });

  console.log(
    `[WS] Client Connected (${clients.size})`
  );

  sendInitial(ws);

  ws.on('message', async raw => {

    let msg;

    try {

      msg = JSON.parse(raw);

    } catch (_) {

      return;
    }

    try {

      await handleMsg(
        ws,
        msg,
        uid
      );

    } catch (e) {

      console.error(
        '[WS Message]',
        e.message
      );
    }
  });

  ws.on('close', () => {

    clients.delete(ws);

    console.log(
      `[WS] Client Disconnected (${clients.size})`
    );
  });

  ws.on('error', e => {

    clients.delete(ws);

    console.error(
      '[WS]',
      e.message
    );
  });
});

// ─────────────────────────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────

async function handleMsg(
  ws,
  { action, payload },
  uid
) {

  const reply = (type, data) =>
    send(ws, type, data);

  switch (action) {

    case 'RUN_SCAN': {

      const type =
        (
          payload?.type ||
          'BREAKOUT'
        ).toUpperCase();

      reply(
        'SCAN_STARTED',
        { type }
      );

      try {

        const result =
          await scanner.runScan(type);

        reply(
          'SCAN_RESULTS',
          result
        );

      } catch (e) {

        reply(
          'SCAN_RESULTS',
          {
            type,
            error: e.message,
            results: [],
          }
        );
      }

      break;
    }

    case 'GET_SCANNER_DB': {

      reply(
        'SCANNER_DB',
        scanner.getScannerDB()
      );

      break;
    }

    case 'GET_ALL_QUOTES': {

      reply(
        'ALL_QUOTES',
        liveData.getAllQuotes()
      );

      break;
    }

    case 'GET_GIFT_NIFTY': {

      reply(
        'GIFT_NIFTY',
        liveData.giftNifty
      );

      break;
    }

    case 'GET_MARKET_MOOD': {

      reply(
        'MARKET_MOOD',
        liveData.getMarketMood()
      );

      break;
    }

    case 'GET_MARKET_BREADTH': {

      reply(
        'MARKET_BREADTH',
        liveData.getMarketBreadth()
      );

      break;
    }

    case 'AI_QUERY': {

      try {

        const ctx = {

          gainers:
            liveData
              .getTopGainers()
              .slice(0, 10),

          losers:
            liveData
              .getTopLosers()
              .slice(0, 10),

          mood:
            liveData.getMarketMood(),

          breadth:
            liveData.getMarketBreadth(),
        };

        const result =
          await aiEngine.query(
            payload?.question || '',
            ctx
          );

        reply(
          'AI_RESPONSE',
          result
        );

      } catch (e) {

        reply(
          'AI_RESPONSE',
          {
            error: e.message,
          }
        );
      }

      break;
    }

    case 'GET_WATCHLIST': {

      reply(
        'WATCHLIST',
        getWL(uid)
      );

      break;
    }

    default:

      console.warn(
        '[WS] Unknown Action:',
        action
      );
  }
}

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

app.get('/api/health', (_, res) => {

  res.json({
    status: 'OK',
    uptime: process.uptime(),
    clients: clients.size,
    stockInfo:
      liveData.getStockListInfo(),
  });
});

app.get('/api/indices', (_, res) => {

  res.json(
    liveData.getStructuredIndices()
  );
});

app.get('/api/gift-nifty', (_, res) => {

  res.json(
    liveData.giftNifty || {}
  );
});

app.get('/api/gainers', (_, res) => {

  res.json(
    liveData.getTopGainers()
  );
});

app.get('/api/losers', (_, res) => {

  res.json(
    liveData.getTopLosers()
  );
});

app.get('/api/all-quotes', (_, res) => {

  res.json(
    liveData.getAllQuotes()
  );
});

app.get('/api/market-mood', (_, res) => {

  res.json(
    liveData.getMarketMood()
  );
});

app.get('/api/market-breadth', (_, res) => {

  res.json(
    liveData.getMarketBreadth()
  );
});

app.get('/api/scan/:type', async (req, res) => {

  try {

    const result =
      await scanner.runScan(
        req.params.type.toUpperCase()
      );

    res.json(result);

  } catch (e) {

    res.status(500).json({
      error: e.message,
    });
  }
});

app.get('/api/scanner-db', (_, res) => {

  res.json(
    scanner.getScannerDB()
  );
});

app.get('/api/stock/:symbol', (req, res) => {

  const q =
    liveData.getStockQuote(
      req.params.symbol
    );

  if (!q) {

    return res
      .status(404)
      .json({
        error: 'Not found',
      });
  }

  res.json(q);
});

app.post('/api/ai', async (req, res) => {

  try {

    const result =
      await aiEngine.query(
        req.body.question || '',
        {}
      );

    res.json(result);

  } catch (e) {

    res.status(500).json({
      error: e.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// YAHOO CHART PROXY
// ─────────────────────────────────────────────────────────────

app.get(
  '/api/chart/:symbol',
  async (req, res) => {

    const sym =
      req.params.symbol;

    const range =
      req.query.range || '1y';

    const interval =
      req.query.interval || '1d';

    try {

      const axios =
        require('axios');

      const hdrs =
        yahooFetcher._headers || {
          'User-Agent':
            'Mozilla/5.0',
        };

      for (const base of [
        'https://query1.finance.yahoo.com',
        'https://query2.finance.yahoo.com',
      ]) {

        try {

          const r =
            await axios.get(
              `${base}/v8/finance/chart/${encodeURIComponent(sym)}`,
              {
                headers: hdrs,
                params: {
                  range,
                  interval,
                },
                timeout: 15000,
              }
            );

          if (
            r.data?.chart?.result
          ) {

            return res.json(
              r.data
            );
          }

        } catch (_) {}
      }

      res.status(500).json({
        error:
          'Yahoo fetch failed',
      });

    } catch (e) {

      res.status(500).json({
        error: e.message,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// FRONTEND
// ─────────────────────────────────────────────────────────────

app.get('*', (_, res) => {

  res.sendFile(
    path.join(
      __dirname,
      '../public/index.html'
    )
  );
});

// ─────────────────────────────────────────────────────────────
// CRON
// ─────────────────────────────────────────────────────────────

cron.schedule(
  '25 3 * * 1-5',
  async () => {

    try {

      console.log(
        '[CRON] Reloading symbols'
      );

      await liveData.loadSymbolUniverse();

    } catch (e) {

      console.error(
        '[CRON]',
        e.message
      );
    }

  },
  {
    timezone: 'UTC',
  }
);

// ─────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────

(async () => {

  try {

    console.log(
      '[STARTUP] Loading symbols'
    );

    await liveData.loadSymbolUniverse();

    console.log(
      '[STARTUP] Starting live loop'
    );

    await liveData.runLiveLoop();

    startBroadcastLoop();

    setTimeout(async () => {

      try {

        const u =
          liveData.getScanUniverse();

        if (u.length > 0) {

          await scanner.prewarmCache(u);
        }

      } catch (e) {

        console.error(
          '[CACHE]',
          e.message
        );
      }

    }, 45000);

    console.log(
      '[STARTUP] Ready'
    );

  } catch (e) {

    console.error(
      '[STARTUP ERROR]',
      e.message
    );
  }

})();

// ─────────────────────────────────────────────────────────────
// VERCEL EXPORT
// ─────────────────────────────────────────────────────────────

module.exports = app;
