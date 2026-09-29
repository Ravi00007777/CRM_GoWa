// Each teacher-student conversation has one WhatsApp group: the student, their parent (if the
// site has a number), the admin and the student-facing number. The teacher is never in it and works only on the AlmaEd site: what
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

const SELECT = `SELECT "teacherId", "studentId", "teacherGroupJid", "studentGroupJid", note, "groupName",
    "studentGroupInvite", "existingGroup", "wantsNewGroup", "groupTopicLink", "parentJidAdded", "removeGroup"
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
const userPart = (j) => String(j ?? '').split('@')[0].split(':')[0];

// Admin removed the batch. WhatsApp has no "delete group", so the relay empties it (everyone but
// itself and admin) and leaves; a family's own linked group is only left, never emptied. Then the
// ids are cleared, so the student can get a fresh group if they join another batch.
async function removeGroups(c) {
  const sides = [[cfg.studentDevice, c.studentGroupJid, !c.existingGroup], [cfg.teacherDevice, c.teacherGroupJid, true]];
  for (const [device, jid, empty] of sides) {
    if (!jid) continue;
    if (empty) {
      const keep = [...(await gowa.ownIds(device)), userPart(adminJid())];
      const others = (await gowa.groupParticipants(device, jid)).filter((p) => !keep.includes(userPart(p)));
      if (others.length) await gowa.removeParticipants(device, jid, others);
    }
    await gowa.leaveGroup(device, jid);
  }
}

const CLEARED = `UPDATE "WaConversation" SET "removeGroup" = false, "studentGroupJid" = NULL, "teacherGroupJid" = NULL,
    "existingGroup" = false, "wantsNewGroup" = false, "groupName" = NULL, "groupTopicLink" = NULL,
    "parentJidAdded" = NULL, note = NULL, "updatedAt" = now()
  WHERE "teacherId" = $1 AND "studentId" = $2`;

// Creates the student group for one pair. Anyone WhatsApp refuses to add - their "who can add me
// to groups" setting - is recorded rather than swallowed, because the group otherwise looks
// fine and simply never reaches them.
async function createFor(pair) {
  const notes = [];
  const make = async (device, title, people) => {
    const { jid, missing } = await gowa.createGroup(device, title, [...people, adminJid()]);
    for (const m of missing) notes.push(`${m.jid || m.phone}: ${m.status || 'not added'}`);
    return jid;
  };

  // The group carries the batch's name, so it is recognisable as what admin sees on the site.
  const teacherGroup = null;
  const studentGroup = await make(cfg.studentDevice, pair.batch, [pair.student_jid, pair.parent_jid].filter(Boolean));

  await people.pool.query(
    `INSERT INTO "WaConversation" (id, "teacherId", "studentId", "teacherGroupJid", "studentGroupJid", note, "groupName", "parentJidAdded", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT ("teacherId", "studentId") DO UPDATE
       SET "teacherGroupJid" = EXCLUDED."teacherGroupJid",
           "studentGroupJid" = EXCLUDED."studentGroupJid", "wantsNewGroup" = false,
           "parentJidAdded" = EXCLUDED."parentJidAdded",
           note = EXCLUDED.note, "groupName" = EXCLUDED."groupName", "updatedAt" = now()`,
    [pair.teacher_id, pair.student_id, teacherGroup, studentGroup, notes.join('; ') || null, pair.batch, pair.parent_jid || null],
  );
  refresh();
  return { teacherGroup, studentGroup, notes };
}

// Admin pasted the invite link of a group the student already has (on the AlmaEd site). The
// student-facing number joins it and the pair switches to it; a group the relay had made for the
// pair before is left, so it goes quiet. The old group is used as it is and never renamed.
async function linkExisting(c) {
  const jid = await gowa.joinGroupWithLink(cfg.studentDevice, c.studentGroupInvite);
  await people.pool.query(
    `UPDATE "WaConversation" SET "studentGroupJid" = $3, "studentGroupInvite" = NULL, "existingGroup" = true,
       note = NULL, "updatedAt" = now() WHERE "teacherId" = $1 AND "studentId" = $2`,
    [c.teacherId, c.studentId, jid]);
  refresh();
  if (c.studentGroupJid && c.studentGroupJid !== jid) {
    await gowa.leaveGroup(cfg.studentDevice, c.studentGroupJid)
      .catch((err) => console.error(`[groups] could not leave ${c.studentGroupJid}:`, err.message));
  }
  return jid;
}

// The student group's description, from the batch's three links on the AlmaEd site - the same
// text the site previews to admin (edtech-platform src/lib/group-description.ts).
function groupDescription(pair) {
  const parts = [];
  if (pair.meet_link) parts.push(`Join classes using this Google Meet link: ${pair.meet_link}`);
  if (pair.schedule_sheet_link) parts.push(`Class&AssignmentSchedule- \n${pair.schedule_sheet_link}`);
  if (pair.drive_link) parts.push(`Assignment and notes docs:\n${pair.drive_link}`);
  return parts.join('\n\n');
}

const setNote = async (c, note, extra = '') => {
  await people.pool.query(
    `UPDATE "WaConversation" SET note = $3${extra}, "updatedAt" = now() WHERE "teacherId" = $1 AND "studentId" = $2`,
    [c.teacherId, c.studentId, note]);
  refresh();
};

// Called on a timer. Groups are made only when admin asked for one on the batch page
// (wantsNewGroup), or joined when admin pasted an existing group's link - never just because a
// batch exists. Creating a group is slow and rate-limited by WhatsApp, so one per pass.
async function reconcile() {
  const existing = await conversations();

  // Removed batches first: nothing else should touch a group that is going away.
  for (const c of existing) {
    if (!c.removeGroup) continue;
    try {
      await removeGroups(c);
      console.log(`[groups] removed the groups of ${c.teacherId} / ${c.studentId}`);
    } catch (err) {
      // Not retried every pass: the batch page is gone, so admin is told on WhatsApp instead.
      console.error(`[groups] could not remove the groups of ${c.teacherId} / ${c.studentId}:`, err.message);
      await gowa.alertAdmin(`A removed batch's WhatsApp group could not be emptied (${err.message}). ` +
        'Remove the student and parent from it by hand.').catch(() => {});
    }
    await people.pool.query(CLEARED, [c.teacherId, c.studentId]);
    refresh();
    return; // one per pass
  }

  // Existing groups admin linked come first, so no new group is made for those students.
  for (const c of existing) {
    if (!c.studentGroupInvite) continue;
    try {
      const jid = await linkExisting(c);
      console.log(`[groups] linked existing group ${jid} for student ${c.studentId}`);
    } catch (err) {
      // Not retried every minute: the link is cleared and admin sees why on the batch page.
      const note = `Could not join the existing WhatsApp group: ${err.message}. Check the invite link and paste it again.`;
      await people.pool.query(
        `UPDATE "WaConversation" SET "studentGroupInvite" = NULL, note = $3, "updatedAt" = now()
         WHERE "teacherId" = $1 AND "studentId" = $2`, [c.teacherId, c.studentId, note]);
      refresh();
      console.error(`[groups] ${note}`);
      await gowa.alertAdmin(note).catch(() => {});
    }
    return; // one per pass
  }

  for (const c of existing) {
    if (!c.wantsNewGroup || c.studentGroupJid || c.studentGroupInvite) continue;
    const pair = await people.pairOf(c.teacherId, c.studentId);
    if (!pair) {
      // Stays requested: made as soon as the missing details are filled in on the site.
      if (!c.note) {
        await setNote(c, 'Waiting to create the WhatsApp group: the student needs a phone number and a WhatsApp tag, and the teacher a phone number.');
      }
      continue;
    }
    try {
      const { studentGroup, notes } = await createFor(pair);
      console.log(`[groups] ${pair.teacher} / ${pair.student}: ${studentGroup}`);
      if (notes.length) {
        await gowa.alertAdmin(`${pair.teacher} / ${pair.student}: WhatsApp would not add ` +
          `${notes.join('; ')}. Invite them to the group by hand.`).catch(() => {});
      }
    } catch (err) {
      // Not retried every minute: admin sees why on the batch page and can ask again.
      await setNote(c, `Could not create the WhatsApp group: ${err.message}. Try again from the batch page.`, ', "wantsNewGroup" = false');
      console.error(`[groups] could not set up ${pair.teacher} / ${pair.student}:`, err.message);
    }
    return; // one per pass
  }

  // A batch renamed on the site renames its groups, so they never drift apart.
  for (const c of existing) {
    const pair = await people.pairOf(c.teacherId, c.studentId);
    if (!pair || !pair.batch || pair.batch === c.groupName || c.existingGroup) continue;
    try {
      if (c.teacherGroupJid) await gowa.renameGroup(cfg.teacherDevice, c.teacherGroupJid, pair.batch);
      if (c.studentGroupJid) await gowa.renameGroup(cfg.studentDevice, c.studentGroupJid, pair.batch);
      await people.pool.query('UPDATE "WaConversation" SET "groupName" = $1, "updatedAt" = now() WHERE "teacherId" = $2 AND "studentId" = $3',
        [pair.batch, c.teacherId, c.studentId]);
      refresh();
      console.log(`[groups] renamed ${pair.teacher} / ${pair.student} to "${pair.batch}"`);
    } catch (err) {
      // Not retried every pass: one stuck group would stall every later rename, topic and parent sync.
      await people.pool.query('UPDATE "WaConversation" SET "groupName" = $1, note = $4, "updatedAt" = now() WHERE "teacherId" = $2 AND "studentId" = $3',
        [pair.batch, c.teacherId, c.studentId, `Could not rename the WhatsApp group to "${pair.batch}": ${err.message}. Rename it by hand in WhatsApp.`]);
      refresh();
      console.error(`[groups] rename failed for ${pair.student}:`, err.message);
    }
    return; // one per pass
  }

  if (await syncTopics(existing)) return;
  await syncParents(existing);
}

// Admin added, changed or removed a student's parent number on the site: bring the group in
// line (a replaced number is removed from it). parentJidAdded is what was last done.
async function syncParents(existing) {
  for (const c of existing) {
    if (!c.studentGroupJid) continue;
    const pair = await people.pairOf(c.teacherId, c.studentId);
    if (!pair) continue;
    const want = pair.parent_jid || null;
    if (want === (c.parentJidAdded || null)) continue;
    let note = null;
    try {
      if (c.parentJidAdded && c.parentJidAdded !== want) {
        await gowa.removeParticipants(cfg.studentDevice, c.studentGroupJid, [c.parentJidAdded]).catch(() => {});
      }
      if (want) {
        const { missing } = await gowa.addParticipants(cfg.studentDevice, c.studentGroupJid, [want]);
        if (missing.length) note = `WhatsApp would not add the parent (${want.split('@')[0]}), probably their privacy settings. Invite them to the group by hand.`;
      }
    } catch (err) {
      note = `Could not add the parent to the WhatsApp group: ${err.message}. Make the student number a group admin, or add them by hand.`;
    }
    await people.pool.query(
      `UPDATE "WaConversation" SET "parentJidAdded" = $3, note = COALESCE($4, note), "updatedAt" = now()
       WHERE "teacherId" = $1 AND "studentId" = $2`, [c.teacherId, c.studentId, want, note]);
    refresh();
    if (note) await gowa.alertAdmin(`${pair.student}: ${note}`).catch(() => {});
    return; // one per pass
  }
}

// Admin saved the batch's links on the site: rewrite the group description to match.
// groupTopicLink holds the description last written, so each change is written once.
async function syncTopics(existing) {
  // Off until admin has filled in each batch's links; set GROUP_DESCRIPTIONS=on in .env to start.
  if (process.env.GROUP_DESCRIPTIONS !== 'on') return false;
  for (const c of existing) {
    if (!c.studentGroupJid) continue;
    const pair = await people.pairOf(c.teacherId, c.studentId);
    if (!pair) continue;
    const want = groupDescription(pair);
    if (!want || want === (c.groupTopicLink || '')) continue;
    try {
      await gowa.setGroupTopic(cfg.studentDevice, c.studentGroupJid, want);
      console.log(`[groups] description of ${c.studentGroupJid} updated from the batch links`);
    } catch (err) {
      // Not retried every minute: usually the group only lets admins edit its info.
      await setNote(c, `Could not update the WhatsApp group description (${err.message}). ` +
        'Make the student number a group admin, or copy the description from the batch page by hand.');
    }
    await people.pool.query(
      'UPDATE "WaConversation" SET "groupTopicLink" = $3, "updatedAt" = now() WHERE "teacherId" = $1 AND "studentId" = $2',
      [c.teacherId, c.studentId, want]);
    refresh();
    return true; // one per pass
  }
  return false;
}

function start() {
  const tick = () => reconcile().catch((err) => console.error('[groups] reconcile failed:', err.message));
  setInterval(tick, 60e3).unref();
  setTimeout(tick, 5e3).unref();
}

module.exports = { sideOfGroup, reconcile, createFor, start, refresh, groupDescription };
