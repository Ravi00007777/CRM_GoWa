// A dropped idle database connection must not crash the relay.
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
  GOWA_BASE_URL: 'http://gowa.test', GOWA_BASIC_AUTH: 'u:p',
  TEACHER_DEVICE_ID: 'teacher', STUDENT_DEVICE_ID: 'student', WEBHOOK_SECRET: 's3cret',
  ADMIN_WA_JID: '910000000000@s.whatsapp.net', ADMIN_TOKEN: 't',
});

const test = require('node:test');
const assert = require('node:assert/strict');
const people = require('../src/people');

test('a pool error is logged, not thrown', () => {
  const err = Object.assign(new Error('connect EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' });
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    people.pool.emit('error', err); // throws "Unhandled 'error' event" without a listener
  } finally {
    console.error = original;
  }
  assert.match(logged.join('\n'), /idle connection dropped: EADDRNOTAVAIL/);
});
