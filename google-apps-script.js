/**
 * 旅遊記帳系統 → Google 試算表 同步接收端
 *
 * 設定步驟：
 * 1. 打開你要用來存記帳資料的 Google 試算表。
 * 2. 上方選單「擴充功能」→「Apps Script」。
 * 3. 把這個檔案的全部內容貼進去（取代原本的空白內容）。
 * 4. 把下面 SECRET 換成你自己想的一組亂碼（英數字皆可，越亂越好）。
 * 5. 上方「部署」→「新增部署作業」：
 *      類型：網頁應用程式
 *      執行身分：我
 *      誰可以存取：任何人
 *    按「部署」，過程可能會跳出 Google 帳號授權確認，同意即可。
 * 6. 部署完成後複製「網頁應用程式」網址。
 * 7. 把這個網址和第 4 步設定的 SECRET，到 Render Dashboard →
 *    你的服務 → Environment，新增兩個環境變數：
 *      GOOGLE_SHEETS_WEBHOOK_URL = 剛剛複製的網址
 *      GOOGLE_SHEETS_SECRET      = 你設定的那組亂碼
 *
 * 之後在「管理」分頁點「立即同步」，資料就會依旅程名稱寫進對應的分頁
 * （分頁不存在會自動新增；已存在會清空重寫，不會累加重複）。
 */

const SECRET = '請換成你自己的一組亂碼';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.secret !== SECRET) {
      return jsonResponse({ ok: false, error: 'Unauthorized' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = sanitizeSheetName(body.sheetName || '未命名旅程');
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    } else {
      sheet.clearContents();
    }

    const headers = body.headers || [];
    const rows = body.rows || [];
    const data = [headers, ...rows];
    if (data.length > 0 && headers.length > 0) {
      sheet.getRange(1, 1, data.length, headers.length).setValues(data);
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

// Google Sheets 分頁名稱不能包含 [ ] * ? / \ : 這些字元，也不能超過 100 字
function sanitizeSheetName(name) {
  return String(name).slice(0, 100).replace(/[\[\]\*\?\/\\:]/g, '-');
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
