// Google Sheets admin panel. Admin edits the input columns of Teachers/Students/Classes;
// every minute the app upserts them into SQLite and writes ids, status columns and the chat log back.
const crypto = require('node:crypto');
const fs = require('node:fs');
const cron = require('node-cron');
const db = require('./db');
const cfg = require('./config');
const { toJid } = require('./redact');
const { dueDates } = require('./schedule');

const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const IST = 330 * 60e3; // sheet time zone must be GMT+05:30
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TABS = {
  Teachers: [['id', 'name', 'phone', 'payout_email', 'sync_error']],
  Students: [['id', 'name', 'parent_phone', 'parent_payment_email', 'grade', 'sync_error']],
  Classes: [['id', 'teacher_id', 'student_id', 'held_at (IST, e.g. 2026-09-15 17:00)', 'meet_link',
    'held_at_ist', 'teacher', 'student', 'notes_due', 'notes_sent', 'result_due', 'result_sent',
    'notes_reminders', 'result_reminders', 'needs_followup', 'sync_error']],
  Messages: [['class_id', 'time_ist', 'direction', 'status', 'content (redacted)']],
  Schedule: [[`=QUERY(Classes!A:P, "select A, G, H, F, E, J, L, O where F >= '" & TEXT(NOW(), "yyyy-mm-dd hh:mm") & "' order by F", 1)`]],
  FollowUp: [['=QUERY(Classes!A:P, "select A, G, H, F, I, J, K, L, M, N where O = 1 order by F desc", 1)']],
  ClassDetail: [
    ['Class id:', '', '=IF(B1="", "", QUERY(Classes!A:P, "select G, H, F, E, J, L, O where A = " & B1, 1))'],
    [],
    ['=IF(B1="", "Type a class id in B1", QUERY(Messages!A:E, "select B, C, D, E where A = " & B1 & " order by B", 1))'],
  ],
};

// ---- auth: service-account JWT, signed with node:crypto (no googleapis dependency) ----
let token = { value: '', exp: 0 };
async function accessToken() {
  if (Date.now() < token.exp - 60e3) return token.value;
  const key = JSON.parse(fs.readFileSync(cfg.googleKeyFile, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google auth failed: ${data.error_description || data.error || res.status}`);
  token = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return token.value;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + cfg.sheetId + path, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sheets ${method} ${path.split('?')[0]} -> ${res.status} ${data.error?.message || ''}`);
  return data;
}

const write = (data, valueInputOption = 'RAW') => data.length && api('/values:batchUpdate', { method: 'POST', body: { valueInputOption, data } });

// ---- time helpers ----
function parseSheetTime(v) {
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400e3) - IST).toISOString(); // Sheets serial date
  const m = String(v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) throw new Error('held_at must look like 2026-09-15 17:00');
  return new Date(Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5]) - IST).toISOString();
}
const ist = (iso) => (iso ? new Date(Date.parse(iso) + IST).toISOString().slice(0, 16).replace('T', ' ') : '');

// ---- sync ----
const cell = (v) => (v === undefined || v === null ? '' : String(v).trim());

function syncPeople(rows, tab, upsert) {
  const out = [];
  rows.forEach((r, i) => {
    const row = i + 2;
    if (!cell(r[1]) && !cell(r[2])) return; // blank row
    const errCol = tab === 'Teachers' ? 'E' : 'F';
    try {
      const id = upsert(r);
      if (cell(r[0]) !== String(id)) out.push({ range: `${tab}!A${row}`, values: [[id]] });
      out.push({ range: `${tab}!${errCol}${row}`, values: [['']] });
    } catch (err) {
      out.push({ range: `${tab}!${errCol}${row}`, values: [[err.message]] });
    }
  });
  return out;
}

function need(value, name) {
  if (!cell(value)) throw new Error(`${name} is required`);
  return cell(value);
}
function email(v) {
  if (cell(v) && !EMAIL_OK.test(cell(v))) throw new Error('invalid email');
  return cell(v) || null;
}
const idOrNull = (v) => (cell(v) ? Number(v) : null);
const friendly = (err) => (String(err.code).startsWith('SQLITE_CONSTRAINT_UNIQUE') ? new Error('this phone number is already used by another row') : err);

const upsertTeacher = (r) => {
  try {
    return db.prepare(`INSERT INTO teachers (id, name, wa_jid, payout_email) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, wa_jid = excluded.wa_jid, payout_email = excluded.payout_email
      RETURNING id`).get(idOrNull(r[0]), need(r[1], 'name'), toJid(need(r[2], 'phone'), cfg.countryCode), email(r[3])).id;
  } catch (err) { throw friendly(err); }
};

const upsertStudent = (r) => {
  try {
    return db.prepare(`INSERT INTO students (id, name, parent_wa_jid, parent_payment_email, grade) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_wa_jid = excluded.parent_wa_jid,
        parent_payment_email = excluded.parent_payment_email, grade = excluded.grade
      RETURNING id`).get(idOrNull(r[0]), need(r[1], 'name'), toJid(need(r[2], 'parent_phone'), cfg.countryCode), email(r[3]), cell(r[4]) || null).id;
  } catch (err) { throw friendly(err); }
};

function upsertClass(r) {
  const teacherId = Number(need(r[1], 'teacher_id'));
  const studentId = Number(need(r[2], 'student_id'));
  if (!db.prepare('SELECT 1 FROM teachers WHERE id = ?').get(teacherId)) throw new Error(`no teacher with id ${teacherId}`);
  if (!db.prepare('SELECT 1 FROM students WHERE id = ?').get(studentId)) throw new Error(`no student with id ${studentId}`);
  const due = dueDates(parseSheetTime(need(r[3], 'held_at')), cfg.notesSlaHours, cfg.testHourIst);
  const existing = idOrNull(r[0]) && db.prepare('SELECT held_at FROM classes WHERE id = ?').get(idOrNull(r[0]));
  if (existing) {
    db.prepare('UPDATE classes SET teacher_id = ?, student_id = ?, meet_link = ? WHERE id = ?')
      .run(teacherId, studentId, cell(r[4]) || null, idOrNull(r[0]));
    if (existing.held_at !== due.held_at) { // rescheduled: move due dates too
      db.prepare('UPDATE classes SET held_at = ?, notes_due_at = ?, test_result_due_at = ? WHERE id = ?')
        .run(due.held_at, due.notes_due_at, due.test_result_due_at, idOrNull(r[0]));
    }
    return idOrNull(r[0]);
  }
  return db.prepare(`INSERT INTO classes (id, teacher_id, student_id, held_at, meet_link, notes_due_at, test_result_due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(idOrNull(r[0]), teacherId, studentId, due.held_at, cell(r[4]) || null, due.notes_due_at, due.test_result_due_at).id;
}

const classStatus = db.prepare(`
  SELECT c.*, t.name AS teacher, s.name AS student FROM classes c
  JOIN teachers t ON t.id = c.teacher_id JOIN students s ON s.id = c.student_id WHERE c.id = ?`);

async function syncOnce() {
  const { valueRanges } = await api('/values:batchGet?ranges=Teachers!A2:E&ranges=Students!A2:F&ranges=Classes!A2:E' +
    '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
  const [teachers, students, classes] = valueRanges.map((v) => v.values || []);

  // ponytail: rows are matched by position between read and write; if the admin re-sorts a tab mid-sync,
  // one minute of write-backs can land on the wrong rows (fixed on the next sync). Use a row-id lock if that bites.
  const updates = [...syncPeople(teachers, 'Teachers', upsertTeacher), ...syncPeople(students, 'Students', upsertStudent)];

  classes.forEach((r, i) => {
    const row = i + 2;
    if (!cell(r[1]) && !cell(r[2]) && !cell(r[3])) return;
    try {
      const c = classStatus.get(upsertClass(r));
      updates.push({ range: `Classes!A${row}`, values: [[c.id]] });
      updates.push({ range: `Classes!F${row}:P${row}`, values: [[ist(c.held_at), c.teacher, c.student,
        ist(c.notes_due_at), ist(c.notes_sent_at), ist(c.test_result_due_at), ist(c.test_result_sent_at),
        c.reminder_count, c.test_reminder_count, c.needs_followup, '']] });
    } catch (err) {
      updates.push({ range: `Classes!P${row}`, values: [[err.message]] });
    }
  });
  await write(updates);

  // Chat log: newest 2000 redacted messages, rewritten each sync.
  const log = db.prepare(`SELECT class_id, sent_at, direction, status, content FROM messages
    ORDER BY sent_at DESC LIMIT 2000`).all().map((m) => [m.class_id ?? '', ist(m.sent_at), m.direction, m.status, m.content ?? '']);
  await api('/values/Messages!A2:E:clear', { method: 'POST', body: {} });
  await write([{ range: 'Messages!A2', values: log }]);
}

async function ensureTabs() {
  const { sheets = [] } = await api('?fields=sheets.properties.title');
  const have = new Set(sheets.map((s) => s.properties.title));
  const missing = Object.keys(TABS).filter((t) => !have.has(t));
  if (!missing.length) return;
  await api(':batchUpdate', { method: 'POST', body: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
  await write(missing.map((t) => ({ range: `${t}!A1`, values: TABS[t] })), 'USER_ENTERED');
  console.log(`[sheets] created tabs: ${missing.join(', ')}`);
}

function start() {
  if (!cfg.sheetId) return console.log('[sheets] GOOGLE_SHEET_ID not set, Sheets admin panel disabled');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await syncOnce(); } catch (err) { console.error('[sheets] sync failed:', err.message); } finally { running = false; }
  };
  ensureTabs().then(tick, (err) => console.error('[sheets] setup failed:', err.message));
  cron.schedule('* * * * *', tick);
}

module.exports = { start, syncOnce, ensureTabs, parseSheetTime, ist };
