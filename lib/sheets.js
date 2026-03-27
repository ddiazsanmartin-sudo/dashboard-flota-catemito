// ============================================================
// SECCIÓN: CONECTOR GOOGLE SHEETS API
// Lee hojas del Spreadsheet usando una Service Account.
// Las credenciales vienen de variables de entorno.
// ============================================================

require('dotenv').config();
const { google } = require('googleapis');

// --- CONFIGURACIÓN ---
// El ID del Spreadsheet está en la URL de Google Sheets:
// https://docs.google.com/spreadsheets/d/ESTE_ES_EL_ID/edit
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

if (!SPREADSHEET_ID) {
  console.error('[Sheets] ERROR: Variable de entorno SPREADSHEET_ID no definida.');
}

// ============================================================
// SECCIÓN: AUTENTICACIÓN CON SERVICE ACCOUNT
// ============================================================
function getAuth() {
  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error('Variable de entorno GOOGLE_CREDENTIALS no definida.');
  }

  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (e) {
    throw new Error('GOOGLE_CREDENTIALS no es un JSON válido: ' + e.message);
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

// ============================================================
// SECCIÓN: LECTURA DE HOJA
// Retorna un array 2D con todos los valores de la hoja.
// La fila 0 siempre son los encabezados.
// ============================================================
async function readSheet(sheetName, spreadsheetId = SPREADSHEET_ID) {
  const auth = await getAuth().getClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName,
    valueRenderOption: 'FORMATTED_VALUE', // Leer como texto formateado
  });

  return response.data.values || [];
}

module.exports = { readSheet };
