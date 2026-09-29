const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEmailRouter } = require('../src/routes/emailRoutes');
const { createStatusRouter } = require('../src/routes/statusRoutes');
const whatsapp = require('../src/whatsappClient');
const gmail = require('../src/gmailClient');

process.env.WHATSAPP_WEBHOOK_SECRET = 'unit-test-secret';
const payload = { to: 'reviewer@example.com', subject: 'Floor plan approval', text: 'Review this version.' };
const auth = req => req.set('Authorization', 'Bearer unit-test-secret');
function fixture(t, sendMail) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-plan-email-'));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const env = { GMAIL_USER: gmail.SENDER, GMAIL_APP_PASSWORD: 'test-only', EMAIL_RECEIPTS_PATH: dir };
 let verifies = 0;
 const build = () => express().use(express.json()).use(createEmailRouter({ env, makeTransport: () => ({ sendMail, verify: async () => { verifies++; } }) }));
 return { env, build, get verifies() { return verifies; } };
}
test('Gmail auth required; fixed sender; receipt survives router recreation', async t => {
 let sends = 0;
 const f = fixture(t, async data => {
  sends++;
  assert.equal(data.from.address, 'info@meridianconvention.com');
  assert.equal(data.replyTo, 'info@meridianconvention.com');
  return { accepted: [payload.to], messageId: data.messageId };
 });
 assert.equal((await request(f.build()).post('/send-email').send(payload)).status, 401);
 const send = app => auth(request(app).post('/send-email')).set('X-Idempotency-Key', 'plan-1-kevin-1').send(payload);
 assert.equal((await send(f.build())).body.success, true);
 assert.equal((await send(f.build())).body.cached, true);
 assert.equal(sends, 1);
 const conflict = await auth(request(f.build()).post('/send-email')).set('X-Idempotency-Key', 'plan-1-kevin-1').send({ ...payload, text: 'Another version' });
 assert.equal(conflict.status, 409);
 assert.equal(sends, 1);
 assert.equal((await auth(request(f.build()).post('/verify-email'))).body.authenticated, true);
 assert.equal(f.verifies, 1);
 assert.equal(sends, 1);
});
test('uncertain sends stay unknown and are never automatically repeated', async t => {
 let sends = 0;
 const f = fixture(t, async () => { sends++; throw Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }); });
 const send = () => auth(request(f.build()).post('/send-email')).set('X-Idempotency-Key', 'plan-2-kevin-1').send(payload);
 for (let i = 0; i < 2; i++) assert.equal((await send()).body.state, 'SEND_ATTEMPTED_UNCONFIRMED');
 assert.equal(sends, 1);
});
test('concurrent duplicates do not dispatch a second email', async t => {
 let release, started;
 const startedPromise = new Promise(resolve => { started = resolve; });
 let sends = 0;
 const f = fixture(t, async () => { sends++; started(); await new Promise(resolve => { release = resolve; }); return { accepted: [payload.to], messageId: 'mail-1' }; });
 const send = () => auth(request(f.build()).post('/send-email')).set('X-Idempotency-Key', 'plan-3-kevin-1').send(payload).then(r => r);
 const first = send();
 await startedPromise;
 assert.equal((await send()).body.state, 'SEND_ATTEMPTED_UNCONFIRMED');
 release();
 assert.equal((await first).body.success, true);
 assert.equal(sends, 1);
});
test('rejects wrong Gmail account, multiple recipients and header injection', async t => {
 let sends = 0;
 const f = fixture(t, async () => { sends++; });
 f.env.GMAIL_USER = 'another@example.com';
 assert.equal((await auth(request(f.build()).post('/send-email')).set('X-Idempotency-Key', 'wrong-account').send(payload)).body.state, 'NOT_ATTEMPTED');
 f.env.GMAIL_USER = gmail.SENDER;
 for (const invalid of [{ ...payload, to: 'a@b.com,b@c.com' }, { ...payload, subject: 'hello\r\nBcc: person@example.com' }]) {
  assert.equal((await auth(request(f.build()).post('/send-email')).set('X-Idempotency-Key', 'invalid').send(invalid)).status, 400);
 }
 assert.equal(sends, 0);
});
test('WhatsApp blocks wrong or unknown senders before dispatch', async () => {
 process.env.WHATSAPP_EXPECTED_SENDER = '13362186470';
 let sends = 0;
 try {
  for (const wid of [undefined, { user: '11111111111', server: 'c.us' }, { user: '13362186470', server: 'lid' }]) {
   whatsapp._internal.__setTestClient({ info: { wid }, sendMessage: async () => { sends++; } });
   await assert.rejects(whatsapp.sendContactMessage({ contact: '15555555555', message: 'test' }), e => e.state === 'SENDER_MISMATCH');
  }
  assert.equal(sends, 0);
  whatsapp._internal.__setTestClient({ info: { wid: { user: '13362186470', server: 'c.us' } }, getNumberId: async () => ({ _serialized: '15555555555@c.us' }), sendMessage: async () => { sends++; return { id: { _serialized: 'test-message' } }; } });
  assert.equal(whatsapp.getSenderIdentity().matches, true);
  assert.equal((await whatsapp.sendContactMessage({ contact: '15555555555', message: 'test' })).messageId, 'test-message');
  assert.equal(sends, 1);
  const app = express().use(createStatusRouter({ whatsappClient: whatsapp }));
  assert.equal((await request(app).get('/sender-status')).status, 401);
  assert.equal((await auth(request(app).get('/sender-status'))).body.whatsapp.phone, '13362186470');
 } finally { delete process.env.WHATSAPP_EXPECTED_SENDER; }
});
