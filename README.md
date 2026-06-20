# Stabilizer-bot
# Stabilizer Finance Swap Bot (Sepolia Testnet)

Automated bot that performs random-pair stablecoin swaps on
[Stabilizer Finance](https://app.stabilizer.finance) (Sepolia Testnet),
in an infinite loop with randomized delays.

## What it does, each cycle

1. Picks a random `(sellToken, buyToken)` pair out of USDC / USDT / USDS / USDZ
   (12 possible directional pairs, uniformly random).
2. Reads your live on-chain balance of the sell token.
3. Computes the swap amount as **25% of that balance** (configurable).
4. Sends `approve()` to the router if the existing allowance isn't enough.
5. Sends `swap()` on the Stabilizer Router.
6. Waits a **random delay between 2–10 minutes** (configurable), then repeats forever.

## Architecture

```
.env            <- your secrets and tunables (never commit this)
.env.example    <- template, safe to commit
config.js       <- loads + strictly validates .env at startup
abis.js         <- minimal ERC20 + Router ABIs
logger.js       <- timestamped console logging
swap.js         <- core swap logic (SwapBot class)
index.js        <- entrypoint: startup + infinite loop + shutdown handling
```

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and fill in:
- `PRIVATE_KEY` — your wallet's private key (Sepolia testnet wallet only — never use a mainnet key)
- `RPC_URL` — any Sepolia RPC endpoint (Infura, Alchemy, public RPC)

Everything else (router address, token addresses, swap %, delays) is already filled
in from values confirmed during setup, but double-check them against the
`.env.example` comments before running.

## Running locally

```bash
npm start
```

## Deploying to Railway

1. Push this folder to a GitHub repo (`.env` is gitignored — it will NOT be pushed).
2. Create a new Railway project from that repo.
3. In Railway's "Variables" tab, add every variable from `.env.example` with your real values.
4. Railway will run `npm start` automatically (uses `package.json`'s `main`/`start` script).
5. Watch the logs tab — you should see the startup banner, balances, then swap cycles.

## ⚠️ Important: things I could not 100% verify

I built this from your screenshots of one real transaction plus your reported token
addresses. Two things are **assumptions**, not confirmed facts, and you should watch
the first few live cycles closely:

1. **The `_toAmount` parameter's exact meaning.** Stabilizer's FAQ confirms multi-hop
   atomic routing through USDZ but doesn't document this parameter precisely. I've
   treated it as a **minimum acceptable output** (standard DeFi slippage-guard pattern)
   and compute it as 90% of a naive 1:1-adjusted expected amount. If Stabilizer's
   contract instead expects an *exact* output amount (not a minimum), swaps will
   revert consistently. If that happens, lowering `MIN_OUTPUT_PERCENT` won't fix it —
   the parameter semantics would need re-checking against a real successful
   multi-hop transaction in Etherscan's decoder.

2. **Whether `approve()` needs to be infinite or per-amount.** The bot approves
   exactly the amount it's about to swap, each cycle (safer, but means an approve
   tx before nearly every swap tx — double the transaction count/gas vs. one-time
   max approval). If you'd rather approve `MaxUint256` once and skip repeated
   approvals, that's a one-line change in `swap.js`'s `ensureApproval()` — ask me
   and I'll make it.

**Recommendation:** let it run for 2–3 cycles first and watch the logs. If a swap
reverts, paste me the failed transaction hash and I'll diagnose the decoded
revert reason precisely rather than guessing further.

## Safety features included

- Strict `.env` validation at startup (wrong address format, missing keys, bad
  numeric ranges all fail immediately and loudly, before any transaction is sent).
- Chain ID cross-check between RPC and `.env` — refuses to start if mismatched.
- Skips a cycle (rather than reverting on-chain) if the randomly chosen sell
  token's balance is below `MIN_BALANCE_THRESHOLD`.
- Retry with backoff on transient RPC errors (`MAX_RETRIES`, `RETRY_DELAY_SECONDS`).
- A failed swap cycle is logged and the bot moves on to the next cycle — it
  never crashes the whole process over one bad transaction.
- Graceful shutdown on `SIGINT`/`SIGTERM` (finishes current cycle, then exits).
- All decimals are read live from each token contract — never hardcoded/assumed.
