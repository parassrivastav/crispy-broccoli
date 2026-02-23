# Outreach Automation Server (Node.js)

This project implements an end-to-end outreach workflow with CSV uploads, AI-like template generation, thread-aware conversations, meeting handling, reminders, and event logging.

## Run

```bash
node server.js
```

Open: `http://localhost:3000`

## Pages (served by the Node server)

- `GET /`  
  Main console page to:
  - paste/upload CSV contacts,
  - trigger generation/send/reply/meeting/reminder actions,
  - inspect full state and logs.

## API routes

### Health/state

- `GET /api/health`  
  Health check.

- `GET /api/state`  
  Full in-memory/persisted state (contacts, conversations, events, settings).

- `GET /api/logs`  
  Returns event logs + conversation state.

### Contacts

- `POST /api/contacts/upload`  
  Upload contacts from CSV text.

  Body:
  ```json
  {
    "csv": "name,email,company,impressive\nAlice,alice@example.com,ACME,Optional fact"
  }
  ```

  Supports columns: `name`, `email`, `company`, optional `impressive`.

### Email generation/sending

- `POST /api/emails/generate`  
  Generate Type 1 or Type 2 draft from contact data.

  Body:
  ```json
  {
    "contactId": "contact_xxx",
    "templateType": "type1"
  }
  ```

- `POST /api/emails/send`  
  Schedules outbound email with:
  - safe delay randomization (90–120 sec),
  - allowed send windows (Tue–Fri, 08:30–11:00 and 13:00–15:00 UTC),
  - threaded conversation storage,
  - automatic follow-up scheduling (3 days).

  Body:
  ```json
  {
    "contactId": "contact_xxx"
  }
  ```

### Reply monitoring and AI drafting

- `POST /api/replies/inbound`  
  Stores inbound reply, analyzes intent/tone cues, and generates human-like draft response in the same thread.

  Body:
  ```json
  {
    "contactId": "contact_xxx",
    "body": "Prospect reply text"
  }
  ```

  Meeting proposal logic proposes 2 specific times and schedules a 24h follow-up timestamp when relevant.

### Meetings and reminders

- `POST /api/meetings/confirm`  
  Confirms selected meeting time, creates Google-Meet-style link, logs invite details, and schedules a thread confirmation message for 2–3 minutes later.

  Body:
  ```json
  {
    "contactId": "contact_xxx",
    "chosenTime": "2026-02-28T10:00:00.000Z"
  }
  ```

- `POST /api/reminders/trigger`  
  Sends 1-hour reminder with the meeting link. Optional trust links are only included when explicitly requested via `includeTrustLinks`.

  Body:
  ```json
  {
    "contactId": "contact_xxx",
    "includeTrustLinks": true
  }
  ```

## Requirement mapping

1. Upload contacts CSV: `/api/contacts/upload` + `/` UI.
2. Email generation (Type 1/2): `/api/emails/generate`.
3. Send emails with safe delays/windows: `/api/emails/send`.
4. Threaded conversations: `state.conversations[contactId]` + `threadId`.
5. Follow-ups after 3 days: automatic in `/api/emails/send`.
6. Monitor replies + AI draft responses: `/api/replies/inbound`.
7. Meeting proposals + 2 times + weekend handling + 24h follow-up marker: `/api/replies/inbound`.
8. Meeting confirmation + Meet link + delayed confirmation email scheduling: `/api/meetings/confirm`.
9. 1-hour reminder + optional trust links: `/api/reminders/trigger`.
10. Conditional company/trust links only when interested/asked: reply/reminder logic.
11. Logging and conversation state tracking: `state.events`, `/api/logs`.

## Notes

- This is a production-style scaffold with deterministic routing and local persistence in `data/state.json`.
- Real integrations (SMTP provider, Google Calendar/Meet API, LLM API) can be plugged into the same route handlers.
