const functions = require('@google-cloud/functions-framework');
const express = require('express');
const registerBillingRoutes = require('./facturacion');

const app = express();
app.use(express.json());
registerBillingRoutes(app);

functions.http('api', app); // entrypoint = api
