# WIF mandates and marketplace implementation plan

> Execute with superpowers:executing-plans, using test-driven changes and a final review. The user requested the ordered plan and execution on 11 November 2026.

**Goal:** Complete the existing WIF agent and creator-commerce paths, then enable the live marketplace after its payment and accounting checks pass.

**Architecture:** Keep the Hono gateway, PostgreSQL ledger, x402 Permit2 payments, existing owner-funded EIP-1271 mandate, and local MCP signer. Reuse the quote store for marketplace requests. Credit creators in the same transaction that completes a request. Operators authorize creator transfers in their own wallets, and the gateway verifies their on-chain transfers before marking payouts sent.

**Tech stack:** TypeScript, Hono, PostgreSQL/PGlite, viem, x402 2.27, Solidity, browser EIP-1193 wallets.

## Constraints and acceptance checks

- Preserve direct wallet chat, legacy Algorand behavior, existing receipt formats, and recorded balances.
- Keep private keys out of the gateway and website. Mandate owner transactions remain wallet-authorized.
- Preserve chain 4663, canonical WIF/Permit2/proxy addresses, exact integer amounts, finite allowance, expiry and revocation enforcement.
- Real mainnet proof requires an owner-approved funded mandate and wallet signatures. Simulations must stay labeled as simulations.
- Marketplace listing approval remains an operator action. Publish the existing 15% default fee and wallet-authorized payout terms.
- A repeated payment, response retry, payout request, or payout transaction must not create duplicate work, earnings or payouts.
- The downloaded folder has no Git history. Compare changed files with the current repository before publication and preserve unrelated work.

## Ordered tasks

### 1. Payment and accounting correctness

Files: `src/routes/market.ts`, `src/payments/gateway.ts`, `src/payments/wif-challenges.ts`, `src/ledger/index.ts`, `sdk/js/src/index.ts`, `src/market/safeFetch.ts`, existing payment/marketplace tests.

- [ ] Add regression tests for a changed price between a marketplace challenge and signed retry, a changed request body, and an expired quote.
- [x] Reuse server-issued quote ID, exact body hash and original price for signed marketplace retries.
- [x] Complete a request and book its creator/rebate credit atomically. Test rollback and repeat completion.
- [x] Reserve SDK budgets during payment creation. Release only confirmed uncharged failures, preserve uncertain outcomes, and test simultaneous calls and signature rejection.
- [x] Reject literal IPv6 creator targets as well as private DNS results.

### 2. Agent mandate completion

Files: `sdk/js/src/evm-mandate*.ts`, `sdk/js/src/mcp.ts`, `web/mandate.ts`, `src/routes/mandates.ts`, `src/application.ts`, `contracts/scripts/*`, mandate tests.

- [ ] Exercise real installed client and facilitator code against the contract on a local chain, including transfer and finite allowance decrement.
- [ ] Verify over-cap, wrong token/payee, expiry, revoked and stale-epoch payments fail.
- [x] Provide an on-chain WIF mandate lookup that reports active policy without presenting the legacy Algorand API as the WIF implementation.
- [ ] Fix any integration failures and make the owner setup/local MCP instructions reproducible.

### 3. Verified creator payouts

Files: `src/ledger/db.ts`, `src/ledger/index.ts`, `src/routes/ops.ts`, `src/application.ts`, WIF payout verifier and tests.

- [x] Batch exact unpaid credits atomically, safe under concurrent batching.
- [x] Return wallet transaction instructions for the selected batch without holding a private key.
- [x] Verify chain, successful confirmed receipt, WIF contract, sender, recipient and exact amount before recording payment.
- [x] Reject transaction reuse and make reconciliation idempotent. Preserve Algorand workers.

### 4. Website and integration surfaces

Files: `src/site/pages.ts`, `src/site/script.ts`, `src/site/widgets.ts`, `src/site/nav.ts`, `web/pay.ts`, browser tests.

- [x] Expose enabled marketplace browsing, wallet-signed listing submission and paid calls, plus creator earnings and payout status.
- [x] Keep pending listings out of the public marketplace and show their review status to the submitter.
- [x] Show accurate decimal WIF quotes and the beta/verification status of mandates.
- [ ] Verify desktop and mobile pages, wallet rejections, quote expiry and receipt verification.

### 5. Documentation and complete verification

- [x] Update README, SDK examples, WIF docs, environment template and operator payout instructions to match the implemented paths.
- [ ] Run typechecks, backend/SDK tests, local mandate settlement tests and relevant browser checks. Fix new failures.
- [x] Review changed payment, authorization and persistence paths with their retry/concurrency behavior.

### 6. Publish and live verification

- [ ] Compare current repository state, publish the tested changes, and identify the actual Render/Vercel service revisions.
- [ ] Set public documentation URL and enable the marketplace only when the deployed code supports the completed path.
- [ ] Verify health, listing discovery, unsigned quotes/challenges, MCP and mandate lookup on the public URL.
- [ ] Present the exact owner-wallet setup/payment/payout transactions if a live wallet signature is needed. Record real proof only after it exists.

## Progress

- Plan created. Scope follows the user's existing project and explicit request to execute.
- Ruling: Use operator-wallet payouts plus verified reconciliation. The existing gateway has no EVM payout key, and this completes creator payment without introducing custody of that key.
- Updated owner and new-payment recipient confirmed by the user: `0x0cbF84496640E7441eF743f8F03189Aa8C0B8cb6`. A real ETH balance was verified on 11 November. Deployment/fund/arm require its wallet signature. Local session public address: `0x7e19f35143a7413b51117BdD94Aba1e9829844AE`; its key remains local.
- Connected Render service: `srv-dbmedjd9fdbs738kl840`, workspace `tea-d59slgpr0fns7380hj3g`, auto-deploying repository main. Public Vercel proxies to this Render service.
- Isolated upstream checkout: `node_modules/.moltworld-upstream`, head `a44156f2957dd07231de774723511a80a84d8197`. Initial comparisons show identical source content except local changes and Windows line endings.
- Implemented a live-only read/pay check at `scripts/checkWifMandate.ts`; `--pay` requires the user's owner-armed contract and local session config.
- Contract compilation succeeded and regenerated the SDK artifact plus the server runtime fingerprint. Source hash remains `83dbe15acfaf4d6401196ded5e57719afffd0ab1e56913d744d65e26f92d4682`.
- 41 selected payment/mandate tests and 12 site/owner checks passed. Typecheck and initial build passed. Full suite under sandbox could not reach localhost facilitators. Escalated catalog tests passed; the payments hook exceeded this machine's 30-second hook timeout while other tests/builds were running. Rerun after the current full suite ends with a longer CLI hook timeout, without changing production configuration.
- Remaining: finish accurate UI/docs and browser checks, payout replay/concurrency tests, review, publish tested changes, set Render docs URL and marketplace flag, verify real live surfaces, then perform wallet-authorized mandate deployment/payment. No contract, seller listing or transaction has been fabricated.

- Final review completed: corrected pending payout filtering, added regression for 1,001 newer paid rows, concurrent batches, idempotent reconciliation and transfer reuse. Transfers predating their batch are rejected.
- Full backend/SDK suite: 167 passed, 2 skipped. Final focused checks after review: 33 passed. Latest production build passed. Desktop/390px/320px browser checks passed without JavaScript errors or overflow. Browser signing/rejection and actual mandate/creator payment still require a connected wallet and approved real API.
- Operator token was absent (404 verified on both public and Render origins). A strong token was generated into ignored `.env.local`; no wallet key or token is committed.

- Final follow-up review found no release blockers. Typed-data digest checks passed. The optional local Ganache test could not start its emulator on this Windows host; this is not mainnet proof. No Solidity contract behavior was changed.
- Render settings merged for ADMIN_TOKEN, the user-selected EVM_ADDRESS, canonical PUBLIC_DOMAIN and DOCS_URL. Marketplace flag is enabled only after this release is live.
