require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const schedule = require('node-schedule');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// ─── CORS: Allow Vercel frontend ───
// Set FRONTEND_URL env var on Render to your Vercel domain
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const ALLOWED_ORIGINS = [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
      callback(null, true);
    } else {
      callback(null, true); // Be permissive for now; tighten in production
    }
  },
  credentials: true
}));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ─── Hardcoded credentials ───
const VALID_EMAIL = process.env.VALID_EMAIL;
const VALID_PASSWORD = process.env.VALID_PASSWORD;

// ─── Persistent data file ───
const DATA_FILE = path.join(__dirname, 'scheduled_data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error loading data:', e.message); }
  return { jobs: [], nextId: 1 };
}

function saveData() {
  const safe = {
    nextId: jobIdCounter,
    jobs: scheduledJobs.map(({ id, phone, messages, time, type, status, lastSent }) => ({
      id, phone, messages, time, type, status, lastSent
    }))
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(safe, null, 2));
}

// ─── State ───
let whatsappClient = null;
let isWhatsAppReady = false;
let scheduledJobs = [];
let jobIdCounter = 1;

const saved = loadData();
jobIdCounter = saved.nextId || 1;

// ─── Keep-alive / ping endpoint ───
app.get('/api/ping', (_req, res) => {
  res.json({
    status: 'alive',
    whatsapp: isWhatsAppReady,
    uptime: process.uptime(),
    jobs: scheduledJobs.length,
    timestamp: new Date().toISOString()
  });
});

// ─── Login endpoint ───
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (email === VALID_EMAIL && password === VALID_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// ─── Get scheduled messages ───
app.get('/api/messages', (_req, res) => {
  res.json(sanitizeJobs());
});

// ─── Delete a scheduled message ───
app.delete('/api/messages/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = scheduledJobs.findIndex(j => j.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const job = scheduledJobs[idx];
  if (job.jobRef) job.jobRef.cancel();
  scheduledJobs.splice(idx, 1);
  saveData();
  io.emit('jobs-update', sanitizeJobs());
  res.json({ success: true });
});

// ─── Schedule a message ───
app.post('/api/schedule', (req, res) => {
  if (!isWhatsAppReady) {
    return res.status(400).json({ error: 'WhatsApp is not connected. Please scan QR first.' });
  }

  const { phone, messages, time, type } = req.body;

  if (!phone || !messages || !Array.isArray(messages) || messages.length === 0 || !time || !type) {
    return res.status(400).json({ error: 'phone, messages (array), time, and type are required.' });
  }

  const cleanMessages = messages.map(m => m.trim()).filter(m => m.length > 0);
  if (cleanMessages.length === 0) {
    return res.status(400).json({ error: 'At least one non-empty message is required.' });
  }

  // ─── 2-hour gap check for daily recurring jobs ───
  if (type === 'daily') {
    const [newH, newM] = time.split(':').map(Number);
    const newMinutes = newH * 60 + newM;
    const normalizedPhone = phone.replace(/[^0-9]/g, '');
    for (const j of scheduledJobs) {
      if (j.type !== 'daily' || j.status === 'sent' || j.status === 'failed') continue;
      if (j.phone.replace(/[^0-9]/g, '') !== normalizedPhone) continue;
      const [eH, eM] = j.time.split(':').map(Number);
      const existingMinutes = eH * 60 + eM;
      let gap = Math.abs(newMinutes - existingMinutes);
      if (gap > 720) gap = 1440 - gap; // wrap around midnight
      if (gap < 120) {
        return res.status(400).json({
          error: `Too close to existing daily schedule at ${j.time} for this number. Minimum 2-hour gap required.`
        });
      }
    }
  }

  const id = jobIdCounter++;
  const chatId = phone.replace(/[^0-9]/g, '') + '@c.us';
  const entry = { id, phone, messages: cleanMessages, time, type, status: 'active', jobRef: null, lastSent: null };

  if (type === 'once') {
    const sendAt = new Date(time);
    if (sendAt <= new Date()) {
      return res.status(400).json({ error: 'Scheduled time must be in the future.' });
    }
    entry.jobRef = schedule.scheduleJob(sendAt, async () => {
      const msg = pickRandom(entry.messages);
      try {
        await whatsappClient.sendMessage(chatId, msg);
        entry.status = 'sent';
        entry.lastSent = new Date().toISOString();
        console.log(`✅ [Once] Sent to ${phone}: "${msg}"`);
      } catch (err) {
        entry.status = 'failed';
        console.error(`❌ [Once] Failed ${phone}:`, err.message);
      }
      // Go offline so contacts don't see us as "online"
      try { await whatsappClient.sendPresenceUnavailable(); } catch (e) {}
      saveData();
      io.emit('jobs-update', sanitizeJobs());
    });

  } else if (type === 'daily') {
    const [hour, minute] = time.split(':').map(Number);
    const rule = new schedule.RecurrenceRule();
    rule.hour = hour;
    rule.minute = minute;
    rule.second = 0;

    entry.jobRef = schedule.scheduleJob(rule, async () => {
      const msg = pickRandom(entry.messages);
      try {
        await whatsappClient.sendMessage(chatId, msg);
        entry.lastSent = new Date().toISOString();
        console.log(`✅ [Daily ${time}] Sent to ${phone}: "${msg}"`);
      } catch (err) {
        console.error(`❌ [Daily ${time}] Failed ${phone}:`, err.message);
      }
      // Go offline so contacts don't see us as "online"
      try { await whatsappClient.sendPresenceUnavailable(); } catch (e) {}
      saveData();
      io.emit('jobs-update', sanitizeJobs());
    });
  }

  scheduledJobs.push(entry);
  saveData();
  io.emit('jobs-update', sanitizeJobs());
  res.json({ success: true, id });
});

// ─── WhatsApp status endpoint ───
app.get('/api/whatsapp-status', (_req, res) => {
  res.json({ connected: isWhatsAppReady });
});

// ─── Helpers ───
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sanitizeJobs() {
  return scheduledJobs.map(({ id, phone, messages, time, type, status, lastSent }) => ({
    id, phone, messages, time, type, status, lastSent
  }));
}

function reschedulePersistedJobs() {
  const data = loadData();
  for (const j of data.jobs) {
    if (j.status === 'sent' || j.status === 'failed') {
      scheduledJobs.push({ ...j, jobRef: null });
      continue;
    }

    const chatId = j.phone.replace(/[^0-9]/g, '') + '@c.us';
    const entry = { ...j, jobRef: null };

    if (j.type === 'once') {
      const sendAt = new Date(j.time);
      if (sendAt <= new Date()) {
        entry.status = 'missed';
        scheduledJobs.push(entry);
        continue;
      }
      entry.jobRef = schedule.scheduleJob(sendAt, async () => {
        const msg = pickRandom(entry.messages);
        try {
          await whatsappClient.sendMessage(chatId, msg);
          entry.status = 'sent';
          entry.lastSent = new Date().toISOString();
        } catch (err) {
          entry.status = 'failed';
        }
        try { await whatsappClient.sendPresenceUnavailable(); } catch (e) {}
        saveData();
        io.emit('jobs-update', sanitizeJobs());
      });
    } else if (j.type === 'daily') {
      const [hour, minute] = j.time.split(':').map(Number);
      const rule = new schedule.RecurrenceRule();
      rule.hour = hour;
      rule.minute = minute;
      rule.second = 0;
      entry.jobRef = schedule.scheduleJob(rule, async () => {
        const msg = pickRandom(entry.messages);
        try {
          await whatsappClient.sendMessage(chatId, msg);
          entry.lastSent = new Date().toISOString();
        } catch (err) {
          console.error(`❌ [Daily-restored] Failed ${j.phone}:`, err.message);
        }
        try { await whatsappClient.sendPresenceUnavailable(); } catch (e) {}
        saveData();
        io.emit('jobs-update', sanitizeJobs());
      });
    }
    scheduledJobs.push(entry);
  }
  saveData();
  console.log(`📋 Restored ${scheduledJobs.length} scheduled jobs`);
}

// ─── Socket.IO ───
io.on('connection', (socket) => {
  console.log('🔌 Client connected');
  socket.emit('whatsapp-status', { connected: isWhatsAppReady });
  socket.emit('jobs-update', sanitizeJobs());

  socket.on('init-whatsapp', () => {
    if (whatsappClient) {
      if (isWhatsAppReady) socket.emit('whatsapp-status', { connected: true });
      return;
    }

    console.log('🚀 Initializing WhatsApp client...');
    whatsappClient = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-extensions'
        ]
      }
    });

    whatsappClient.on('qr', async (qr) => {
      console.log('📱 QR Code received');
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
        io.emit('qr-code', qrDataUrl);
      } catch (err) {
        console.error('QR generation error:', err);
      }
    });

    whatsappClient.on('ready', async () => {
      console.log('✅ WhatsApp client is ready!');
      isWhatsAppReady = true;
      // Immediately go offline so contacts don't see us as "online"
      try { await whatsappClient.sendPresenceUnavailable(); } catch (e) {}
      io.emit('whatsapp-status', { connected: true });
      reschedulePersistedJobs();
    });

    whatsappClient.on('authenticated', () => console.log('🔐 WhatsApp authenticated'));

    whatsappClient.on('auth_failure', (msg) => {
      console.error('❌ Auth failure:', msg);
      io.emit('whatsapp-error', 'Authentication failed. Please try again.');
      whatsappClient = null;
      isWhatsAppReady = false;
    });

    whatsappClient.on('disconnected', (reason) => {
      console.log('🔌 WhatsApp disconnected:', reason);
      isWhatsAppReady = false;
      whatsappClient = null;
      io.emit('whatsapp-status', { connected: false });
    });

    whatsappClient.initialize();
  });

  socket.on('disconnect', () => console.log('🔌 Client disconnected'));
});

// ─── Start server ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Scheduler Backend running on port ${PORT}`);
  console.log(`   Allowed frontend: ${FRONTEND_URL}\n`);
});
