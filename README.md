# WhatsApp Relay CRM

A WhatsApp relay backend for a tutoring brokerage. Teachers message one WhatsApp number and parents/students message another. Every message goes through this app, which removes contact info and forwards it from the other number, so neither side ever sees the other's real number.

```
teacher phone ──► [teacher number] ─┐                    ┌─ [student number] ◄── parent phone
                                    └► gowa ──webhook──► Express ──send (X-Device-Id)──► gowa ─┘
```

- **gowa** (`go-whatsapp-web-multidevice` v9.3.1, multi-device) holds both paired accounts in one container.
- **Express + better-sqlite3** checks the webhook HMAC, works out who sent the message, redacts it, relays it through the *other* device and writes an audit log.
- **node-cron** checks every 15 minutes for overdue notes or test results.

## Layout

```
docker-compose.yml   gowa container (webhook -> Express on the host)
.env.example         all config; copy to .env (read by both docker compose and the app)
src/server.js        express wiring + cron start
src/relay.js         POST /webhook: HMAC -> device role -> sender -> class -> redact -> relay -> log
src/redact.js        redaction, outbound guard, phone -> JID normalisation (pure)
src/gowa.js          gowa client: send text/file scoped by X-Device-Id, media download, device lookup
src/reminders.js     notes + test-result reminders
src/schedule.js      notes_due_at / test_result_due_at math (Sunday tests, IST)
src/admin.js         token-guarded admin API
src/db.js            schema
test/relay.test.js   node:test suite (mocked gowa, in-memory DB)
```

## 1. Configure

```bash
cp .env.example .env
```

| Var | Meaning |
|---|---|
| `GOWA_BASE_URL` | gowa as seen from the app, e.g. `http://localhost:3002` |
| `GOWA_BASIC_AUTH` | `user:pass` protecting gowa's API. Used by compose and the app |
| `TEACHER_DEVICE_ID` / `STUDENT_DEVICE_ID` | gowa device slot ids you create in step 3 (e.g. `teacher`, `student`) |
| `WEBHOOK_SECRET` | HMAC key for `X-Hub-Signature-256`. Use a long random value: `openssl rand -hex 32` |
| `ADMIN_WA_JID` | Admin's WhatsApp, country code included: `91XXXXXXXXXX@s.whatsapp.net` |
| `ADMIN_TOKEN` | Bearer token for `/admin/*`. Long random value |
| `NOTES_SLA_HOURS` | Notes due this many hours after class; test result due this many hours after the Sunday test. Default 24 |
| `REMINDER_GAP_HOURS` | Gap between reminder 1 and reminder 2. Default 12 |
| `TEST_HOUR_IST` | Hour (IST) the Sunday test starts. Default 11 |
| `DEFAULT_COUNTRY_CODE` | Added to bare 10-digit numbers entered through the admin API. Default 91 |

## 2. Start gowa

Choose one of these. Both use the same `.env`.

**Without Docker (macOS):**
```bash
npm run gowa
```
On first run, `scripts/gowa.sh` downloads the official gowa v9.3.1 macOS build into `gowa/` and checks its checksum. It then starts gowa on the port in `GOWA_BASE_URL`, with its webhook pointed at `http://localhost:$PORT/webhook`. WhatsApp sessions are saved in `gowa/storages` (gitignored), so pairing survives restarts.

**With Docker:**
```bash
docker compose up -d
docker compose logs -f gowa
```
The host port mapping in `docker-compose.yml` must match `GOWA_BASE_URL`. gowa sends webhooks to `http://host.docker.internal:$PORT/webhook`, and sessions are saved in the `gowa_storages` volume.

## 3. Pair both WhatsApp accounts

Do this once per number. Use the gowa basic-auth credentials from `.env`.

```bash
AUTH=admin:change-me   # = GOWA_BASIC_AUTH

# create the two device slots
curl -u $AUTH -X POST localhost:3002/devices -H 'Content-Type: application/json' -d '{"device_id":"teacher"}'
curl -u $AUTH -X POST localhost:3002/devices -H 'Content-Type: application/json' -d '{"device_id":"student"}'

# get a QR code for the teacher slot
curl -u $AUTH localhost:3002/devices/teacher/login
# -> {"results":{"qr_link":"http://localhost:3000/statics/images/qrcode/scan-qr-....png","qr_duration":30}}
```

1. Open `qr_link` in a browser. The QR code expires after about 30 seconds; call `login` again for a fresh one.
2. On the **teacher-facing phone**, open WhatsApp → **Settings → Linked Devices → Link a device** and scan the code.
3. Repeat with `/devices/student/login`, scanning from the **student-facing phone**.
4. Check both slots: `curl -u $AUTH localhost:3002/devices`. Each should show `"state":"logged_in"` and its own `jid`.

The device ids you created (`teacher`, `student`) must match `TEACHER_DEVICE_ID` / `STUDENT_DEVICE_ID`. Webhooks identify the device by its JID; the app maps JIDs back to device ids through `GET /devices`.

## 4. Run the app

```bash
npm install
npm test          # offline suite, no gowa needed
npm start         # listens on $PORT (8080)
```

Add people and a class (phones may be `98765 43210`, `+91-98765-43210` or a full JID; the app stores `91XXXXXXXXXX@s.whatsapp.net`):

```bash
T='Authorization: Bearer <ADMIN_TOKEN>'; J='Content-Type: application/json'
curl -H "$T" -H "$J" localhost:8080/admin/teachers -d '{"name":"Asha","phone":"+91 98765 43210","payout_email":"asha@example.com"}'
curl -H "$T" -H "$J" localhost:8080/admin/students -d '{"name":"Diya","parent_phone":"+91 87654 32109","parent_payment_email":"parent@example.com","grade":"8"}'
curl -H "$T" -H "$J" localhost:8080/admin/classes  -d '{"teacher_id":1,"student_id":1,"held_at":"2026-09-14T16:30:00+05:30","meet_link":"https://meet.google.com/abc-defg-hij"}'
curl -H "$T" "localhost:8080/admin/classes?needs_followup=1"
curl -H "$T" -H "$J" -X PATCH localhost:8080/admin/classes/1 -d '{"needs_followup":0}'
```

Creating a class sets `notes_due_at = held_at + NOTES_SLA_HOURS`. It also sets `test_result_due_at` to `NOTES_SLA_HOURS` after `TEST_HOUR_IST` on the first Sunday strictly after the class.

End-to-end check: text the student number from the parent phone. The teacher phone should receive `Student Diya: ...` from the teacher number.

## Relay rules

| Incoming | What happens |
|---|---|
| Text | Redacted, then relayed as `Teacher <name>: ...` / `Student <name>: ...` |
| Text that is only a phone number, email or wa.me link | Not relayed. Logged as `flagged` |
| Document (PDF etc.) | Caption redacted. File relayed as `class-<id>.<ext>`, so the original filename never leaves the system. From a teacher, it sets `notes_sent_at` |
| Message or caption containing `#result` (teacher) | Keyword removed, relayed as `Teacher <name> - Test result`, sets `test_result_sent_at` |
| Contact card (or `.vcf` document) | Dropped silently and logged as `dropped` |
| Image / video / audio / sticker / location | Dropped. The sender is asked to send text or a PDF instead. Does **not** count as notes delivered |
| Unknown sender | Not relayed. The admin gets an alert that contains no number |
| Sender with no class | The sender is told so and the admin is alerted |

Redaction removes phone-shaped numbers (10 or more digits, even with spaces, dashes, dots or parentheses), emails, `wa.me` / WhatsApp invite links and JIDs. Just before sending, every outbound message is checked once more and refused if it contains both an email and a number/JID. Teachers and students are always paired 1:1, so each message goes to the sender's latest class.

## Reminders

Every 15 minutes, for notes and test results separately:

- Reminder 1 goes to the teacher once the due time has passed and nothing has been sent.
- Reminder 2 goes out `REMINDER_GAP_HOURS` later. It also sets `needs_followup = 1` and alerts `ADMIN_WA_JID`.
- After two reminders, no more are sent. Notes use `reminder_count` and test results use `test_reminder_count`.

## Known limits

- Redaction only sees text. A photo or PDF can still contain a handwritten number or document metadata. Images aren't relayed because of this; PDFs are relayed and trusted.
- Numbers written out as words ("nine eight seven...") are not caught. Strings of 10 or more digits that aren't phone numbers (long IDs) get redacted.
- If WhatsApp reports a sender only by `@lid` with no phone JID in `from`/`from_lid`, that sender counts as unknown and the admin is alerted.
