const functions = require('@google-cloud/functions-framework');
const express = require('express');
const registerBillingRoutes = require('./facturacion');

const app = express();
app.use(express.json());

// Monta /billing (generateLink + webhook)
registerBillingRoutes(app);

// Exporta el handler HTTP para Cloud Run (Functions Framework)
functions.http('api', app);