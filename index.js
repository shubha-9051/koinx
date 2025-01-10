import 'dotenv/config'
import express from 'express';
import { MongoClient } from 'mongodb';
import cron from 'node-cron';
import fetch from 'node-fetch';

const app = express();
const client = new MongoClient(process.env.MONGODB_URI );
let db;

// Initialize database
async function initDB() {
  await client.connect();
  db = client.db('crypto');
  await db.collection('crypto_stats').createIndex({ coin: 1, timestamp: -1 });
}

// Background job to fetch crypto data
async function fetchCryptoData() {
  const coins = {
    bitcoin: 'bitcoin',
    matic: 'matic-network',
    ethereum: 'ethereum'
  };

  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(coins).join(',')}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`;
    const response = await fetch(url, {
      headers: { accept: 'application/json' }
    });
    const data = await response.json();

    const operations = Object.entries(coins).map(([coinKey, coinId]) => ({
      updateOne: {
        filter: { coin: coinKey },
        update: {
          $set: {
            coin: coinKey,
            price_usd: data[coinId].usd,
            market_cap_usd: data[coinId].usd_market_cap,
            change_24h: data[coinId].usd_24h_change,
            timestamp: new Date()
          }
        },
        upsert: true
      }
    }));

    await db.collection('crypto_stats').bulkWrite(operations);
    console.log('Crypto data updated:', new Date().toISOString());
  } catch (error) {
    console.error('Error fetching crypto data:', error);
  }
}

// API endpoint to get latest stats
app.get('/stats', async (req, res) => {
  const { coin } = req.query;
  if (!coin) {
    return res.status(400).json({ error: 'Coin parameter is required' });
  }

  try {
    const result = await db.collection('crypto_stats').findOne(
      { coin: coin.toLowerCase() },
      { sort: { timestamp: -1 } }
    );

    if (!result) {
      return res.status(404).json({ error: 'Coin not found' });
    }

    res.json({
      price: result.price_usd,
      marketCap: result.market_cap_usd,
      '24hChange': result.change_24h
    });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to get price deviation
app.get('/deviation', async (req, res) => {
  const { coin } = req.query;
  if (!coin) {
    return res.status(400).json({ error: 'Coin parameter is required' });
  }

  try {
    const prices = await db.collection('crypto_stats')
      .find({ coin: coin.toLowerCase() })
      .sort({ timestamp: -1 })
      .limit(100)
      .toArray();

    if (prices.length < 2) {
      return res.status(404).json({ error: 'Not enough data for deviation calculation' });
    }

    const avgPrice = prices.reduce((sum, record) => sum + record.price_usd, 0) / prices.length;
    const deviation = Math.sqrt(
      prices.reduce((sum, record) => sum + Math.pow(record.price_usd - avgPrice, 2), 0) / prices.length
    );

    res.json({ deviation: parseFloat(deviation.toFixed(2)) });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


async function start() {
  await initDB();
  // Initial fetch
  await fetchCryptoData();
  // Run the background job every 2 hours
  cron.schedule('0 */2 * * *', fetchCryptoData);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch(console.error);