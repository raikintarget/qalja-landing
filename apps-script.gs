// Google Apps Script – QALJA тіркеу формасы
// Деректерді Google Sheets-ке жазады және CORS рұқсатын береді.
//
// ОРНАТУ:
//   1. script.google.com → «Жаңа жоба» (New project)
//   2. Осы кодты бастапқы кодқа қойыңыз
//   3. «Deploy → New deployment» → «Web app»
//      – Execute as: «Me»
//      – Who has access: «Anyone»
//   4. «Deploy» батырмасын басыңыз → берілген URL-ді көшіріңіз
//   5. index.html ішіндегі SCRIPT_URL мәнін сол URL-ге ауыстырыңыз

const SHEET_ID = '1-1XIi5B5TXHYswgIAhHReCulMedjutOo_xOyZX2svVc';

function doPost(e) {
  try {
    const data  = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();

    // Бірінші рет: тақырып жолын қосамыз
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Уақыт', 'Аты-жөні', 'Телефон']);
    }

    sheet.appendRow([data.date || new Date().toLocaleString('ru-RU'), data.name, data.phone]);

    return response({ status: 'ok' });
  } catch (err) {
    return response({ status: 'error', message: err.message });
  }
}

// GET сұрауын да қабылдаймыз (тексеру үшін)
function doGet() {
  return response({ status: 'QALJA script is running' });
}

function response(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
