const CURRENCIES = ['TWD', 'USD', 'JPY', 'EUR', 'GBP', 'KRW', 'HKD', 'CNY', 'THB', 'SGD', 'MYR', 'AUD', 'CAD', 'VND', 'PHP', 'IDR', 'NZD', 'CHF', 'MOP', 'INR'];

const state = {
  trips: [],
  currentTrip: null,
  expenses: [],
  charts: {},
  pendingReceiptFile: null,
  pendingRemoveReceipt: false,
};

const PAYMENT_METHOD_LABELS = { cash: '現金', credit_card: '信用卡' };
const OFFLINE_QUEUE_KEY = 'offlineExpenseQueue';

// 是否為完整管理端頁面（index.html 有「管理」分頁；親友頁 family.html 沒有這些 DOM，靠這個旗標跳過管理相關邏輯）
const IS_ADMIN_UI = !!document.getElementById('tab-admin');
const FAMILY_MATCH = window.location.pathname.match(/^\/family\/(\d+)/);
const GUEST_FAMILY_NUMBER = FAMILY_MATCH ? FAMILY_MATCH[1] : null;

function payerStorageKey(tripId) {
  return `lastPayer_${tripId}`;
}

function currencyStorageKey(tripId) {
  return `lastCurrency_${tripId}`;
}

function unlockedStorageKey(tripId) {
  return `unlockedAdmin_${tripId}`;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `請求失敗 (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- 離線支援：App Shell 快取由 sw.js 處理；這裡處理離線時新增的支出排隊與自動同步 ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

function getOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY)) || [];
  } catch {
    return [];
  }
}

function setOfflineQueue(queue) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

function queueOfflineExpense(tripId, body) {
  const queue = getOfflineQueue();
  queue.push({ tripId, body, createdAt: Date.now() });
  setOfflineQueue(queue);
  updateOfflineBadge();
}

async function flushOfflineQueue() {
  const queue = getOfflineQueue();
  if (queue.length === 0) { updateOfflineBadge(); return; }
  const remaining = [];
  let syncedAny = false;
  for (const item of queue) {
    try {
      await api(`/api/trips/${item.tripId}/expenses`, { method: 'POST', body: JSON.stringify(item.body) });
      syncedAny = true;
    } catch (err) {
      remaining.push(item);
    }
  }
  setOfflineQueue(remaining);
  updateOfflineBadge();
  if (syncedAny && state.currentTrip) await loadExpenses();
}

function updateOfflineBadge() {
  const badge = document.getElementById('offlineBadge');
  const count = getOfflineQueue().length;
  document.getElementById('offlineCount').textContent = count;
  badge.classList.toggle('hidden', count === 0 && navigator.onLine);
}

window.addEventListener('online', flushOfflineQueue);
window.addEventListener('offline', updateOfflineBadge);

function isNetworkError(err) {
  return err instanceof TypeError || !navigator.onLine;
}

function fillSelectOptions(selectEl, values, selected) {
  selectEl.innerHTML = values.map((v) => `<option value="${v}">${v}</option>`).join('');
  if (selected) selectEl.value = selected;
}

function populateCurrencySelect(selectEl, selected) {
  fillSelectOptions(selectEl, CURRENCIES, selected);
}

function pickInitialCurrency(trip) {
  const list = trip.currencies.map((c) => c.currency);
  const remembered = localStorage.getItem(currencyStorageKey(trip.id));
  if (remembered && list.includes(remembered)) return remembered;
  return list[0] || 'TWD';
}

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => tryEnterTab(btn.dataset.tab));
});

async function tryEnterTab(tab) {
  if (tab === 'admin' && !(await ensureAdminUnlocked())) return;
  switchTab(tab);
}

// 簡易密碼只是前端提示層級的防呆，不是後端強制的權限控管
async function ensureAdminUnlocked() {
  const trip = state.currentTrip;
  if (!trip || !trip.has_pin) return true;
  if (sessionStorage.getItem(unlockedStorageKey(trip.id)) === '1') return true;
  const pin = prompt('請輸入這趟旅程的簡易密碼：');
  if (pin === null) return false;
  try {
    const data = await api(`/api/trips/${trip.id}/verify-pin`, { method: 'POST', body: JSON.stringify({ pin }) });
    if (data.ok) {
      sessionStorage.setItem(unlockedStorageKey(trip.id), '1');
      return true;
    }
    alert('密碼錯誤');
    return false;
  } catch (err) {
    alert('驗證失敗，請稍後再試');
    return false;
  }
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'dashboard') renderDashboard();
  if (tab === 'settlement') loadSettlement();
}

function showNoTripHint(show) {
  document.getElementById('noTripHint').classList.toggle('hidden', !show);
}

// ---------- Trip loading ----------
async function loadTrips() {
  state.trips = await api('/api/trips');
  const select = document.getElementById('tripSelect');
  select.innerHTML = '<option value="">請選擇旅程...</option>' +
    state.trips.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');

  const savedId = localStorage.getItem('currentTripId');
  if (savedId && state.trips.some((t) => String(t.id) === savedId)) {
    select.value = savedId;
    await selectTrip(savedId);
  } else if (state.trips.length > 0) {
    select.value = state.trips[0].id;
    await selectTrip(state.trips[0].id);
  } else {
    state.currentTrip = null;
    showNoTripHint(true);
  }
}

if (IS_ADMIN_UI) {
  document.getElementById('tripSelect').addEventListener('change', async (e) => {
    // 換旅程時，若原本停在「管理」分頁就先跳回「記帳」，避免不同旅程的管理內容互相帶出
    switchTab('record');
    await selectTrip(e.target.value);
  });
}

async function selectTrip(id) {
  if (!id) {
    state.currentTrip = null;
    localStorage.removeItem('currentTripId');
    showNoTripHint(true);
    return;
  }
  localStorage.setItem('currentTripId', id);
  state.currentTrip = await api(`/api/trips/${id}`);
  showNoTripHint(false);
  populateTripDependentUI();
  resetExpenseForm();
  await loadExpenses();
}

async function refreshCurrentTrip() {
  if (!state.currentTrip) return;
  const id = state.currentTrip.id;
  state.currentTrip = await api(`/api/trips/${id}`);
  populateTripDependentUI();
  resetExpenseForm();
  await loadExpenses();
}

function populateTripDependentUI() {
  const trip = state.currentTrip;
  fillSelectOptions(document.getElementById('f-currency'), trip.currencies.map((c) => c.currency));

  const categorySelect = document.getElementById('f-category');
  categorySelect.innerHTML = trip.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

  const payerSelect = document.getElementById('f-payer');
  payerSelect.innerHTML = '<option value="">未指定</option>' +
    trip.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');

  document.getElementById('exportCsvBtn').href = `/api/trips/${trip.id}/export.csv`;

  if (IS_ADMIN_UI) {
    document.getElementById('t-name').value = trip.name;
    document.getElementById('t-start').value = trip.start_date || '';
    document.getElementById('t-end').value = trip.end_date || '';
    document.getElementById('t-pin').value = '';
    document.getElementById('t-pin-confirm').value = '';
    document.getElementById('familyLinkInput').value = `${location.origin}/family/${trip.family_number}`;
    renderMemberChips();
    renderCategoryChips();
    renderCurrencyChips();
    populateSyncFilterPayer();
  }

  renderSplitCustomArea();
}

function renderCurrencyChips() {
  const container = document.getElementById('currencyList');
  const currencies = state.currentTrip.currencies;
  container.innerHTML = currencies.map((c) => {
    const removeBtn = c.currency === 'TWD' ? '' : `<button data-id="${c.id}" class="del-currency" title="移除幣別">×</button>`;
    return `<span class="chip">${escapeHtml(c.currency)} ${removeBtn}</span>`;
  }).join('');
  container.querySelectorAll('.del-currency').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定要移除這個幣別嗎？')) return;
      await api(`/api/currencies/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshCurrentTrip();
    });
  });

  const usedCurrencies = new Set(currencies.map((c) => c.currency));
  const available = CURRENCIES.filter((c) => !usedCurrencies.has(c));
  const select = document.getElementById('newCurrencySelect');
  fillSelectOptions(select, available.length ? available : ['']);
}

function renderMemberChips() {
  const container = document.getElementById('memberList');
  const members = state.currentTrip.members;
  container.innerHTML = members.length
    ? members.map((m) => `<span class="chip">${escapeHtml(m.name)} <button data-id="${m.id}" class="del-member" title="刪除成員">×</button></span>`).join('')
    : '<span class="hint">尚無成員</span>';
  container.querySelectorAll('.del-member').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定要刪除這位成員嗎？相關分攤紀錄也會一併移除。')) return;
      await api(`/api/members/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshCurrentTrip();
    });
  });
}

function renderCategoryChips() {
  const container = document.getElementById('categoryList');
  const categories = state.currentTrip.categories;
  container.innerHTML = categories.length
    ? categories.map((c) => `<span class="chip">${escapeHtml(c.name)} <button data-id="${c.id}" class="del-category" title="刪除分類">×</button></span>`).join('')
    : '<span class="hint">尚無分類</span>';
  container.querySelectorAll('.del-category').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定要刪除這個分類嗎？')) return;
      await api(`/api/categories/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshCurrentTrip();
    });
  });
}

if (IS_ADMIN_UI) {
  document.getElementById('addMemberBtn').addEventListener('click', async () => {
    const input = document.getElementById('newMemberName');
    const name = input.value.trim();
    if (!name || !state.currentTrip) return;
    await api(`/api/trips/${state.currentTrip.id}/members`, { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    await refreshCurrentTrip();
  });

  document.getElementById('addCategoryBtn').addEventListener('click', async () => {
    const input = document.getElementById('newCategoryName');
    const name = input.value.trim();
    if (!name || !state.currentTrip) return;
    await api(`/api/trips/${state.currentTrip.id}/categories`, { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    await refreshCurrentTrip();
  });

  document.getElementById('newTripBtn').addEventListener('click', openNewTripModal);

  document.getElementById('addCurrencyBtn').addEventListener('click', async () => {
    if (!state.currentTrip) return;
    const select = document.getElementById('newCurrencySelect');
    const currency = select.value;
    if (!currency) return;
    await api(`/api/trips/${state.currentTrip.id}/currencies`, { method: 'POST', body: JSON.stringify({ currency }) });
    await refreshCurrentTrip();
  });

  document.getElementById('copyFamilyLinkBtn').addEventListener('click', async () => {
    const input = document.getElementById('familyLinkInput');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    alert('已複製連結');
  });

  document.getElementById('saveTripBtn').addEventListener('click', async () => {
    if (!state.currentTrip) return;
    const pin = document.getElementById('t-pin').value;
    const pinConfirm = document.getElementById('t-pin-confirm').value;
    if (pin && pin !== pinConfirm) { alert('兩次輸入的密碼不一致'); return; }
    const body = {
      name: document.getElementById('t-name').value.trim(),
      start_date: document.getElementById('t-start').value || null,
      end_date: document.getElementById('t-end').value || null,
      pin: pin || undefined,
    };
    if (!body.name) { alert('請輸入旅程名稱'); return; }
    await api(`/api/trips/${state.currentTrip.id}`, { method: 'PUT', body: JSON.stringify(body) });
    if (pin) sessionStorage.setItem(unlockedStorageKey(state.currentTrip.id), '1');
    await loadTrips();
    document.getElementById('tripSelect').value = state.currentTrip.id;
    await selectTrip(state.currentTrip.id);
    alert('已儲存旅程設定');
  });

  document.getElementById('deleteTripBtn').addEventListener('click', async () => {
    if (!state.currentTrip) return;
    if (!confirm('確定要刪除整個旅程嗎？所有支出紀錄都會一併刪除，無法復原。')) return;
    await api(`/api/trips/${state.currentTrip.id}`, { method: 'DELETE' });
    localStorage.removeItem('currentTripId');
    switchTab('record');
    await loadTrips();
  });
}

function openNewTripModal() {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-box">
        <h3>新增旅程</h3>
        <div class="form-grid">
          <label>名稱 <input type="text" id="m-name" placeholder="例如：東京五日遊" /></label>
          <label>開始日期 <input type="date" id="m-start" /></label>
          <label>結束日期 <input type="date" id="m-end" /></label>
          <label>簡易密碼（必填） <input type="password" id="m-pin" autocomplete="new-password" /></label>
          <label>確認密碼 <input type="password" id="m-pin-confirm" autocomplete="new-password" /></label>
        </div>
        <div class="form-actions">
          <button id="m-submit" class="btn btn-primary">建立</button>
          <button id="m-cancel" class="btn btn-secondary">取消</button>
        </div>
      </div>
    </div>`;
  document.getElementById('m-cancel').addEventListener('click', () => { root.innerHTML = ''; });
  document.getElementById('m-submit').addEventListener('click', async () => {
    const name = document.getElementById('m-name').value.trim();
    if (!name) { alert('請輸入旅程名稱'); return; }
    const pin = document.getElementById('m-pin').value;
    const pinConfirm = document.getElementById('m-pin-confirm').value;
    if (!pin) { alert('請設定簡易密碼'); return; }
    if (pin !== pinConfirm) { alert('兩次輸入的密碼不一致'); return; }
    const body = {
      name,
      start_date: document.getElementById('m-start').value || null,
      end_date: document.getElementById('m-end').value || null,
      pin,
    };
    const created = await api('/api/trips', { method: 'POST', body: JSON.stringify(body) });
    root.innerHTML = '';
    sessionStorage.setItem(unlockedStorageKey(created.id), '1');
    await loadTrips();
    document.getElementById('tripSelect').value = created.id;
    await selectTrip(created.id);
  });
}

// ---------- Expense form ----------
document.getElementById('f-currency').addEventListener('change', updateRatePreview);
document.getElementById('f-amount').addEventListener('input', updateConvertedPreview);
document.getElementById('f-rate').addEventListener('input', updateConvertedPreview);
document.querySelectorAll('input[name="splitMode"]').forEach((radio) => radio.addEventListener('change', renderSplitCustomArea));
document.getElementById('cancelEditBtn').addEventListener('click', resetExpenseForm);

document.getElementById('f-receipt').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.pendingReceiptFile = file;
  state.pendingRemoveReceipt = false;
  const url = URL.createObjectURL(file);
  showReceiptPreview(url);
});

document.getElementById('removeReceiptBtn').addEventListener('click', () => {
  state.pendingReceiptFile = null;
  state.pendingRemoveReceipt = true;
  document.getElementById('f-receipt').value = '';
  hideReceiptPreview();
});

function showReceiptPreview(src) {
  document.getElementById('receiptImg').src = src;
  document.getElementById('receiptPreview').classList.remove('hidden');
}

function hideReceiptPreview() {
  document.getElementById('receiptPreview').classList.add('hidden');
  document.getElementById('receiptImg').src = '';
}

async function updateRatePreview() {
  const trip = state.currentTrip;
  const statusEl = document.getElementById('rateStatus');
  if (!trip) return;
  const currency = document.getElementById('f-currency').value;

  if (currency === 'TWD') {
    document.getElementById('f-rate').value = 1;
    statusEl.textContent = '同幣別，匯率為 1';
    statusEl.classList.remove('error');
    updateConvertedPreview();
    return;
  }

  statusEl.textContent = '正在查詢即時匯率...';
  statusEl.classList.remove('error');
  try {
    const data = await api(`/api/rates?base=${encodeURIComponent(currency)}&target=TWD`);
    document.getElementById('f-rate').value = data.rate;
    const sourceLabel = data.source === 'live' ? '即時' : data.source === 'cache' ? '快取' : '相同幣別';
    statusEl.textContent = `已帶入 ${data.date} 匯率（來源：${sourceLabel}），如需可手動修改`;
  } catch (err) {
    statusEl.textContent = `匯率查詢失敗：${err.message}，請手動輸入匯率`;
    statusEl.classList.add('error');
  }
  updateConvertedPreview();
}

function updateConvertedPreview() {
  const amount = parseFloat(document.getElementById('f-amount').value) || 0;
  const rate = parseFloat(document.getElementById('f-rate').value) || 0;
  const converted = Math.round(amount * rate * 100) / 100;
  document.getElementById('convertedPreview').textContent = fmt(converted);
  renderSplitCustomArea();
}

function getSplitMode() {
  return document.querySelector('input[name="splitMode"]:checked').value;
}

function renderSplitCustomArea() {
  const area = document.getElementById('splitCustomArea');
  const mode = getSplitMode();
  if (mode !== 'custom' || !state.currentTrip) {
    area.classList.add('hidden');
    area.innerHTML = '';
    return;
  }
  area.classList.remove('hidden');
  const members = state.currentTrip.members;
  if (members.length === 0) {
    area.innerHTML = '<p class="hint">請先在「管理」分頁新增成員</p>';
    return;
  }

  const converted = parseFloat(document.getElementById('convertedPreview').textContent.replace(/,/g, '')) || 0;
  const equalShare = Math.round((converted / members.length) * 100) / 100;

  const existing = {};
  area.querySelectorAll('.split-row').forEach((row) => {
    existing[row.dataset.memberId] = {
      checked: row.querySelector('.split-check').checked,
      amount: row.querySelector('.split-amount').value,
    };
  });

  area.innerHTML = members.map((m) => {
    const prev = existing[m.id];
    const checked = prev ? prev.checked : true;
    const amount = prev && prev.amount !== '' ? prev.amount : equalShare;
    return `
      <div class="split-row" data-member-id="${m.id}">
        <input type="checkbox" class="split-check" ${checked ? 'checked' : ''} />
        <span>${escapeHtml(m.name)}</span>
        <input type="number" class="split-amount" step="0.01" min="0" value="${amount}" style="width:100px" ${checked ? '' : 'disabled'} />
      </div>`;
  }).join('') + '<p class="hint">自訂分攤金額總和需等於換算金額</p>';

  area.querySelectorAll('.split-check').forEach((chk) => {
    chk.addEventListener('change', (e) => {
      e.target.closest('.split-row').querySelector('.split-amount').disabled = !e.target.checked;
    });
  });
}

function getSplitPayload() {
  const mode = getSplitMode();
  if (mode === 'none') return { split_mode: 'none', splits: [] };
  if (mode === 'equal') return { split_mode: 'equal', splits: undefined };
  const splits = [];
  document.querySelectorAll('#splitCustomArea .split-row').forEach((row) => {
    if (row.querySelector('.split-check').checked) {
      splits.push({
        member_id: Number(row.dataset.memberId),
        share_amount: parseFloat(row.querySelector('.split-amount').value) || 0,
      });
    }
  });
  return { split_mode: 'custom', splits };
}

document.getElementById('expenseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const trip = state.currentTrip;
  if (!trip) { alert('請先在右上角建立或選擇旅程'); return; }

  const amount = parseFloat(document.getElementById('f-amount').value);
  const rate = parseFloat(document.getElementById('f-rate').value);
  if (!amount || !rate) { alert('請輸入有效的金額與匯率'); return; }
  const converted = Math.round(amount * rate * 100) / 100;

  const { split_mode, splits } = getSplitPayload();
  if (split_mode === 'custom') {
    if (splits.length === 0) { alert('自訂分攤模式下請至少勾選一位成員'); return; }
    const sum = splits.reduce((a, s) => a + s.share_amount, 0);
    if (Math.abs(sum - converted) > 0.05) {
      alert(`自訂分攤總和 (${sum.toFixed(2)}) 與換算金額 (${converted.toFixed(2)}) 不符，請調整`);
      return;
    }
  }

  const editingId = document.getElementById('expenseId').value;

  if (!editingId && state.pendingReceiptFile && !navigator.onLine) {
    alert('離線時無法上傳收據照片，請先移除照片，恢復網路後再到「管理」分頁編輯這筆支出補傳');
    return;
  }

  const body = {
    date: document.getElementById('f-date').value,
    category_id: document.getElementById('f-category').value || null,
    payer_member_id: document.getElementById('f-payer').value || null,
    original_amount: amount,
    original_currency: document.getElementById('f-currency').value,
    rate_used: rate,
    converted_amount: converted,
    note: document.getElementById('f-note').value.trim() || null,
    payment_method: document.getElementById('f-payment').value,
    split_mode,
    splits,
  };

  if (body.payer_member_id) {
    localStorage.setItem(payerStorageKey(trip.id), body.payer_member_id);
  }
  localStorage.setItem(currencyStorageKey(trip.id), body.original_currency);

  if (!editingId && !navigator.onLine) {
    queueOfflineExpense(trip.id, body);
    alert('目前離線，這筆支出已暫存在裝置上，恢復網路連線後會自動上傳同步');
    resetExpenseForm();
    return;
  }

  try {
    let expenseId = editingId;
    if (editingId) {
      await api(`/api/expenses/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      const created = await api(`/api/trips/${trip.id}/expenses`, { method: 'POST', body: JSON.stringify(body) });
      expenseId = created.id;
    }

    if (state.pendingReceiptFile) {
      const formData = new FormData();
      formData.append('receipt', state.pendingReceiptFile);
      await fetch(`/api/expenses/${expenseId}/receipt`, { method: 'POST', body: formData });
    } else if (state.pendingRemoveReceipt) {
      await fetch(`/api/expenses/${expenseId}/receipt`, { method: 'DELETE' });
    }

    resetExpenseForm();
    await loadExpenses();
  } catch (err) {
    if (!editingId && isNetworkError(err)) {
      queueOfflineExpense(trip.id, body);
      alert('目前離線，這筆支出已暫存在裝置上，恢復網路連線後會自動上傳同步');
      resetExpenseForm();
      return;
    }
    alert(editingId && isNetworkError(err) ? '目前離線，暫時無法編輯支出，請恢復網路連線後再試' : err.message);
  }
});

function resetExpenseForm() {
  document.getElementById('expenseForm').reset();
  document.getElementById('expenseId').value = '';
  document.getElementById('formTitle').textContent = '新增支出';
  document.getElementById('cancelEditBtn').classList.add('hidden');
  document.getElementById('f-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('f-rate').value = 1;
  document.getElementById('f-payment').value = 'cash';
  if (state.currentTrip) {
    document.getElementById('f-currency').value = pickInitialCurrency(state.currentTrip);
    updateRatePreview(); // 主動觸發匯率查詢，修正「幣別預選好但匯率不會自動跳轉」的問題
    const rememberedPayer = localStorage.getItem(payerStorageKey(state.currentTrip.id));
    const payerSelect = document.getElementById('f-payer');
    if (rememberedPayer && payerSelect.querySelector(`option[value="${rememberedPayer}"]`)) {
      payerSelect.value = rememberedPayer;
    }
  }
  document.querySelector('input[name="splitMode"][value="equal"]').checked = true;
  state.pendingReceiptFile = null;
  state.pendingRemoveReceipt = false;
  hideReceiptPreview();
  updateConvertedPreview();
}

// 從分攤明細反推這筆支出當初用的是哪種分攤方式（DB 本身沒有另外存 split_mode）
function describeSplitMode(expense, memberCount) {
  if (expense.splits.length === 0) return '無需分攤';
  const count = memberCount || 1;
  const equalShare = Math.round((expense.converted_amount / count) * 100) / 100;
  const isEqual = expense.splits.length === count &&
    expense.splits.every((s) => Math.abs(s.share_amount - equalShare) < 0.02);
  return isEqual ? '全體均分' : '自訂分攤';
}

function startEditExpense(expense) {
  document.getElementById('expenseId').value = expense.id;
  document.getElementById('formTitle').textContent = '編輯支出';
  document.getElementById('cancelEditBtn').classList.remove('hidden');
  document.getElementById('f-date').value = expense.date;
  document.getElementById('f-category').value = expense.category_id || '';
  document.getElementById('f-payer').value = expense.payer_member_id || '';
  document.getElementById('f-amount').value = expense.original_amount;
  document.getElementById('f-currency').value = expense.original_currency;
  document.getElementById('f-rate').value = expense.rate_used;
  document.getElementById('f-note').value = expense.note || '';
  document.getElementById('f-payment').value = expense.payment_method || 'cash';
  document.getElementById('rateStatus').textContent = '';
  updateConvertedPreview();

  state.pendingReceiptFile = null;
  state.pendingRemoveReceipt = false;
  document.getElementById('f-receipt').value = '';
  if (expense.has_receipt) {
    showReceiptPreview(`/api/expenses/${expense.id}/receipt`);
  } else {
    hideReceiptPreview();
  }

  const description = describeSplitMode(expense, state.currentTrip.members.length);
  const mode = description === '無需分攤' ? 'none' : description === '全體均分' ? 'equal' : 'custom';

  document.querySelector(`input[name="splitMode"][value="${mode}"]`).checked = true;
  renderSplitCustomArea();

  if (mode === 'custom') {
    document.querySelectorAll('#splitCustomArea .split-row').forEach((row) => {
      const memberId = Number(row.dataset.memberId);
      const split = expense.splits.find((s) => s.member_id === memberId);
      row.querySelector('.split-check').checked = !!split;
      row.querySelector('.split-amount').disabled = !split;
      row.querySelector('.split-amount').value = split ? split.share_amount : 0;
    });
  }

  switchTab('record');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- Expenses list / table ----------
async function loadExpenses() {
  if (!state.currentTrip) return;
  state.expenses = await api(`/api/trips/${state.currentTrip.id}/expenses`);
  renderRecentExpenses();
  if (IS_ADMIN_UI) renderExpenseTable();
  renderDashboard();
}

function renderRecentExpenses() {
  const container = document.getElementById('recentExpenses');
  const recent = state.expenses.slice(0, 5);
  if (recent.length === 0) { container.innerHTML = '<p class="hint">尚無紀錄</p>'; return; }
  container.innerHTML = recent.map((e) => `
    <div class="recent-expense-row">
      <span>${e.date} · ${escapeHtml(e.category_name || '未分類')} · ${escapeHtml(e.payer_name || '未指定')}</span>
      <span>${fmt(e.converted_amount)} TWD</span>
    </div>
  `).join('');
}

// 管理頁「所有支出紀錄」與分帳結算頁「支出明細」共用同一組欄位，只差管理頁多了編輯/刪除
function expenseRowCells(e, memberCount) {
  return `
      <td>${e.date}</td>
      <td>${escapeHtml(e.category_name || '未分類')}</td>
      <td>${escapeHtml(e.payer_name || '未指定')}</td>
      <td>${PAYMENT_METHOD_LABELS[e.payment_method] || '現金'}</td>
      <td>${fmt(e.original_amount)} ${e.original_currency}</td>
      <td>${fmt(e.converted_amount)} TWD</td>
      <td class="wrap">${escapeHtml(e.note || '')}</td>
      <td>${describeSplitMode(e, memberCount)}</td>
      <td class="wrap">${e.splits.length ? e.splits.map((s) => `${escapeHtml(s.member_name)}:${fmt(s.share_amount)}`).join(', ') : '—'}</td>
      <td>${e.has_receipt ? `<a class="receipt-link" href="/api/expenses/${e.id}/receipt" target="_blank" rel="noopener" title="查看收據">📷</a>` : ''}</td>`;
}

function renderExpenseTable() {
  const tbody = document.querySelector('#expenseTable tbody');
  if (state.expenses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="hint">尚無支出紀錄</td></tr>';
    return;
  }
  const memberCount = state.currentTrip.members.length;
  tbody.innerHTML = state.expenses.map((e) => `
    <tr>
      ${expenseRowCells(e, memberCount)}
      <td>
        <button class="btn btn-secondary btn-small edit-expense" data-id="${e.id}">編輯</button>
        <button class="btn btn-danger btn-small del-expense" data-id="${e.id}">刪除</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.edit-expense').forEach((btn) => {
    btn.addEventListener('click', () => {
      const expense = state.expenses.find((e) => e.id === Number(btn.dataset.id));
      if (expense) startEditExpense(expense);
    });
  });
  tbody.querySelectorAll('.del-expense').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定要刪除這筆支出嗎？')) return;
      await api(`/api/expenses/${btn.dataset.id}`, { method: 'DELETE' });
      await loadExpenses();
    });
  });
}

// ---------- Dashboard / charts ----------
document.getElementById('filterFrom').addEventListener('change', renderDashboard);
document.getElementById('filterTo').addEventListener('change', renderDashboard);
document.getElementById('clearFilterBtn').addEventListener('click', () => {
  document.getElementById('filterFrom').value = '';
  document.getElementById('filterTo').value = '';
  renderDashboard();
});

function getFilteredExpenses() {
  const from = document.getElementById('filterFrom').value;
  const to = document.getElementById('filterTo').value;
  return state.expenses.filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
}

const PALETTE = ['#7B93A8', '#B98572', '#8FA888', '#C9A66B', '#9B8AA0', '#6B8CAE', '#BFA5A0', '#8C9A93', '#A98F76'];

function renderDashboard() {
  if (!state.currentTrip) {
    document.getElementById('totalAmount').textContent = '-';
    return;
  }
  const expenses = getFilteredExpenses();
  const total = expenses.reduce((a, e) => a + e.converted_amount, 0);
  document.getElementById('totalAmount').textContent = `${fmt(total)} TWD`;

  const byCategory = {};
  const byDate = {};
  const byMember = {};
  const byCurrency = {};
  expenses.forEach((e) => {
    const cat = e.category_name || '未分類';
    byCategory[cat] = (byCategory[cat] || 0) + e.converted_amount;
    byDate[e.date] = (byDate[e.date] || 0) + e.converted_amount;
    const mem = e.payer_name || '未指定';
    byMember[mem] = (byMember[mem] || 0) + e.converted_amount;
    if (!byCurrency[e.original_currency]) byCurrency[e.original_currency] = { original: 0, twd: 0 };
    byCurrency[e.original_currency].original += e.original_amount;
    byCurrency[e.original_currency].twd += e.converted_amount;
  });

  renderChart('categoryChart', 'doughnut', Object.keys(byCategory), Object.values(byCategory));
  const sortedDates = Object.keys(byDate).sort();
  renderChart('dateChart', 'line', sortedDates, sortedDates.map((d) => byDate[d]));
  renderChart('memberChart', 'bar', Object.keys(byMember), Object.values(byMember));

  // 依原幣別：圓餅圖用換算後的 TWD 比較（不同幣別的原始數字級距差太多，直接比會失真），
  // 底下再用文字列出各幣別實際付了多少原幣
  const currencies = Object.keys(byCurrency).sort((a, b) => byCurrency[b].twd - byCurrency[a].twd);
  renderChart('currencyChart', 'doughnut', currencies, currencies.map((c) => byCurrency[c].twd));
  document.getElementById('currencyBreakdown').innerHTML = currencies.length
    ? currencies.map((c) => `
      <div class="recent-expense-row">
        <span>${escapeHtml(c)}</span>
        <span>${fmt(byCurrency[c].original)} ${escapeHtml(c)}　→　${fmt(byCurrency[c].twd)} TWD</span>
      </div>`).join('')
    : '<p class="hint">尚無紀錄</p>';
}

function renderChart(canvasId, type, labels, data) {
  const ctx = document.getElementById(canvasId);
  if (state.charts[canvasId]) state.charts[canvasId].destroy();
  state.charts[canvasId] = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [{
        label: state.currentTrip ? 'TWD' : '',
        data,
        backgroundColor: type === 'line' ? 'rgba(123,147,168,0.18)' : PALETTE,
        borderColor: type === 'line' ? '#7B93A8' : '#ffffff',
        borderWidth: type === 'doughnut' ? 2 : 1,
        fill: type === 'line',
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: type !== 'bar' } },
      scales: type === 'doughnut' ? {} : { y: { beginAtZero: true } },
    },
  });
}

// ---------- Settlement ----------
async function loadSettlement() {
  if (!state.currentTrip) return;
  const data = await api(`/api/trips/${state.currentTrip.id}/settlement`);
  const tbody = document.querySelector('#balanceTable tbody');
  tbody.innerHTML = data.balances.length
    ? data.balances.map((b) => `<tr><td>${escapeHtml(b.name)}</td><td>${fmt(b.paid)}</td><td>${fmt(b.owed)}</td><td>${fmt(b.net)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="hint">尚無資料</td></tr>';

  const list = document.getElementById('transactionList');
  list.innerHTML = data.transactions.length
    ? data.transactions.map((t) => `<li>${escapeHtml(t.from)} → ${escapeHtml(t.to)}：${fmt(t.amount)} TWD</li>`).join('')
    : '<li class="hint">目前收支平衡，無需轉帳</li>';

  renderExpenseDetailTable();
}

// 支出明細的篩選條件（依付款人、日期區間），只影響這張表格與它的 CSV 匯出，不影響上方結算計算
function getDetailFilteredExpenses() {
  const payer = document.getElementById('detailFilterPayer').value;
  const from = document.getElementById('detailFilterFrom').value;
  const to = document.getElementById('detailFilterTo').value;
  return state.expenses.filter((e) =>
    (!payer || String(e.payer_member_id || '') === payer) &&
    (!from || e.date >= from) &&
    (!to || e.date <= to));
}

// 列出這趟旅程的支出（不管分攤方式），讓大家看得到完整的輸入資料，跟結算計算邏輯分開
function renderExpenseDetailTable() {
  const tbody = document.querySelector('#expenseDetailTable tbody');
  if (!tbody || !state.currentTrip) return;

  const payerSelect = document.getElementById('detailFilterPayer');
  const previousPayer = payerSelect.value;
  payerSelect.innerHTML = '<option value="">全部付款人</option>' +
    state.currentTrip.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  if (previousPayer && payerSelect.querySelector(`option[value="${previousPayer}"]`)) {
    payerSelect.value = previousPayer;
  }

  const expenses = getDetailFilteredExpenses();
  if (expenses.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="hint">${state.expenses.length === 0 ? '尚無支出紀錄' : '目前篩選條件下沒有符合的紀錄'}</td></tr>`;
    return;
  }
  const memberCount = state.currentTrip.members.length;
  tbody.innerHTML = expenses.map((e) => `<tr>${expenseRowCells(e, memberCount)}</tr>`).join('');
}

document.getElementById('detailFilterPayer').addEventListener('change', renderExpenseDetailTable);
document.getElementById('detailFilterFrom').addEventListener('change', renderExpenseDetailTable);
document.getElementById('detailFilterTo').addEventListener('change', renderExpenseDetailTable);
document.getElementById('clearDetailFilterBtn').addEventListener('click', () => {
  document.getElementById('detailFilterPayer').value = '';
  document.getElementById('detailFilterFrom').value = '';
  document.getElementById('detailFilterTo').value = '';
  renderExpenseDetailTable();
});

// ---------- Google 試算表同步（管理端限定）----------
function populateSyncFilterPayer() {
  const select = document.getElementById('syncFilterPayer');
  const previous = select.value;
  select.innerHTML = '<option value="">全部付款人</option>' +
    state.currentTrip.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  if (previous && select.querySelector(`option[value="${previous}"]`)) select.value = previous;
}

if (IS_ADMIN_UI) {
  document.getElementById('clearSyncFilterBtn').addEventListener('click', () => {
    document.getElementById('syncFilterPayer').value = '';
    document.getElementById('syncFilterFrom').value = '';
    document.getElementById('syncFilterTo').value = '';
  });

  document.getElementById('syncSheetsBtn').addEventListener('click', async () => {
    if (!state.currentTrip) return;
    const statusEl = document.getElementById('syncSheetsStatus');
    statusEl.classList.remove('error');
    statusEl.textContent = '同步中...';
    const body = {
      payer_member_id: document.getElementById('syncFilterPayer').value || undefined,
      from: document.getElementById('syncFilterFrom').value || undefined,
      to: document.getElementById('syncFilterTo').value || undefined,
    };
    try {
      const data = await api(`/api/trips/${state.currentTrip.id}/sync-sheets`, { method: 'POST', body: JSON.stringify(body) });
      statusEl.textContent = `同步成功，共 ${data.syncedRows} 筆`;
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.classList.add('error');
    }
  });
}

async function selectTripByFamilyNumber(familyNumber) {
  state.currentTrip = await api(`/api/trips/by-family/${familyNumber}`);
  showNoTripHint(false);
  populateTripDependentUI();
  resetExpenseForm();
  await loadExpenses();
}

// ---------- Init ----------
(async function init() {
  showNoTripHint(true);
  document.getElementById('noTripHint').textContent = GUEST_FAMILY_NUMBER ? '正在載入旅程...' : '請先在右上角建立或選擇一個旅程。';
  resetExpenseForm();
  updateOfflineBadge();
  try {
    if (GUEST_FAMILY_NUMBER) {
      await selectTripByFamilyNumber(GUEST_FAMILY_NUMBER);
      const nameEl = document.getElementById('guestTripName');
      if (nameEl && state.currentTrip) nameEl.textContent = `✈️ ${state.currentTrip.name}`;
    } else {
      await loadTrips();
    }
  } catch (err) {
    if (!isNetworkError(err)) {
      document.getElementById('noTripHint').textContent = GUEST_FAMILY_NUMBER
        ? '找不到這趟旅程，請確認連結是否正確'
        : `無法載入旅程：${err.message}`;
    } else {
      document.getElementById('noTripHint').textContent = '目前離線，且尚無快取資料可顯示，請確認網路連線';
    }
  }
  await flushOfflineQueue();
})();
