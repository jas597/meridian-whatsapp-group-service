# Meridian WhatsApp Group Service

Standalone Node.js service that receives staff schedule messages from the Meridian Dashboard and sends them to the WhatsApp group named `Meridian Staff` using `whatsapp-web.js`.

The dashboard posts this provider-independent payload:

```json
{
  "group": "Meridian Staff",
  "message": "Weekly schedule text"
}
```

## Endpoints

### `GET /health`

Returns service and WhatsApp connection status.

```json
{
  "success": true,
  "service": "meridian-whatsapp-group-service",
  "whatsappStatus": "starting",
  "timestamp": "2026-07-24T12:00:00.000Z"
}
```

### `GET /qr?key=<QR_PAGE_SECRET>`

Protected QR login page. Use this to connect the Meridian WhatsApp account.

### `POST /send-group-message`

Headers:

```text
Content-Type: application/json
Authorization: Bearer <WHATSAPP_WEBHOOK_SECRET>
X-Idempotency-Key: schedule-<schedule-id>-<publish-version>
```

Body:

```json
{
  "group": "Meridian Staff",
  "message": "Meridian WhatsApp group service test."
}
```

Success:

```json
{
  "success": true,
  "group": "Meridian Staff",
  "messageId": "...",
  "sentAt": "ISO timestamp"
}
```

## Environment Variables

```text
PORT=3000
ALLOWED_GROUP_NAME=Meridian Staff
WHATSAPP_WEBHOOK_SECRET=replace-with-a-long-random-secret
WHATSAPP_SESSION_PATH=/var/data/whatsapp-session
QR_PAGE_SECRET=replace-with-another-long-random-secret
NODE_ENV=production
```

## Render Deployment

1. Deploy this Node.js service to Render.
2. Use one instance only. Do not enable horizontal scaling.
3. Add a persistent disk mounted at:

```text
/var/data
```

4. Add all environment variables from `.env.example`.
5. Open:

```text
https://<service>.onrender.com/qr?key=<QR_PAGE_SECRET>
```

6. Scan the QR code using the Meridian WhatsApp account.
7. Confirm `/health` reports:

```json
"whatsappStatus": "ready"
```

8. Confirm the account is already a member of the WhatsApp group:

```text
Meridian Staff
```

9. Test using curl:

```bash
curl -X POST "https://<service>.onrender.com/send-group-message" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SECRET" \
  -H "X-Idempotency-Key: test-001" \
  -d '{
    "group": "Meridian Staff",
    "message": "Meridian WhatsApp group service test."
  }'
```

10. Put the service endpoint and matching secret into the dashboard Render environment variables:

```text
WHATSAPP_GROUP_WEBHOOK_URL=https://<service-name>.onrender.com/send-group-message
WHATSAPP_GROUP_WEBHOOK_SECRET=<same WHATSAPP_WEBHOOK_SECRET>
```

## Local Development

```bash
npm install
npm test
npm start
```

## Limitations

- WhatsApp Web automation requires a persistent logged-in session.
- The Render disk mounted at `/var/data` is required so LocalAuth survives deploys and restarts.
- Run only one service instance. Multiple instances can corrupt or fight over the same WhatsApp session.
- Do not claim a message was sent unless `sendMessage` returns successfully.
