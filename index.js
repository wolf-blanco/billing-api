"use strict";

const admin = require("firebase-admin");
const express = require("express");

admin.initializeApp();
const db = admin.firestore();

const ENV = {
  BILLING_BEARER_TOKEN: process.env.BILLING_BEARER_TOKEN || "",
};

function toIso(v) {
  if (!v) return null;
  try {
    if (typeof v.toDate === "function") return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "string") return new Date(v).toISOString();
  } catch {}
  return null;
}

function getAvailableAtDay30NineAM() {
  const now = new Date();
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

function resolveAmountLocalAtIssue(periodData) {
  if (periodData?.amount_local_at_issue != null) return periodData.amount_local_at_issue;
  return 0;
}

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.use((req, _res, next) => {
  req.customer_id = String(req.header("X-Customer-Id") || "cus_001");
  next();
});

function requireBillingToken(req, res, next) {
  const expected = ENV.BILLING_BEARER_TOKEN ? `Bearer ${ENV.BILLING_BEARER_TOKEN}` : null;
  const token = req.header("Authorization") || "";
  if (!expected) return res.status(500).json({ error: "server_misconfigured" });
  if (token !== expected) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/bff/billing/:period/overview", async (req, res) => {
  try {
    const customer_id = req.customer_id;
    const period = req.params.period;

    const cusSnap = await db.collection("customers").doc(customer_id).get();
    if (!cusSnap.exists) return res.status(404).json({ error: "customer_not_found" });
    const customer = cusSnap.data() || {};

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
          amount_local_at_issue: null,
        },
        lastPayment: null,
        history: [],
      });
    }

    const p = perSnap.data() || {};
    const invoice = {
      status: p.status || "scheduled",
      available_at: toIso(p.available_at) || toIso(p.issued_at) || null,
      payment_link: null,
      invoice_pdf_url: p.invoice_pdf_url || null,
      issued_at: toIso(p.issued_at) || null,
      expires_at: toIso(p.expires_at) || null,
      amount_local_at_issue: resolveAmountLocalAtIssue(p),
    };

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
        invoice_pdf_url: h.invoice_pdf_url || null,
      };
    });

    res.json({
      customer: { display_name: customer.display_name, plan_id: customer.plan_id || "basic_startup" },
      period,
      invoice,
      lastPayment,
      history,
    });
  } catch (e) {
    console.error("overview error", e);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/bff/billing/:period/generate", requireBillingToken, async (req, res) => {
  try {
    const customer_id = req.customer_id;
    const period = req.params.period;
    const { ref, data } = await getPeriodDoc(customer_id, period);
    const nowIso = new Date().toISOString();

    if (data && data.status === "paid") {
      return res.status(400).json({ error: "already_paid" });
    }

    const amount_local = resolveAmountLocalAtIssue(data);
    const expires_at = addHours(nowIso, 48);

    await ref.set(
      {
        customer_id,
        period,
        status: "issued",
        amount_local_at_issue: amount_local,
        issued_at: nowIso,
        expires_at,
        updated_at: nowIso,
      },
      { merge: true }
    );

    res.json({ ok: true, period });
  } catch (e) {
    console.error("generate error", e);
    res.status(500).json({ error: "internal_error" });
  }
});

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

    await ref.set(
      {
        status: "issued",
        amount_local_at_issue: amount_local,
        last_regenerated_at: nowIso,
        expires_at,
        updated_at: nowIso,
      },
      { merge: true }
    );

    res.json({ ok: true, period });
  } catch (e) {
    console.error("regenerate error", e);
    res.status(500).json({ error: "internal_error" });
  }
});

exports.api = app;
