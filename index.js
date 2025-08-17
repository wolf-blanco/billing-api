// index.js
// -------------------------------------------------------------
// EiryBot Billing BFF (CommonJS + Functions Framework target=api)
// - Exporta un Express app como `exports.api` (sin app.listen)
// - Healthchecks: /healthz
// - Endpoint: GET /bff/billing/:period/overview
// - Usa firebase-admin para Firestore
// -------------------------------------------------------------

const admin = require("firebase-admin");
const express = require("express");

// ---------- Bootstrap Firebase Admin ----------
admin.initializeApp();
const db = admin.firestore();

// ---------- Helpers ----------
/**
 * Convierte distintos tipos de timestamp (Firestore Timestamp, Date, ISO string)
 * a ISO string. Si no puede, devuelve null.
 */
function toIso(v) {
  if (!v) return null;
  try {
    if (typeof v.toDate === "function") return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "string") return v;
  } catch (e) {
    // noop
  }
  return null;
}

/**
 * Devuelve el Date del día 30 a las 09:00 hora local del runtime.
 * (Si necesitás TZ del cliente, calculalo server-side con una lib tipo luxon)
 */
function getLocalAvailableAtForThisMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 30, 9, 0, 0);
}

// ---------- Express app ----------
const app = express();
app.use(express.json());

// Health (útil para Cloud Run/Health checks en general)
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Middleware simple para derivar customer_id (ajustá según tu auth/JWT)
app.use((req, _res, next) => {
  req.customer_id = String(req.header("X-Customer-Id") || "cus_001");
  next();
});

// ---------- BFF: Overview de facturación ----------
// GET /bff/billing/:period/overview
// Respuesta esperada por el front:
// {
//   customer: { display_name, plan_id },
//   period: "YYYY-MM",
//   invoice: { status, available_at, payment_link, invoice_pdf_url, issued_at, expires_at, amount_local_at_issue },
//   lastPayment: { period, amount_local, paid_at, invoice_pdf_url } | null,
//   history: [{ period, status, amount_local, paid_at, invoice_pdf_url }, ...]
// }
app.get("/bff/billing/:period/overview", async (req, res) => {
  try {
    const customer_id = req.customer_id;
    const period = req.params.period; // "YYYY-MM"

    // 1) Customer
    const cusSnap = await db.collection("customers").doc(customer_id).get();
    if (!cusSnap.exists) {
      return res.status(404).json({ error: "customer_not_found" });
    }
    const customer = cusSnap.data() || {};

    // 2) Period actual
    const perId = `${customer_id}_${period}`;
    const perSnap = await db.collection("periods").doc(perId).get();

    if (!perSnap.exists) {
      // Si no existe el doc, devolvés "scheduled" con fecha de disponibilidad (día 30 09:00)
      const availableAt = getLocalAvailableAtForThisMonth();
      return res.json({
        customer: {
          display_name: customer.display_name,
          plan_id: customer.plan_id || "basic_startup",
        },
        period,
        invoice: {
          status: "scheduled",
          available_at: availableAt.toISOString(),
          payment_link: null,
          invoice_pdf_url: null,
          issued_at: null,
          expires_at: null,
          amount_local_at_issue: null,
        },
        lastPayment: null,
        history: [],
      });
    }

    const p = perSnap.data() || {};
    const invoice = {
      status: p.status || "scheduled",
      available_at: toIso(p.issued_at) || null, // en muchos casos coincide con issued_at
      payment_link: p.payment_link || null,
      invoice_pdf_url: p.invoice_pdf_url || null,
      issued_at: toIso(p.issued_at) || null,
      expires_at: toIso(p.expires_at) || null,
      amount_local_at_issue:
        p.amount_local_at_issue != null
          ? p.amount_local_at_issue
          : p.local_estimated_eom != null
          ? p.local_estimated_eom
          : null,
    };

    // 3) Último pago (colección payments)
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
        invoice_pdf_url: d.invoice_pdf_url || null,
      };
    }

    // 4) Historial de períodos (últimos 12)
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
        amount_local:
          h.amount_local_at_issue != null
            ? h.amount_local_at_issue
            : h.local_estimated_eom != null
            ? h.local_estimated_eom
            : null,
        paid_at: toIso(h.paid_at),
        invoice_pdf_url: h.invoice_pdf_url || null,
      };
    });

    return res.json({
      customer: {
        display_name: customer.display_name,
        plan_id: customer.plan_id || "basic_startup",
      },
      period,
      invoice,
      lastPayment,
      history,
    });
  } catch (e) {
    console.error("overview error", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ---------- Export para Functions Framework ----------
// IMPORTANT: NO usar app.listen() con functions-framework.
// El start está definido en package.json: "start": "functions-framework --target=api ..."
exports.api = app;
