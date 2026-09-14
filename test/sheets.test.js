// Sheets sync against a fake Google API. Own file = own process = own in-memory DB.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-')), 'sa.json');
fs.writeFileSync(keyFile, JSON.stringify({ client_email: 'crm@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));

Object.assign(process.env, {
  DB_PATH: ':memory:', GOWA_BASE_URL: 'http://gowa.test', GOWA_BASIC_AUTH: 'u:p', TEACHER_DEVICE_ID: 'teacher',
  STUDENT_DEVICE_ID: 'student', WEBHOOK_SECRET: 's', ADMIN_WA_JID: '910000000000@s.whatsapp.net', ADMIN_TOKEN: 't',
  NOTES_SLA_HOURS: '24', TEST_HOUR_IST: '11', GOOGLE_SHEET_ID: 'SHEET', GOOGLE_SERVICE_ACCOUNT_FILE: keyFile,
});

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { syncOnce, parseSheetTime, ist } = require('../src/sheets');

let sheet;
const writes = [];
global.fetch = async (url, opts = {}) => {
  if (url === 'https://oauth2.googleapis.com/token') {
    const [h, p, sig] = new URLSearchParams(opts.body.toString()).get('assertion').split('.');
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')), 'JWT signature');
    return Response.json({ access_token: 'tok', expires_in: 3600 });
  }
  assert.equal(opts.headers.Authorization, 'Bearer tok');
  if (url.includes('values:batchGet')) return Response.json({ valueRanges: sheet.map((values) => ({ values })) });
  if (url.includes('values:batchUpdate')) writes.push(...JSON.parse(opts.body).data);
  return Response.json({});
};
const cellAt = (range) => writes.filter((w) => w.range === range).at(-1)?.values;

test('sheet time parsing: typed text and Sheets serial dates are IST', () => {
  assert.equal(parseSheetTime('2026-09-15 17:00'), '2026-09-15T11:30:00.000Z');
  assert.equal(parseSheetTime(46280.7083333333), '2026-09-15T11:30:00.000Z'); // 2026-09-15 17:00 as a serial
  assert.throws(() => parseSheetTime('15/9/2026'));
  assert.equal(ist('2026-09-15T11:30:00.000Z'), '2026-09-15 17:00');
});

test('sync: rows -> DB, ids + status + errors written back, edits update in place', async () => {
  sheet = [
    [['', 'Asha', 9876543210, 'asha@pay.in'], ['', 'Bad', '12345']], // phone typed as a number in Sheets
    [['', 'Diya', '+91 87654 32109', 'p@pay.in', 8]],
    [['', 1, 1, '2026-09-15 17:00', 'https://meet.google.com/abc-defg-hij'], ['', 1, 99, '2026-09-15 18:00']],
  ];
  await syncOnce();

  assert.equal(db.prepare('SELECT wa_jid FROM teachers WHERE id = 1').get().wa_jid, '919876543210@s.whatsapp.net');
  assert.deepEqual(cellAt('Teachers!A2'), [[1]]);
  assert.match(cellAt('Teachers!E3')[0][0], /country code/);
  assert.deepEqual(cellAt('Students!A2'), [[1]]);
  assert.deepEqual(cellAt('Classes!F2:P2'), [['2026-09-15 17:00', 'Asha', 'Diya', '2026-09-16 17:00', '',
    '2026-09-21 11:00', '', 0, 0, 0, '']]);
  assert.deepEqual(cellAt('Classes!P3'), [['no student with id 99']]);

  // Admin renames teacher and reschedules the class -> same ids, due dates move.
  writes.length = 0;
  sheet[0][0] = [1, 'Asha K', 9876543210, 'asha@pay.in'];
  sheet[2][0] = [1, 1, 1, '2026-09-16 17:00', 'https://meet.google.com/abc-defg-hij'];
  await syncOnce();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM teachers').get().n, 1);
  assert.equal(db.prepare('SELECT name FROM teachers WHERE id = 1').get().name, 'Asha K');
  assert.equal(cellAt('Classes!F2:P2')[0][3], '2026-09-17 17:00');
});
