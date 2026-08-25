require('dotenv').config();
const express = require('express');
const path = require('path');
const { init } = require('./db');

const tripsRouter = require('./routes/trips');
const expensesRouter = require('./routes/expenses');
const ratesRouter = require('./routes/rates');
const exportRouter = require('./routes/export');

const app = express();
app.use(express.json());

app.get('/friend/:tripId(\\d+)', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'friend.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/rates', ratesRouter);
app.use('/api', tripsRouter);
app.use('/api', expensesRouter);
app.use('/api', exportRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '伺服器發生錯誤', detail: err.message });
});

const PORT = process.env.PORT || 3000;

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`旅遊記帳系統啟動於 http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('資料庫初始化失敗', err);
    process.exit(1);
  });
