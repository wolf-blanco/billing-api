// index.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const functions = require("@google-cloud/functions-framework");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Inicializar Firebase Admin si no está iniciado
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const collectionFacturas = db.collection("facturas");
const collectionClientes = db.collection("clientes");

// Ruta base para Cloud Run
functions.http("api", app);

// Ruta: Overview
app.get("/bff/billing/:periodo/overview", async (req, res) => {
  const { periodo } = req.params;
  const clienteId = req.headers["cliente-id"];

  if (!clienteId) {
    return res.status(400).json({ error: "Falta cliente-id en headers" });
  }

  try {
    const snapshot = await collectionFacturas
      .where("cliente_id", "==", clienteId)
      .where("periodo", "==", periodo)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        estado: "no_generada",
        periodo,
        total: 15,
        fecha: `${periodo}-31`,
        moneda: "USD",
      });
    }

    const doc = snapshot.docs[0].data();

    return res.status(200).json({
      estado: doc.estado,
      periodo: doc.periodo,
      total: doc.total,
      fecha: doc.fecha,
      moneda: doc.moneda || "USD",
      enlace: doc.enlace || null,
    });
  } catch (error) {
    console.error("Error al consultar factura:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Ruta: Generar factura
app.post("/bff/billing/:periodo/generate", async (req, res) => {
  const { periodo } = req.params;
  const clienteId = req.headers["cliente-id"];

  if (!clienteId) {
    return res.status(400).json({ error: "Falta cliente-id en headers" });
  }

  try {
    const clienteDoc = await collectionClientes.doc(clienteId).get();
    if (!clienteDoc.exists) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const cliente = clienteDoc.data();

    const factura = {
      cliente_id: clienteId,
      periodo,
      estado: "pendiente",
      total: 15,
      fecha: `${periodo}-31`,
      moneda: "USD",
      cliente_nombre: cliente.nombre || "",
      cliente_email: cliente.email || "",
      creada: new Date().toISOString(),
    };

    const docRef = await collectionFacturas.add(factura);

    return res.status(200).json({ id: docRef.id, ...factura });
  } catch (error) {
    console.error("Error al generar factura:", error);
    return res.status(500).json({ error: "Error al generar factura" });
  }
});

// Ruta: Regenerar factura
app.post("/bff/billing/:periodo/regenerate", async (req, res) => {
  const { periodo } = req.params;
  const clienteId = req.headers["cliente-id"];

  if (!clienteId) {
    return res.status(400).json({ error: "Falta cliente-id en headers" });
  }

  try {
    const query = await collectionFacturas
      .where("cliente_id", "==", clienteId)
      .where("periodo", "==", periodo)
      .limit(1)
      .get();

    if (!query.empty) {
      await query.docs[0].ref.delete();
    }

    const clienteDoc = await collectionClientes.doc(clienteId).get();
    if (!clienteDoc.exists) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const cliente = clienteDoc.data();

    const nuevaFactura = {
      cliente_id: clienteId,
      periodo,
      estado: "pendiente",
      total: 15,
      fecha: `${periodo}-31`,
      moneda: "USD",
      cliente_nombre: cliente.nombre || "",
      cliente_email: cliente.email || "",
      creada: new Date().toISOString(),
    };

    const docRef = await collectionFacturas.add(nuevaFactura);

    return res.status(200).json({ id: docRef.id, ...nuevaFactura });
  } catch (error) {
    console.error("Error al regenerar factura:", error);
    return res.status(500).json({ error: "Error al regenerar factura" });
  }
});
