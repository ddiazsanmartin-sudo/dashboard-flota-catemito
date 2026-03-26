// ============================================================
// SECCIÓN: SERVIDOR EXPRESS - PUNTO DE ENTRADA
// Sirve el dashboard HTML y expone la API REST que lee
// los datos de Google Sheets via Service Account.
// ============================================================

require('dotenv').config();
const express = require('express');
const path    = require('path');
const { readSheet }        = require('./lib/sheets');
const { procesarDashboard, NOMBRES_HOJAS } = require('./lib/processor');
const cache   = require('./lib/cache');

const app  = express();
const PORT = process.env.PORT || 3000;

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
async function cargarDatos(numeroAuditoria) {
  const cacheKey = `dashboard_${numeroAuditoria ?? 'latest'}`;

  // Intentar devolver desde caché
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[Server] Sirviendo desde caché: ${cacheKey}`);
    return cached;
  }

  console.log(`[Server] Cargando datos de Sheets para auditoría: ${numeroAuditoria ?? 'más reciente'}`);

  // Leer las 4 hojas en paralelo para mayor velocidad
  const [respRows, datosRows, flotaRows, audRows] = await Promise.all([
    readSheet(NOMBRES_HOJAS.RESPUESTAS),
    readSheet(NOMBRES_HOJAS.DATOS),
    readSheet(NOMBRES_HOJAS.FLOTA),
    readSheet(NOMBRES_HOJAS.AUDITORIAS).catch(() => {
      console.warn('[Server] Hoja "Auditorias" no encontrada. Mostrando todos los datos.');
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
// SECCIÓN: API - LISTA DE AUDITORÍAS
// GET /api/auditorias
// Retorna la lista de auditorías definidas en la hoja.
// ============================================================
app.get('/api/auditorias', async (req, res) => {
  try {
    const cached = cache.get('auditorias_lista');
    if (cached) return res.json(cached);

    const audRows = await readSheet(NOMBRES_HOJAS.AUDITORIAS).catch(() => []);
    const { parseAuditorias } = require('./lib/processor');
    const auditorias = parseAuditorias(audRows).map(a => ({
      numero:  a.numero,
      nombre:  a.nombre,
      inicio:  a.inicio?.toISOString() || null,
      cierre:  a.cierre?.toISOString() || null,
      enCurso: a.enCurso,
    }));

    cache.set('auditorias_lista', auditorias, 2 * 60 * 1000);
    res.json(auditorias);
  } catch (err) {
    console.error('[/api/auditorias]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SECCIÓN: API - DATOS DEL DASHBOARD
// GET /api/dashboard?auditoria=N
// Retorna todos los datos procesados para renderizar el
// dashboard. Si no se especifica auditoría, usa la más reciente.
// ============================================================
app.get('/api/dashboard', async (req, res) => {
  try {
    const numAud = req.query.auditoria ? parseInt(req.query.auditoria) : null;
    const resultado = await cargarDatos(numAud);
    res.json(resultado.dashboard);
  } catch (err) {
    console.error('[/api/dashboard]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SECCIÓN: API - DETALLE POR BUS
// GET /api/bus/:interno?auditoria=N
// Retorna todos los valores de elementos para un bus específico.
// Usado por la pestaña "Buscador por bus".
// ============================================================
app.get('/api/bus/:interno', async (req, res) => {
  try {
    const busNum = req.params.interno.trim();
    const numAud = req.query.auditoria ? parseInt(req.query.auditoria) : null;

    const resultado = await cargarDatos(numAud);
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
// GET /api/refresh
// Fuerza recarga de todos los datos desde Sheets.
// ============================================================
app.get('/api/refresh', (req, res) => {
  cache.invalidateAll();
  res.json({ ok: true, mensaje: 'Caché limpiado. Próxima carga traerá datos frescos de Sheets.' });
});

// ============================================================
// SECCIÓN: RUTA FALLBACK
// Cualquier ruta no reconocida devuelve el index.html
// para que el router del frontend maneje la navegación.
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// SECCIÓN: INICIO DEL SERVIDOR
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚌 Dashboard Flota Catemito`);
  console.log(`   Puerto: ${PORT}`);
  console.log(`   URL:    http://localhost:${PORT}`);
  console.log(`   Sheets: ${process.env.SPREADSHEET_ID ? '✅ Configurado' : '❌ SPREADSHEET_ID no definido'}`);
  console.log(`   Creds:  ${process.env.GOOGLE_CREDENTIALS ? '✅ Configuradas' : '❌ GOOGLE_CREDENTIALS no definidas'}\n`);
});
