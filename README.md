# Scanner AI - Indian Stock Market Live Scanner
# 100% Free Railway Deployment | No Login Required

## Features
- ⚡ Live Breakout Scanner (NSE + BSE)
- 🚀 IPO Base Breakout Scanner (including micro-candle new listings)
- 📊 Market Mood Index (Fear & Greed for India)
- 🤖 AI Analysis with Entry / Stop Loss / Targets
- 📈 Real-time Indices (Nifty 50, Sensex, India VIX)
- 🔥 Top Gainers & Losers
- 🔔 Price Alerts
- 📰 Market News
- ⏱ Configurable auto-scan interval (10s to 3600s)

## Free Deployment on Railway (No Credit Card Needed)

### Step 1: Create Railway Account
1. Go to **https://railway.app**
2. Click "Login" → "Login with GitHub"
3. Authorize Railway (free, no card needed)

### Step 2: Create GitHub Repo
1. Go to **https://github.com/new**
2. Name it `scanner-ai`
3. Make it Public
4. Click "Create repository"

### Step 3: Upload This Project
Option A - Using GitHub Web UI:
1. In your new repo, click "uploading an existing file"
2. Drag all files from this zip folder
3. Click "Commit changes"

Option B - Using Git (if you have it):
```bash
cd scanner-ai
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/scanner-ai.git
git push -u origin main
```

### Step 4: Deploy to Railway
1. Go to **https://railway.app/new**
2. Click "Deploy from GitHub repo"
3. Select your `scanner-ai` repository
4. Railway auto-detects Node.js and deploys!

### Step 5: Set Environment Variables (Optional)
In Railway dashboard → your project → Variables:
```
ANTHROPIC_API_KEY = sk-ant-your-key-here   (for AI features - free at console.anthropic.com)
SCANNER_INTERVAL = 30                       (scan every 30 seconds)
```

### Step 6: Get Your URL
Railway gives you a free URL like: `https://scanner-ai-production.up.railway.app`

That's it! Your scanner runs 24/7 for FREE! 🎉

## Railway Free Tier
- ✅ $5 free credit per month (more than enough)
- ✅ No credit card required
- ✅ 24/7 uptime
- ✅ Custom domain support
- ✅ Auto-restarts on crash

## Getting Free AI Features
1. Go to https://console.anthropic.com
2. Sign up (free)
3. Create API key
4. Add to Railway environment variables as `ANTHROPIC_API_KEY`

## Local Development
```bash
npm install
cp .env.example .env
# Edit .env with your API key
npm start
# Open http://localhost:3000
```

## Data Sources (All Free, No API Keys)
- NSE India public APIs (https://www.nseindia.com)
- Yahoo Finance (free, no key needed)
- Fallback mock data if APIs are unavailable

## Scanner Details
- **Breakout Score**: 0-100 based on 8+ technical indicators
- **Strong**: Score ≥ 80 | **Moderate**: 60-79 | **Weak**: 40-59
- **Entry**: Current breakout price
- **Stop Loss**: 1.5x ATR below entry
- **Target 1**: 1:2 Risk/Reward
- **Target 2**: 1:3 Risk/Reward  
- **Target 3**: 1:5 Risk/Reward

## IPO Scanner
Scans IPOs for:
- IPO Base Pattern (tight consolidation after listing)
- Base Breakout (price breaking above base high)
- Volume Confirmation
- Issue Price Support
- Works for fresh IPOs with as few as 5 candles!
