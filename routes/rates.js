const express = require('express');
const router = express.Router();
const { db } = require('../db');

// 免費、免申請 key 的公開匯率 API（含 TWD）
const RATE_API_BASE = 'https://open.er-api.com/v6/latest';

async function fetchLiveRates(base) {
  const resp = await fetch(`${RATE_API_BASE}/${encodeURIComponent(base)}`);
  if (!resp.ok) throw new Error(`匯率 API 回應錯誤: ${resp.status}`);
  const data = await resp.json();
  if (data.result !== 'success' || !data.rates) throw new Error('匯率 API 回傳格式異常');
  return data.rates;
}

router.get('/', async (req, res) => {
  const base = String(req.query.base || '').toUpperCase();
  const target = String(req.query.target || '').toUpperCase();
  if (!base || !target) return res.status(400).json({ error: 'base 與 target 為必填參數' });

  if (base === target) return res.json({ rate: 1, date: new Date().toISOString().slice(0, 10), source: 'identity' });

  const today = new Date().toISOString().slice(0, 10);

  try {
    const cached = await db.execute({
      sql: 'SELECT rate FROM rate_cache WHERE date = ? AND base_currency = ? AND target_currency = ?',
      args: [today, base, target],
    });
    if (cached.rows.length > 0) {
      return res.json({ rate: cached.rows[0].rate, date: today, source: 'cache' });
    }

    const rates = await fetchLiveRates(base);
    const rate = rates[target];
    if (rate === undefined) {
      return res.status(404).json({ error: `不支援的幣別: ${target}` });
    }

    await db.execute({
      sql: 'INSERT OR REPLACE INTO rate_cache (date, base_currency, target_currency, rate) VALUES (?, ?, ?, ?)',
      args: [today, base, target, rate],
    });

    res.json({ rate, date: today, source: 'live' });
  } catch (err) {
    res.status(502).json({ error: '匯率服務暫時無法使用，請手動輸入匯率', detail: err.message });
  }
});

module.exports = router;
