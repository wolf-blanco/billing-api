// index.js
const admin = require("firebase-admin");
const express = require("express");

admin.initializeApp();
const db = admin.firestore();

function toIso(v) {
  if (!v) return null;
  try {
    if (typeof v.toDate === "function") return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "string") return v;
  } catch {}
  return null;
}

function getAvailableAtDay30NineAM() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 30, 9, 0, 0);
}

const app = express();
app.use(express.json());

// rutas básicas para health/readiness
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// inyectar customer_id (ajusta a tu auth real)
app.use((req, _res, next) => {
  req.customer_id = String(req.header("X-Customer-Id") || "cus_001");
  next();
});

// GET /bff/billing/:period/overview
app.get("/bff/billing/:period/overview", async (req, res) => {
  try {
    const customer_id = req.customer_id;
    const period = req.params.period; // "YYYY-MM"

    // 1) Customer
    const cusSnap = await db.collection("customers").doc(customer_id).get();
    if (!cusSnap.exists) return res.status(404).json({ error: "customer_not_found" });
    const customer = cusSnap.data() || {};

    // 2) Period
    const perId = `${customer_id}_${period}`;
    const perSnap = await db.collection("periods").doc(perId).get();

    if (!perSnap.exists) {
      const availableAt = getAvailableAtDay30NineAM();
      return res.json({
        customer: { display_name: customer.display_name, plan_id: customer.plan_id || "basic_startup" },
        period,
        invoice: {
          status: "scheduled",
          available_at: availableAt.toISOString(),
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
      available_at: toIso(p.issued_at),
      payment_link: p.payment_link || null,
      invoice_pdf_url: p.invoice_pdf_url || null,
      issued_at: toIso(p.issued_at),
      expires_at: toIso(p.expires_at),
      amount_local_at_issue:
        p.amount_local_at_issue ?? p.local_estimated_eom ?? null
    };

    // 3) Último pago
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

    // 4) Historial (12)
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
        amount_local: h.amount_local_at_issue ?? h.local_estimated_eom ?? null,
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

// IMPORTANTÍSIMO para Functions Framework:
exports.api = app; // <<<< NO usar app.listen()
