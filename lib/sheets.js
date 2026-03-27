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
function getAuth(readonly = true) {
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
    scopes: [
      readonly
        ? 'https://www.googleapis.com/auth/spreadsheets.readonly'
        : 'https://www.googleapis.com/auth/spreadsheets',
    ],
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

// ============================================================
// SECCIÓN: ESCRITURA EN HOJA (Admin)
// Agrega una fila al final de la hoja indicada.
// Requiere que la Service Account tenga rol Editor en el Sheet.
// ============================================================
async function appendRow(sheetName, values, spreadsheetId = SPREADSHEET_ID) {
  const auth   = await getAuth(false).getClient();
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetName,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

// ============================================================
// SECCIÓN: ACTUALIZAR CELDA ESPECÍFICA
// Actualiza una celda por fila (1-indexed) y columna (0-indexed).
// Usado para registrar la fecha de cierre de una auditoría en curso.
// ============================================================
async function updateCell(sheetName, rowIndex1, colIndex0, value, spreadsheetId = SPREADSHEET_ID) {
  const auth   = await getAuth(false).getClient();
  const sheets = google.sheets({ version: 'v4', auth });

  // Convertir índice de columna 0-based a letra (0→A, 1→B, 2→C…)
  const colLetter = String.fromCharCode(65 + colIndex0);
  const range     = `${sheetName}!${colLetter}${rowIndex1}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

module.exports = { readSheet, appendRow, updateCell };
