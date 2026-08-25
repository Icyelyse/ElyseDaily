const express = require('express');
const router = express.Router();
const { db, seedDefaultCategories } = require('../db');

router.get('/trips', async (req, res) => {
  const result = await db.execute(`
    SELECT t.*,
      (SELECT COUNT(*) FROM members m WHERE m.trip_id = t.id) AS member_count,
      (SELECT COUNT(*) FROM expenses e WHERE e.trip_id = t.id) AS expense_count
    FROM trips t ORDER BY t.created_at DESC
  `);
  res.json(result.rows);
});

router.post('/trips', async (req, res) => {
  const { name, start_date, end_date, default_currency } = req.body;
  if (!name) return res.status(400).json({ error: 'name 為必填' });
  const result = await db.execute({
    sql: "INSERT INTO trips (name, base_currency, start_date, end_date, default_currency) VALUES (?, 'TWD', ?, ?, ?)",
    args: [name, start_date || null, end_date || null, default_currency || 'TWD'],
  });
  const tripId = Number(result.lastInsertRowid);
  await seedDefaultCategories(tripId);
  res.status(201).json({ id: tripId });
});

router.get('/trips/:id', async (req, res) => {
  const tripId = req.params.id;
  const trip = await db.execute({ sql: 'SELECT * FROM trips WHERE id = ?', args: [tripId] });
  if (trip.rows.length === 0) return res.status(404).json({ error: '找不到旅程' });
  const members = await db.execute({ sql: 'SELECT * FROM members WHERE trip_id = ? ORDER BY id', args: [tripId] });
  const categories = await db.execute({ sql: 'SELECT * FROM categories WHERE trip_id = ? ORDER BY id', args: [tripId] });
  res.json({ ...trip.rows[0], members: members.rows, categories: categories.rows });
});

router.put('/trips/:id', async (req, res) => {
  const { name, start_date, end_date, default_currency } = req.body;
  await db.execute({
    sql: "UPDATE trips SET name = ?, base_currency = 'TWD', start_date = ?, end_date = ?, default_currency = ? WHERE id = ?",
    args: [name, start_date || null, end_date || null, default_currency || 'TWD', req.params.id],
  });
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

module.exports = router;
