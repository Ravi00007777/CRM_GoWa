const express = require('express');
const cfg = require('./config');
const { handleWebhook } = require('./relay');
const groups = require('./groups');
const outbox = require('./outbox');
const reminders = require('./reminders');

const app = express();

// Raw bytes are kept for HMAC verification; JSON parsing alone would change them.
app.post('/webhook', express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }), handleWebhook);
// Admin lives on the AlmaEd site now, so the relay serves only the webhook and a health check.
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(cfg.port, () => console.log(`AlmaEd WhatsApp relay listening on :${cfg.port}`));
// Creates the WhatsApp groups for any pair added on the AlmaEd site that has none yet.
groups.start();
// Sends what teachers write on the AlmaEd site to the students' WhatsApp groups.
outbox.start();
// Teacher WhatsApp reminders ~3 hours before each class, and the site's reminder emails.
reminders.start();
