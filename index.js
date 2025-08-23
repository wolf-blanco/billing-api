// index.js
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// === Inicializa Firebase Admin ===
admin.initializeApp();
const db = admin.firestore();

// === Express App ===
const app = express();
const PORT = process.env.PORT || 8080;

// === Middleware ===
app.use(cors()); // Permite llamadas desde el frontend (incluso en localhost)
app.use(express.json()); // Para leer JSON en el body

// === Middleware de autenticación por Bearer Token ===
const BILLING_BEARER_TOKEN = process.env.BILLING_BEARER_TOKEN || "";
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (authHeader === BILLING_BEARER_TOKEN) {
    return next();
  }
  return res.status(401).json({ error: "unauthorized" });
};

// === Ruta de salud para ver si está vivo el servicio ===
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// === Ruta para obtener overview del período de facturación ===
app.get("/bff/billing/:period/overview", authMiddleware, async (req, res) => {
  const customerId = req.headers["x-customer-id"];
  const { period } = req.params;
  if (!customerId) return res.status(400).json({ error: "customer_id required" });

  const docId = `${customerId}_${period}`;
  try {
    const ref = db.collection("periods").doc(docId);
    const doc = await ref.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "period not found" });
    }
    return res.status(200).json(doc.data());
  } catch (err) {
    console.error("Error al obtener periodo:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// === Ruta para generar factura (sin link de pago) ===
app.post("/bff/billing/:period/generate", authMiddleware, async (req, res) => {
  const customerId = req.headers["x-customer-id"];
  const { period } = req.params;
  if (!customerId) return res.status(400).json({ error: "customer_id required" });

  const docId = `${customerId}_${period}`;
  const ref = db.collection("periods").doc(docId);

  try {
    await ref.set(
      {
        customer_id: customerId,
        period,
        status: "issued",
        created_at: new Date().toISOString(),
        amount_local_at_issue: req.body.amount || 0
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      service: "billing",
      periodo: period
    });
  } catch (err) {
    console.error("Error al generar factura:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// === Inicia el servidor ===
app.listen(PORT, () => {
  console.log(`Servidor de billing activo en http://localhost:${PORT}`);
});
