// ============================================================
// SECCIÓN: PROCESADOR DE DATOS - LÓGICA DE NEGOCIO PRINCIPAL
// Toma los datos crudos de Google Sheets y produce el JSON
// final que consume el dashboard.
// ============================================================

// --- CONSTANTES ---
// Tipos de pregunta que SÍ cuentan para el % de disponibilidad
const TIPOS_EVALUABLES = new Set(['Pregunta individual', 'Elemento de un bloque']);
// Respuesta que cuenta como positiva (operativo)
const RESPUESTA_POSITIVA = 'operativo';
// Sub-grupo que usa escala 1-5 en vez de Operativo/No Operativo
const SUBGRUPO_ASEO = 'aseo';
// Nombres de las hojas de Google Sheets
const NOMBRES_HOJAS = {
  RESPUESTAS: 'Respuestas de formulario 3',
  DATOS: 'Datos',
  FLOTA: 'Flota',
  AUDITORIAS: 'Auditorias',
};

// ============================================================
// SECCIÓN: HELPERS
// ============================================================

/** Normaliza un string: quita espacios, pasa a minúsculas */
function norm(str) {
  return String(str || '').trim().toLowerCase();
}

/** Encuentra el índice de columna buscando por nombre normalizado */
function findCol(headers, name) {
  return headers.findIndex(h => norm(h) === norm(name));
}

// ============================================================
// SECCIÓN: PARSING DE AUDITORÍAS
// Lee la hoja "Auditorias" y retorna un array de objetos.
// Si la hoja no existe, retorna array vacío.
// ============================================================
function parseAuditorias(audRows) {
  if (!audRows || audRows.length < 2) return [];

  const headers = audRows[0] || [];
  const idxNum    = headers.findIndex(h => norm(h).includes('n°') || norm(h).includes('numero') || norm(h).includes('número'));
  const idxInicio = headers.findIndex(h => norm(h).includes('inicio'));
  const idxCierre = headers.findIndex(h => norm(h).includes('cierre'));
  const idxNombre = headers.findIndex(h => norm(h).includes('nombre'));

  const result = [];
  for (let i = 1; i < audRows.length; i++) {
    const row = audRows[i];
    const numero = parseInt(row[idxNum]);
    if (isNaN(numero)) continue;

    const inicioRaw = row[idxInicio] ? String(row[idxInicio]).trim() : null;
    const cierreRaw = row[idxCierre] ? String(row[idxCierre]).trim() : null;

    // Parsear fechas en formato DD/MM/YYYY o YYYY-MM-DD
    const inicio = inicioRaw ? parseFecha(inicioRaw) : null;
    const cierre = cierreRaw ? parseFecha(cierreRaw) : null;

    result.push({
      numero,
      nombre: String(row[idxNombre] || `Auditoría ${numero}`).trim(),
      inicio,
      cierre,
      enCurso: inicio !== null && cierre === null,
    });
  }

  return result;
}

/** Parsea una fecha en formato DD/MM/YYYY o YYYY-MM-DD */
function parseFecha(str) {
  if (!str) return null;
  // Formato DD/MM/YYYY
  const dmY = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmY) return new Date(`${dmY[3]}-${dmY[2].padStart(2,'0')}-${dmY[1].padStart(2,'0')}T00:00:00`);
  // Formato YYYY-MM-DD o cualquier formato que Date entienda
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

// ============================================================
// SECCIÓN: MAPA DE FLOTA
// Crea un diccionario { nInterno: { modelo, estandar } }
// para consultar información de cada bus rápidamente.
// ============================================================
function buildFlotaMap(flotaRows) {
  if (!flotaRows || flotaRows.length < 2) return {};

  const headers = flotaRows[0] || [];
  const idxInterno  = findCol(headers, 'n° interno');
  const idxEstandar = findCol(headers, 'estandar');
  const idxModelo   = findCol(headers, 'resumen modelo');

  const map = {};
  for (let i = 1; i < flotaRows.length; i++) {
    const row = flotaRows[i];
    const interno = String(row[idxInterno] || '').trim();
    if (!interno) continue;
    map[interno] = {
      estandar: String(row[idxEstandar] || '').trim(),
      modelo:   String(row[idxModelo]   || '').trim(),
    };
  }

  return map;
}

// ============================================================
// SECCIÓN: CONSTRUCCIÓN DE ELEMENTOS DESDE HOJA "DATOS"
// Parsea la hoja Datos y retorna solo los elementos evaluables
// (descarta derivaciones y preguntas de derivación).
// ============================================================
function buildElementos(datosRows) {
  if (!datosRows || datosRows.length < 2) return [];

  const headers = datosRows[0] || [];
  const idx = {
    grupo:     findCol(headers, 'grupo de revisión'),
    subgrupo:  findCol(headers, 'sub-grupo'),
    elemento:  findCol(headers, 'nombre elemento'),
    tipo:      findCol(headers, 'tipo'),
    nombreCol: findCol(headers, 'nombre columna'),
    estandar:  findCol(headers, 'estándar del bus'),
  };

  // Verificar que las columnas existen
  if (idx.grupo < 0 || idx.nombreCol < 0) {
    console.error('[Processor] La hoja Datos no tiene las columnas esperadas. Revisar encabezados.');
    return [];
  }

  const elementos = [];
  for (let i = 1; i < datosRows.length; i++) {
    const row = datosRows[i];
    const tipo = String(row[idx.tipo] || '').trim();

    // Solo procesar tipos evaluables
    if (!TIPOS_EVALUABLES.has(tipo)) continue;

    const nombreCol = String(row[idx.nombreCol] || '').trim();
    if (!nombreCol) continue;

    const subgrupo = String(row[idx.subgrupo] || '').trim();
    const estandar = idx.estandar >= 0 ? String(row[idx.estandar] || '').trim() : 'Bus con camaras';

    elementos.push({
      grupo:        String(row[idx.grupo]    || '').trim(),
      subgrupo,
      elemento:     String(row[idx.elemento] || '').trim(),
      tipo,
      nombreCol,
      nombreColNorm: norm(nombreCol),
      estandar,
      esAseo: norm(subgrupo) === SUBGRUPO_ASEO,
    });
  }

  return elementos;
}

// ============================================================
// SECCIÓN: MAPA DE ÍNDICES DE COLUMNA
// Resuelve qué índice en Respuestas corresponde a cada
// elemento del mapa de Datos.
//
// PROBLEMA: El mismo nombre de columna puede aparecer dos
// veces en Respuestas (una para "Bus con camaras", otra para
// "Bus sin camaras"). Este mapa usa el orden de aparición en
// Datos para asignar la ocurrencia correcta.
// ============================================================
function buildColIndexMap(headers, elementos) {
  // 1. Registrar TODAS las ocurrencias de cada nombre de columna
  //    { "polarizado": [6, 119], "estado check point": [26] }
  const headerOccurrences = {};
  headers.forEach((h, i) => {
    const key = norm(h);
    if (!key) return;
    if (!headerOccurrences[key]) headerOccurrences[key] = [];
    headerOccurrences[key].push(i);
  });

  // 2. Para cada elemento, asignar el índice correcto según
  //    el orden en que aparecen en Datos.
  //    "Bus con camaras" está primero en Datos → usa ocurrencia[0]
  //    "Bus sin camaras" está después → usa ocurrencia[1]
  const assignedCount = {};  // { "polarizado": 1 } → cuántas ocurrencias ya asignadas
  const colIndexMap = {};    // { "polarizado|Bus con camaras": 6 }

  elementos.forEach(el => {
    const mapKey = `${el.nombreColNorm}|${el.estandar}`;
    if (colIndexMap[mapKey] !== undefined) return; // Ya mapeado, saltar

    const occurrences = headerOccurrences[el.nombreColNorm] || [];
    const alreadyAssigned = assignedCount[el.nombreColNorm] || 0;

    if (occurrences[alreadyAssigned] !== undefined) {
      colIndexMap[mapKey] = occurrences[alreadyAssigned];
      assignedCount[el.nombreColNorm] = alreadyAssigned + 1;
    } else {
      // La columna no existe en Respuestas → avisar pero no detener
      console.warn(`[Processor] Columna no encontrada en Respuestas: "${el.nombreCol}" (${el.estandar})`);
    }
  });

  return colIndexMap;
}

// ============================================================
// SECCIÓN: FILTRADO Y DEDUPLICACIÓN DE RESPUESTAS
// - Filtra filas según el período de auditoría
// - Mantiene solo la respuesta más reciente por bus
// ============================================================
function prepararFilas(respRows, colTs, colBusNum, auditoriaDef) {
  const inicio = auditoriaDef?.inicio || null;
  const cierre = auditoriaDef?.cierre || null;

  const latestPerBus = {};

  // Iterar desde fila 1 (fila 0 son encabezados)
  for (let i = 1; i < respRows.length; i++) {
    const row = respRows[i];

    // Validar timestamp
    const tsRaw = row[colTs];
    if (!tsRaw) continue;
    const ts = new Date(tsRaw);
    if (isNaN(ts)) continue;

    // Filtrar por período si está definido
    if (inicio && ts < inicio) continue;
    if (cierre) {
      // Incluir hasta el final del día de cierre
      const cierreFinDia = new Date(cierre);
      cierreFinDia.setHours(23, 59, 59, 999);
      if (ts > cierreFinDia) continue;
    }

    // Validar número de bus
    const busNum = String(row[colBusNum] || '').trim();
    if (!busNum) continue;

    // Mantener solo el más reciente por bus
    if (!latestPerBus[busNum] || ts > latestPerBus[busNum].ts) {
      latestPerBus[busNum] = { row, ts };
    }
  }

  return latestPerBus;
}

// ============================================================
// SECCIÓN: CÁLCULO DE MÉTRICAS POR ELEMENTO
// Para cada bus (última respuesta del período):
//   - Identifica qué elementos aplican según su estándar
//   - Clasifica la respuesta: positivo / negativo / N/A / aseo
//   - Acumula contadores por grupo > subgrupo > elemento
// ============================================================
function calcularMetricas(latestPerBus, elementos, colIndexMap, colEstandar) {
  // Estructura: { grupo: { subgrupo: { elemento: { ...contadores } } } }
  const resultados = {};

  Object.entries(latestPerBus).forEach(([busNum, { row }]) => {
    const busEstandar = String(row[colEstandar] || '').trim();

    // Solo procesar elementos que correspondan al estándar de este bus
    const elementosAplicables = elementos.filter(el => el.estandar === busEstandar);

    elementosAplicables.forEach(el => {
      const mapKey = `${el.nombreColNorm}|${el.estandar}`;
      const colIdx = colIndexMap[mapKey];
      if (colIdx === undefined) return; // Columna no encontrada

      const valorRaw = row[colIdx];
      const valor = String(valorRaw ?? '').trim();
      if (!valor) return; // Celda vacía = N/A → excluir del denominador

      // Inicializar bucket si no existe
      if (!resultados[el.grupo]) resultados[el.grupo] = {};
      if (!resultados[el.grupo][el.subgrupo]) resultados[el.grupo][el.subgrupo] = {};
      if (!resultados[el.grupo][el.subgrupo][el.elemento]) {
        resultados[el.grupo][el.subgrupo][el.elemento] = {
          positivos:    0,
          evaluables:   0,
          fallidos:     [],
          esAseo:       el.esAseo,
          suma:         0,
          distribucion: {},
        };
      }

      const bucket = resultados[el.grupo][el.subgrupo][el.elemento];
      bucket.evaluables++;

      if (el.esAseo) {
        // --- ASEO: escala 1 al 5 ---
        const score = parseFloat(valor);
        if (!isNaN(score) && score >= 1 && score <= 5) {
          bucket.suma += score;
          const k = String(Math.round(score));
          bucket.distribucion[k] = (bucket.distribucion[k] || 0) + 1;
        }
      } else {
        // --- BINARIO: Operativo / No Operativo ---
        if (norm(valor) === RESPUESTA_POSITIVA) {
          bucket.positivos++;
        } else {
          bucket.fallidos.push(busNum);
        }
      }
    });
  });

  return resultados;
}

// ============================================================
// SECCIÓN: FORMATEO DE RESULTADOS PARA EL FRONTEND
// Convierte los contadores crudos en porcentajes y
// estructura jerárquica lista para el HTML.
// ============================================================
function formatearResultados(resultados) {
  const tabs = {};

  Object.entries(resultados).forEach(([grupo, subgrupos]) => {
    let grupoPos = 0;
    let grupoEval = 0;

    tabs[grupo] = { porcentajeGeneral: null, subgrupos: [] };

    Object.entries(subgrupos).forEach(([subgrupo, elementos]) => {
      let sgPos = 0;
      let sgEval = 0;
      const elemList = [];

      Object.entries(elementos).forEach(([elemento, data]) => {
        if (data.esAseo) {
          const promedio = data.evaluables > 0
            ? Math.round((data.suma / data.evaluables) * 10) / 10
            : null;

          elemList.push({
            nombre:      elemento,
            esAseo:      true,
            promedio,
            evaluables:  data.evaluables,
            distribucion: data.distribucion,
          });
        } else {
          const pct = data.evaluables > 0
            ? Math.round((data.positivos / data.evaluables) * 1000) / 10
            : null;

          elemList.push({
            nombre:     elemento,
            esAseo:     false,
            porcentaje: pct,
            positivos:  data.positivos,
            evaluables: data.evaluables,
            fallidos:   data.fallidos.sort(),
          });

          if (pct !== null) {
            sgPos  += data.positivos;
            sgEval += data.evaluables;
          }
        }
      });

      // Porcentaje del subgrupo (solo elementos no-aseo)
      const sgPct = sgEval > 0
        ? Math.round((sgPos / sgEval) * 1000) / 10
        : null;

      tabs[grupo].subgrupos.push({ nombre: subgrupo, porcentaje: sgPct, elementos: elemList });

      grupoPos  += sgPos;
      grupoEval += sgEval;
    });

    // Porcentaje general del grupo
    tabs[grupo].porcentajeGeneral = grupoEval > 0
      ? Math.round((grupoPos / grupoEval) * 1000) / 10
      : null;
  });

  return tabs;
}

// ============================================================
// SECCIÓN: CÁLCULO PORCENTAJE GENERAL DE FLOTA
// ============================================================
function calcPctGeneral(tabs) {
  let totalPos = 0;
  let totalEval = 0;

  Object.values(tabs).forEach(tab => {
    tab.subgrupos.forEach(sg => {
      sg.elementos.forEach(el => {
        if (!el.esAseo && el.evaluables > 0) {
          totalPos  += el.positivos;
          totalEval += el.evaluables;
        }
      });
    });
  });

  return totalEval > 0 ? Math.round((totalPos / totalEval) * 1000) / 10 : null;
}

// ============================================================
// SECCIÓN: DETALLE POR BUS
// Retorna todos los valores de elementos para un bus específico.
// Usado por la pestaña "Buscador".
// ============================================================
function buildBusesDetalle(latestPerBus, elementos, colIndexMap, colEstandar, flotaMap) {
  const detalle = {};

  Object.entries(latestPerBus).forEach(([busNum, { row, ts }]) => {
    const busEstandar = String(row[colEstandar] || '').trim();
    const flotaInfo   = flotaMap[busNum] || {};

    const elementosAplicables = elementos.filter(el => el.estandar === busEstandar);
    const items = [];

    elementosAplicables.forEach(el => {
      const mapKey = `${el.nombreColNorm}|${el.estandar}`;
      const colIdx = colIndexMap[mapKey];
      const valorRaw = colIdx !== undefined ? row[colIdx] : undefined;
      const valor = String(valorRaw ?? '').trim();

      items.push({
        grupo:    el.grupo,
        subgrupo: el.subgrupo,
        elemento: el.elemento,
        valor:    valor || null,  // null = N/A
        esAseo:   el.esAseo,
      });
    });

    detalle[busNum] = {
      nInterno:  busNum,
      modelo:    flotaInfo.modelo  || '',
      estandar:  flotaInfo.estandar || busEstandar,
      fechaAuditoria: ts.toISOString(),
      elementos: items,
    };
  });

  return detalle;
}

// ============================================================
// SECCIÓN: FUNCIÓN PRINCIPAL - PROCESAR DASHBOARD
// Orquesta todos los pasos y retorna el objeto final.
// ============================================================
function procesarDashboard({ respRows, datosRows, flotaRows, audRows, numeroAuditoria }) {
  console.log('[Processor] Iniciando procesamiento...');
  const t0 = Date.now();

  // --- 1. Parsear estructura ---
  const auditorias  = parseAuditorias(audRows);
  const flotaMap    = buildFlotaMap(flotaRows);
  const elementos   = buildElementos(datosRows);

  console.log(`[Processor] Elementos evaluables: ${elementos.length}`);

  // --- 2. Encontrar columnas clave en Respuestas ---
  const headers     = respRows[0] || [];
  const colTs       = findCol(headers, 'Marca temporal');
  const colBusNum   = findCol(headers, 'N° Interno del bus');
  const colEstandar = findCol(headers, 'Señale el estándar del bus');

  if (colTs < 0 || colBusNum < 0 || colEstandar < 0) {
    throw new Error(
      `No se encontraron columnas clave en Respuestas. ` +
      `colTs=${colTs}, colBusNum=${colBusNum}, colEstandar=${colEstandar}. ` +
      `Verificar que los encabezados existen exactamente.`
    );
  }

  // --- 3. Construir mapa de índices de columna ---
  const colIndexMap = buildColIndexMap(headers, elementos);

  // --- 4. Determinar auditoría a mostrar ---
  let auditoriaDef = null;
  let auditoriaAnteriorDef = null;

  if (numeroAuditoria != null) {
    auditoriaDef = auditorias.find(a => a.numero === numeroAuditoria) || null;
    auditoriaAnteriorDef = auditorias.find(a => a.numero === numeroAuditoria - 1) || null;
  } else {
    // Sin especificar → usar la más reciente (mayor número)
    if (auditorias.length > 0) {
      auditoriaDef = auditorias.reduce((a, b) => a.numero > b.numero ? a : b);
      auditoriaAnteriorDef = auditorias.find(a => a.numero === auditoriaDef.numero - 1) || null;
    }
  }

  // --- 5. Filtrar y deduplicar filas ---
  const totalBuses  = Object.keys(flotaMap).length;
  const latestPerBus = prepararFilas(respRows, colTs, colBusNum, auditoriaDef);
  const busesAuditados = Object.keys(latestPerBus).length;

  console.log(`[Processor] Buses en período: ${busesAuditados} / ${totalBuses}`);

  // --- 6. Calcular métricas ---
  const resultadosCrudos = calcularMetricas(latestPerBus, elementos, colIndexMap, colEstandar);

  // --- 7. Formatear para el frontend ---
  const tabs = formatearResultados(resultadosCrudos);
  const pctGeneral = calcPctGeneral(tabs);

  // --- 8. Progreso de auditorías anteriores (para comparativa) ---
  const historial = [];
  for (const aud of auditorias) {
    if (aud.numero === auditoriaDef?.numero) continue; // La actual se muestra aparte
    const lpb = prepararFilas(respRows, colTs, colBusNum, aud);
    const rc  = calcularMetricas(lpb, elementos, colIndexMap, colEstandar);
    const tf  = formatearResultados(rc);
    const pg  = calcPctGeneral(tf);
    const dias = aud.inicio && aud.cierre
      ? Math.ceil((aud.cierre - aud.inicio) / (1000 * 60 * 60 * 24))
      : null;

    historial.push({
      numero:          aud.numero,
      nombre:          aud.nombre,
      inicio:          aud.inicio?.toISOString() || null,
      cierre:          aud.cierre?.toISOString() || null,
      duracionDias:    dias,
      busesAuditados:  Object.keys(lpb).length,
      totalBuses,
      porcentajeGeneral: pg,
      // Porcentaje por grupo para comparativa
      porPestaña: Object.fromEntries(
        Object.entries(tf).map(([g, v]) => [g, v.porcentajeGeneral])
      ),
    });
  }
  historial.sort((a, b) => b.numero - a.numero);

  // --- 9. Calcular días transcurridos de auditoría actual ---
  let diasTranscurridos = null;
  if (auditoriaDef?.inicio) {
    const fin = auditoriaDef.cierre || new Date();
    diasTranscurridos = Math.ceil((fin - auditoriaDef.inicio) / (1000 * 60 * 60 * 24));
  }

  // --- 10. Construir detalle por bus (para buscador) ---
  const busesDetalle = buildBusesDetalle(latestPerBus, elementos, colIndexMap, colEstandar, flotaMap);

  // --- 11. Identificar buses en datos históricos que ya no están en la flota actual ---
  // Se recolectan TODOS los buses que alguna vez aparecieron en Respuestas
  const todosLosBusesHistoricos = new Set();
  for (let i = 1; i < respRows.length; i++) {
    const b = String(respRows[i][colBusNum] || '').trim();
    if (b) todosLosBusesHistoricos.add(b);
  }
  const busesNoEnFlota = [...todosLosBusesHistoricos]
    .filter(b => !flotaMap[b])
    .sort();

  console.log(`[Processor] Buses históricos no en flota actual: ${busesNoEnFlota.length}`);
  console.log(`[Processor] Completado en ${Date.now() - t0}ms`);

  return {
    // Datos del dashboard (enviados al frontend)
    dashboard: {
      auditoria: auditoriaDef ? {
        numero:          auditoriaDef.numero,
        nombre:          auditoriaDef.nombre,
        inicio:          auditoriaDef.inicio?.toISOString() || null,
        cierre:          auditoriaDef.cierre?.toISOString() || null,
        enCurso:         auditoriaDef.enCurso,
        diasTranscurridos,
        busesAuditados,
        totalBuses,
        pctBusesAuditados: totalBuses > 0
          ? Math.round((busesAuditados / totalBuses) * 1000) / 10
          : null,
      } : null,
      sinAuditoriasDefinidas: auditorias.length === 0,
      porcentajeGeneral: pctGeneral,
      todasLasAuditorias: auditorias.map(a => ({
        numero: a.numero, nombre: a.nombre,
        inicio: a.inicio?.toISOString() || null,
        cierre: a.cierre?.toISOString() || null,
        enCurso: a.enCurso,
      })),
      historial,
      tabs,
      busesAuditadosList: Object.keys(latestPerBus).sort(),
      // Lista de buses que aparecen en historial pero ya no están en la flota actual
      busesNoEnFlota,
    },
    // Datos internos (NO enviados al frontend, usados por /api/bus)
    busesDetalle,
  };
}

module.exports = {
  procesarDashboard,
  parseAuditorias,
  NOMBRES_HOJAS,
};
