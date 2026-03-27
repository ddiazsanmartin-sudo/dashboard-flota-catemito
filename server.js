// ============================================================
// SECCIÓN: SERVIDOR EXPRESS - PUNTO DE ENTRADA
// Sirve el dashboard HTML y expone la API REST que lee
// los datos de Google Sheets via Service Account.
// ============================================================

require('dotenv').config();
const express = require('express');
const path    = require('path');
const { readSheet }                      = require('./lib/sheets');
const { procesarDashboard, parseAuditorias } = require('./lib/processor');
const cache   = require('./lib/cache');

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// SECCIÓN: CONFIGURACIÓN DE CATASTROS
// Cada catastro apunta a un Spreadsheet distinto y tiene sus
// propios nombres de hojas.
// ============================================================
const CATASTROS = {
  flota: {
    nombre:        'Catastro de Flota - Catemito',
    spreadsheetId: process.env.SPREADSHEET_ID,
    hojas: {
      RESPUESTAS:  'Respuestas de formulario 3',
      DATOS:       'Datos',
      FLOTA:       'Flota',
      AUDITORIAS:  'Auditorias',
    },
  },
  senyaletica: {
    nombre:        'Señalética y Elementos Críticos de Carrocería',
    spreadsheetId: process.env.SPREADSHEET_ID_SENYALETICA,
    hojas: {
      RESPUESTAS:  'Respuestas de formulario 2',
      DATOS:       'Datos',
      FLOTA:       'Flota',
      AUDITORIAS:  'Auditorias',
    },
  },
};

function getCatastro(id) {
  return CATASTROS[id] || CATASTROS.flota;
}

// ============================================================
// SECCIÓN: SERVIR ARCHIVOS ESTÁTICOS
// La carpeta /public contiene el index.html del dashboard.
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// SECCIÓN: HELPER - CARGAR Y PROCESAR DATOS
// Función compartida entre endpoints para evitar duplicar
// la lógica de carga + caché.
// ============================================================
async function cargarDatos(numeroAuditoria, catastroId = 'flota') {
  const catastro  = getCatastro(catastroId);
  const cacheKey  = `dashboard_${catastroId}_${numeroAuditoria ?? 'latest'}`;

  // Intentar devolver desde caché
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[Server] Sirviendo desde caché: ${cacheKey}`);
    return cached;
  }

  console.log(`[Server] Cargando datos [${catastroId}] auditoría: ${numeroAuditoria ?? 'más reciente'}`);

  const { hojas, spreadsheetId } = catastro;

  // Leer las 4 hojas en paralelo para mayor velocidad
  const [respRows, datosRows, flotaRows, audRows] = await Promise.all([
    readSheet(hojas.RESPUESTAS,  spreadsheetId),
    readSheet(hojas.DATOS,       spreadsheetId),
    readSheet(hojas.FLOTA,       spreadsheetId),
    readSheet(hojas.AUDITORIAS,  spreadsheetId).catch(() => {
      console.warn(`[Server] Hoja "Auditorias" no encontrada en catastro ${catastroId}.`);
      return [];
    }),
  ]);

  const resultado = procesarDashboard({
    respRows, datosRows, flotaRows, audRows,
    numeroAuditoria: numeroAuditoria ?? null,
  });

  // Guardar en caché por 5 minutos
  cache.set(cacheKey, resultado, 5 * 60 * 1000);
  return resultado;
}

// ============================================================
// SECCIÓN: API - LISTA DE CATASTROS DISPONIBLES
// GET /api/catastros
// ============================================================
app.get('/api/catastros', (req, res) => {
  const lista = Object.entries(CATASTROS).map(([id, cfg]) => ({
    id,
    nombre:       cfg.nombre,
    configurado:  !!cfg.spreadsheetId,
  }));
  res.json(lista);
});

// ============================================================
// SECCIÓN: API - LISTA DE AUDITORÍAS
// GET /api/auditorias?catastro=flota
// Retorna la lista de auditorías definidas en la hoja.
// ============================================================
app.get('/api/auditorias', async (req, res) => {
  const catastroId = req.query.catastro || 'flota';
  try {
    const cacheKey = `auditorias_lista_${catastroId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const catastro  = getCatastro(catastroId);
    const audRows   = await readSheet(catastro.hojas.AUDITORIAS, catastro.spreadsheetId).catch(() => []);
    const auditorias = parseAuditorias(audRows).map(a => ({
      numero:  a.numero,
      nombre:  a.nombre,
      inicio:  a.inicio?.toISOString() || null,
      cierre:  a.cierre?.toISOString() || null,
      enCurso: a.enCurso,
    }));

    cache.set(cacheKey, auditorias, 2 * 60 * 1000);
    res.json(auditorias);
  } catch (err) {
    console.error('[/api/auditorias]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SECCIÓN: API - DATOS DEL DASHBOARD
// GET /api/dashboard?auditoria=N&catastro=flota
// ============================================================
app.get('/api/dashboard', async (req, res) => {
  try {
    const numAud     = req.query.auditoria ? parseInt(req.query.auditoria) : null;
    const catastroId = req.query.catastro || 'flota';
    const resultado  = await cargarDatos(numAud, catastroId);
    res.json(resultado.dashboard);
  } catch (err) {
    console.error('[/api/dashboard]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SECCIÓN: API - DETALLE POR BUS
// GET /api/bus/:interno?auditoria=N&catastro=flota
// ============================================================
app.get('/api/bus/:interno', async (req, res) => {
  try {
    const busNum     = req.params.interno.trim();
    const numAud     = req.query.auditoria ? parseInt(req.query.auditoria) : null;
    const catastroId = req.query.catastro || 'flota';

    const resultado  = await cargarDatos(numAud, catastroId);
    const busDetalle = resultado.busesDetalle?.[busNum];

    if (!busDetalle) {
      return res.status(404).json({
        error: `Bus N° ${busNum} no encontrado en esta auditoría. ` +
               `Puede que aún no haya sido auditado en este período.`
      });
    }

    res.json(busDetalle);
  } catch (err) {
    console.error('[/api/bus]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SECCIÓN: API - LIMPIAR CACHÉ MANUALMENTE
// GET /api/refresh   — limpia todo
// GET /api/refresh?catastro=flota — limpia solo ese catastro
// ============================================================
app.get('/api/refresh', (req, res) => {
  const catastroId = req.query.catastro;
  if (catastroId) {
    // Invalidar solo las entradas de este catastro
    cache.invalidateByPrefix(`dashboard_${catastroId}`);
    cache.invalidateByPrefix(`auditorias_lista_${catastroId}`);
    res.json({ ok: true, mensaje: `Caché limpiado para catastro: ${catastroId}` });
  } else {
    cache.invalidateAll();
    res.json({ ok: true, mensaje: 'Caché limpiado. Próxima carga traerá datos frescos de Sheets.' });
  }
});

// ============================================================
// SECCIÓN: RUTA FALLBACK
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// SECCIÓN: INICIO DEL SERVIDOR
// ============================================================
app.listen(PORT, () => {
  console.log(`\n📋 Dashboard Multi-Catastro - Catemito`);
  console.log(`   Puerto: ${PORT}`);
  console.log(`   URL:    http://localhost:${PORT}`);
  console.log(`   Flota:       ${process.env.SPREADSHEET_ID          ? '✅' : '❌ SPREADSHEET_ID no definido'}`);
  console.log(`   Señalética:  ${process.env.SPREADSHEET_ID_SENYALETICA ? '✅' : '❌ SPREADSHEET_ID_SENYALETICA no definido'}`);
  console.log(`   Creds:       ${process.env.GOOGLE_CREDENTIALS       ? '✅' : '❌ GOOGLE_CREDENTIALS no definidas'}\n`);
});
