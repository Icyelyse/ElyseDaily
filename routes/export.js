const express = require('express');
const router = express.Router();
const { db } = require('../db');

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

router.get('/trips/:tripId/export.csv', async (req, res) => {
  const { tripId } = req.params;

  const tripResult = await db.execute({ sql: 'SELECT * FROM trips WHERE id = ?', args: [tripId] });
  if (tripResult.rows.length === 0) return res.status(404).json({ error: '找不到旅程' });
  const trip = tripResult.rows[0];

  const expensesResult = await db.execute({
    sql: `SELECT e.id, e.date, e.original_amount, e.original_currency, e.rate_used, e.converted_amount, e.note, e.payment_method,
                 CASE WHEN e.receipt_image IS NOT NULL THEN 1 ELSE 0 END AS has_receipt,
                 c.name AS category_name, m.name AS payer_name
          FROM expenses e
          LEFT JOIN categories c ON c.id = e.category_id
          LEFT JOIN members m ON m.id = e.payer_member_id
          WHERE e.trip_id = ? ORDER BY e.date ASC, e.id ASC`,
    args: [tripId],
  });

  const ids = expensesResult.rows.map((e) => e.id);
  let splitsByExpense = {};
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
      splitsByExpense[s.expense_id].push(`${s.member_name}:${s.share_amount}`);
    }
  }

  const PAYMENT_METHOD_LABELS = { cash: '現金', credit_card: '信用卡' };
  const header = ['日期', '分類', '付款人', '付款方式', `原幣金額`, '原幣別', '匯率', `換算金額(${trip.base_currency})`, '備註', '分攤明細', '有收據'];
  const lines = [header.map(csvEscape).join(',')];

  for (const e of expensesResult.rows) {
    lines.push([
      e.date,
      e.category_name || '未分類',
      e.payer_name || '未指定',
      PAYMENT_METHOD_LABELS[e.payment_method] || e.payment_method || '',
      e.original_amount,
      e.original_currency,
      e.rate_used,
      e.converted_amount,
      e.note || '',
      (splitsByExpense[e.id] || []).join(' / '),
      e.has_receipt ? '是' : '否',
    ].map(csvEscape).join(','));
  }

  const BOM = String.fromCharCode(0xfeff);
  const csv = BOM + lines.join('\n') + '\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="trip_${tripId}_expenses.csv"`);
  res.send(csv);
});

module.exports = router;
