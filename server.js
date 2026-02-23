const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_PATH = path.join(__dirname, 'data', 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const state = loadState();

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      contacts: [],
      conversations: {},
      events: [],
      settings: {
        sendingDomain: 'mailer.yourdomain.com',
        timezone: 'Europe/Madrid',
        trustLinks: {
          website: 'https://example.com',
          testimonials: 'https://example.com/testimonials',
          instagram: 'https://instagram.com/example'
        }
      }
    };
  }
}

function saveState() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2));
}

function logEvent(type, payload = {}) {
  state.events.push({ id: uid('evt'), type, payload, at: new Date().toISOString() });
  if (state.events.length > 2000) state.events = state.events.slice(-2000);
}

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function parseCsv(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') {
      row.push(field); field = '';
      if (row.some((v) => (v || '').trim() !== '')) rows.push(row);
      row = []; i++; continue;
    }
    if (c !== '\r') field += c;
    i++;
  }
  row.push(field);
  if (row.some((v) => (v || '').trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => (h || '').trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const out = {};
    headers.forEach((h, idx) => out[h] = (r[idx] || '').trim());
    return {
      name: out.name || out.fullname || '',
      email: out.email || '',
      company: out.company || out.organization || '',
      impressive: out.impressive || out.impressive_fact || '',
      templateType: (out.linkedin || out.impressive) ? 'type2' : 'type1'
    };
  }).filter((x) => x.name && x.email && x.company);
}

function buildDraft(contact) {
  const impressive = contact.impressive || `Your work at ${contact.company} stood out to us.`;
  if (contact.templateType === 'type2') {
    return {
      subject: `${contact.name} – quick thought for ${contact.company}`,
      body: `Hi ${contact.name},\n\n${impressive}\n\nWe help teams like ${contact.company} convert more qualified leads into meetings.\n\nWould either Tuesday 10:30 or Wednesday 14:00 work for a 15-min chat?\n\nBest,\nCarl`
    };
  }
  return {
    subject: `Quick idea for ${contact.company}`,
    body: `Hi ${contact.name},\n\nI wanted to share how we help agencies reduce time spent on unqualified leads.\n\nWould Tuesday 10:30 or Wednesday 14:00 work for a quick call?\n\nBest,\nCarl`
  };
}

function delaySeconds() {
  return 90 + Math.floor(Math.random() * 31);
}

function isAllowedWindow(date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 1 || day === 6) return false; // Tue-Fri only
  const mins = date.getUTCHours() * 60 + date.getUTCMinutes();
  const morning = mins >= (8 * 60 + 30) && mins <= (11 * 60);
  const afternoon = mins >= (13 * 60) && mins <= (15 * 60);
  return morning || afternoon;
}

function nextAllowedWindow(base = new Date()) {
  let d = new Date(base);
  for (let i = 0; i < 24 * 30; i++) {
    if (isAllowedWindow(d)) return d;
    d = new Date(d.getTime() + 30 * 60 * 1000);
  }
  return d;
}

function ensureConversation(contactId) {
  if (!state.conversations[contactId]) {
    state.conversations[contactId] = {
      threadId: uid('thread'),
      messages: [],
      status: 'new',
      followUpScheduledFor: null,
      proposedMeetingTimes: [],
      meeting: null
    };
  }
  return state.conversations[contactId];
}

function scheduleFollowUp(contactId) {
  const conv = ensureConversation(contactId);
  const dt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  conv.followUpScheduledFor = dt.toISOString();
  logEvent('followup_scheduled', { contactId, at: conv.followUpScheduledFor });
}

function analyzeReply(text) {
  const t = (text || '').toLowerCase();
  const interested = /(interested|sounds good|yes|let'?s|meeting|call)/.test(t);
  const asksLinks = /(website|testimonial|instagram|proof|case study)/.test(t);
  const asksMeeting = /(time|slot|available|calendar|tomorrow|next week)/.test(t);
  return { interested, asksLinks, asksMeeting };
}

function nextBusinessTimes(now = new Date()) {
  const one = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const two = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  [one, two].forEach((d) => {
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
  });
  two.setHours(14, 0, 0, 0);
  return [one, two];
}

function draftReply(contact, incomingText, analysis) {
  const conv = ensureConversation(contact.id);
  const lines = [`Hi ${contact.name},`, ''];
  if (analysis.interested || analysis.asksMeeting) {
    const [t1, t2] = nextBusinessTimes();
    conv.proposedMeetingTimes = [t1.toISOString(), t2.toISOString()];
    lines.push(`Great to hear from you. I can do ${t1.toUTCString()} or ${t2.toUTCString()}.`);
    lines.push('If one works for you, I will send a Google Meet invite right away.');
    logEvent('meeting_proposed', { contactId: contact.id, options: conv.proposedMeetingTimes });
  } else {
    lines.push('Thanks for your reply. Happy to clarify anything you want to explore.');
  }
  if (analysis.asksLinks || analysis.interested) {
    lines.push('');
    lines.push('Here are references in case useful:');
    lines.push(`Website: ${state.settings.trustLinks.website}`);
    lines.push(`Testimonials: ${state.settings.trustLinks.testimonials}`);
    lines.push(`Instagram: ${state.settings.trustLinks.instagram}`);
  }
  lines.push('', 'Best,', 'Carl');
  return lines.join('\n');
}

function createMeeting(contactId, chosenTime) {
  const conv = ensureConversation(contactId);
  const meeting = {
    id: uid('meet'),
    startsAt: new Date(chosenTime).toISOString(),
    link: `https://meet.google.com/${Math.random().toString(36).slice(2,5)}-${Math.random().toString(36).slice(2,6)}-${Math.random().toString(36).slice(2,5)}`,
    reminderAt: new Date(new Date(chosenTime).getTime() - 60 * 60 * 1000).toISOString(),
    confirmationEmailAt: new Date(Date.now() + (120 + Math.floor(Math.random() * 61)) * 1000).toISOString()
  };
  conv.meeting = meeting;
  conv.status = 'meeting_confirmed';
  logEvent('meeting_created', { contactId, meeting });
  return meeting;
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'application/javascript';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, 200, state);

  if (req.method === 'POST' && pathname === '/api/contacts/upload') {
    try {
      const { csv } = await parseJsonBody(req);
      const contacts = parseCsv(csv || '');
      contacts.forEach((c) => {
        const contact = { id: uid('contact'), ...c, status: 'uploaded', createdAt: new Date().toISOString() };
        state.contacts.push(contact);
        ensureConversation(contact.id);
        logEvent('contact_uploaded', { contactId: contact.id, email: contact.email });
      });
      saveState();
      return sendJson(res, 201, { count: contacts.length, contacts: state.contacts.slice(-contacts.length) });
    } catch (e) {
      return sendJson(res, 400, { error: 'Invalid payload', detail: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/emails/generate') {
    const { contactId, templateType } = await parseJsonBody(req);
    const contact = state.contacts.find((c) => c.id === contactId);
    if (!contact) return sendJson(res, 404, { error: 'Contact not found' });
    if (templateType) contact.templateType = templateType;
    contact.draft = buildDraft(contact);
    contact.status = 'drafted';
    logEvent('email_generated', { contactId, templateType: contact.templateType });
    saveState();
    return sendJson(res, 200, { draft: contact.draft });
  }

  if (req.method === 'POST' && pathname === '/api/emails/send') {
    const { contactId } = await parseJsonBody(req);
    const contact = state.contacts.find((c) => c.id === contactId);
    if (!contact) return sendJson(res, 404, { error: 'Contact not found' });
    if (!contact.draft) contact.draft = buildDraft(contact);

    const sendAt = nextAllowedWindow(new Date(Date.now() + delaySeconds() * 1000));
    const conv = ensureConversation(contactId);
    const msg = { id: uid('msg'), type: 'outbound', subject: contact.draft.subject, body: contact.draft.body, sentAt: sendAt.toISOString() };
    conv.messages.push(msg);
    contact.status = 'scheduled_send';
    scheduleFollowUp(contactId);
    logEvent('email_scheduled', { contactId, sendAt: msg.sentAt, delay: '90-120 seconds', window: 'Tue-Fri 08:30-11:00 & 13:00-15:00 UTC' });
    saveState();
    return sendJson(res, 200, { threadId: conv.threadId, message: msg });
  }

  if (req.method === 'POST' && pathname === '/api/replies/inbound') {
    const { contactId, body } = await parseJsonBody(req);
    const contact = state.contacts.find((c) => c.id === contactId);
    if (!contact) return sendJson(res, 404, { error: 'Contact not found' });
    const conv = ensureConversation(contactId);
    conv.messages.push({ id: uid('msg'), type: 'inbound', body, at: new Date().toISOString() });
    conv.status = 'replied';

    const analysis = analyzeReply(body);
    const replyDraft = draftReply(contact, body, analysis);
    conv.messages.push({ id: uid('msg'), type: 'ai_draft', body: replyDraft, at: new Date().toISOString() });
    logEvent('reply_analyzed', { contactId, analysis });

    const meetingFollowUpAt = analysis.asksMeeting || analysis.interested
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : null;

    saveState();
    return sendJson(res, 200, { analysis, draftReply: replyDraft, followUpIn24hAt: meetingFollowUpAt });
  }

  if (req.method === 'POST' && pathname === '/api/meetings/confirm') {
    const { contactId, chosenTime } = await parseJsonBody(req);
    const contact = state.contacts.find((c) => c.id === contactId);
    if (!contact) return sendJson(res, 404, { error: 'Contact not found' });
    const meeting = createMeeting(contactId, chosenTime);
    saveState();
    return sendJson(res, 200, { meeting, confirmationEmailIn: '2-3 minutes in same thread' });
  }

  if (req.method === 'GET' && pathname === '/api/logs') {
    return sendJson(res, 200, { events: state.events, conversations: state.conversations });
  }

  if (req.method === 'POST' && pathname === '/api/reminders/trigger') {
    const { contactId, includeTrustLinks } = await parseJsonBody(req);
    const contact = state.contacts.find((c) => c.id === contactId);
    if (!contact) return sendJson(res, 404, { error: 'Contact not found' });
    const conv = ensureConversation(contactId);
    if (!conv.meeting) return sendJson(res, 400, { error: 'No meeting confirmed for contact' });

    let body = `Hi ${contact.name}, this is a reminder for our meeting in one hour.\nGoogle Meet: ${conv.meeting.link}`;
    if (includeTrustLinks) {
      body += `\n\nWebsite: ${state.settings.trustLinks.website}\nTestimonials: ${state.settings.trustLinks.testimonials}\nInstagram: ${state.settings.trustLinks.instagram}`;
    }
    conv.messages.push({ id: uid('msg'), type: 'reminder', body, at: new Date().toISOString() });
    logEvent('reminder_sent', { contactId, includeTrustLinks: !!includeTrustLinks });
    saveState();
    return sendJson(res, 200, { reminder: body });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'API route not found' });
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
