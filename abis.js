// ============================================================
// abis.js
// Minimal ABIs — only the functions this bot actually calls.
// Keeping ABIs minimal reduces ambiguity and avoids accidentally
// matching the wrong overloaded function signature.
// ============================================================

// Standard ERC-20 surface needed for balance checks, decimals,
// and the approve() call required before swap().
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// Stabilizer Router — confirmed from on-chain transaction input data:
//   swap(address _from, address _to, uint256 _fromAmount, uint256 _toAmount)
// This single entrypoint internally routes multi-hop swaps through USDZ
// when needed (e.g. USDT -> USDZ -> USDC), and reverts atomically if
// any hop fails.
const ROUTER_ABI = [
  "function swap(address _from, address _to, uint256 _fromAmount, uint256 _toAmount)",
];

module.exports = { ERC20_ABI, ROUTER_ABI };
