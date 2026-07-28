const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { createApp } = require("../server");
const { idempotencyCache } = require("../src/routes/messageRoutes");

function buildApp(clientOverrides = {}, envOverrides = {}) {
  process.env.WHATSAPP_WEBHOOK_SECRET = "test-secret";
  process.env.ALLOWED_GROUP_NAME = "Meridian Staff";
  if (Object.hasOwn(envOverrides, "ALLOWED_CONTACTS")) {
    if (envOverrides.ALLOWED_CONTACTS) {
      process.env.ALLOWED_CONTACTS = envOverrides.ALLOWED_CONTACTS;
    } else {
      delete process.env.ALLOWED_CONTACTS;
    }
  } else {
    delete process.env.ALLOWED_CONTACTS;
  }
  idempotencyCache.clear();

  const whatsappClient = {
    getStatus: () => "ready",
    getQrDataUrl: () => "",
    sendGroupMessage: async () => ({
      messageId: "test-message-id",
      sentAt: "2026-07-24T12:00:00.000Z",
    }),
    sendContactMessage: async () => ({
      messageId: "test-contact-message-id",
      sentAt: "2026-07-24T12:00:00.000Z",
    }),
    ...clientOverrides,
  };

  return createApp({ whatsappClient });
}

test("rejects missing authorization", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/send-group-message")
    .send({ group: "Meridian Staff", message: "Hello" });

  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
});

test("rejects incorrect authorization", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/send-group-message")
    .set("Authorization", "Bearer wrong")
    .send({ group: "Meridian Staff", message: "Hello" });

  assert.equal(response.status, 401);
});

test("rejects missing group", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/send-group-message")
    .set("Authorization", "Bearer test-secret")
    .send({ message: "Hello" });

  assert.equal(response.status, 400);
});

test("rejects missing message", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/send-group-message")
    .set("Authorization", "Bearer test-secret")
    .send({ group: "Meridian Staff" });

  assert.equal(response.status, 400);
});

test("rejects empty message", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/send-group-message")
    .set("Authorization", "Bearer test-secret")
    .send({ group: "Meridian Staff", message: "   " });

  assert.equal(response.status, 400);
});

test("rejects unauthorized group name", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/send-group-message")
    .set("Authorization", "Bearer test-secret")
    .send({ group: "Other Group", message: "Hello" });

  assert.equal(response.status, 400);
});

test("returns WhatsApp not ready", async () => {
  const error = new Error("WhatsApp is not ready.");
  error.statusCode = 503;
  const app = buildApp({
    sendGroupMessage: async () => {
      throw error;
    },
  });
  const response = await request(app)
    .post("/send-group-message")
    .set("Authorization", "Bearer test-secret")
    .send({ group: "Meridian Staff", message: "Hello" });

  assert.equal(response.status, 503);
});

test("returns group not found", async () => {
  const error = new Error("WhatsApp group not found.");
  error.statusCode = 404;
  const app = buildApp({
    sendGroupMessage: async () => {
      throw error;
    },
  });
  const response = await request(app)
    .post("/send-group-message")
    .set("Authorization", "Bearer test-secret")
    .send({ group: "Meridian Staff", message: "Hello" });

  assert.equal(response.status, 404);
});

test("sends successfully", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/send-group-message")
    .set("Authorization", "Bearer test-secret")
    .send({ group: "Meridian Staff", message: "Hello" });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.messageId, "test-message-id");
});

test("duplicate idempotency key returns cached result", async () => {
  let sendCount = 0;
  const app = buildApp({
    sendGroupMessage: async () => {
      sendCount += 1;
      return {
        messageId: `message-${sendCount}`,
        sentAt: "2026-07-24T12:00:00.000Z",
      };
    },
  });

  const first = await request(app)
    .post("/send-group-message")
    .set("Authorization", "Bearer test-secret")
    .set("X-Idempotency-Key", "same-key")
    .send({ group: "Meridian Staff", message: "Hello" });

  const second = await request(app)
    .post("/send-group-message")
    .set("Authorization", "Bearer test-secret")
    .set("X-Idempotency-Key", "same-key")
    .send({ group: "Meridian Staff", message: "Hello again" });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.messageId, "message-1");
  assert.equal(second.body.messageId, "message-1");
  assert.equal(sendCount, 1);
});

test("sends contact message successfully", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/send-contact-message")
    .set("Authorization", "Bearer test-secret")
    .send({ contact: "+16475550123", message: "Hello" });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.messageId, "test-contact-message-id");
});

test("rejects missing contact", async () => {
  const app = buildApp();
  const response = await request(app)
    .post("/send-contact-message")
    .set("Authorization", "Bearer test-secret")
    .send({ message: "Hello" });

  assert.equal(response.status, 400);
});

test("rejects unauthorized contact when allow list is configured", async () => {
  const app = buildApp({}, {
    ALLOWED_CONTACTS: "+16475550123;+16475550124",
  });
  const response = await request(app)
    .post("/send-contact-message")
    .set("Authorization", "Bearer test-secret")
    .send({ contact: "+16475550199", message: "Hello" });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "Unauthorized contact.");
});

test("allows configured contact with punctuation differences", async () => {
  const app = buildApp({}, {
    ALLOWED_CONTACTS: "+1 (647) 555-0123",
  });
  const response = await request(app)
    .post("/send-contact-message")
    .set("Authorization", "Bearer test-secret")
    .send({ contact: "+16475550123", message: "Hello" });

  assert.equal(response.status, 200);
});
