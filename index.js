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

const prompt = `
You are a pattern analyst.  
Below are the last N daily candles (oldest → newest) from Binance:

${candles.map(c => `Date:${c.date} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`).join('\n')}

Tasks:
1. Identify the dominant price pattern (e.g., ascending triangle, double-bottom, bull-flag, etc.).
2. Predict the next 1-day direction: UP / DOWN / NEUTRAL.
3. Provide confidence % (0-100).
4. One-sentence rationale.

Return strict JSON:
{
  "pattern": "<name>",
  "prediction": "UP|DOWN|NEUTRAL",
  "confidence": 0-100,
  "rationale": "<reason>"
}
`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  const symbol = 'BTCUSDT';
  const interval = '1d';
  const start = new Date('2013-01-01').getTime();  // Binance starts 2017-08-17
  const end   = new Date().getTime();

  const limit = 1000;                      // max rows per call
  let totalInserted = 0;
  let totalRows     = 0;

  /* walk forward 1000 days at a time */
  for (let t = start; t < end; t += limit * 86400000) {
    const url =
      `https://api.binance.com/api/v3/klines` +
      `?symbol=${symbol}&interval=${interval}` +
      `&startTime=${t}&endTime=${Math.min(t + limit * 86400000, end)}&limit=${limit}`;

    const { data } = await axios.get(url);

    for (const k of data) {
      const date  = new Date(k[0]).toISOString().split('T')[0]; // k[0] = open time
      const open  = Number(k[1]);
      const high  = Number(k[2]);
      const low   = Number(k[3]);
      const close = Number(k[4]);
      const vol   = Number(k[5]);

      const { rowCount } = await pool.query(`
        INSERT INTO btc_candles (date, open, high, low, close, volume)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (date) DO NOTHING`,
        [date, open, high, low, close, vol]
      );
      totalInserted += rowCount;
    }
    totalRows += data.length;
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
    /* 1. Pull all Binance daily candles */
    const { rows } = await pool.query(`
      SELECT date, open, high, low, close, volume
      FROM btc_candles
      ORDER BY date ASC
    `);
    const candles = rows.map(r => ({
      date: r.date.toISOString().split('T')[0],
      open:  Number(r.open),
      high:  Number(r.high),
      low:   Number(r.low),
      close: Number(r.close),
      volume:Number(r.volume)
    }));

    /* 2. Ask Gemini */
    const model  = genAI.getGenerativeModel({ model:'gemini-1.5-flash' });
    const reply  = await model.generateContent(prompt.replace('${candles.length}', candles.length));
    const parsed = JSON.parse(reply.response.text().replace(/```json|```/g,'').trim());

    /* 3. Trade only if confident */
    let trade = null;
    if (parsed.confidence >= 80) {
      const side = parsed.prediction === 'UP' ? 'BUY' : 'DOWN' ? 'SELL' : null;
      if (side) {
        const order = await sendOrder(side, 0.0001);
        await pool.query(
          `INSERT INTO kraken_orders(signal, order_id, created_at) VALUES ($1,$2,NOW())`,
          [side, order.order_id]
        );
        trade = { side, order_id: order.order_id };
      }
    }

    res.json({ analysis: parsed, trade });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


/* ---------- 4. START ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Robo-trader live on :${PORT}`));
