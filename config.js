// ============================================================
// config.js
// Loads and validates environment variables. Fails fast and loud
// at startup rather than failing confusingly mid-transaction.
// ============================================================

require("dotenv").config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`[CONFIG ERROR] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function requireAddress(name) {
  const value = requireEnv(name);
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`[CONFIG ERROR] ${name} is not a valid Ethereum address: ${value}`);
  }
  return value;
}

function requireNumber(name, { min = -Infinity, max = Infinity } = {}) {
  const raw = requireEnv(name);
  const num = Number(raw);
  if (Number.isNaN(num)) {
    throw new Error(`[CONFIG ERROR] ${name} must be a number, got: ${raw}`);
  }
  if (num < min || num > max) {
    throw new Error(`[CONFIG ERROR] ${name}=${num} is out of allowed range [${min}, ${max}]`);
  }
  return num;
}

const config = {
  privateKey: requireEnv("PRIVATE_KEY"),
  rpcUrl: requireEnv("RPC_URL"),
  chainId: requireNumber("CHAIN_ID", { min: 1 }),

  routerAddress: requireAddress("ROUTER_ADDRESS"),

  tokens: {
    USDC: requireAddress("USDC_ADDRESS"),
    USDT: requireAddress("USDT_ADDRESS"),
    USDS: requireAddress("USDS_ADDRESS"),
    USDZ: requireAddress("USDZ_ADDRESS"),
  },

  swapPercent: requireNumber("SWAP_PERCENT", { min: 0.01, max: 100 }),
  minOutputPercent: requireNumber("MIN_OUTPUT_PERCENT", { min: 0, max: 100 }),

  minDelaySeconds: requireNumber("MIN_DELAY_SECONDS", { min: 1 }),
  maxDelaySeconds: requireNumber("MAX_DELAY_SECONDS", { min: 1 }),

  minBalanceThreshold: requireNumber("MIN_BALANCE_THRESHOLD", { min: 0 }),

  maxRetries: requireNumber("MAX_RETRIES", { min: 0, max: 20 }),
  retryDelaySeconds: requireNumber("RETRY_DELAY_SECONDS", { min: 1 }),

  gasLimitMultiplier: requireNumber("GAS_LIMIT_MULTIPLIER", { min: 1, max: 5 }),
};

// Cross-field validation
if (config.minDelaySeconds > config.maxDelaySeconds) {
  throw new Error(
    `[CONFIG ERROR] MIN_DELAY_SECONDS (${config.minDelaySeconds}) cannot be greater than MAX_DELAY_SECONDS (${config.maxDelaySeconds})`
  );
}

// Validate private key format (basic check; ethers will do the real validation)
if (!/^0x[a-fA-F0-9]{64}$/.test(config.privateKey)) {
  throw new Error(
    "[CONFIG ERROR] PRIVATE_KEY must be a 0x-prefixed 64-character hex string"
  );
}

module.exports = config;
