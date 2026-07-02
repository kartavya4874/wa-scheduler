// ═══════════════════════════════════════════════════════════════
// API URL comes from config.js (loaded before this script)
// ═══════════════════════════════════════════════════════════════
const API_URL = CONFIG.API_URL;

// ═══════════ DOM REFS ═══════════
const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

const connectWaBtn = document.getElementById('connect-wa-btn');
const qrPlaceholder = document.getElementById('qr-placeholder');
const qrLoading = document.getElementById('qr-loading');
const qrImageWrapper = document.getElementById('qr-image-wrapper');
const qrImage = document.getElementById('qr-image');
const qrConnected = document.getElementById('qr-connected');
const waStatusBadge = document.getElementById('wa-status-badge');
const serverStatusBadge = document.getElementById('server-status-badge');

const scheduleForm = document.getElementById('schedule-form');
const schedError = document.getElementById('schedule-error');
const schedSuccess = document.getElementById('schedule-success');
const jobsList = document.getElementById('jobs-list');
const jobCount = document.getElementById('job-count');

const toggleOnce = document.getElementById('toggle-once');
const toggleDaily = document.getElementById('toggle-daily');
const onceTimeGroup = document.getElementById('once-time-group');
const dailyTimeGroup = document.getElementById('daily-time-group');
const messagesList = document.getElementById('messages-list');
const addMsgBtn = document.getElementById('add-msg-btn');

let socket = null;
let scheduleType = 'once';
let keepAliveInterval = null;

// ═══════════ HELPERS ═══════════
function showEl(el) { el.classList.remove('hidden'); }
function hideEl(el) { el.classList.add('hidden'); }

function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3500);
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ═══════════ KEEP-ALIVE PING (every 13 min) ═══════════
function startKeepAlive() {
  if (keepAliveInterval) return;

  async function ping() {
    try {
      const res = await fetch(`${API_URL}/api/ping`);
      const data = await res.json();
      serverStatusBadge.className = 'status-badge connected';
      serverStatusBadge.querySelector('.status-text').textContent = `Server: Active (${data.jobs} jobs)`;
      console.log(`🏓 Keep-alive ping OK — uptime: ${Math.round(data.uptime)}s, WA: ${data.whatsapp}`);
    } catch (err) {
      serverStatusBadge.className = 'status-badge disconnected';
      serverStatusBadge.querySelector('.status-text').textContent = 'Server: Sleeping...';
      console.warn('🏓 Keep-alive ping failed — server may be sleeping');
    }
  }

  ping(); // Immediate first ping
  keepAliveInterval = setInterval(ping, 13 * 60 * 1000); // Every 13 minutes
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ═══════════ LOGIN ═══════════
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideEl(loginError);
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch(`${API_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.success) {
      loginScreen.classList.remove('active');
      dashboardScreen.classList.add('active');
      initSocket();
      startKeepAlive();
    } else {
      loginError.textContent = data.message || 'Invalid credentials';
      showEl(loginError);
    }
  } catch (err) {
    loginError.textContent = 'Cannot reach server. It may be waking up — try again in 30 seconds.';
    showEl(loginError);
  }
});

logoutBtn.addEventListener('click', () => {
  dashboardScreen.classList.remove('active');
  loginScreen.classList.add('active');
  loginForm.reset();
  stopKeepAlive();
});

// ═══════════ SCHEDULE TYPE TOGGLE ═══════════
toggleOnce.addEventListener('click', () => {
  scheduleType = 'once';
  toggleOnce.classList.add('active');
  toggleDaily.classList.remove('active');
  showEl(onceTimeGroup);
  hideEl(dailyTimeGroup);
});

toggleDaily.addEventListener('click', () => {
  scheduleType = 'daily';
  toggleDaily.classList.add('active');
  toggleOnce.classList.remove('active');
  hideEl(onceTimeGroup);
  showEl(dailyTimeGroup);
});

// ═══════════ MESSAGE VARIANTS ═══════════
addMsgBtn.addEventListener('click', () => {
  const count = messagesList.children.length + 1;
  const entry = document.createElement('div');
  entry.className = 'msg-entry';
  entry.innerHTML = `
    <span class="msg-entry-number">${count}</span>
    <textarea class="msg-input" rows="2" placeholder="Message variant ${count}..." required></textarea>
    <button type="button" class="remove-msg-btn" title="Remove">✕</button>
  `;
  entry.querySelector('.remove-msg-btn').addEventListener('click', () => {
    entry.remove();
    renumberMessages();
  });
  messagesList.appendChild(entry);
});

function renumberMessages() {
  const entries = messagesList.querySelectorAll('.msg-entry');
  entries.forEach((entry, i) => {
    const num = entry.querySelector('.msg-entry-number');
    if (num) num.textContent = i + 1;
    entry.querySelector('.msg-input').placeholder = `Message variant ${i + 1}...`;
  });
}

// ═══════════ SOCKET ═══════════
function initSocket() {
  if (socket) return;
  // Connect to the Render backend URL
  socket = io(API_URL, {
    transports: ['websocket', 'polling'],
    withCredentials: true
  });

  socket.on('connect', () => {
    console.log('🔌 Socket connected to backend');
  });

  socket.on('connect_error', (err) => {
    console.warn('🔌 Socket connection error:', err.message);
  });

  socket.on('qr-code', (dataUrl) => {
    hideEl(qrPlaceholder); hideEl(qrLoading); hideEl(qrConnected);
    showEl(qrImageWrapper);
    qrImage.src = dataUrl;
    toast('QR Code ready — scan it with your phone!', 'info');
  });

  socket.on('whatsapp-status', ({ connected }) => {
    updateWaStatus(connected);
    if (connected) {
      hideEl(qrPlaceholder); hideEl(qrLoading); hideEl(qrImageWrapper);
      showEl(qrConnected);
      toast('WhatsApp connected successfully!', 'success');
    }
  });

  socket.on('whatsapp-error', (msg) => {
    toast(msg, 'error');
    hideEl(qrLoading); showEl(qrPlaceholder);
  });

  socket.on('jobs-update', (jobs) => renderJobs(jobs));
}

function updateWaStatus(connected) {
  waStatusBadge.className = `status-badge ${connected ? 'connected' : 'disconnected'}`;
  waStatusBadge.querySelector('.status-text').textContent = connected ? 'WA: Connected' : 'WA: Disconnected';
}

// ═══════════ CONNECT WA ═══════════
connectWaBtn.addEventListener('click', () => {
  hideEl(qrPlaceholder); showEl(qrLoading);
  if (socket) socket.emit('init-whatsapp');
});

// ═══════════ SCHEDULE FORM ═══════════
scheduleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideEl(schedError); hideEl(schedSuccess);

  const phone = document.getElementById('sched-phone').value.trim();
  const msgInputs = messagesList.querySelectorAll('.msg-input');
  const messages = Array.from(msgInputs).map(t => t.value.trim()).filter(m => m.length > 0);

  if (messages.length === 0) {
    schedError.textContent = 'Add at least one message.';
    showEl(schedError); return;
  }

  let time;
  if (scheduleType === 'once') {
    time = document.getElementById('sched-datetime').value;
    if (!time) { schedError.textContent = 'Select a date & time.'; showEl(schedError); return; }
  } else {
    time = document.getElementById('sched-daily-time').value;
    if (!time) { schedError.textContent = 'Select a daily time.'; showEl(schedError); return; }
  }

  try {
    const res = await fetch(`${API_URL}/api/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, messages, time, type: scheduleType })
    });
    const data = await res.json();
    if (data.success) {
      const typeLabel = scheduleType === 'daily' ? `Daily at ${time}` : `on ${new Date(time).toLocaleString()}`;
      schedSuccess.textContent = `Scheduled ${typeLabel} with ${messages.length} message variant(s)`;
      showEl(schedSuccess);
      document.getElementById('sched-phone').value = '';
      document.getElementById('sched-datetime').value = '';
      document.getElementById('sched-daily-time').value = '';
      messagesList.innerHTML = '<div class="msg-entry"><textarea class="msg-input" rows="2" placeholder="Message variant 1..." required></textarea></div>';
      toast('Message scheduled!', 'success');
      setTimeout(() => hideEl(schedSuccess), 4000);
    } else {
      schedError.textContent = data.error || 'Failed to schedule';
      showEl(schedError);
    }
  } catch (err) {
    schedError.textContent = 'Cannot reach server. It may be waking up.';
    showEl(schedError);
  }
});

// ═══════════ RENDER JOBS ═══════════
function renderJobs(jobs) {
  jobCount.textContent = jobs.length;
  if (jobs.length === 0) {
    jobsList.innerHTML = '<div class="empty-state"><p>No scheduled messages yet</p></div>';
    return;
  }

  jobsList.innerHTML = jobs.map(j => {
    const typeEmoji = j.type === 'daily' ? '🔁' : '📅';
    const timeDisplay = j.type === 'daily'
      ? `Every day at ${j.time}`
      : new Date(j.time).toLocaleString();

    const msgChips = j.messages.map(m =>
      `<span class="job-msg-chip" title="${escapeHtml(m)}">${escapeHtml(m)}</span>`
    ).join('');

    const lastSent = j.lastSent ? `Last sent: ${new Date(j.lastSent).toLocaleString()}` : '';

    return `
      <div class="job-item">
        <div class="job-header">
          <span class="job-phone">📞 ${escapeHtml(j.phone)}</span>
          <span class="job-type ${j.type}">${typeEmoji} ${j.type}</span>
        </div>
        <div class="job-meta">🕐 ${timeDisplay}</div>
        <div class="job-msgs">
          <div class="job-msgs-label">💬 ${j.messages.length} variant(s) — random pick each send:</div>
          <div class="job-msgs-list">${msgChips}</div>
        </div>
        <div class="job-footer">
          <div>
            <span class="job-status ${j.status}">${j.status}</span>
            ${lastSent ? `<span class="job-last-sent"> · ${lastSent}</span>` : ''}
          </div>
          <button class="btn btn-danger" onclick="deleteJob(${j.id})">
            ${j.type === 'daily' ? 'Stop' : 'Cancel'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function deleteJob(id) {
  try {
    await fetch(`${API_URL}/api/messages/${id}`, { method: 'DELETE' });
    toast('Schedule removed', 'info');
  } catch (err) {
    toast('Failed to remove', 'error');
  }
}

// Set min datetime
const dtInput = document.getElementById('sched-datetime');
const now = new Date();
now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
dtInput.min = now.toISOString().slice(0, 16);
