// Draw To Build - itch.io configuration.
// SERVER_URL / STATUS_URL must point to a server running server/server.js (v2) - it enforces ownership and the 24h Global Build rule.
// Must be wss:// / https:// because itch.io is https. Keep the old values only if that host now runs the v2 server.
window.DTB_CONFIG = {
  SERVER_URL: 'wss://dao7kga3dqiq-production-sa0k4pz1.us-central1.suga.run/ws',
  STATUS_URL: 'https://dao7kga3dqiq-production-sa0k4pz1.us-central1.suga.run/api/status'
};
