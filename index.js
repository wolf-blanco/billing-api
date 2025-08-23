const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const app = express();

// ✅ Middleware CORS para permitir acceso desde el frontend
app.use(cors({
  origin: "*", // Solo durante desarrollo. Luego reemplaza por tu dominio real.
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Customer-Id"]
}));

// ✅ Middleware para parsear JSON
app.use(express.json());

// ✅ Middleware para validar token de autorización (Bearer)
const validateAuth = (req, res, next) => {
  const token = req.headers["authorization"];
  if (!token || token !== process.env.BILLING_BEARER_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
};

// ✅ Ruta para generar factura
app.post("/bff/billing/:period/generate", validateAuth, async (req, res) => {
  const period = req.params.period;
  const customerId = req.headers["x-customer-id"];
  if (!customerId) return res.status(400).json({ error: "missing customer id" });

  try {
    const ref = db.collection("facturas");
    const docRef = await ref.add({
      customer_id: customerId,
      period,
      status: "pendiente",
      created_at: new Date().toISOString()
    });

    res.json({ ok: true, id: docRef.id });
  } catch (error) {
    console.error("Error al generar factura:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// ✅ Ruta para consultar overview de facturación
app.get("/bff/billing/:period/overview", validateAuth, async (req, res) => {
  const period = req.params.period;
  const customerId = req.headers["x-customer-id"];
  if (!customerId) return res.status(400).json({ error: "missing customer id" });

  try {
    const snapshot = await db.collection("facturas")
      .where("customer_id", "==", customerId)
      .where("period", "==", period)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: "no factura found" });
    }

    const doc = snapshot.docs[0];
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error("Error al obtener overview:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// ✅ Exportar la función principal
exports.api = functions
  .region("us-central1")
  .https.onRequest(app);
