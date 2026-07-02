// Local development server — runs frontend + backend together on port 3000
// For deployment, use backend/ and frontend/ folders separately

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
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, { cors: { origin: '*' } });

const VALID_EMAIL = process.env.VALID_EMAIL;
const VALID_PASSWORD = process.env.VALID_PASSWORD;

const DATA_FILE = path.join(__dirname, 'scheduled_data.json');
function loadData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
  return { jobs: [], nextId: 1 };
}
function saveData() {
  const safe = { nextId: jobIdCounter, jobs: scheduledJobs.map(({id,phone,messages,time,type,status,lastSent})=>({id,phone,messages,time,type,status,lastSent})) };
  fs.writeFileSync(DATA_FILE, JSON.stringify(safe, null, 2));
}

let whatsappClient = null, isWhatsAppReady = false, scheduledJobs = [], jobIdCounter = 1;
const saved = loadData(); jobIdCounter = saved.nextId || 1;

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sanitizeJobs() { return scheduledJobs.map(({id,phone,messages,time,type,status,lastSent})=>({id,phone,messages,time,type,status,lastSent})); }

app.get('/api/ping', (_,res) => res.json({ status:'alive', whatsapp:isWhatsAppReady, uptime:process.uptime(), jobs:scheduledJobs.length }));

app.post('/api/login', (req,res) => {
  const {email,password} = req.body;
  if (email===VALID_EMAIL && password===VALID_PASSWORD) return res.json({success:true});
  res.status(401).json({success:false, message:'Invalid credentials'});
});

app.get('/api/messages', (_,res) => res.json(sanitizeJobs()));

app.delete('/api/messages/:id', (req,res) => {
  const id = parseInt(req.params.id);
  const idx = scheduledJobs.findIndex(j=>j.id===id);
  if (idx===-1) return res.status(404).json({error:'Not found'});
  if (scheduledJobs[idx].jobRef) scheduledJobs[idx].jobRef.cancel();
  scheduledJobs.splice(idx,1); saveData();
  io.emit('jobs-update', sanitizeJobs());
  res.json({success:true});
});

app.post('/api/schedule', (req,res) => {
  if (!isWhatsAppReady) return res.status(400).json({error:'WhatsApp not connected. Scan QR first.'});
  const {phone,messages,time,type} = req.body;
  if (!phone||!messages||!Array.isArray(messages)||!messages.length||!time||!type)
    return res.status(400).json({error:'phone, messages, time, type required.'});
  const clean = messages.map(m=>m.trim()).filter(m=>m);
  if (!clean.length) return res.status(400).json({error:'At least one message needed.'});

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

  const id = jobIdCounter++, chatId = phone.replace(/[^0-9]/g,'')+'@c.us';
  const entry = {id,phone,messages:clean,time,type,status:'active',jobRef:null,lastSent:null};

  if (type==='once') {
    const sendAt = new Date(time);
    if (sendAt<=new Date()) return res.status(400).json({error:'Time must be in future.'});
    entry.jobRef = schedule.scheduleJob(sendAt, async()=>{
      const msg=pickRandom(entry.messages);
      try {
        await whatsappClient.sendMessage(chatId,msg);
        entry.status='sent'; entry.lastSent=new Date().toISOString();
      } catch(e) { entry.status='failed'; }
      // Go offline so contacts don't see us as "online"
      try { await whatsappClient.sendPresenceUnavailable(); } catch(e){}
      saveData(); io.emit('jobs-update',sanitizeJobs());
    });
  } else {
    const [h,m]=time.split(':').map(Number);
    const rule=new schedule.RecurrenceRule(); rule.hour=h; rule.minute=m; rule.second=0;
    entry.jobRef = schedule.scheduleJob(rule, async()=>{
      const msg=pickRandom(entry.messages);
      try { await whatsappClient.sendMessage(chatId,msg); entry.lastSent=new Date().toISOString(); } catch(e){}
      // Go offline so contacts don't see us as "online"
      try { await whatsappClient.sendPresenceUnavailable(); } catch(e){}
      saveData(); io.emit('jobs-update',sanitizeJobs());
    });
  }
  scheduledJobs.push(entry); saveData();
  io.emit('jobs-update',sanitizeJobs());
  res.json({success:true, id});
});

app.get('/api/whatsapp-status', (_,res) => res.json({connected:isWhatsAppReady}));

io.on('connection', (socket) => {
  socket.emit('whatsapp-status',{connected:isWhatsAppReady});
  socket.emit('jobs-update',sanitizeJobs());
  socket.on('init-whatsapp', () => {
    if (whatsappClient) { if(isWhatsAppReady) socket.emit('whatsapp-status',{connected:true}); return; }
    whatsappClient = new Client({ authStrategy:new LocalAuth(), puppeteer:{headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']}});
    whatsappClient.on('qr', async(qr)=>{ const url=await QRCode.toDataURL(qr,{width:320,margin:2}); io.emit('qr-code',url); });
    whatsappClient.on('ready', async()=>{
      isWhatsAppReady=true;
      // Immediately go offline so contacts don't see us as "online"
      try { await whatsappClient.sendPresenceUnavailable(); } catch(e){}
      io.emit('whatsapp-status',{connected:true});
    });
    whatsappClient.on('auth_failure', ()=>{ io.emit('whatsapp-error','Auth failed'); whatsappClient=null; isWhatsAppReady=false; });
    whatsappClient.on('disconnected', ()=>{ isWhatsAppReady=false; whatsappClient=null; io.emit('whatsapp-status',{connected:false}); });
    whatsappClient.initialize();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🚀 Local dev server: http://localhost:${PORT}\n`));
