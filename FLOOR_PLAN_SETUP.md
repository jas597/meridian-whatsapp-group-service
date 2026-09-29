# Dedicated floor-plan notifications

This branch prepares a **new** Render service in Meridian Convention Center's workspace. It does not change `main` or Kim's existing WhatsApp service/session. It has not been deployed or connected to the planner yet.

| Channel | Sender |
|---|---|
| WhatsApp | +1 336-218-6470 |
| Gmail | info@meridianconvention.com |

Every WhatsApp send checks the linked phone first. Gmail authenticates as and sends from the fixed address above.

## Proposed deployment

Standard (2 GB RAM, matching the existing Chromium service) plus a separate 1 GB disk: approximately **$25.25/month**, before taxes or extra usage. Owner approval is required before applying the paid Blueprint. No workspace upgrade is requested. The free service cannot attach the persistent disk and blocks SMTP.

After cost approval, open [Deploy on Render](https://render.com/deploy?repo=https://github.com/jas597/meridian-whatsapp-group-service/tree/floor-plan-messaging).

Select **Meridian Convention Center**. The Blueprint must show only the NEW service `meridian-floor-plan-messaging`, with branch `floor-plan-messaging`. Auto-deploy is off. Confirm the proposed price before applying. Never replace the staff service or copy its disk/session.

Render generates `WHATSAPP_WEBHOOK_SECRET` and `QR_PAGE_SECRET`. Keep both private.

## One-time connections

1. Sign in as **info@meridianconvention.com** at [Google App Passwords](https://myaccount.google.com/apppasswords). Two-step verification is required. Some Workspace policies disable app passwords; if unavailable, configure OAuth instead.
2. In the NEW Render service's Environment page, add `GMAIL_APP_PASSWORD` using the generated app password. Never paste it into chat, the repository or public app settings. Do not use the ordinary Gmail password.
3. Open the new service's `/qr?key=<QR_PAGE_SECRET>` privately. On the phone for **+1 336-218-6470**, use WhatsApp Business → Settings → Linked devices → Link a device.
4. Check `GET /sender-status` with the bearer webhook secret. Expected and actual phone must both be `13362186470`, and status must be `ready`.
5. Call `POST /verify-email` with the same bearer secret. This verifies SMTP authentication without sending email.

## Planner connection after deployment

The planner already supports the gateway's direct-contact API. Set its server-only environment to the NEW service, using these keys:

```
WHATSAPP_PROVIDER=gateway
WHATSAPP_CONTACT_WEBHOOK_URL=https://<new-service-host>/send-contact-message
WHATSAPP_WEBHOOK_SECRET=<new service's secret>
WHATSAPP_SITE_ORIGIN=https://meridian-3d-floor-planner.jas571806.chatgpt.site
WHATSAPP_AUTO_SEND=true
```

Enable only after verifying the linked sender. No historical requests should be replayed automatically.

Gmail API: `POST /send-email` with the same bearer secret, an `X-Idempotency-Key` unique to plan/revision/reviewer/channel, and JSON `{ "to": "reviewer@example.com", "subject": "Floor plan review", "text": "Review link and plan details" }`.

**Remaining app work:** wire Gmail dispatch into the planner with a separate email status and durable claim for each approval step. The live planner currently dispatches WhatsApp only. Keep email disabled until connected and tested. Approvals remain authenticated in the planner: Kevin first, then Jawa. A chat/email reply alone must not approve a plan.

Email receipts persist on disk and prevent repeat sends for the same key across concurrent requests and restarts. An uncertain result stays `SEND_ATTEMPTED_UNCONFIRMED`; check Gmail Sent before a manual resend. Success means SMTP accepted the message, not confirmed recipient delivery. Do not remove receipt files to force retries.

Optional server-only `ALLOWED_CONTACTS` and `ALLOWED_EMAILS` can restrict recipients further; configure these using the published reviewer contacts.

## Validation

`PUPPETEER_SKIP_DOWNLOAD=true npm ci --ignore-scripts` installs test dependencies without downloading Chromium. `npm test` uses fake transports and sends no real messages. `npm run check` checks JavaScript syntax. The Docker build installs the Chromium browser through Puppeteer's normal install script.

After deployment, check Render status/logs, `/health`, sender identity and Gmail authentication, then run an authorized test approval. Do not mark the setup complete before actual connectivity is verified.
