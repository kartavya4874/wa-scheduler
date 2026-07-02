// ═══════════════════════════════════════════════════════════════
// FRONTEND CONFIGURATION
// ═══════════════════════════════════════════════════════════════
// Since this is a static frontend (no bundler), environment
// variables can't be injected at build time. Instead, edit this
// file to set your backend API URL.
//
// For local development: use 'http://localhost:3000'
// For production:        use your Render backend URL
// ═══════════════════════════════════════════════════════════════

const CONFIG = Object.freeze({
  API_URL: window.location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://wa-scheduler-u2en.onrender.com',
});
