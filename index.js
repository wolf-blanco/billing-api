const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const functions = require("@google-cloud/functions-framework");

// Inicializar Firebase Admin
admin.initializeApp();
const db = admin.firestore();

// Inicializar Express
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Middleware de autenticación por token
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  const token = process.env.BILLING_BEARER_TOKEN;

  if (!auth || !auth.startsWith("Bearer ") || auth.split(" ")[1] !== token) {
    return res.status(401).json({ error: "unauthorized" });
  }

  next();
});

// Ruta: Obtener resumen de facturación del cliente
app.get("/bff/billing/:periodo/overview", async (req, res) => {
  try {
    const customerId = req.headers["x-customer-id"];
    const periodo = req.params.periodo;

    const snapshot = await db.collection("facturas")
      .where("cliente_id", "==", customerId)
      .where("periodo", "==", periodo)
      .get();

    if (snapshot.empty) return res.status(404).json({ error: "Factura no encontrada" });

    const factura = snapshot.docs[0].data();
    res.json(factura);
  } catch (err) {
    console.error("Error overview:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Ruta: Generar nueva factura para el cliente
app.post("/bff/billing/:periodo/generate", async (req, res) => {
  try {
    const periodo = req.params.periodo;
    const customerId = req.headers["x-customer-id"];

    if (!customerId) return res.status(400).json({ error: "Falta customer-id" });

    const clienteRef = db.collection("clientes").doc(customerId);
    const clienteSnap = await clienteRef.get();

    if (!clienteSnap.exists) return res.status(404).json({ error: "Cliente no encontrado" });

    const cliente = clienteSnap.data();

    const nuevaFactura = {
      cliente_id: customerId,
      periodo,
      estado: "pendiente",
      fecha_emision: new Date().toISOString(),
      monto_total: cliente.plan_mensual || 0,
      moneda: "USD",
      observaciones: "",
    };

    const facturaRef = await db.collection("facturas").add(nuevaFactura);

    res.status(201).json({
      id: facturaRef.id,
      ...nuevaFactura,
    });
  } catch (err) {
    console.error("Error al generar factura:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Exportar para Cloud Run (functions-framework)
functions.http("api", app);
