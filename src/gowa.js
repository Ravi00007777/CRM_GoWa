const cfg = require('./config');
const { assertSafeOutbound } = require('./redact');

// gowa accepts several user:pass pairs; the app uses the first.
const AUTH = 'Basic ' + Buffer.from(cfg.gowaBasicAuth.split(',')[0]).toString('base64');
const PHONE_JID = /^\d{11,15}@s\.whatsapp\.net$/; // bare 10-digit numbers fail silently in gowa
const GROUP_JID = /^\d+@g\.us$/;

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
  // A conversation is carried by a group, so both shapes are valid recipients.
  if (!PHONE_JID.test(jid) && !GROUP_JID.test(jid)) {
    throw new Error('Recipient must be 91XXXXXXXXXX@s.whatsapp.net or a group JID ending @g.us');
  }
}

// Returns the new group's JID. The participants WhatsApp refused to add come back separately:
// a person whose privacy settings block being added is simply left out, with no error, so the
// caller has to check rather than assume everyone is in.
async function createGroup(device, title, participants) {
  participants.forEach((jid) => {
    if (!PHONE_JID.test(jid)) throw new Error(`Cannot add ${jid} to a group: not a phone JID`);
  });
  const r = await call('/group', { device, json: { title, participants } });
  return { jid: r.group_id, missing: r.participant_status?.filter((p) => p.status !== 'success') ?? [] };
}

async function renameGroup(device, jid, name) {
  return call('/group/name', { device, json: { group_id: jid, name } });
}

async function groupParticipants(device, jid) {
  const r = await call('/user/my/groups', { method: 'GET', device });
  const g = (r?.data ?? []).find((x) => x.JID === jid);
  return (g?.Participants ?? []).map((p) => p.PhoneNumber || p.JID);
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

module.exports = { sendText, sendFile, fetchMedia, alertAdmin, roleOfDevice, createGroup, renameGroup, groupParticipants };
