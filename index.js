// index.js
// -------------------------------------------------------------------
// EiryBot Billing BFF (CommonJS + Functions Framework target=api)
// Rutas:
// - GET  /bff/billing/:period/overview
// - POST /bff/billing/:period/generate
// - POST /bff/billing/:period/regenerate
// - GET  /healthz
// -------------------------------------------------------------------

const admin = require("firebase-admin");
const express = require("express");

// MercadoPago SDK: intentamos soportar v1 y v2
let mpV1 = null;
let mpV2 = null;
try { mpV1 = require("mercadopago"); } catch (_) {}
try { const pkg = require("mercadopago"); mpV2 = pkg.MercadoPagoConfig ? pkg : null; } catch (_) {}

// ---------- Bootstrap ----------
admin.initializeApp();
const db = admin.firestore();

const HAS_MP = !!process.env.MP_ACCESS_TOKEN;
const MP_TZ_OFFSET = process.env.MP_TZ_OFFSET || "-03:00"; // Argentina por defecto
const MP_BACK_URL_BASE =
  process.env.MP_BACK_URL_BASE || "https://eirybot.com"; // ajustable por env

if (HAS_MP && mpV1 && typeof mpV1.configure === "function") {
  mpV1.configure({ access_token: process.env.MP_ACCESS_TOKEN });
  console.log("[billing-api] MercadoPago SDK v1 configured");
} else if (HAS_MP && mpV2 && mpV2.MercadoPagoConfig) {
  console.log("[billing-api] MercadoPago SDK v2 available");
} else {
  console.warn("[billing-api] MP_ACCESS_TOKEN not set or SDK missing → using DEMO links");
}

// ---------- Helpers ----------
function toIso(v) {
  if (!v) return null;
  try {
    if (typeof v.toDate === "function") return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "string") return new Date(v).toISOString();
  } catch {}
  return null;
}

function toMPDatetime(isoOrDate, tz = MP_TZ_OFFSET) {
  const s = (isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate)).toISOString(); // 2025-08-21T01:54:59.000Z
  return s.replace("Z", tz); // 2025-08-21T01:54:59.000-03:00
}

function getAvailableAtDay30NineAM() {
  const now = new Date();
  // 9am del día 30 del mes actual (hora local de la instancia)
  return new Date(now.getFullYear(), now.getMonth(), 30, 9, 0, 0);
}

function addHours(isoOrDate, hours) {
  const t = (isoOrDate instanceof Date) ? isoOrDate : new Date(isoOrDate || Date.now());
  return new Date(t.getTime() + hours * 3600 * 1000).toISOString();
}

async function getPeriodDoc(customer_id, period) {
  const perId = `${customer_id}_${period}`;
  const ref = db.collection("periods").doc(perId);
  const snap = await ref.get();
  return { ref, snap, data: snap.exists ? (snap.data() || {}) : null };
}

// Unifica creación de preferencia MP (v1 / v2) o fallback demo
async function createPreference({
  title,
  quantity,
  unit_price,
  currency_id,
  external_reference,
  expires_at_iso // ISO con 'Z'; se formatea a offset para MP
}) {
  // back_urls configurables por env; evitan errores con auto_return
  const back_urls = {
    success: `${MP_BACK_URL_BASE}/billing/success`,
    failure: `${MP_BACK_URL_BASE}/billing/failure`,
    pending: `${MP_BACK_URL_BASE}/billing/pending`
  };

  // Cuerpo común
  const mpBody = {
    items: [{ title, quantity, currency_id, unit_price }],
    external_reference,
    auto_return: "approved",
    back_urls
  };

  // Expiración (si se quiere enviar a MP)
  if (expires_at_iso) {
    const now = new Date();
    mpBody.expires = true;
    mpBody.expiration_date_from = toMPDatetime(now);
    mpBody.expiration_date_to = toMPDatetime(expires_at_iso);
  }

  // Fallback demo si no hay token real
  if (!HAS_MP) {
    return {
      preference_id: "demo_pref",
      payment_link:
        "https://www.mercadopago.com/checkout/v1/redirect?pref_id=demo_pref"
    };
  }

  try {
    // SDK v1
    if (mpV1 && mpV1.preferences && typeof mpV1.preferences.create === "function") {
      const resp = await mpV1.preferences.create(mpBody);
      const body = resp.body || resp;
      return {
        preference_id: body.id,
        payment_link: body.init_point || body.sandbox_init_point
      };
    }

    // SDK v2
    if (mpV2 && mpV2.MercadoPagoConfig) {
      const { MercadoPagoConfig, Preference } = mpV2;
      const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
      const pref = new Preference(client);
      const resp = await pref.create({ body: mpBody });
      return {
        preference_id: resp.id,
        payment_link: resp.init_point || resp.sandbox_init_point
      };
    }

    throw new Error("MercadoPago SDK not available");
  } catch (e) {
    console.error("mp createPreference error:", e?.response?.data || e?.response?.body || e);
    throw e;
  }
}

// (Regla simple) monto a emitir
function resolveAmountLocalAtIssue(periodData) {
  if (periodData?.amount_local_at_issue != null) return periodData.amount_local_at_issue;
  return 0;
}

// ---------- Express app ----------
const app = express();
app.use(express.json());

// Health
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Inyecta customer_id desde header (ajustar si usas JWT)
app.use((req, _res, next) => {
  req.customer_id = String(req.header("X-Customer-Id") || "cus_001");
  next();
});

// Seguridad simple para POST /generate y /regenerate
function requireBillingToken(req, res, next) {
  const expected = process.env.BILLING_BEARER_TOKEN ? `Bearer ${process.env.BILLING_BEARER_TOKEN}` : null;
  const token = req.header("Authorization") || "";
  if (!expected) return res.status(500).json({ error: "server_misconfigured" });
  if (token !== expected) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ---------- GET /overview ----------
app.get("/bff/billing/:period/overview", async (req, res) => {
  try {
    const customer_id = req.customer_id;
    const period = req.params.period;

    // Customer
    const cusSnap = await db.collection("customers").doc(customer_id).get();
    if (!cusSnap.exists) return res.status(404).json({ error: "customer_not_found" });
    const customer = cusSnap.data() || {};

    // Period
    const perId = `${customer_id}_${period}`;
    const perSnap = await db.collection("periods").doc(perId).get();

    if (!perSnap.exists) {
      const availableAt = getAvailableAtDay30NineAM().toISOString();
      return res.json({
        customer: { display_name: customer.display_name, plan_id: customer.plan_id || "basic_startup" },
        period,
        invoice: {
          status: "scheduled",
          available_at: availableAt,
          payment_link: null,
          invoice_pdf_url: null,
          issued_at: null,
          expires_at: null,
          amount_local_at_issue: null
        },
        lastPayment: null,
        history: []
      });
    }

    const p = perSnap.data() || {};
    const invoice = {
      status: p.status || "scheduled",
      available_at: toIso(p.available_at) || toIso(p.issued_at) || null,
      payment_link: p.payment_link || null,
      invoice_pdf_url: p.invoice_pdf_url || null,
      issued_at: toIso(p.issued_at) || null,
      expires_at: toIso(p.expires_at) || null,
      amount_local_at_issue: resolveAmountLocalAtIssue(p)
    };

    // Último pago (opcional)
    const paySnap = await db
      .collection("payments")
      .where("customer_id", "==", customer_id)
      .orderBy("date_approved", "desc")
      .limit(1)
      .get();

    let lastPayment = null;
    if (!paySnap.empty) {
      const d = paySnap.docs[0].data() || {};
      lastPayment = {
        period: d.period || null,
        amount_local: d.transaction_amount || null,
        paid_at: toIso(d.date_approved),
        invoice_pdf_url: d.invoice_pdf_url || null
      };
    }

    // Historial (12)
    const histSnap = await db
      .collection("periods")
      .where("customer_id", "==", customer_id)
      .orderBy("period", "desc")
      .limit(12)
      .get();

    const history = histSnap.docs.map((doc) => {
      const h = doc.data() || {};
      return {
        period: h.period,
        status: h.status || "scheduled",
        amount_local: resolveAmountLocalAtIssue(h),
        paid_at: toIso(h.paid_at),
        invoice_pdf_url: h.invoice_pdf_url || null
      };
    });

    res.json({
      customer: { display_name: customer.display_name, plan_id: customer.plan_id || "basic_startup" },
      period,
      invoice,
      lastPayment,
      history
    });
  } catch (e) {
    console.error("overview error", e);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---------- POST /generate ----------
app.post("/bff/billing/:period/generate", requireBillingToken, async (req, res) => {
  try {
    const customer_id = req.customer_id;
    const period = req.params.period;
    const { ref, data } = await getPeriodDoc(customer_id, period);
    const nowIso = new Date().toISOString();

    // si ya está paid, no generes
    if (data && data.status === "paid") {
      return res.status(400).json({ error: "already_paid" });
    }

    const amount_local = resolveAmountLocalAtIssue(data);
    const expires_at = addHours(nowIso, 48);

    // preferencia MP (real o demo)
    const { preference_id, payment_link } = await createPreference({
      title: `EiryBot ${period} — Plan básico startup (Mantenimiento) + Casillero de correo`,
      quantity: 1,
      currency_id: "ARS", // ajusta si cobrás en otra moneda
      unit_price: Number((amount_local || 0).toFixed(2)),
      external_reference: `${customer_id}_${period}`,
      expires_at_iso: expires_at
    });

    await ref.set(
      {
        customer_id,
        period,
        status: "issued",
        amount_local_at_issue: amount_local,
        payment_link,
        preference_id,
        issued_at: nowIso,
        expires_at,
        updated_at: nowIso
      },
      { merge: true }
    );

    res.json({ ok: true, period, payment_link, preference_id, expires_at });
  } catch (e) {
    console.error("generate error", e);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---------- POST /regenerate ----------
app.post("/bff/billing/:period/regenerate", requireBillingToken, async (req, res) => {
  try {
    const customer_id = req.customer_id;
    const period = req.params.period;
    const { ref, data } = await getPeriodDoc(customer_id, period);

    if (!data) return res.status(404).json({ error: "period_not_found" });
    if (data.status === "paid") return res.status(400).json({ error: "already_paid" });

    const nowIso = new Date().toISOString();
    const amount_local = resolveAmountLocalAtIssue(data);
    const expires_at = addHours(nowIso, 48);

    const { preference_id, payment_link } = await createPreference({
      title: `EiryBot ${period} — Plan básico startup (Mantenimiento) + Casillero de correo`,
      quantity: 1,
      currency_id: "ARS",
      unit_price: Number((amount_local || 0).toFixed(2)),
      external_reference: `${customer_id}_${period}`,
      expires_at_iso: expires_at
    });

    await ref.set(
      {
        status: "issued",
        amount_local_at_issue: amount_local,
        payment_link,
        preference_id,
        last_regenerated_at: nowIso,
        expires_at,
        updated_at: nowIso
      },
      { merge: true }
    );

    res.json({ ok: true, period, payment_link, preference_id, expires_at });
  } catch (e) {
    console.error("regenerate error", e);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---------- Export para Functions Framework ----------
exports.api = app;
