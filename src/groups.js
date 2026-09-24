// Each teacher-student conversation has one WhatsApp group: the student (parent), the admin and
// the student-facing number. The teacher is never in it and works only on the AlmaEd site: what
// they write there is posted here by the outbox, and what the student writes here lands in the
// site's doubt thread. So the student never sees the teacher's number, and the admin reads along.
//
// Pairs set up earlier also have a teacher group (teacherGroupJid); it is left in place, but
// nothing a teacher types there is relayed any more.
//
// AlmaEd cannot create these itself - once deployed it has no route to gowa, which holds the
// WhatsApp session on a machine at home - so the relay reconciles instead: it looks for pairs
// that have no groups yet and creates them.
const cfg = require('./config');
const gowa = require('./gowa');
const people = require('./people');

const SELECT = `SELECT "teacherId", "studentId", "teacherGroupJid", "studentGroupJid", note, "groupName"
  FROM "WaConversation"`;

let cache = { at: 0, rows: [] };
const TTL = 30e3;

async function conversations() {
  if (Date.now() - cache.at < TTL) return cache.rows;
  const { rows } = await people.pool.query(SELECT);
  cache = { at: Date.now(), rows };
  return rows;
}
const refresh = () => { cache.at = 0; };

// Which conversation a group belongs to, and which side of it the group is.
async function sideOfGroup(jid) {
  for (const c of await conversations()) {
    if (c.teacherGroupJid === jid) return { ...c, isTeacher: true };
    if (c.studentGroupJid === jid) return { ...c, isTeacher: false };
  }
  return null;
}

const adminJid = () => cfg.adminJid;

// Creates the student group for one pair. Anyone WhatsApp refuses to add - their "who can add me
// to groups" setting - is recorded rather than swallowed, because the group otherwise looks
// fine and simply never reaches them.
async function createFor(pair) {
  const notes = [];
  const make = async (device, title, participant) => {
    const { jid, missing } = await gowa.createGroup(device, title, [participant, adminJid()]);
    for (const m of missing) notes.push(`${m.jid || m.phone}: ${m.status || 'not added'}`);
    return jid;
  };

  // The group carries the batch's name, so it is recognisable as what admin sees on the site.
  const teacherGroup = null;
  const studentGroup = await make(cfg.studentDevice, pair.batch, pair.parent_jid);

  await people.pool.query(
    `INSERT INTO "WaConversation" (id, "teacherId", "studentId", "teacherGroupJid", "studentGroupJid", note, "groupName", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT ("teacherId", "studentId") DO UPDATE
       SET "teacherGroupJid" = EXCLUDED."teacherGroupJid",
           "studentGroupJid" = EXCLUDED."studentGroupJid",
           note = EXCLUDED.note, "groupName" = EXCLUDED."groupName", "updatedAt" = now()`,
    [pair.teacher_id, pair.student_id, teacherGroup, studentGroup, notes.join('; ') || null, pair.batch],
  );
  refresh();
  return { teacherGroup, studentGroup, notes };
}

// Called on a timer: every pair in AlmaEd that has no groups yet gets them. Creating a group is
// slow and rate-limited by WhatsApp, so one pair per pass is plenty - a new batch is ready
// within a minute, and a burst of new students cannot trip WhatsApp's limits.
async function reconcile() {
  const existing = await conversations();
  const has = new Set(existing.map((c) => `${c.teacherId}:${c.studentId}`));

  for (const pair of await people.directory()) {
    if (has.has(`${pair.teacher_id}:${pair.student_id}`)) continue;
    try {
      const { studentGroup, notes } = await createFor(pair);
      console.log(`[groups] ${pair.teacher} / ${pair.student}: ${studentGroup}`);
      if (notes.length) {
        await gowa.alertAdmin(`${pair.teacher} / ${pair.student}: WhatsApp would not add ` +
          `${notes.join('; ')}. Invite them to the group by hand.`).catch(() => {});
      }
    } catch (err) {
      console.error(`[groups] could not set up ${pair.teacher} / ${pair.student}:`, err.message);
    }
    return; // one per pass
  }

  // A batch renamed on the site renames its groups, so they never drift apart.
  for (const c of existing) {
    const pair = await people.pairOf(c.teacherId, c.studentId);
    if (!pair || !pair.batch || pair.batch === c.groupName) continue;
    try {
      if (c.teacherGroupJid) await gowa.renameGroup(cfg.teacherDevice, c.teacherGroupJid, pair.batch);
      if (c.studentGroupJid) await gowa.renameGroup(cfg.studentDevice, c.studentGroupJid, pair.batch);
      await people.pool.query('UPDATE "WaConversation" SET "groupName" = $1, "updatedAt" = now() WHERE "teacherId" = $2 AND "studentId" = $3',
        [pair.batch, c.teacherId, c.studentId]);
      refresh();
      console.log(`[groups] renamed ${pair.teacher} / ${pair.student} to "${pair.batch}"`);
    } catch (err) {
      console.error(`[groups] rename failed for ${pair.student}:`, err.message);
    }
    return; // one per pass
  }
}

function start() {
  const tick = () => reconcile().catch((err) => console.error('[groups] reconcile failed:', err.message));
  setInterval(tick, 60e3).unref();
  setTimeout(tick, 5e3).unref();
}

module.exports = { sideOfGroup, reconcile, createFor, start, refresh };
