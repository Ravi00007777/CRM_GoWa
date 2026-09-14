const H = 3600e3;
const IST = 330 * 60e3; // India has no DST, so a fixed offset is exact

// Notes are due SLA hours after class. Test is the first Sunday strictly after class (IST); result due SLA hours after test.
function dueDates(heldAt, slaHours, testHourIst) {
  const held = new Date(heldAt);
  if (Number.isNaN(held.getTime())) throw new Error('held_at must be an ISO date, e.g. 2026-09-15T17:00:00+05:30');
  const ist = new Date(held.getTime() + IST);
  const daysToSunday = 7 - ist.getUTCDay(); // Sunday -> 7 (next week), Saturday -> 1
  const testAt = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + daysToSunday, testHourIst) - IST;
  return {
    held_at: held.toISOString(),
    notes_due_at: new Date(held.getTime() + slaHours * H).toISOString(),
    test_result_due_at: new Date(testAt + slaHours * H).toISOString(),
  };
}

module.exports = { dueDates };
