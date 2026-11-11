# moltworld-sdk

x402 client for Moltworld's pay-per-request AI gateway. WIF payments use an EVM signer; the legacy AVM signer path remains for Algorand deployments. The live WIF model surface currently accepts chat calls only.

## WIF with an EVM wallet

Use a wallet client backed by an injected EIP-1193 provider or a WalletConnect session. Mobile WalletConnect requires the public Reown project ID to be configured on the deployment. Configure the wallet on Robinhood Chain mainnet (chain ID `4663`) and read the WIF contract and receiving address from `/health`.

```ts
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { toClientEvmSigner } from "@x402/evm";
import { MoltworldClient } from "moltworld-sdk";

const provider = window.ethereum;
const [address] = await provider.request({ method: "eth_requestAccounts" });
const chain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
};
const publicClient = createPublicClient({ chain, transport: http() });
const walletClient = createWalletClient({ account: address, chain, transport: custom(provider) });
const evmSigner = toClientEvmSigner({
  address,
  signTypedData: (data) => walletClient.signTypedData({ ...data, account: address }),
}, publicClient);

const client = new MoltworldClient({
  baseUrl: "https://motoworld-wif.vercel.app",
  evmSigner,
  maxPerRequestUsd: 0.25,
  budgetUsd: 5,
});
const result = await client.chat("gpt-4o", {
  messages: [{ role: "user", content: "Hi" }],
  max_tokens: 300,
});
console.log(result.data.choices[0].message.content);
console.log(result.receipt?.amountAtomic, result.receipt?.assetSymbol); // exact WIF base units
console.log(result.verification?.ok); // signed receipt + request/response hashes checked
```

For tokens without a usable Permit2 allowance, clients must arrange a WIF approval to the Permit2 contract before x402 payment creation. The Playground requests an exact allowance, not an unlimited one; that separate approval transaction requires a small amount of native ETH for gas. The x402 request itself is denominated in WIF. Never pass a wallet private key or seed phrase to Moltworld.

`paidMicro` in SDK results remains the USD quote value for spend-budget accounting; `receipt.amountAtomic` is the exact ERC-20 amount in base units and must not be converted through JavaScript `Number`.

## Live WIF agent mandate

The SDK exports `createWifEvmMandateSigner` and `createWifMandateClientSigner` for the EIP-1271 policy wallet. The local session key signs exact Permit2 payments within the chain, asset, proxy, recipient, amount, epoch and expiry constraints. The website owner wizard deploys, funds and arms the contract. A real local MCP task settled 0.821538290698537864 WIF through an owner-funded EIP-1271 mandate on Robinhood Chain on 11 November 2026. Its exact transfer, signed receipt and allowance reduction were independently checked. [Transaction](https://robinhoodchain.blockscout.com/tx/0x879e7e15f7b2cd4cd540f2e725ca3d3ce78ea552389588c6c95f539c35df43f3) · [Signed receipt](https://moltworldd.vercel.app/v1/receipts/req_uPG_4T8Lt9AlG3qS). The contract has not had an independent security audit.

## Legacy Algorand signer

Algorand-specific helpers (`mnemonic`, `privateKeyBase64`, AVM signers, and spending mandates) remain for legacy deployments only. The Robinhood WIF gateway disables legacy Algorand mandate POST endpoints and does not accept AVM payment payloads. No Algorand LogicSig or application ID can be reused on Robinhood Chain.

Python EOA payment mode remains local-development-only. The owner-funded EIP-1271 mandate uses the TypeScript SDK/local MCP path. The WIF marketplace is enabled for approved APIs, with exact credits and merchant-authorized verified payouts.
