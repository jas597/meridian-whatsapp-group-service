const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { createApp } = require("../server");

function buildApp({ cloudApiOverrides = {}, inboundRecords = [] } = {}) {
  process.env.WHATSAPP_WEBHOOK_SECRET = "test-secret";
  process.env.WHATSAPP_CLOUD_API_VERIFY_TOKEN = "verify-me";
  process.env.WHATSAPP_CLOUD_API_PHONE_NUMBER_ID = "1083464088192352";

  const whatsappClient = {
    getStatus: () => "ready",
    getQrDataUrl: () => "",
    appendInboundMessage: (record) => inboundRecords.push(record),
  };

  const cloudApiClient = {
    sendTemplateMessage: async () => ({ messageId: "template-message-id" }),
    sendTextMessage: async () => ({ messageId: "text-message-id" }),
    sendImageMessage: async () => ({ messageId: "image-message-id" }),
    ...cloudApiOverrides,
  };

  return createApp({ whatsappClient, cloudApiClient });
}

test("webhook verification succeeds with matching token", async () => {
  const app = buildApp();
  const response = await request(app)
    .get("/cloud-webhook")
    .query({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "12345" });

  assert.equal(response.status, 200);
  assert.equal(response.text, "12345");
});

test("webhook verification rejects wrong token", async () => {
  const app = buildApp();
  const response = await request(app)
    .get("/cloud-webhook")
    .query({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "12345" });

  assert.equal(response.status, 403);
});

test("webhook stores inbound text messages", async () => {
  const inboundRecords = [];
  const app = buildApp({ inboundRecords });

  const payload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: "wamid.abc123",
            from: "13366957646",
            type: "text",
            timestamp: "1700000000",
            text: { body: "APPROVED" },
          }],
        },
      }],
    }],
  };

  const response = await request(app).post("/cloud-webhook").send(payload);

  assert.equal(response.status, 200);
  assert.equal(inboundRecords.length, 1);
  assert.equal(inboundRecords[0].body, "APPROVED");
  assert.equal(inboundRecords[0].contact, "13366957646");
  assert.equal(inboundRecords[0].source, "cloud_api");
});

test("webhook does not throw on status-only payloads", async () => {
  const inboundRecords = [];
  const app = buildApp({ inboundRecords });

  const payload = {
    entry: [{
      changes: [{
        value: {
          statuses: [{ id: "wamid.abc123", status: "delivered", recipient_id: "13366957646" }],
        },
      }],
    }],
  };

  const response = await request(app).post("/cloud-webhook").send(payload);

  assert.equal(response.status, 200);
  assert.equal(inboundRecords.length, 0);
});

test("send-template rejects missing authorization", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/cloud/send-template")
    .send({ to: "+13366957646", templateName: "weekly_schedule" });

  assert.equal(response.status, 401);
});

test("send-template succeeds with valid authorization", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/cloud/send-template")
    .set("Authorization", "Bearer test-secret")
    .send({ to: "+13366957646", templateName: "weekly_schedule" });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.messageId, "template-message-id");
});

test("send-text surfaces failures from the Cloud API client", async () => {
  const app = buildApp({
    cloudApiOverrides: {
      sendTextMessage: async () => {
        const error = new Error("Recipient has no active session.");
        error.statusCode = 400;
        throw error;
      },
    },
  });

  const response = await request(app)
    .post("/cloud/send-text")
    .set("Authorization", "Bearer test-secret")
    .send({ to: "+13366957646", message: "Hello" });

  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.match(response.body.error, /no active session/);
});
