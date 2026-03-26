// ============================================================
// SECCIÓN: CACHÉ EN MEMORIA
// Almacena resultados procesados para evitar recalcular en
// cada petición. TTL por defecto: 5 minutos.
// ============================================================

const store = new Map();

/**
 * Obtiene un valor del caché. Retorna null si no existe o expiró.
 */
function get(key) {
  const item = store.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    store.delete(key);
    return null;
  }
  return item.value;
}

/**
 * Guarda un valor en el caché con un TTL en milisegundos.
 */
function set(key, value, ttlMs = 5 * 60 * 1000) {
  store.set(key, { value, expiry: Date.now() + ttlMs });
}

/**
 * Elimina una entrada específica del caché.
 */
function invalidate(key) {
  store.delete(key);
}

/**
 * Limpia todo el caché (útil para forzar recarga de datos).
 */
function invalidateAll() {
  store.clear();
  console.log('[Cache] Caché limpiado completamente.');
}

module.exports = { get, set, invalidate, invalidateAll };
