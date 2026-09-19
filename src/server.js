const express = require('express');
const cfg = require('./config');
const { handleWebhook } = require('./relay');
const reminders = require('./reminders');

const app = express();

// Raw bytes are kept for HMAC verification; JSON parsing alone would change them.
app.post('/webhook', express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }), handleWebhook);
app.use('/admin', express.json(), require('./admin'));
app.use(express.static(require('node:path').join(__dirname, '../public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(cfg.port, () => console.log(`CRM relay listening on :${cfg.port}`));
reminders.start();
