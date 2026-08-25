const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const url = process.env.DATABASE_URL || `file:${path.join(dataDir, 'travel.db')}`;
const authToken = process.env.DATABASE_AUTH_TOKEN;

const db = createClient(authToken ? { url, authToken } : { url });

const DEFAULT_CATEGORIES = ['交通', '住宿', '餐飲', '購物', '票券/娛樂', '其他'];

async function init() {
  await db.execute('PRAGMA foreign_keys = ON');

  await db.execute(`CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_currency TEXT NOT NULL DEFAULT 'TWD',
    start_date TEXT,
    end_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    name TEXT NOT NULL
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    name TEXT NOT NULL
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    payer_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    original_amount REAL NOT NULL,
    original_currency TEXT NOT NULL,
    rate_used REAL NOT NULL,
    converted_amount REAL NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS expense_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    share_amount REAL NOT NULL
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS rate_cache (
    date TEXT NOT NULL,
    base_currency TEXT NOT NULL,
    target_currency TEXT NOT NULL,
    rate REAL NOT NULL,
    PRIMARY KEY (date, base_currency, target_currency)
  )`);

  // 針對已存在的資料庫檔案做欄位遷移（新裝的話這些欄位在上面 CREATE TABLE 就已包含對應預設值）
  await ensureColumn('expenses', 'payment_method', "TEXT DEFAULT 'cash'");
  await ensureColumn('expenses', 'receipt_mime', 'TEXT');
  await ensureColumn('expenses', 'receipt_image', 'BLOB');
  await ensureColumn('trips', 'default_currency', 'TEXT');
  // 舊資料補上預設幣別（沿用基準貨幣），之後可在「管理」分頁另外設定
  await db.execute('UPDATE trips SET default_currency = base_currency WHERE default_currency IS NULL');
  // 系統改為一律換算成新台幣，基準貨幣不再開放自訂
  await db.execute("UPDATE trips SET base_currency = 'TWD' WHERE base_currency <> 'TWD'");
}

async function ensureColumn(table, column, definition) {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some((row) => row.name === column);
  if (!exists) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function seedDefaultCategories(tripId) {
  for (const name of DEFAULT_CATEGORIES) {
    await db.execute({
      sql: 'INSERT INTO categories (trip_id, name) VALUES (?, ?)',
      args: [tripId, name],
    });
  }
}

module.exports = { db, init, seedDefaultCategories };
