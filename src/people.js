// The relay's view of AlmaEd. Teachers, students and who teaches whom live in AlmaEd's
// Postgres (Supabase); this module reads them and writes the relayed-message log back.
// Nothing here owns data - admin edits everything on the AlmaEd site.
const { Pool } = require('pg');
const cfg = require('./config');
const { toJid } = require('./redact');

// Supabase's pooled connection needs TLS but presents a certificate for its own host,
// which node-postgres rejects by default.
const pool = new Pool({ connectionString: cfg.databaseUrl, ssl: { rejectUnauthorized: false } });

// A teacher is reachable if they are active and have a phone; a student's phone is also
// their parent's, which is how AlmaEd models it. Batch membership is the assignment.
const DIRECTORY = `
  SELECT t.id AS teacher_id, t.name AS teacher, t.phone AS teacher_phone,
         s.id AS student_id, s.name AS student, s."waTag" AS tag, s.phone AS student_phone
  FROM "BatchStudent" bs
  JOIN "Batch" b ON b.id = bs."batchId"
  JOIN "User" t ON t.id = b."teacherId"
  JOIN "User" s ON s.id = bs."studentId"
  WHERE t."isActive" AND s."isActive"
    AND t.phone IS NOT NULL AND s.phone IS NOT NULL AND s."waTag" IS NOT NULL
  ORDER BY s."waTag"`;

// Phones are free text in AlmaEd ("+91 98765 43210"), so they are normalised here rather
// than in SQL. A few dozen people fit in memory; the cache only avoids a query per message.
const TTL = 30e3;
let cache = { at: 0, pairs: [] };

async function directory() {
  if (Date.now() - cache.at < TTL) return cache.pairs;
  const { rows } = await pool.query(DIRECTORY);
  const pairs = [];
  for (const r of rows) {
    // A phone AlmaEd cannot turn into a WhatsApp number is skipped, not guessed at: relaying
    // to the wrong person is worse than not relaying.
    let parent_jid;
    let teacher_jid;
    try {
      parent_jid = toJid(r.student_phone, cfg.countryCode);
      teacher_jid = toJid(r.teacher_phone, cfg.countryCode);
    } catch {
      console.warn(`[people] skipped ${r.student}/${r.teacher}: phone is not a usable number`);
      continue;
    }
    pairs.push({ ...r, parent_jid, teacher_jid });
  }
  cache = { at: Date.now(), pairs };
  return pairs;
}

// Changes made on the AlmaEd site should show up on the next message, not 30 seconds later,
// whenever something has just gone wrong for the sender.
const refresh = () => { cache.at = 0; };

const user = (jid) => String(jid).split('@')[0].split(':')[0];

async function studentsOfTeacher(jid) {
  return (await directory()).filter((p) => user(p.teacher_jid) === user(jid));
}

async function childrenOfParent(jid) {
  return (await directory()).filter((p) => user(p.parent_jid) === user(jid));
}

async function findTeacher(jids) {
  const dir = await directory();
  const hit = dir.find((p) => jids.some((j) => j && user(p.teacher_jid) === user(j)));
  return hit && { id: hit.teacher_id, name: hit.teacher, wa_jid: hit.teacher_jid };
}

async function findParent(jids) {
  const dir = await directory();
  const hit = dir.find((p) => jids.some((j) => j && user(p.parent_jid) === user(j)));
  return hit && { id: hit.student_id, name: hit.student, wa_jid: hit.parent_jid };
}

// Duplicate inbound ids are ignored rather than logged twice, so a gowa webhook retry is safe.
const INSERT = `
  INSERT INTO "WaMessage" (id, "teacherId", "studentId", direction, "waMessageId", "outMessageId", content, status, "sentAt")
  VALUES (gen_random_uuid()::text, $1, $2, $3::"WaDirection", $4, $5, $6, $7::"WaStatus", now())
  ON CONFLICT ("waMessageId") DO NOTHING`;

async function log({ teacherId, studentId, direction, waMessageId, outMessageId, content, status }) {
  await pool.query(INSERT, [teacherId, studentId, direction, waMessageId || null, outMessageId || null, content, status]);
}

// Which conversation an earlier relayed message belonged to, for swipe-replies. Either copy
// of the message resolves to the same pair.
async function pairOfMessage(waId) {
  const { rows } = await pool.query(
    'SELECT "teacherId", "studentId" FROM "WaMessage" WHERE "waMessageId" = $1 OR "outMessageId" = $1 LIMIT 1', [waId]);
  return rows[0] && { teacher_id: rows[0].teacherId, student_id: rows[0].studentId };
}

const seen = async (waId) => (await pool.query('SELECT 1 FROM "WaMessage" WHERE "waMessageId" = $1', [waId])).rowCount > 0;

module.exports = { studentsOfTeacher, childrenOfParent, findTeacher, findParent, log, pairOfMessage, seen, refresh, pool };
