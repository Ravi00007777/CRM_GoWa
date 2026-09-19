const express = require('express');
const cfg = require('./config');
const { handleWebhook } = require('./relay');

const app = express();

// Raw bytes are kept for HMAC verification; JSON parsing alone would change them.
app.post('/webhook', express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }), handleWebhook);
// Admin lives on the AlmaEd site now, so the relay serves only the webhook and a health check.
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(cfg.port, () => console.log(`AlmaEd WhatsApp relay listening on :${cfg.port}`));
