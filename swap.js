// ============================================================
// swap.js
// Core swap execution logic.
//
// Each cycle now does TWO swaps:
//   1. Forward: A -> B  (50% of A's current balance)
//   2. Random delay (2-10 min)
//   3. Return:  B -> A  (exact amount received from forward swap)
//   4. Random delay (2-10 min)  <- handled by index.js after return
//
// Then index.js picks a fresh random pair for the next cycle.
//
// PYUSD added as 5th token alongside USDC, USDT, USDS, USDZ.
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

// Wraps a contract call with retry + backoff for transient errors.
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

    const percentBasisPoints = BigInt(Math.round(config.minOutputPercent * 100));
    return (expected * percentBasisPoints) / 10000n;
  }

  // Executes a single on-chain swap. Returns the raw amount of buyToken
  // actually received (derived from the ERC-20 Transfer event in the
  // receipt), so the return swap can use the exact received amount.
  async _sendSwap(sellToken, buyToken, sellAmountRaw) {
    const humanAmount = ethers.formatUnits(sellAmountRaw, this.decimalsCache[sellToken.symbol]);

    logger.info(
      `Swapping ${humanAmount} ${sellToken.symbol} -> ${buyToken.symbol}`
    );

    // Approval
    await this.ensureApproval(sellToken.symbol, sellAmountRaw);

    // Minimum acceptable output (slippage guard)
    const minOutputRaw = this.computeMinOutput(
      sellAmountRaw,
      sellToken.symbol,
      buyToken.symbol
    );
    logger.info(
      `Min acceptable output: ${ethers.formatUnits(minOutputRaw, this.decimalsCache[buyToken.symbol])} ${buyToken.symbol}`
    );

    // Estimate gas + send
    const tx = await withRetry(`${sellToken.symbol}->${buyToken.symbol} swap()`, async () => {
      const estimatedGas = await this.router.swap.estimateGas(
        sellToken.address,
        buyToken.address,
        sellAmountRaw,
        minOutputRaw
      );
      const gasLimit =
        (estimatedGas * BigInt(Math.round(config.gasLimitMultiplier * 100))) / 100n;

      return this.router.swap(
        sellToken.address,
        buyToken.address,
        sellAmountRaw,
        minOutputRaw,
        { gasLimit }
      );
    });

    logger.info(`Swap tx sent: ${tx.hash}`);
    const receipt = await tx.wait(1);

    if (receipt.status !== 1) {
      throw new Error(`Swap transaction reverted on-chain. Tx: ${tx.hash}`);
    }

    // Derive the exact amount of buyToken received by parsing the
    // ERC-20 Transfer events in the receipt. We look for a Transfer
    // TO our wallet address of the buyToken contract.
    const buyTokenAddress = buyToken.address.toLowerCase();
    const walletAddress = this.wallet.address.toLowerCase();
    const transferTopic = ethers.id("Transfer(address,address,uint256)");

    let receivedRaw = 0n;
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === buyTokenAddress &&
        log.topics[0] === transferTopic &&
        log.topics.length === 3
      ) {
        const to = "0x" + log.topics[2].slice(26);
        if (to.toLowerCase() === walletAddress) {
          receivedRaw = BigInt(log.data);
          break;
        }
      }
    }

    const humanReceived = ethers.formatUnits(receivedRaw, this.decimalsCache[buyToken.symbol]);
    logger.success(
      `Swap confirmed in block ${receipt.blockNumber}. ` +
      `Sent ${humanAmount} ${sellToken.symbol}, received ${humanReceived} ${buyToken.symbol}. ` +
      `Gas used: ${receipt.gasUsed.toString()}`
    );

    return { txHash: tx.hash, receivedRaw, humanReceived };
  }

  // One full swap cycle:
  //   1. Pick random pair A -> B
  //   2. Swap 50% of A's balance -> B
  //   3. Wait random delay
  //   4. Swap exact received amount back B -> A
  //
  // The delay after the return swap is handled by index.js,
  // consistent with how the original bot was structured.
  async executeSwap() {
    const { sellToken, buyToken } = pickRandomPair();
    logger.cycle(`SWAP CYCLE: ${sellToken.symbol} <-> ${buyToken.symbol}`);

    // ── FORWARD SWAP: A -> B ──────────────────────────────────
    const rawBalance = await this.getRawBalance(sellToken.symbol);
    const humanBalance = ethers.formatUnits(rawBalance, this.decimalsCache[sellToken.symbol]);

    if (Number(humanBalance) < config.minBalanceThreshold) {
      logger.warn(
        `${sellToken.symbol} balance (${humanBalance}) is below MIN_BALANCE_THRESHOLD ` +
        `(${config.minBalanceThreshold}). Skipping this cycle.`
      );
      return { skipped: true, reason: "insufficient_balance" };
    }

    // 50% of current balance
    const percentBasisPoints = BigInt(Math.round(config.swapPercent * 100)); // 5000 for 50%
    const forwardAmountRaw = (rawBalance * percentBasisPoints) / 10000n;

    if (forwardAmountRaw === 0n) {
      logger.warn(`Computed swap amount is 0 for ${sellToken.symbol}. Skipping this cycle.`);
      return { skipped: true, reason: "zero_amount" };
    }

    logger.info(
      `Forward swap: ${config.swapPercent}% of ${humanBalance} ${sellToken.symbol} ` +
      `= ${ethers.formatUnits(forwardAmountRaw, this.decimalsCache[sellToken.symbol])} ${sellToken.symbol}`
    );

    const forward = await this._sendSwap(sellToken, buyToken, forwardAmountRaw);

    // ── INTER-SWAP DELAY ──────────────────────────────────────
    if (forward.receivedRaw === 0n) {
      logger.warn(
        `Could not determine exact amount received from forward swap ` +
        `(Transfer event not found in receipt). Skipping return swap to avoid sending wrong amount.`
      );
      return { skipped: false, txHash: forward.txHash, returnSkipped: true };
    }

    const interDelay = randomInt(config.minDelaySeconds, config.maxDelaySeconds);
    logger.info(
      `Forward swap complete. Waiting ${interDelay}s before return swap...`
    );
    await sleep(interDelay * 1000);

    // ── RETURN SWAP: B -> A (exact amount received) ───────────
    logger.cycle(`RETURN SWAP: ${buyToken.symbol} -> ${sellToken.symbol}`);
    logger.info(
      `Returning exact received amount: ${forward.humanReceived} ${buyToken.symbol} -> ${sellToken.symbol}`
    );

    // Verify we still have enough of buyToken to return
    // (edge case: another process or tx may have spent it)
    const buyTokenBalance = await this.getRawBalance(buyToken.symbol);
    if (buyTokenBalance < forward.receivedRaw) {
      logger.warn(
        `${buyToken.symbol} balance (${ethers.formatUnits(buyTokenBalance, this.decimalsCache[buyToken.symbol])}) ` +
        `is less than expected return amount (${forward.humanReceived}). ` +
        `Using available balance instead.`
      );
      // Use what's actually available rather than failing
      forward.receivedRaw = buyTokenBalance;
    }

    const returnSwap = await this._sendSwap(buyToken, sellToken, forward.receivedRaw);

    return {
      skipped: false,
      forwardTxHash: forward.txHash,
      returnTxHash: returnSwap.txHash,
    };
  }
}

module.exports = { SwapBot, sleep, randomInt };
