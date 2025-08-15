/**
 * Facturación EiryBot en Cloud Run
 * - Lee dólar cripto desde CriptoYa
 * - Aplica margen FX
 * - Crea preferencia de cobro en Mercado Pago (Checkout Pro)
 * - Webhook para confirmar recepción (log)
 *
 * Variables de entorno:
 *   MP_ACCESS_TOKEN       (secreto) -> Access Token Mercado Pago
 *   BILLING_PRICE_USD     (ej: "49")
 *   BILLING_MARGIN_FX     (ej: "0.02" = 2%)
 *   BILLING_CURRENCY_ID   (ej: "ARS")
 *   BILLING_EXPIRES_H     (ej: "48")
 *   BILLING_BEARER_TOKEN  (opcional) -> para proteger /billing/generateLink
 */

const mercadopago = require('mercadopago');

// === Utilidades entorno ===
function getEnv(name, def = undefined, required = false) {
  const v = process.env[name];
  if ((v === undefined || v === '') && required) throw new Error(`Falta variable: ${name}`);
  return v ?? def;
}

const CONFIG = {
  PRICE_USD: parseFloat(getEnv('BILLING_PRICE_USD', '49')),
  MARGIN_FX: parseFloat(getEnv('BILLING_MARGIN_FX', '0.02')),
  CURRENCY_ID: getEnv('BILLING_CURRENCY_ID', 'ARS'),
  EXPIRES_H: parseInt(getEnv('BILLING_EXPIRES_H', '48'), 10),
  MP_ACCESS_TOKEN: getEnv('MP_ACCESS_TOKEN', undefined, true),
  BEARER_TOKEN: getEnv('BILLING_BEARER_TOKEN', '')
};

mercadopago.configure({ access_token: CONFIG.MP_ACCESS_TOKEN });

// === Auth Bearer opcional ===
function requireBearer(req, res, next) {
  if (!CONFIG.BEARER_TOKEN) return next();
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m || m[1] !== CONFIG.BEARER_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// === Helpers ===
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function periodoISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Intenta extraer un número válido de un objeto (o número) dado.
 */
function firstValidNumber(any) {
  if (typeof any === 'number' && Number.isFinite(any) && any > 0) return any;
  if (typeof any === 'string') {
    const num = Number(any.replace(',', '.'));
    if (Number.isFinite(num) && num > 0) return num;
  }
  if (any && typeof any === 'object') {
    // orden de preferencia de claves típicas
    const prefer = ['promedio', 'venta', 'price', 'avg', 'ask', 'valor'];
    for (const k of prefer) {
      if (k in any) {
        const v = firstValidNumber(any[k]);
        if (v) return v;
      }
    }
    // última chance: primer valor numérico > 0 que aparezca
    for (const v of Object.values(any)) {
      const num = firstValidNumber(v);
      if (num) return num;
    }
  }
  return undefined;
}

/**
 * Obtiene dólar cripto desde CriptoYa, con timeout y logs de diagnóstico.
 * Estructuras posibles (cambian con el tiempo). Buscamos en:
 *   - j.cripto (número u objeto)
 *   - j.usdt / j.usdc (por si proveen esos atajos)
 */
async function getDolarCripto() {
  const url = 'https://criptoya.com/api/dolar';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  let bodyText;

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'eirybot-billing/1.0 (+cloudrun)' }
    });
    bodyText = await res.text();
    if (!res.ok) throw new Error(`CriptoYa HTTP ${res.status} :: ${bodyText?.slice(0, 200)}`);
  } catch (e) {
    clearTimeout(t);
    console.error('CriptoYa fetch error:', e);
    throw new Error('No se pudo consultar CriptoYa');
  }
  clearTimeout(t);

  let j;
  try {
    j = JSON.parse(bodyText);
  } catch (e) {
    console.error('CriptoYa JSON inválido:', bodyText?.slice(0, 500));
    throw new Error('Respuesta inválida de CriptoYa');
  }

  // candidatos en orden
const usdtAsk =
  firstValidNumber(j?.cripto?.usdt?.ask) ??
  firstValidNumber(j?.cripto?.usdt?.price);
if (usdtAsk) return usdtAsk;

// Si no hay usdt ask, probá ccb/usdc y luego fallback genérico
const ccbAsk = firstValidNumber(j?.cripto?.ccb?.ask);
if (ccbAsk) return ccbAsk;
const usdcAsk = firstValidNumber(j?.cripto?.usdc?.ask);
if (usdcAsk) return usdcAsk;

// Por último, búsqueda flexible (como ya tenías)
const candidates = [j?.cripto, j?.usdt, j?.usdc];
for (const c of candidates) {
  const v = firstValidNumber(c);
  if (v) return v;
}


  console.error('CriptoYa sin tasa utilizable. JSON:', JSON.stringify(j).slice(0, 800));
  throw new Error('Tasa cripto inválida');
}

/** Fallback simple por si CriptoYa falla (ej: dólar blue) */
async function getDolarFallback() {
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares/blue', { method: 'GET' });
    const j = await r.json();
    const v = firstValidNumber(j?.venta) || firstValidNumber(j?.promedio) || firstValidNumber(j?.valor);
    if (v) return v;
  } catch (_) {}
  throw new Error('Fallback sin datos');
}

async function getTasaConFallback() {
  try {
    return await getDolarCripto();
  } catch (e) {
    console.warn('Falla CriptoYa, usando fallback:', e.message);
    return await getDolarFallback();
  }
}

// === Registro de rutas en Express ===
module.exports = function registerBillingRoutes(app) {
  const express = require('express');
  const router = express.Router();

  // Health
  router.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'billing' }));

  // Debug de tasa (temporal)
  router.get('/_debug/dolar', async (req, res) => {
    try {
      const url = 'https://criptoya.com/api/dolar';
      const r = await fetch(url, { headers: { 'User-Agent': 'eirybot-billing/1.0 (+cloudrun)' } });
      const txt = await r.text();
      res.status(200).json({ ok: true, source: 'criptoya', raw: txt.slice(0, 1000) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  /**
   * POST /billing/generateLink
   * Body opcional:
   * {
   *   "periodo": "YYYY-MM",
   *   "priceUsd": 49,
   *   "marginFxPct": 0.02,
   *   "currencyId": "ARS",
   *   "expiresHours": 48,
   *   "externalReference": "EIRYBOT-2025-08-CLIENTE123"
   * }
   */
  router.post('/generateLink', requireBearer, async (req, res) => {
    try {
      const now = new Date();
      const {
        periodo = periodoISO(now),
        priceUsd = CONFIG.PRICE_USD,
        marginFxPct = CONFIG.MARGIN_FX,
        currencyId = CONFIG.CURRENCY_ID,
        expiresHours = CONFIG.EXPIRES_H,
        externalReference
      } = req.body || {};

      const tasaBase = await getTasaConFallback();
      const tasaAplicada = round2(parseFloat(tasaBase) * (1 + parseFloat(marginFxPct)));
      const montoLocal = round2(parseFloat(priceUsd) * tasaAplicada);

      const expiresAt = new Date(now.getTime() + (parseInt(expiresHours, 10) * 60 * 60 * 1000));
      const isoExp = expiresAt.toISOString();

      const preference = {
        items: [
          {
            title: `Servicio mensual EiryBot - ${periodo}`,
            quantity: 1,
            unit_price: montoLocal,
            currency_id: currencyId
          }
        ],
        metadata: {
          periodo,
          price_usd: parseFloat(priceUsd),
          tasa_base: tasaBase,
          margen_fx: parseFloat(marginFxPct),
          tasa_aplicada: tasaAplicada,
          monto_local: montoLocal
        },
        external_reference: externalReference || `EIRYBOT-${periodo}`,
        date_of_expiration: isoExp
      };

      const result = await mercadopago.preferences.create(preference);
      const { id: preferenceId, init_point, sandbox_init_point } = result.body || {};

      return res.status(200).json({
        ok: true,
        periodo,
        preferenceId,
        init_point,
        sandbox_init_point,
        montoLocal,
        currencyId,
        tasaBase,
        tasaAplicada,
        expiresAt: isoExp
      });
    } catch (err) {
      console.error('generateLink error:', err);
      return res.status(500).json({ ok: false, error: err.message || 'internal_error' });
    }
  });

  // Webhook (MP notificará aquí si lo configuras)
  router.post('/webhook', async (req, res) => {
    try {
      const payload = Object.keys(req.body || {}).length ? req.body : req.query;
      console.log('MP webhook:', JSON.stringify(payload));
      return res.status(200).send('OK');
    } catch (e) {
      console.error('webhook error:', e);
      return res.status(200).send('OK');
    }
  });

  app.use('/billing', router);
};
