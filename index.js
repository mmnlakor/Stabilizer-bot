// ============================================================
// index.js
// Main entrypoint. Runs the swap bot as a long-lived process:
//   startup -> loop { swap cycle -> random delay } forever
//
// Designed to run on Railway (or any always-on Node host).
// ============================================================

const config = require("./config");
const logger = require("./logger");
const { SwapBot, sleep, randomInt } = require("./swap");

let isShuttingDown = false;
let cycleCount = 0;

async function mainLoop(bot) {
  while (!isShuttingDown) {
    cycleCount++;
    logger.info(`--- Starting cycle #${cycleCount} ---`);

    try {
      await bot.executeSwap();
    } catch (err) {
      // A failed cycle should never crash the whole bot. Log it,
      // wait the normal delay, and try again next cycle with a
      // fresh random pair/amount.
      logger.error(`Cycle #${cycleCount} failed: ${err.shortMessage || err.message}`);
      if (err.transactionHash || err.receipt?.hash) {
        logger.error(`Failed tx hash: ${err.transactionHash || err.receipt?.hash}`);
      }
    }

    if (isShuttingDown) break;

    const delaySeconds = randomInt(config.minDelaySeconds, config.maxDelaySeconds);
    logger.info(`Next cycle in ${delaySeconds}s (${(delaySeconds / 60).toFixed(1)} min)...\n`);
    await sleep(delaySeconds * 1000);
  }

  logger.info("Main loop exited cleanly.");
}

async function start() {
  logger.cycle("STABILIZER FINANCE SWAP BOT — STARTING UP");
  logger.info(`Swap percent per cycle: ${config.swapPercent}%`);
  logger.info(`Min output guard: ${config.minOutputPercent}%`);
  logger.info(`Delay range: ${config.minDelaySeconds}s - ${config.maxDelaySeconds}s`);

  const bot = new SwapBot();

  try {
    await bot.init();
  } catch (err) {
    logger.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }

  logger.success("Bot initialized successfully. Entering main loop.\n");
  await mainLoop(bot);
}

// Graceful shutdown on Ctrl+C or platform stop signal (e.g. Railway redeploy)
function setupShutdownHandlers() {
  const shutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}. Finishing current cycle, then shutting down...`);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Catch anything unexpected so the process doesn't die silently
// without a log line explaining why (important on Railway where
// you only see logs, not a terminal).
process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled promise rejection: ${reason}`);
});
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  // Uncaught exceptions outside the main loop's try/catch are not
  // safe to continue from blindly — exit and let Railway restart
  // the process cleanly rather than risk a corrupted state.
  process.exit(1);
});

setupShutdownHandlers();
start();
