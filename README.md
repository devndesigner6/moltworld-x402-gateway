# Moltworld x402 Gateway

Moltworld is an x402 pay-per-request gateway for AI services. The current WIF payment rail uses **WIF (World Is Flat)** on **Robinhood Chain**; the network reference is technical and does not imply affiliation or endorsement.

> **Current status:** WIF chat uses live Robinhood Chain x402 payments and signed receipts. Setting `ROBINHOOD_MARKETPLACE_ENABLED=true` enables wallet-signed creator listings, reviewed API checkout, exact creator credits, and verified wallet-authorized payout reconciliation. The owner setup wizard deploys, funds, arms, revokes and withdraws from the experimental EIP-1271 mandate. Its session key stays on the local agent's machine. Mainnet deployment and paid mandate verification require the owner's wallet and gas; the code does not invent transaction evidence. The contract has no independent audit. External mobile-wallet connectivity requires a Reown project ID. Image, voice, video and automatic WIF refunds remain unavailable.

## Payment addresses

These are different kinds of addresses and must not be interchanged:

| Setting | Value | Purpose |
| --- | --- | --- |
| WIF token contract (`WIF_TOKEN_ADDRESS`) | `0x5173b8eA6923c2d40267890D45C46a3480954773` | ERC-20 asset paid by users; 18 decimals |
| Merchant recipient (`EVM_ADDRESS`) | `0x0cbF84496640E7441eF743f8F03189Aa8C0B8cb6` | Your wallet; x402 settlements are sent here |

The backend only needs the public recipient address. **Never provide or commit a seed phrase or private key.** A user connects a supported EVM wallet and authorizes a WIF payment. First use may require an exact ERC-20 approval to Permit2; that separate approval transaction consumes native ETH for gas. The x402 payment itself is in WIF.

## Current payment flow

1. The gateway validates a chat request and computes its USD quote before issuing an x402 challenge.
2. A guarded live WIF/USD price snapshot is derived from the exact Robinhood Uniswap v4 PoolId using StateView plus the on-chain Chainlink ETH/USD feed, then converted to an exact 18-decimal amount with integer arithmetic. The adapter checks chain ID, latest-block freshness, the oracle heartbeat, and active liquidity. Identical reads are coalesced and cached for five seconds; RPC/oracle failures never fall back to a stale price.
3. The challenge names Robinhood Chain (`eip155:4663` on mainnet), the WIF ERC-20 contract, the receiving wallet, the exact raw amount, and Permit2 transfer metadata.
4. A connected wallet authorizes the x402 payment; the facilitator verifies and settles it to the configured recipient.
5. The gateway verifies that chain, token, recipient, and amount still match the quote; it records the payment and signs a receipt containing the exact token amount and the USD quote.

No automated WIF refund is implemented. Chat is configured to settle after successful work; a rare failure after an already-confirmed settlement is marked for manual review rather than invoking the legacy Algorand-USDC refund worker.

## Run and verify locally

Requirements: Node.js 20+, pnpm, and the project dependencies.

```bash
cp .env.example .env
# Add real development credentials only in your local .env; never commit it.
pnpm install --frozen-lockfile
node_modules/.bin/tsc --noEmit -p tsconfig.json
node_modules/.bin/tsc -p sdk/js/tsconfig.json --noEmit
node_modules/.bin/tsc -p web/tsconfig.json
node_modules/.bin/vitest run
node_modules/.bin/tsx scripts/build-vendor.ts
```

The automated tests use deterministic test fixtures and do not broadcast a blockchain payment. The WIF price adapter used by the running application uses live pool data and fails closed; the code does not create simulated production settlements.

## Public deployment

The public website and API origin is [moltworldd.vercel.app](https://moltworldd.vercel.app). WIF documentation is hosted at [algorand-54fd52b3.mintlify.app](https://algorand-54fd52b3.mintlify.app). Vercel proxies requests to the Render Hono service at `https://motoworld-wif.onrender.com`; the Vercel function also proxies paths handled by the function itself (including the root) to that same fixed Render origin. Render holds the database connection and provider/receipt secrets. Set Render `PUBLIC_DOMAIN=https://moltworldd.vercel.app` so x402 challenges and canonical links use the public origin. Vercel does not need the database URL or provider key.

See [`.env.example`](.env.example) for the service settings. Production requires `NODE_ENV=production`, `PAYMENT_CHAIN=robinhood`, `ROBINHOOD_NETWORK=mainnet`, the public `EVM_ADDRESS`, WIF contract, a real OpenAI or OpenRouter key, PostgreSQL, a receipt signing seed, and `MOCK_PROVIDERS=false` / `SKIP_UPSTREAM_VERIFICATION=false`. Keep secrets in Render, not Git. The Render free service can sleep when idle; its first request may take time to wake.

## Scope not yet migrated

- WIF settlement/refunds for image, voice, and video calls.
- Independent security review and a user-authorized mainnet payment for the EIP-1271 mandate. The owner setup/revoke wizard, pinned on-chain lookup and local session signer are implemented.
- Additional repeat-use evidence across users or agents is still needed to establish a measured hackathon flywheel; the first user-authorized WIF payment and response have been verified.

Legacy-only payment actions stay isolated from WIF. Mandate deployment happens in the owner's wallet. Run `pnpm exec tsx scripts/checkWifMandate.ts` with the local MCP configuration to read its live policy, then add `--pay` to make one real GPT request and verify its receipt. A funded, armed mandate is required. Local EOA budgets do not enforce the contract's policy.

## Source and license

This public [Moltworld x402 Gateway repository](https://github.com/devndesigner6/moltworld-x402-gateway) builds on [`hackcat29/moltworld-x402`](https://github.com/hackcat29/moltworld-x402). The package declares MIT licensing; the upstream license text could not be retrieved from that repository. Moltworld is an independent project and is not affiliated with, endorsed by, or sponsored by Robinhood Markets, Inc.
