import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express from "express";

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(express.json());

// Middleware simple para derivar customer_id (adáptalo a tu auth)
app.use(async (req, _res, next) => {
  // Ejemplo: viene en header X-Customer-Id o lo resolvés del JWT.
  (req as any).customer_id = (req.header("X-Customer-Id") || "cus_001").toString();
  next();
});

// GET /bff/billing/:period/overview
app.get("/bff/billing/:period/overview", async (req, res) => {
  try {
    const customer_id = (req as any).customer_id;
    const period = req.params.period; // "YYYY-MM"

    // 1) Customer
    const cusRef = db.collection("customers").doc(customer_id);
    const cusSnap = await cusRef.get();
    if (!cusSnap.exists) return res.status(404).json({ error: "customer_not_found" });
    const customer = cusSnap.data() || {};
    const timezone = customer.timezone || "America/Argentina/Buenos_Aires";

    // 2) Period actual
    const perId = `${customer_id}_${period}`;
    const perSnap = await db.collection("periods").doc(perId).get();
    if (!perSnap.exists) {
      // Si no existe el doc, devolvé programado (scheduled) con fecha de disponibilidad
      const now = new Date();
      const availableAt = new Date(now.getFullYear(), now.getMonth(), 30, 9, 0, 0);
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

    const p = perSnap.data()!;
    const invoice = {
      status: p.status || "scheduled",
      available_at: p.issued_at ? p.issued_at.toDate?.().toISOString?.() || p.issued_at : null,
      payment_link: p.payment_link || null,
      invoice_pdf_url: p.invoice_pdf_url || null,
      issued_at: p.issued_at ? (p.issued_at.toDate?.().toISOString?.() || p.issued_at) : null,
      expires_at: p.expires_at ? (p.expires_at.toDate?.().toISOString?.() || p.expires_at) : null,
      amount_local_at_issue: p.amount_local_at_issue ?? p.local_estimated_eom ?? null
    };

    // 3) Último pago (colección payments)
    const paySnap = await db
      .collection("payments")
      .where("customer_id", "==", customer_id)
      .orderBy("date_approved", "desc")
      .limit(1)
      .get();

    let lastPayment = null as any;
    if (!paySnap.empty) {
      const d = paySnap.docs[0].data();
      lastPayment = {
        period: d.period,
        amount_local: d.transaction_amount,
        paid_at: d.date_approved?.toDate?.().toISOString?.() || d.date_approved || null,
        invoice_pdf_url: d.invoice_pdf_url || null
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
      const h = doc.data();
      return {
        period: h.period,
        status: h.status || "scheduled",
        amount_local: h.amount_local_at_issue ?? h.local_estimated_eom ?? null,
        paid_at: h.paid_at ? (h.paid_at.toDate?.().toISOString?.() || h.paid_at) : null,
        invoice_pdf_url: h.invoice_pdf_url || null
      };
    });

    return res.json({
      customer: { display_name: customer.display_name, plan_id: customer.plan_id || "basic_startup" },
      period,
      invoice,
      lastPayment,
      history
    });
  } catch (e: any) {
    console.error("overview error", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

exports.api = functions.https.onRequest(app);
