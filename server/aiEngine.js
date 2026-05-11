/**
 * aiEngine.js v5
 * Claude API integration with rich Indian market context.
 * Falls back to rule-based responses when no API key.
 */
'use strict';
require('dotenv').config();
const axios = require('axios');

const SYSTEM = `You are Scanner AI, an expert Indian stock market analyst for NSE and BSE CASH SEGMENT ONLY. No F&O, no derivatives, no commodities trading advice.

Expertise:
- NSE/BSE cash equity: breakouts, momentum, IPO base patterns
- Indices: Nifty 50, Sensex, Bank Nifty, Midcap 100, Smallcap, VIX, sectoral
- Commodities: Gold, Silver (MCX) — information only
- Gift Nifty: global cues interpretation
- Scanners: Breakout, Bull Snort, STaRS, My Universe, 52W High, IPO, UC/LC, Intraday, Weekly
- UC/LC detection from live circuit data
- Gainers >= 10%, Losers <= -9.90% (live from 5,628+ stocks)
- Risk management: 1-2% rule, ATR-based SL, 1:2 R:R minimum
- All data from Yahoo Finance (real-time quotes for 5,628+ NSE+BSE stocks)

Response style:
- Direct, actionable, concise
- Use ₹ for prices, Cr for crores
- Include Entry / SL / Target when discussing specific stocks
- Mention circuit status (UC/LC) when relevant
- Cash segment only — never suggest F&O`;

function buildContext(q, ctx = {}) {
  if (!ctx || !Object.keys(ctx).length) return q;
  const p = [q, '\n--- Live Market Context ---'];
  if (ctx.mood)         p.push(`Market Mood: ${ctx.mood.label} (${ctx.mood.score}/100) — ${ctx.mood.description}`);
  if (ctx.breadth)      p.push(`Breadth: Adv ${ctx.breadth.advancing} / Dec ${ctx.breadth.declining} | UC: ${ctx.breadth.ucCount} | LC: ${ctx.breadth.lcCount}`);
  if (ctx.gainers?.length) p.push(`Gainers (≥10%): ${ctx.gainers.slice(0,8).map(s=>`${s.symbol}+${s.pChange.toFixed(1)}%`).join(', ')}`);
  if (ctx.losers?.length)  p.push(`Losers (≤-9.9%): ${ctx.losers.slice(0,8).map(s=>`${s.symbol}${s.pChange.toFixed(1)}%`).join(', ')}`);
  if (ctx.ucStocks?.length) p.push(`Upper Circuit (${ctx.ucStocks.length}): ${ctx.ucStocks.slice(0,6).map(s=>s.symbol).join(', ')}`);
  if (ctx.lcStocks?.length) p.push(`Lower Circuit (${ctx.lcStocks.length}): ${ctx.lcStocks.slice(0,6).map(s=>s.symbol).join(', ')}`);
  if (ctx.scanResults?.length) p.push(`Scanner hits: ${ctx.scanResults.slice(0,6).map(s=>`${s.symbol}@₹${s.ltp}`).join(', ')}`);
  if (ctx.totalScanned) p.push(`Total stocks scanned: ${ctx.totalScanned}`);
  if (ctx.commodities)  p.push(`Gold: ₹${ctx.commodities.GOLD?.ltp||'--'} | Silver: ₹${ctx.commodities.SILVER?.ltp||'--'}`);
  if (ctx.marketOpen !== undefined) p.push(`Market: ${ctx.marketOpen ? 'OPEN' : 'CLOSED'}`);
  return p.join('\n');
}

async function query(question, ctx = {}) {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key || key.length < 20 || key === 'your_anthropic_api_key_here') {
    return fallback(question, ctx);
  }
  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildContext(question, ctx) }]
    }, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      timeout: 30000
    });
    return { response: r.data.content?.[0]?.text || 'No response.', source: 'claude' };
  } catch (e) {
    console.error('[AI]', e.response?.data || e.message);
    return fallback(question, ctx);
  }
}

function fallback(q, ctx = {}) {
  const lo = q.toLowerCase();

  if (lo.includes('circuit') || lo.includes(' uc ') || lo.includes(' lc ')) {
    const uc = ctx.ucStocks || [], lc = ctx.lcStocks || [];
    return { source: 'fallback', response:
      `**Upper & Lower Circuits — Live Data**\n\n` +
      (uc.length ? `🔼 **Upper Circuit (${uc.length}):** ${uc.slice(0,15).map(s=>`${s.symbol}(+${s.pChange.toFixed(1)}%)`).join(', ')}\n` : '') +
      (lc.length ? `🔽 **Lower Circuit (${lc.length}):** ${lc.slice(0,15).map(s=>`${s.symbol}(${s.pChange.toFixed(1)}%)`).join(', ')}\n` : '') +
      `\n**Circuit Rules (NSE/BSE Cash):**\n• UC/LC triggers at ±2%, ±5%, ±10%, ±20%\n• UC: LTP ≥ High × 99.85% at circuit %\n• LC: LTP ≤ Low × 100.15% at circuit %\n\n**Strategy:**\n• Avoid buying AT UC — no supply, gap-down risk next day\n• UC 2–3 days consecutively = strong momentum, buy pullbacks\n• LC stocks = avoid until selling exhaustion visible`
    };
  }

  if (lo.includes('gainer') || lo.includes('loser') || lo.includes('top stock')) {
    const g = ctx.gainers || [], l = ctx.losers || [];
    return { source: 'fallback', response:
      `**Top Gainers & Losers — Live (from ${ctx.totalScanned||5628}+ stocks)**\n\n` +
      (g.length ? `🚀 **Gainers ≥10%:**\n${g.slice(0,10).map(s=>`${s.symbol} ₹${s.ltp} (+${s.pChange.toFixed(2)}%) Vol:${(s.volume/1e5).toFixed(1)}L`).join('\n')}\n` : 'No gainers data loaded.\n') +
      (l.length ? `\n📉 **Losers ≤-9.9%:**\n${l.slice(0,10).map(s=>`${s.symbol} ₹${s.ltp} (${s.pChange.toFixed(2)}%)`).join('\n')}\n` : '') +
      `\n**Reading signals:**\n• Gainers on heavy volume = genuine breakout\n• Gainers on thin volume = unreliable, may reverse\n• Check circuit status — avoid buying at UC price`
    };
  }

  if (lo.includes('commodity') || lo.includes('gold') || lo.includes('silver') || lo.includes('mcx')) {
    const comm = ctx.commodities || {};
    const gold = comm.GOLD, silver = comm.SILVER;
    return { source: 'fallback', response:
      `**MCX Commodities — Live Data**\n\n` +
      (gold ? `🥇 **Gold:** ₹${gold.ltp} | Change: ${gold.pChange}% | High: ₹${gold.high} | Low: ₹${gold.low}\n` : '') +
      (silver ? `🥈 **Silver:** ₹${silver.ltp} | Change: ${silver.pChange}% | High: ₹${silver.high} | Low: ₹${silver.low}\n` : '') +
      `\n**Note:** Commodity prices shown in ₹ per standard lot unit.\nMCX trading hours: 9:00 AM – 11:55 PM IST (Mon–Fri)\nTokens configurable via .env (MCX_GOLD, MCX_SILVER etc.)`
    };
  }

  if (lo.includes('mood') || lo.includes('sentiment') || lo.includes('breadth') || lo.includes('market')) {
    const m = ctx.mood;
    return { source: 'fallback', response:
      `**Market Mood & Breadth**\n\n` +
      (m ? `Current: **${m.label}** (${m.score}/100)\n${m.description}\n\nAdvancing: ${m.advancing} | Declining: ${m.declining}\nUC: ${m.ucCount} | LC: ${m.lcCount}\n` : '') +
      `\n**Mood Levels:**\n• 80+ Extreme Greed: Book profits, tighten SLs\n• 60–80 Greed: Buy breakouts, ride momentum\n• 40–60 Neutral: Stock-specific, quality only\n• 20–40 Fear: Accumulate quality, avoid weak stocks\n• <20 Extreme Fear: Watch for reversal setup`
    };
  }

  if (lo.includes('gift nifty') || lo.includes('giftnifty')) {
    return { source: 'fallback', response:
      `**Gift Nifty** is the SGX Nifty futures traded on GIFT City (NSE IX), giving advance indication of Nifty 50 opening.\n\n**How to use:**\n• Gift Nifty significantly above Nifty close → gap-up opening expected\n• Gift Nifty below Nifty close → gap-down opening\n• ±0.5% from previous close = normal; >1% = significant move\n\n**Data:** Updated every 10s from investing.com (24×7)`
    };
  }

  if (lo.includes('breakout')) {
    return { source: 'fallback', response:
      `**Breakout Analysis — Cash Segment**\n\n**Valid breakout requires:**\n✅ Close above 20-day high with conviction\n✅ Volume ≥ 1.5× 20-day average\n✅ RSI 52–78 (momentum without overextension)\n✅ Price above 20 EMA and 50 SMA\n✅ 50 SMA trending up (rising)\n✅ Within 3% of 52W high (not overextended)\n✅ Upper wick ≤ 65% of candle range\n\n**Entry:** Breakout candle close\n**SL:** Entry − 1.5 × ATR14\n**T1:** 1:2 R:R | **T2:** 1:3 R:R\n\n**False breakout signs:**\n• High volume on day, low volume next day\n• Price closes back below breakout level\n• RSI > 80 at breakout (overextended)\n• No follow-through in 2–3 sessions`
    };
  }

  if (lo.includes('ipo')) {
    return { source: 'fallback', response:
      `**IPO Base Breakout Scanner**\n\n**IPO Base Criteria:**\n• Listed within last 1 year on NSE/BSE\n• Consolidation after listing (base range < 28%)\n• Volume drying up during base = constructive\n• Breakout above base high on volume\n\n**Entry:** Buy breakout above base high\n**SL:** Below base low or listing day low\n**Target:** 1.5× to 3× base range projected above\n\n**IPO DSS (Demand-Supply Setup):**\n• Stock below 88% of listing high\n• Volume pickup = demand returning\n• Watch for reversal candle patterns`
    };
  }

  if (lo.includes('scanner') || lo.includes('bull snort') || lo.includes('stars') || lo.includes('universe')) {
    return { source: 'fallback', response:
      `**Scanner Reference Guide**\n\n🐂 **Bull Snort:** Green candle + vol 200%+ above 20d/50d avg + upper wick ≤40% + above SMA200\n\n🌐 **My Universe:** Liq ≥₹10Cr + above EMA50 & EMA200 + ATR% > 3%\n\n⭐ **STaRS:** Prev candle red → today closes above prev high + %chg < 7% + turnover ok\n\n🏛 **Legacy:** Within 25% of 52W high + above EMA50 & EMA200 + ₹500Cr+ turnover\n\n📈 **Biggest 5-Day:** 5-day gain ≥8% from 5d low + above SMA200 + SMA50>SMA200\n\n🎯 **Near 52W High:** Within 5% of 52W high + EMA20>EMA50 + above EMA21\n\n📊 **Short-Term BO:** Close above 6-month high + vol>5d avg\n\n📅 **Weekly BO:** Weekly close above 6-month weekly high + RSI>50\n\n🔴 **Upper Circuit:** Live detection from Yahoo quotes (±2/5/10/20% at circuit price)\n\n⚡ **Intra:** %chg > 3% + volume > 3L shares`
    };
  }

  // Default help
  return { source: 'fallback', response:
    `**Scanner AI — Indian Stock Market (Cash Segment Only)**\n\nI analyse NSE and BSE cash equity stocks exclusively. No F&O.\n\n📊 **Live Data (5,628+ stocks — Yahoo Finance):**\n• LTP, High, Low, Volume, % Change every 1s\n• Gainers ≥10%, Losers ≤-9.9%\n• UC (${ctx.ucStocks?.length||0}) and LC (${ctx.lcStocks?.length||0}) circuits\n• Gift Nifty: 24×7 every 10s (investing.com)\n• MCX Commodities: Gold, Silver (Groww API)\n\n📈 **13 Scanners:** Breakout, IPO Base, IPO DSS, 5-Day Gainer, Bull Snort, My Universe, 52W High, Short-Term BO, STaRS, Weekly BO, Legacy, Upper Circuit, Intraday\n\n💡 **Quick commands:**\n• "Top gainers today"\n• "Show upper circuits"\n• "Market mood and breadth"\n• "Analyze RELIANCE"\n• "Run breakout scan"\n• Add Anthropic API key in Settings for full AI analysis`
  };
}

module.exports = { query };
