const express = require('express');
const multer = require('multer');
const router = express.Router();
const { db } = require('../db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const EXPENSE_COLUMNS = `e.id, e.trip_id, e.date, e.category_id, e.payer_member_id, e.original_amount, e.original_currency,
    e.rate_used, e.converted_amount, e.note, e.payment_method, e.created_at,
    CASE WHEN e.receipt_image IS NOT NULL THEN 1 ELSE 0 END AS has_receipt`;

async function getMembers(tripId) {
  const result = await db.execute({ sql: 'SELECT * FROM members WHERE trip_id = ?', args: [tripId] });
  return result.rows;
}

async function attachSplits(expenseRows) {
  if (expenseRows.length === 0) return [];
  const ids = expenseRows.map((e) => e.id);
  const placeholders = ids.map(() => '?').join(',');
  const splitsResult = await db.execute({
    sql: `SELECT es.*, m.name AS member_name FROM expense_splits es
          JOIN members m ON m.id = es.member_id
          WHERE es.expense_id IN (${placeholders})`,
    args: ids,
  });
  const splitsByExpense = {};
  for (const s of splitsResult.rows) {
    if (!splitsByExpense[s.expense_id]) splitsByExpense[s.expense_id] = [];
    splitsByExpense[s.expense_id].push({ member_id: s.member_id, member_name: s.member_name, share_amount: s.share_amount });
  }
  return expenseRows.map((e) => ({ ...e, splits: splitsByExpense[e.id] || [] }));
}

router.get('/trips/:tripId/expenses', async (req, res) => {
  const { tripId } = req.params;
  const result = await db.execute({
    sql: `SELECT ${EXPENSE_COLUMNS}, c.name AS category_name, m.name AS payer_name
          FROM expenses e
          LEFT JOIN categories c ON c.id = e.category_id
          LEFT JOIN members m ON m.id = e.payer_member_id
          WHERE e.trip_id = ?
          ORDER BY e.date DESC, e.id DESC`,
    args: [tripId],
  });
  const withSplits = await attachSplits(result.rows);
  res.json(withSplits);
});

// splitMode: 'equal'（全體均分，預設）｜'custom'（自訂金額）｜'none'（無需分攤，不列入分帳結算）
async function buildSplits(tripId, convertedAmount, splitMode, splitsInput) {
  if (splitMode === 'none') return [];

  if (splitMode === 'custom') {
    const arr = Array.isArray(splitsInput) ? splitsInput : [];
    if (arr.length === 0) throw new Error('自訂分攤模式下請至少勾選一位成員');
    const sum = arr.reduce((acc, s) => acc + Number(s.share_amount), 0);
    if (Math.abs(sum - convertedAmount) > 0.05) {
      throw new Error(`分攤金額總和 (${sum.toFixed(2)}) 與換算後金額 (${convertedAmount.toFixed(2)}) 不符`);
    }
    return arr.map((s) => ({ member_id: s.member_id, share_amount: Number(s.share_amount) }));
  }

  // 預設：全體成員均分
  const members = await getMembers(tripId);
  if (members.length === 0) return [];
  const share = Math.round((convertedAmount / members.length) * 100) / 100;
  const splits = members.map((m) => ({ member_id: m.id, share_amount: share }));
  // 修正四捨五入造成的誤差，全部加到最後一筆
  const diff = Math.round((convertedAmount - share * members.length) * 100) / 100;
  if (splits.length > 0) splits[splits.length - 1].share_amount = Math.round((splits[splits.length - 1].share_amount + diff) * 100) / 100;
  return splits;
}

router.post('/trips/:tripId/expenses', async (req, res) => {
  const { tripId } = req.params;
  const { date, category_id, payer_member_id, original_amount, original_currency, rate_used, converted_amount, note, payment_method, split_mode, splits } = req.body;

  if (!date || !original_amount || !original_currency || !rate_used || !converted_amount) {
    return res.status(400).json({ error: 'date、original_amount、original_currency、rate_used、converted_amount 為必填' });
  }

  try {
    const finalSplits = await buildSplits(tripId, Number(converted_amount), split_mode || 'equal', splits);

    const result = await db.execute({
      sql: `INSERT INTO expenses (trip_id, date, category_id, payer_member_id, original_amount, original_currency, rate_used, converted_amount, note, payment_method)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [tripId, date, category_id || null, payer_member_id || null, original_amount, original_currency, rate_used, converted_amount, note || null, payment_method || 'cash'],
    });
    const expenseId = Number(result.lastInsertRowid);

    for (const s of finalSplits) {
      await db.execute({
        sql: 'INSERT INTO expense_splits (expense_id, member_id, share_amount) VALUES (?, ?, ?)',
        args: [expenseId, s.member_id, s.share_amount],
      });
    }

    res.status(201).json({ id: expenseId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/expenses/:id', async (req, res) => {
  const { id } = req.params;
  const { date, category_id, payer_member_id, original_amount, original_currency, rate_used, converted_amount, note, payment_method, split_mode, splits } = req.body;

  const existing = await db.execute({ sql: 'SELECT trip_id FROM expenses WHERE id = ?', args: [id] });
  if (existing.rows.length === 0) return res.status(404).json({ error: '找不到這筆支出' });
  const tripId = existing.rows[0].trip_id;

  try {
    const finalSplits = await buildSplits(tripId, Number(converted_amount), split_mode || 'equal', splits);

    await db.execute({
      sql: `UPDATE expenses SET date = ?, category_id = ?, payer_member_id = ?, original_amount = ?, original_currency = ?,
            rate_used = ?, converted_amount = ?, note = ?, payment_method = ? WHERE id = ?`,
      args: [date, category_id || null, payer_member_id || null, original_amount, original_currency, rate_used, converted_amount, note || null, payment_method || 'cash', id],
    });

    await db.execute({ sql: 'DELETE FROM expense_splits WHERE expense_id = ?', args: [id] });
    for (const s of finalSplits) {
      await db.execute({
        sql: 'INSERT INTO expense_splits (expense_id, member_id, share_amount) VALUES (?, ?, ?)',
        args: [id, s.member_id, s.share_amount],
      });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/expenses/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM expenses WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- 收據照片（存成 DB 內的 BLOB，跟著資料庫一起持久化，雲端部署時不用額外掛檔案儲存空間）----------
router.post('/expenses/:id/receipt', upload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇圖片檔案' });
  if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: '僅支援圖片檔案' });

  const existing = await db.execute({ sql: 'SELECT id FROM expenses WHERE id = ?', args: [req.params.id] });
  if (existing.rows.length === 0) return res.status(404).json({ error: '找不到這筆支出' });

  await db.execute({
    sql: 'UPDATE expenses SET receipt_image = ?, receipt_mime = ? WHERE id = ?',
    args: [req.file.buffer, req.file.mimetype, req.params.id],
  });
  res.json({ ok: true });
});

router.get('/expenses/:id/receipt', async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT receipt_image, receipt_mime FROM expenses WHERE id = ?',
    args: [req.params.id],
  });
  const row = result.rows[0];
  if (!row || !row.receipt_image) return res.status(404).end();
  res.setHeader('Content-Type', row.receipt_mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(row.receipt_image));
});

router.delete('/expenses/:id/receipt', async (req, res) => {
  await db.execute({
    sql: 'UPDATE expenses SET receipt_image = NULL, receipt_mime = NULL WHERE id = ?',
    args: [req.params.id],
  });
  res.json({ ok: true });
});

router.get('/trips/:tripId/summary', async (req, res) => {
  const { tripId } = req.params;

  const totalResult = await db.execute({
    sql: 'SELECT COALESCE(SUM(converted_amount), 0) AS total FROM expenses WHERE trip_id = ?',
    args: [tripId],
  });

  const byCategory = await db.execute({
    sql: `SELECT COALESCE(c.name, '未分類') AS category, SUM(e.converted_amount) AS total
          FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
          WHERE e.trip_id = ? GROUP BY category ORDER BY total DESC`,
    args: [tripId],
  });

  const byDate = await db.execute({
    sql: `SELECT date, SUM(converted_amount) AS total FROM expenses WHERE trip_id = ? GROUP BY date ORDER BY date ASC`,
    args: [tripId],
  });

  const byMember = await db.execute({
    sql: `SELECT COALESCE(m.name, '未指定') AS member, SUM(e.converted_amount) AS total
          FROM expenses e LEFT JOIN members m ON m.id = e.payer_member_id
          WHERE e.trip_id = ? GROUP BY member ORDER BY total DESC`,
    args: [tripId],
  });

  res.json({
    total: totalResult.rows[0].total,
    byCategory: byCategory.rows,
    byDate: byDate.rows,
    byMember: byMember.rows,
  });
});

router.get('/trips/:tripId/settlement', async (req, res) => {
  const { tripId } = req.params;
  const members = await getMembers(tripId);

  // 只有「有分攤明細」的支出才算入分帳結算；「無需分攤」的個人支出不影響大家的收支計算
  const paidResult = await db.execute({
    sql: `SELECT payer_member_id AS member_id, SUM(converted_amount) AS paid
          FROM expenses e
          WHERE e.trip_id = ? AND e.payer_member_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM expense_splits es WHERE es.expense_id = e.id)
          GROUP BY payer_member_id`,
    args: [tripId],
  });
  const owedResult = await db.execute({
    sql: `SELECT es.member_id, SUM(es.share_amount) AS owed
          FROM expense_splits es JOIN expenses e ON e.id = es.expense_id
          WHERE e.trip_id = ? GROUP BY es.member_id`,
    args: [tripId],
  });

  const paidMap = Object.fromEntries(paidResult.rows.map((r) => [r.member_id, r.paid]));
  const owedMap = Object.fromEntries(owedResult.rows.map((r) => [r.member_id, r.owed]));

  const balances = members.map((m) => {
    const paid = paidMap[m.id] || 0;
    const owed = owedMap[m.id] || 0;
    return { member_id: m.id, name: m.name, paid, owed, net: Math.round((paid - owed) * 100) / 100 };
  });

  const creditors = balances.filter((b) => b.net > 0.01).map((b) => ({ ...b })).sort((a, b) => b.net - a.net);
  const debtors = balances.filter((b) => b.net < -0.01).map((b) => ({ ...b, net: -b.net })).sort((a, b) => b.net - a.net);
  const transactions = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].net, creditors[j].net);
    transactions.push({ from: debtors[i].name, to: creditors[j].name, amount: Math.round(amount * 100) / 100 });
    debtors[i].net = Math.round((debtors[i].net - amount) * 100) / 100;
    creditors[j].net = Math.round((creditors[j].net - amount) * 100) / 100;
    if (debtors[i].net <= 0.01) i += 1;
    if (creditors[j].net <= 0.01) j += 1;
  }

  res.json({ balances, transactions });
});

module.exports = router;
