// ============================================================
// logger.js
// Lightweight timestamped logger. No external dependency needed
// for something this simple — keeps the bot's footprint small.
// ============================================================

function timestamp() {
  return new Date().toISOString();
}

const logger = {
  info: (msg) => console.log(`[${timestamp()}] [INFO]  ${msg}`),
  warn: (msg) => console.warn(`[${timestamp()}] [WARN]  ${msg}`),
  error: (msg) => console.error(`[${timestamp()}] [ERROR] ${msg}`),
  success: (msg) => console.log(`[${timestamp()}] [OK]    ${msg}`),
  cycle: (msg) => console.log(`\n[${timestamp()}] ====== ${msg} ======`),
};

module.exports = logger;
