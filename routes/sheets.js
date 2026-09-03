const express = require('express');
const router = express.Router();
const { db } = require('../db');

const PAYMENT_METHOD_LABELS = { cash: '現金', credit_card: '信用卡' };

// 跟 public/app.js 的 describeSplitMode() 邏輯一致；DB 本身沒有另外存 split_mode，只能從分攤明細反推
function describeSplitMode(splits, convertedAmount, memberCount) {
  if (splits.length === 0) return '無需分攤';
  const count = memberCount || 1;
  const equalShare = Math.round((convertedAmount / count) * 100) / 100;
  const isEqual = splits.length === count && splits.every((s) => Math.abs(s.share_amount - equalShare) < 0.02);
  return isEqual ? '全體均分' : '自訂分攤';
}

// 把旅程的支出（可選：依付款人／日期區間篩選）同步到使用者自己的 Google 試算表。
// 串接方式是 Google Apps Script 部署成的網頁應用程式，伺服器對伺服器 POST，不經過使用者瀏覽器，
// 這樣網址跟密鑰只存在 Render 環境變數裡，不會流到任何前端頁面。
router.post('/trips/:id/sync-sheets', async (req, res) => {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const secret = process.env.GOOGLE_SHEETS_SECRET;
  if (!webhookUrl) {
    return res.status(400).json({ error: '尚未設定 Google 試算表同步網址（GOOGLE_SHEETS_WEBHOOK_URL），請先完成 Apps Script 部署與環境變數設定' });
  }

  const tripId = req.params.id;
  const { payer_member_id, from, to } = req.body || {};

  const tripResult = await db.execute({ sql: 'SELECT name FROM trips WHERE id = ?', args: [tripId] });
  if (tripResult.rows.length === 0) return res.status(404).json({ error: '找不到旅程' });
  const tripName = tripResult.rows[0].name;

  const memberCountResult = await db.execute({ sql: 'SELECT COUNT(*) AS count FROM members WHERE trip_id = ?', args: [tripId] });
  const memberCount = memberCountResult.rows[0].count;

  const conditions = ['e.trip_id = ?'];
  const args = [tripId];
  if (payer_member_id) { conditions.push('e.payer_member_id = ?'); args.push(payer_member_id); }
  if (from) { conditions.push('e.date >= ?'); args.push(from); }
  if (to) { conditions.push('e.date <= ?'); args.push(to); }

  const expensesResult = await db.execute({
    sql: `SELECT e.id, e.date, e.original_amount, e.original_currency, e.converted_amount, e.note, e.payment_method,
                 CASE WHEN e.receipt_image IS NOT NULL THEN 1 ELSE 0 END AS has_receipt,
                 c.name AS category_name, m.name AS payer_name
          FROM expenses e
          LEFT JOIN categories c ON c.id = e.category_id
          LEFT JOIN members m ON m.id = e.payer_member_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY e.date ASC, e.id ASC`,
    args,
  });

  const ids = expensesResult.rows.map((e) => e.id);
  const splitsByExpense = {};
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const splitsResult = await db.execute({
      sql: `SELECT es.expense_id, m.name AS member_name, es.share_amount
            FROM expense_splits es JOIN members m ON m.id = es.member_id
            WHERE es.expense_id IN (${placeholders})`,
      args: ids,
    });
    for (const s of splitsResult.rows) {
      if (!splitsByExpense[s.expense_id]) splitsByExpense[s.expense_id] = [];
      splitsByExpense[s.expense_id].push(s);
    }
  }

  const headers = ['日期', '分類', '付款人', '付款方式', '付款金額', '付款幣別', '換算金額(TWD)', '備註', '分攤方式', '分攤明細', '有收據'];
  const rows = expensesResult.rows.map((e) => {
    const splits = splitsByExpense[e.id] || [];
    return [
      e.date,
      e.category_name || '未分類',
      e.payer_name || '未指定',
      PAYMENT_METHOD_LABELS[e.payment_method] || e.payment_method || '',
      e.original_amount,
      e.original_currency,
      e.converted_amount,
      e.note || '',
      describeSplitMode(splits, e.converted_amount, memberCount),
      splits.map((s) => `${s.member_name}:${s.share_amount}`).join(' / '),
      e.has_receipt ? '是' : '否',
    ];
  });

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, sheetName: tripName, headers, rows }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      return res.status(502).json({ error: result.error || '同步失敗，請確認 Apps Script 網址與部署設定是否正確' });
    }
    res.json({ ok: true, syncedRows: rows.length });
  } catch (err) {
    res.status(502).json({ error: `無法連線到 Google 試算表：${err.message}` });
  }
});

module.exports = router;
