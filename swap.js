// ============================================================
// swap.js
// Core swap execution logic:
//   1. Pick a random (sellToken, buyToken) pair
//   2. Read on-chain balance + decimals for the sell token
//   3. Compute swap amount = SWAP_PERCENT% of balance
//   4. Approve router if current allowance is insufficient
//   5. Compute a safe minimum output and call swap()
//   6. Retry transient failures with backoff
// ============================================================

const { ethers } = require("ethers");
const config = require("./config");
const logger = require("./logger");
const { ERC20_ABI, ROUTER_ABI } = require("./abis");

const TOKEN_LIST = Object.entries(config.tokens).map(([symbol, address]) => ({
  symbol,
  address,
}));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Picks two distinct tokens at random: one to sell, one to buy.
function pickRandomPair() {
  const sellToken = TOKEN_LIST[randomInt(0, TOKEN_LIST.length - 1)];
  const buyPool = TOKEN_LIST.filter((t) => t.symbol !== sellToken.symbol);
  const buyToken = buyPool[randomInt(0, buyPool.length - 1)];
  return { sellToken, buyToken };
}

// Wraps a contract call with retry + backoff for transient errors
// (RPC hiccups, nonce timing, temporary network issues).
async function withRetry(label, fn) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === config.maxRetries + 1;
      logger.warn(
        `${label} failed (attempt ${attempt}/${config.maxRetries + 1}): ${err.shortMessage || err.message}`
      );
      if (isLastAttempt) break;
      await sleep(config.retryDelaySeconds * 1000);
    }
  }
  throw lastError;
}

class SwapBot {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.router = new ethers.Contract(config.routerAddress, ROUTER_ABI, this.wallet);

    // Cache of ERC20 contract instances, keyed by symbol.
    this.tokenContracts = {};
    for (const { symbol, address } of TOKEN_LIST) {
      this.tokenContracts[symbol] = new ethers.Contract(address, ERC20_ABI, this.wallet);
    }
    this.decimalsCache = {};
  }

  async init() {
    const network = await this.provider.getNetwork();
    if (Number(network.chainId) !== config.chainId) {
      throw new Error(
        `[STARTUP ERROR] RPC reports chainId ${network.chainId}, but CHAIN_ID=${config.chainId} in .env. Refusing to start.`
      );
    }

    logger.info(`Wallet address: ${this.wallet.address}`);
    logger.info(`Connected to chain ID ${network.chainId} via ${config.rpcUrl}`);

    // Pre-fetch and cache decimals for all tokens once at startup.
    for (const { symbol } of TOKEN_LIST) {
      const decimals = await this.tokenContracts[symbol].decimals();
      this.decimalsCache[symbol] = Number(decimals);
      logger.info(`Token ${symbol}: decimals = ${this.decimalsCache[symbol]}`);
    }

    await this.logAllBalances();
  }

  async logAllBalances() {
    for (const { symbol } of TOKEN_LIST) {
      const balance = await this.getBalance(symbol);
      logger.info(`Balance ${symbol}: ${balance}`);
    }
  }

  async getBalance(symbol) {
    const raw = await this.tokenContracts[symbol].balanceOf(this.wallet.address);
    return ethers.formatUnits(raw, this.decimalsCache[symbol]);
  }

  async getRawBalance(symbol) {
    return this.tokenContracts[symbol].balanceOf(this.wallet.address);
  }

  // Ensures the router has sufficient allowance to pull `amount` of
  // `symbol` from the wallet. Sends an approve() tx only if needed.
  async ensureApproval(symbol, amount) {
    const contract = this.tokenContracts[symbol];
    const currentAllowance = await contract.allowance(
      this.wallet.address,
      config.routerAddress
    );

    if (currentAllowance >= amount) {
      logger.info(`${symbol} allowance already sufficient, skipping approve()`);
      return;
    }

    logger.info(`Approving router to spend ${symbol}...`);
    const tx = await withRetry(`${symbol} approve()`, () =>
      contract.approve(config.routerAddress, amount)
    );
    logger.info(`Approve tx sent: ${tx.hash}`);
    const receipt = await tx.wait(1);
    logger.success(`Approve confirmed in block ${receipt.blockNumber}`);
  }

  // Computes a conservative minimum-output amount. Stabilizer is a
  // near-1:1 stablecoin AMM, so we assume a 1:1 base rate adjusted
  // for decimal differences between sellToken and buyToken, then
  // apply MIN_OUTPUT_PERCENT as a safety margin.
  computeMinOutput(sellAmountRaw, sellSymbol, buySymbol) {
    const sellDecimals = this.decimalsCache[sellSymbol];
    const buyDecimals = this.decimalsCache[buySymbol];

    let expected = sellAmountRaw;
    if (buyDecimals > sellDecimals) {
      expected = sellAmountRaw * (10n ** BigInt(buyDecimals - sellDecimals));
    } else if (buyDecimals < sellDecimals) {
      expected = sellAmountRaw / (10n ** BigInt(sellDecimals - buyDecimals));
    }

    // Apply MIN_OUTPUT_PERCENT (e.g. 90 => 90%) using integer math.
    const percentBasisPoints = BigInt(Math.round(config.minOutputPercent * 100)); // e.g. 9000
    return (expected * percentBasisPoints) / 10000n;
  }

  async executeSwap() {
    const { sellToken, buyToken } = pickRandomPair();
    logger.cycle(`SWAP CYCLE: ${sellToken.symbol} -> ${buyToken.symbol}`);

    const rawBalance = await this.getRawBalance(sellToken.symbol);
    const humanBalance = ethers.formatUnits(rawBalance, this.decimalsCache[sellToken.symbol]);

    if (Number(humanBalance) < config.minBalanceThreshold) {
      logger.warn(
        `${sellToken.symbol} balance (${humanBalance}) is below MIN_BALANCE_THRESHOLD ` +
        `(${config.minBalanceThreshold}). Skipping this cycle.`
      );
      return { skipped: true, reason: "insufficient_balance" };
    }

    // swapAmount = SWAP_PERCENT% of current balance, in raw token units.
    const percentBasisPoints = BigInt(Math.round(config.swapPercent * 100)); // e.g. 2500 for 25%
    const swapAmountRaw = (rawBalance * percentBasisPoints) / 10000n;

    if (swapAmountRaw === 0n) {
      logger.warn(`Computed swap amount is 0 for ${sellToken.symbol}. Skipping this cycle.`);
      return { skipped: true, reason: "zero_amount" };
    }

    const humanAmount = ethers.formatUnits(swapAmountRaw, this.decimalsCache[sellToken.symbol]);
    logger.info(
      `Swapping ${humanAmount} ${sellToken.symbol} -> ${buyToken.symbol} ` +
      `(${config.swapPercent}% of balance ${humanBalance})`
    );

    // Step 1: Approval
    await this.ensureApproval(sellToken.symbol, swapAmountRaw);

    // Step 2: Compute minimum acceptable output
    const minOutputRaw = this.computeMinOutput(
      swapAmountRaw,
      sellToken.symbol,
      buyToken.symbol
    );
    logger.info(
      `Minimum acceptable output: ${ethers.formatUnits(minOutputRaw, this.decimalsCache[buyToken.symbol])} ${buyToken.symbol} ` +
      `(${config.minOutputPercent}% of naive 1:1 expectation)`
    );

    // Step 3: Estimate gas, then send swap()
    const tx = await withRetry(`${sellToken.symbol}->${buyToken.symbol} swap()`, async () => {
      const estimatedGas = await this.router.swap.estimateGas(
        sellToken.address,
        buyToken.address,
        swapAmountRaw,
        minOutputRaw
      );
      const gasLimit =
        (estimatedGas * BigInt(Math.round(config.gasLimitMultiplier * 100))) / 100n;

      return this.router.swap(
        sellToken.address,
        buyToken.address,
        swapAmountRaw,
        minOutputRaw,
        { gasLimit }
      );
    });

    logger.info(`Swap tx sent: ${tx.hash}`);
    const receipt = await tx.wait(1);

    if (receipt.status !== 1) {
      throw new Error(`Swap transaction reverted on-chain. Tx: ${tx.hash}`);
    }

    logger.success(
      `Swap confirmed in block ${receipt.blockNumber}. ` +
      `${humanAmount} ${sellToken.symbol} -> ${buyToken.symbol}. ` +
      `Gas used: ${receipt.gasUsed.toString()}`
    );

    return { skipped: false, txHash: tx.hash };
  }
}

module.exports = { SwapBot, sleep, randomInt };
