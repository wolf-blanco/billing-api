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
 async function getDolarCripto() {
   const r = await fetch('https://criptoya.com/api/dolar', { method: 'GET' });
   if (!r.ok) throw new Error(`CriptoYa HTTP ${r.status}`);
   const j = await r.json();
   if (!j || typeof j.cripto === 'undefined') throw new Error('Respuesta CriptoYa inválida');
   const rate = parseFloat(j.cripto);
   if (!isFinite(rate) || rate <= 0) throw new Error('Tasa cripto inválida');
   return rate;
 }
 
 function round2(n) {
   return Math.round((n + Number.EPSILON) * 100) / 100;
 }
 
 function periodoISO(d = new Date()) {
   return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
 }
 
 // === Registro de rutas en Express ===
 module.exports = function registerBillingRoutes(app) {
   const express = require('express');
   const router = express.Router();
 
   // Health
   router.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'billing' }));
 
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
 
       const tasaBase = await getDolarCripto();
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
 
   // Webhook (MP notificará aquí si lo configuras en la preferencia o en el panel)
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
 