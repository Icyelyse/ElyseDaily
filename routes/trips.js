const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { db, seedDefaultCategories } = require('../db');

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(salt + pin).digest('hex');
}

function makePinFields(pin) {
  if (!pin) return { pin_hash: null, pin_salt: null };
  const salt = crypto.randomBytes(8).toString('hex');
  return { pin_hash: hashPin(pin, salt), pin_salt: salt };
}

// 回傳給前端的旅程物件絕不附上 pin_hash/pin_salt，只給一個 has_pin 布林值
function sanitizeTrip(row) {
  const { pin_hash, pin_salt, ...rest } = row;
  return { ...rest, has_pin: !!pin_hash };
}

router.get('/trips', async (req, res) => {
  const result = await db.execute(`
    SELECT t.*,
      (SELECT COUNT(*) FROM members m WHERE m.trip_id = t.id) AS member_count,
      (SELECT COUNT(*) FROM expenses e WHERE e.trip_id = t.id) AS expense_count
    FROM trips t ORDER BY t.created_at DESC
  `);
  res.json(result.rows.map(sanitizeTrip));
});

router.post('/trips', async (req, res) => {
  const { name, start_date, end_date, pin } = req.body;
  if (!name) return res.status(400).json({ error: 'name 為必填' });
  if (!pin) return res.status(400).json({ error: '請設定簡易密碼' });

  const maxResult = await db.execute('SELECT COALESCE(MAX(family_number), 0) AS max FROM trips');
  const familyNumber = maxResult.rows[0].max + 1;
  const { pin_hash, pin_salt } = makePinFields(pin);

  const result = await db.execute({
    sql: `INSERT INTO trips (name, base_currency, start_date, end_date, default_currency, family_number, pin_hash, pin_salt)
          VALUES (?, 'TWD', ?, ?, 'TWD', ?, ?, ?)`,
    args: [name, start_date || null, end_date || null, familyNumber, pin_hash, pin_salt],
  });
  const tripId = Number(result.lastInsertRowid);
  await seedDefaultCategories(tripId);
  await db.execute({ sql: 'INSERT INTO trip_currencies (trip_id, currency) VALUES (?, ?)', args: [tripId, 'TWD'] });
  res.status(201).json({ id: tripId, family_number: familyNumber });
});

async function loadFullTrip(whereClause, arg) {
  const trip = await db.execute({ sql: `SELECT * FROM trips WHERE ${whereClause}`, args: [arg] });
  if (trip.rows.length === 0) return null;
  const tripId = trip.rows[0].id;
  const members = await db.execute({ sql: 'SELECT * FROM members WHERE trip_id = ? ORDER BY id', args: [tripId] });
  const categories = await db.execute({ sql: 'SELECT * FROM categories WHERE trip_id = ? ORDER BY id', args: [tripId] });
  const currencies = await db.execute({ sql: 'SELECT * FROM trip_currencies WHERE trip_id = ? ORDER BY id', args: [tripId] });
  return { ...sanitizeTrip(trip.rows[0]), members: members.rows, categories: categories.rows, currencies: currencies.rows };
}

// 注意：這支要放在 /trips/:id 前面註冊，不然 Express 會先把 "by-family" 當成 :id 吃掉
router.get('/trips/by-family/:familyNumber', async (req, res) => {
  const trip = await loadFullTrip('family_number = ?', req.params.familyNumber);
  if (!trip) return res.status(404).json({ error: '找不到旅程' });
  res.json(trip);
});

router.get('/trips/:id', async (req, res) => {
  const trip = await loadFullTrip('id = ?', req.params.id);
  if (!trip) return res.status(404).json({ error: '找不到旅程' });
  res.json(trip);
});

router.post('/trips/:id/verify-pin', async (req, res) => {
  const { pin } = req.body;
  const result = await db.execute({ sql: 'SELECT pin_hash, pin_salt FROM trips WHERE id = ?', args: [req.params.id] });
  if (result.rows.length === 0) return res.status(404).json({ error: '找不到旅程' });
  const { pin_hash, pin_salt } = result.rows[0];
  if (!pin_hash) return res.json({ ok: true });
  const ok = !!pin && hashPin(pin, pin_salt) === pin_hash;
  res.json({ ok });
});

router.put('/trips/:id', async (req, res) => {
  const { name, start_date, end_date, pin } = req.body;

  if (pin) {
    const { pin_hash, pin_salt } = makePinFields(pin);
    await db.execute({
      sql: "UPDATE trips SET name = ?, base_currency = 'TWD', start_date = ?, end_date = ?, pin_hash = ?, pin_salt = ? WHERE id = ?",
      args: [name, start_date || null, end_date || null, pin_hash, pin_salt, req.params.id],
    });
  } else {
    await db.execute({
      sql: "UPDATE trips SET name = ?, base_currency = 'TWD', start_date = ?, end_date = ? WHERE id = ?",
      args: [name, start_date || null, end_date || null, req.params.id],
    });
  }
  res.json({ ok: true });
});

router.delete('/trips/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM trips WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// Members
router.post('/trips/:id/members', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name 為必填' });
  const result = await db.execute({
    sql: 'INSERT INTO members (trip_id, name) VALUES (?, ?)',
    args: [req.params.id, name],
  });
  res.status(201).json({ id: Number(result.lastInsertRowid), name });
});

router.put('/members/:id', async (req, res) => {
  const { name } = req.body;
  await db.execute({ sql: 'UPDATE members SET name = ? WHERE id = ?', args: [name, req.params.id] });
  res.json({ ok: true });
});

router.delete('/members/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM members WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// Categories
router.post('/trips/:id/categories', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name 為必填' });
  const result = await db.execute({
    sql: 'INSERT INTO categories (trip_id, name) VALUES (?, ?)',
    args: [req.params.id, name],
  });
  res.status(201).json({ id: Number(result.lastInsertRowid), name });
});

router.put('/categories/:id', async (req, res) => {
  const { name } = req.body;
  await db.execute({ sql: 'UPDATE categories SET name = ? WHERE id = ?', args: [name, req.params.id] });
  res.json({ ok: true });
});

router.delete('/categories/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM categories WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// Currencies（記帳分頁下拉選單只會列出這裡設定的幣別；TWD 一律存在且不可移除）
router.post('/trips/:id/currencies', async (req, res) => {
  const { currency } = req.body;
  if (!currency) return res.status(400).json({ error: 'currency 為必填' });
  const existing = await db.execute({
    sql: 'SELECT id FROM trip_currencies WHERE trip_id = ? AND currency = ?',
    args: [req.params.id, currency],
  });
  if (existing.rows.length > 0) return res.status(400).json({ error: '這個幣別已經在清單裡了' });
  const result = await db.execute({
    sql: 'INSERT INTO trip_currencies (trip_id, currency) VALUES (?, ?)',
    args: [req.params.id, currency],
  });
  res.status(201).json({ id: Number(result.lastInsertRowid), currency });
});

router.delete('/currencies/:id', async (req, res) => {
  const existing = await db.execute({ sql: 'SELECT currency FROM trip_currencies WHERE id = ?', args: [req.params.id] });
  if (existing.rows.length === 0) return res.status(404).json({ error: '找不到這個幣別' });
  if (existing.rows[0].currency === 'TWD') return res.status(400).json({ error: 'TWD 是必要的幣別，不能移除' });
  await db.execute({ sql: 'DELETE FROM trip_currencies WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

module.exports = router;
