const cfg = require('./config');
const { assertSafeOutbound } = require('./redact');

// gowa accepts several user:pass pairs; the app uses the first.
const AUTH = 'Basic ' + Buffer.from(cfg.gowaBasicAuth.split(',')[0]).toString('base64');
const PHONE_JID = /^\d{11,15}@s\.whatsapp\.net$/; // bare 10-digit numbers fail silently in gowa

async function call(path, { method = 'POST', device, json, form } = {}) {
  const headers = { Authorization: AUTH };
  if (device) headers['X-Device-Id'] = device;
  let body = form;
  if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(cfg.gowaUrl + path, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code && data.code !== 'SUCCESS')) {
    throw new Error(`gowa ${method} ${path} -> HTTP ${res.status} ${data.code || ''} ${data.message || ''}`.trim());
  }
  return data.results;
}

function checkRecipient(jid) {
  if (!PHONE_JID.test(jid)) throw new Error('Recipient must be a country-coded JID like 91XXXXXXXXXX@s.whatsapp.net');
}

async function sendText(device, jid, message) {
  checkRecipient(jid);
  assertSafeOutbound(message);
  return call('/send/message', { device, json: { phone: jid, message } });
}

async function sendFile(device, jid, buffer, filename, caption) {
  checkRecipient(jid);
  assertSafeOutbound(caption);
  const form = new FormData();
  form.append('phone', jid);
  if (caption) form.append('caption', caption);
  form.append('file', new Blob([buffer]), filename);
  return call('/send/file', { device, form });
}

// Webhook media paths look like "statics/media/<chat>/<date>/<file>" and are served by gowa itself.
async function fetchMedia(mediaPath) {
  if (!/^statics\/media\//.test(mediaPath) || mediaPath.includes('..')) throw new Error('Unexpected media path');
  const res = await fetch(`${cfg.gowaUrl}/${mediaPath}`, { headers: { Authorization: AUTH } });
  if (!res.ok) throw new Error(`gowa media download -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const alertAdmin = (text) => sendText(cfg.teacherDevice, cfg.adminJid, `[CRM alert] ${text}`);

// Webhook device_id is the paired account's JID; .env holds gowa device ids. Map one to the other via GET /devices.
const userPart = (s) => String(s ?? '').split('@')[0].split(':')[0];
let deviceUsers = {}; // gowa device id -> JID user part

async function roleOfDevice(deviceId) {
  const match = () => {
    const u = userPart(deviceId);
    for (const [role, id] of [['teacher', cfg.teacherDevice], ['student', cfg.studentDevice]]) {
      if (deviceId === id || (deviceUsers[id] && deviceUsers[id] === u)) return role;
    }
    return null;
  };
  if (match()) return match();
  const devices = (await call('/devices', { method: 'GET' })) || [];
  deviceUsers = Object.fromEntries(devices.map((d) => [d.id, userPart(d.jid)]));
  return match();
}

module.exports = { sendText, sendFile, fetchMedia, alertAdmin, roleOfDevice };
