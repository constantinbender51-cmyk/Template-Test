// index.js  –  phone-only BTC robo-trader template
// 1. Railway → Variables → add:
//    GEMINI_API_KEY        = <google-studio key>
//    KRAKEN_FUTURES_KEY    = <kraken key>
//    KRAKEN_FUTURES_SECRET = <kraken secret>
// 2. Push this file → Railway auto-deploys.

import express from 'express';
import axios   from 'axios';
import crypto  from 'crypto';
import pg      from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app  = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ---------- 1. DB AUTO-SETUP ---------- */
await pool.query(`
  CREATE TABLE IF NOT EXISTS btc_candles (
    id SERIAL PRIMARY KEY,
    date DATE UNIQUE NOT NULL,
    open NUMERIC(12,2),
    high NUMERIC(12,2),
    low  NUMERIC(12,2),
    close NUMERIC(12,2),
    volume NUMERIC(20,2)
  );
  CREATE TABLE IF NOT EXISTS kraken_orders (
    id SERIAL PRIMARY KEY,
    signal TEXT,
    order_id TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );
`);

/* ---------- 2. CANDLES ---------- */
app.get('/candles', async (_req, res) => {
  const { data } = await axios.get(
    'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=52&interval=daily'
  );
  const prices  = data.prices;
  const volumes = data.total_volumes;

  let inserted = 0;
  for (let i = 0; i < prices.length; i++) {
    const date  = new Date(prices[i][0]).toISOString().split('T')[0];
    const close = prices[i][1];
    const volume = volumes[i][1];
    const { rowCount } = await pool.query(`
      INSERT INTO btc_candles (date, open, high, low, close, volume)
      VALUES ($1,$2,$2,$2,$3,$4) ON CONFLICT (date) DO NOTHING`,
      [date, close, close, volume]
    );
    inserted += rowCount;
  }
  res.json({ inserted });
});

/* ---------- 3. SIGNAL + TRADE ---------- */
/* Kraken client */
const BASE_URL = 'https://futures.kraken.com';
const KEY      = process.env.KRAKEN_FUTURES_KEY;
const SECRET   = process.env.KRAKEN_FUTURES_SECRET;
let nonceCounter = 0;

const nonce = () => Date.now() + ('0000' + ++nonceCounter).slice(-5);
function sign(path, n, data) {
  const msg = data + n + path.replace('/derivatives', '');
  const hash = crypto.createHash('sha256').update(msg).digest();
  const sig  = crypto.createHmac('sha512', Buffer.from(SECRET, 'base64'))
                     .update(hash).digest('base64');
  return sig;
}

async function sendOrder(side, size = 0.0001) {
  const path = '/derivatives/api/v3/sendorder';
  const n    = nonce();
  const data = `orderType=mkt&symbol=PF_XBTUSD&side=${side}&size=${size}&limitPrice=`;
  const headers = {
    'Accept':'application/json',
    'APIKey':KEY,
    'Nonce':n,
    'Authent':sign(path,n,data),
    'Content-Type':'application/x-www-form-urlencoded',
    'Content-Length':data.length.toString()
  };
  const { data:resp } = await axios.post(BASE_URL + path, data, { headers });
  if (resp.result !== 'success') throw resp;
  return resp.sendStatus;
}

/* Endpoint */
app.get('/signals', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT close FROM btc_candles ORDER BY date ASC'
  );
  const closes = rows.map(r => Number(r.close));

  const prompt = `Last 52 daily BTC closes:\n${closes.join(',')}\nReply exactly BUY, SELL, or HOLD.`;
  const model  = genAI.getGenerativeModel({ model:'gemini-1.5-flash' });
  const signal = (await model.generateContent(prompt)).response.text().trim().toUpperCase();

  let order = null;
  if (['BUY','SELL'].includes(signal)) {
    order = await sendOrder(signal);
    await pool.query(
      'INSERT INTO kraken_orders(signal,order_id) VALUES ($1,$2)',
      [signal, order.order_id]
    );
  }
  res.json({ signal, order });
});

/* ---------- 4. START ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Robo-trader live on :${PORT}`));
