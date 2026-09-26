require('dotenv').config({ quiet: true });

function need(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var ${key} (see .env.example)`);
  return v;
}

module.exports = {
  port: Number(process.env.PORT) || 8080,
  // AlmaEd's Supabase Postgres: the relay reads teachers, students and batches from it and
  // writes the relayed-message log back. Admin edits everything on the AlmaEd site.
  databaseUrl: need('DATABASE_URL'),
  gowaUrl: need('GOWA_BASE_URL').replace(/\/$/, ''),
  gowaBasicAuth: need('GOWA_BASIC_AUTH'),
  teacherDevice: need('TEACHER_DEVICE_ID'),
  studentDevice: need('STUDENT_DEVICE_ID'),
  webhookSecret: need('WEBHOOK_SECRET'),
  adminJid: need('ADMIN_WA_JID'),
  adminToken: need('ADMIN_TOKEN'),
  notesSlaHours: Number(process.env.NOTES_SLA_HOURS) || 24,
  reminderGapHours: Number(process.env.REMINDER_GAP_HOURS) || 12,
  testHourIst: Number(process.env.TEST_HOUR_IST ?? 11),
  countryCode: process.env.DEFAULT_COUNTRY_CODE || '91',
  // Optional: with both set, the relay triggers the AlmaEd site's reminder emails every 5 minutes.
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
  cronSecret: process.env.CRON_SECRET || '',
};
