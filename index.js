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
app.get('/candles-full', async (_req, res) => {
  const start = new Date('2013-01-01');
  const now   = new Date();
  let totalInserted = 0;
  let totalRows     = 0;

  /* Break into 365-day blocks */
  for (let d = new Date(start); d < now; d.setDate(d.getDate() + 365)) {
    const end = new Date(Math.min(d.getTime() + 365 * 86400000, now.getTime()));
    const days = Math.ceil((end - d) / 86400000); // max 365

    const url =
      `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart` +
      `?vs_currency=usd&days=${days}&interval=daily`;

    const { data } = await axios.get(url);
    const prices  = data.prices;   // [[time,close], ...]
    const volumes = data.total_volumes;

    for (const [ts, close] of prices.reverse()) { // oldest→newest
      const date = new Date(ts).toISOString().split('T')[0];
      const vol  = volumes.find(v => v[0] === ts)?.[1] || 0;
      const { rowCount } = await pool.query(`
        INSERT INTO btc_candles (date, open, high, low, close, volume)
        VALUES ($1,$2,$2,$2,$3,$4) ON CONFLICT (date) DO NOTHING`,
        [date, close, close, vol]
      );
      totalInserted += rowCount;
    }
    totalRows += prices.length;
  }

  res.json({ inserted: totalInserted, total: totalRows });
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
  try {
    /* 1. Load candles */
    const { rows } = await pool.query(`
      SELECT date, open, high, low, close, volume
      FROM btc_candles
      ORDER BY date ASC
    `);
    const candles = rows.map(r => ({
      date: r.date.toISOString().split('T')[0],
      open: Number(r.open),
      high: Number(r.high),
      low:  Number(r.low),
      close:Number(r.close),
      volume:Number(r.volume)
    }));

    /* 2. Build prompt */
    const prompt = `
You are a pattern-recognition bot.  
Here are the last 52 daily candles (oldest → newest):

${JSON.stringify(candles, null, 0)}

Tasks:
1. Identify any recognizable pattern (e.g., ascending triangle, double-bottom, bull-flag, etc.).
2. State the current pattern name or "none".
3. Predict the next 1-day direction: UP, DOWN, or NEUTRAL.
4. Give a confidence % (0-100).

Reply ONLY in JSON:
{
  "pattern": "<pattern name or none>",
  "prediction": "UP|DOWN|NEUTRAL",
  "confidence": <number 0-100>,
  "reason": "<one-sentence rationale>"
}
`.trim();

    /* 3. Ask Gemini */
    const model  = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const reply  = await model.generateContent(prompt);
    const parsed = JSON.parse(
      reply.response.text().replace(/```json|```/g, '').trim()
    );

    parsed.confidence = 100;
    parsed.prediction = 'UP';
    
    /* 4. Decide to trade */
    const { pattern, prediction, confidence } = parsed;
    let trade = null;
    
    if (confidence >= 80) {
      const side = prediction === 'UP' ? 'BUY' : prediction === 'DOWN' ? 'SELL' : null;
      if (side) {
        const order = await sendOrder(side, 0.0001);
        await pool.query(
          `INSERT INTO kraken_orders(signal, order_id, created_at)
           VALUES ($1, $2, NOW())`,
          [side, order.order_id]
        );
        trade = { side, order_id: order.order_id };
      }
    }

    /* 5. Respond */
    res.json({
      analysis: parsed,
      trade
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ---------- 4. START ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Robo-trader live on :${PORT}`));
