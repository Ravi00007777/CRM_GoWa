// Pure functions only (no config/db) so they can be tested in isolation.

// >=10 digits, allowing whitespace/dashes/dots/parens between them: "98765 43210", "+91-98765-43210", "(987) 654.3210".
// ponytail: catches spaced/dashed digits, not spelled-out numbers ("nine eight seven..."); add a word-digit pass if that shows up.
const PHONE = /\+?\d(?:[\s\-.()]*\d){9,}/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const WA_LINK = /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\/\S*/gi;
const JID = /\d+(?::\d+)?@(?:s\.whatsapp\.net|lid|c\.us)/gi;

const MARK = /\[(?:number|email|link) removed\]/g;

// Fees and payments are between the family and AlmaEd, never teacher and student. Kept in step
// with src/lib/contact-filter.ts on the website.
// ponytail: word lists, not understanding. A message is payment talk if it has a payment word, or
// a money word together with a send/give word ("paise bhej do", "₹500 transfer karo", "টাকা পাঠাও").
// Money words alone ("50 paise ka sikka", "paid Rs 500 for a pen") are left alone: they turn up
// in maths problems. Add words as real payment messages slip through; an AI check if lists can't keep up.
// Word edges are Unicode-aware, since \b only understands English letters.
const words = (alts) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{M}])`, 'iu');
const SUFFIX = '[\\p{L}\\p{M}]*';
const PAYMENT = words([
  'fees?', 'payments?', 'upi', 'g-?pay', 'google ?pay', 'phone ?pe', 'paytm', 'bhim', 'ifsc',
  'bank (?:account|details|transfer)', 'account (?:number|no)', 'a/c', 'refund', 'transaction', 'send money', 'qr code',
  'फीस', 'शुल्क', 'भुगतान', 'पेमेंट', 'ফি', 'পেমেন্ট',
]);
const MONEY = words([
  'pais[ae]y?', 'paiso', 'pe?ise', 'rupa[iy]?y?e', 'rupaiya', 'rupiy?a', 'rupya', 'rupees?', 'rs\\.?', 'inr', 'money', 'cash', '₹',
  'पैस' + SUFFIX, 'रुपये', 'रुपए', 'रुपया', 'रूपये', 'रूपए', 'रकम', 'টাকা', 'పైసలు', 'డబ్బు' + SUFFIX, 'பணம்', 'காசு', 'ಹಣ',
  'പണം', 'પૈસા', 'રૂપિયા', 'ਪੈਸੇ', 'ਰੁਪਏ', 'پیسے', 'روپے',
]);
const GIVE = words([
  'bhej' + SUFFIX, 'send' + SUFFIX, 'sent', 'transfer' + SUFFIX, 'de ?do', 'de ?dena', 'dijiye', 'dena', 'dene',
  'jama', 'deposit' + SUFFIX, 'chahiye', 'lage?ga', 'lagenge', 'bharo', 'bharna',
  'भेज' + SUFFIX, 'दे ?दो', 'दीजिए', 'देना', 'जमा', 'चाहिए', 'भरो', 'পাঠা' + SUFFIX, 'দাও', 'দিন',
  'அனுப்ப' + SUFFIX, 'கொடு' + SUFFIX, 'పంప' + SUFFIX, 'ఇవ్వ' + SUFFIX, 'ಕಳುಹಿಸ' + SUFFIX, 'ಕೊಡ' + SUFFIX,
  'അയക്ക' + SUFFIX, 'મોકલ' + SUFFIX, 'આપો', 'ਭੇਜ' + SUFFIX, 'بھیج' + SUFFIX, 'دے دو',
]);
// A UPI ID: like an email but with no dot after the @ ("diya@okaxis", "98765@ybl").
const UPI_ID = /[\w.-]{2,}@[a-z]{2,}\b(?!\.)/i;
// strict (a teacher writing): any money word is enough. Teachers have no reason to mention money
// to a student, and a false alarm only costs them a rephrase.
function mentionsPayment(input, { strict = false } = {}) {
  const s = String(input ?? '');
  return PAYMENT.test(s) || UPI_ID.test(s) || (MONEY.test(s) && (strict || GIVE.test(s)));
}

// Returns { text, flagged }. flagged = something was removed AND nothing meaningful is left -> don't relay.
function redact(input) {
  const raw = String(input ?? '');
  const text = raw
    .replace(JID, '[number removed]')
    .replace(WA_LINK, '[link removed]')
    .replace(EMAIL, '[email removed]')
    .replace(PHONE, '[number removed]');
  const leftover = text.replace(MARK, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return { text, flagged: text !== raw && leftover === '' };
}

const test = (re, s) => { re.lastIndex = 0; return re.test(s); };

// Last line of defence on every outbound message: never a payment email next to a number/JID.
function assertSafeOutbound(text) {
  const s = String(text ?? '');
  if (test(EMAIL, s) && (test(PHONE, s) || test(JID, s))) {
    throw new Error('Refusing to send: outbound text contains both an email and a phone number/JID');
  }
}

// "98765 43210" / "919876543210" / "91...@s.whatsapp.net" -> "919876543210@s.whatsapp.net". Throws if no country code.
function toJid(value, countryCode) {
  let digits = String(value ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (digits.length === 10 && countryCode) digits = countryCode + digits;
  if (digits.length < 11 || digits.length > 15) {
    throw new Error('Phone must include country code, e.g. 91XXXXXXXXXX');
  }
  return `${digits}@s.whatsapp.net`;
}

module.exports = { redact, mentionsPayment, assertSafeOutbound, toJid };
