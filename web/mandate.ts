import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { WIF_MANDATE_ARTIFACT } from "../sdk/js/src/wif-mandate-artifact.js";
import { isCanonicalWifMandateRuntime, ROBINHOOD_WIF_MAINNET_TOKEN } from "../sdk/js/src/evm-mandate-client.js";

const CHAIN_ID = 4663;
const WIF = ROBINHOOD_WIF_MAINNET_TOKEN;
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const EXACT_PROXY = getAddress("0x402085c248EeA27D92E8b30b2C58ed07f9E20001");
const EXPLORER = "https://robinhoodchain.blockscout.com";
const STORAGE_KEY = "moltworld.wif.mandate.address";

const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
});

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "balance", type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "success", type: "bool" }] },
] as const;

interface Health {
  ready?: boolean;
  payment_chain?: string;
  network?: string;
  network_caip2?: string;
  payment_asset?: string;
  payment_symbol?: string;
  payment_decimals?: number;
  pay_to?: string;
}

type Provider = { request(args: { method: string; params?: unknown[] }): Promise<any> };

type WalletContext = {
  account: Address;
  provider: Provider;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  health: Health;
  payTo: Address;
};

export async function waitForWifTransaction(client: Pick<WalletContext["publicClient"], "waitForTransactionReceipt">, hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted. The requested mandate change was not confirmed.`);
  return receipt;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredInput(root: HTMLElement, name: string): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
  if (!input) throw new Error(`Missing ${name} input.`);
  return input;
}

function requireRiskAcknowledgement(root: HTMLElement) {
  if (!requiredInput(root, "risk-ack").checked) {
    throw new Error("Tick the risk acknowledgement after reviewing the experimental-contract warning before continuing.");
  }
}

function setStatus(root: HTMLElement, text: string, error = false) {
  const status = root.querySelector<HTMLElement>("[data-mandate-status]");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("bad", error);
  status.classList.toggle("good", !error);
}

async function readHealth(): Promise<Health> {
  const response = await fetch("/health", { cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Gateway health check returned HTTP ${response.status}.`);
  const health = await response.json() as Health;
  if (!health.ready || health.payment_chain !== "robinhood" || health.network !== "mainnet" || health.network_caip2 !== "eip155:4663") {
    throw new Error("The live gateway is not ready on Robinhood Chain mainnet; refusing mandate setup.");
  }
  if (String(health.payment_asset).toLowerCase() !== WIF.toLowerCase() || health.payment_symbol !== "WIF" || health.payment_decimals !== 18) {
    throw new Error("The gateway health response does not match the configured WIF token and decimals.");
  }
  if (!health.pay_to) throw new Error("The gateway has no configured WIF payment recipient.");
  return health;
}

async function switchToRobinhood(provider: Provider) {
  const target = `0x${CHAIN_ID.toString(16)}`;
  const current = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
  if (current === target.toLowerCase()) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target }] });
  } catch (error: any) {
    if (error?.code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: target,
        chainName: "Robinhood Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
        blockExplorerUrls: [EXPLORER],
      }],
    });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target }] });
  }
}

async function walletContext(): Promise<WalletContext> {
  const provider = (window as unknown as { ethereum?: Provider }).ethereum;
  if (!provider) throw new Error("No injected wallet found. Open this page in a browser with MetaMask or Robinhood Wallet enabled.");
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
  if (!accounts?.[0]) throw new Error("The wallet did not return an account.");
  await switchToRobinhood(provider);
  const health = await readHealth();
  const account = getAddress(accounts[0]);
  const publicClient = createPublicClient({ chain, transport: custom(provider as any) });
  const walletClient = createWalletClient({ account, chain, transport: custom(provider as any) });
  return { account, provider, publicClient, walletClient, health, payTo: getAddress(health.pay_to!) };
}

async function verifyCurrentGateway(ctx: WalletContext) {
  const currentChainId = String(await ctx.provider.request({ method: "eth_chainId" })).toLowerCase();
  if (currentChainId !== `0x${CHAIN_ID.toString(16)}`) {
    throw new Error("Wallet network changed. Reconnect and switch back to Robinhood Chain mainnet before proceeding.");
  }
  const accounts = await ctx.provider.request({ method: "eth_accounts" }) as string[];
  if (!accounts?.[0] || getAddress(accounts[0]) !== ctx.account) {
    throw new Error("Wallet account changed. Reconnect the intended mandate owner before proceeding.");
  }
  const health = await readHealth();
  const livePayTo = getAddress(health.pay_to!);
  if (livePayTo !== ctx.payTo) {
    throw new Error("Gateway pay-to changed since wallet connection. Reconnect and verify the new recipient before proceeding.");
  }
  ctx.health = health;
}

async function ensureMandate(ctx: WalletContext, addressText: string) {
  await verifyCurrentGateway(ctx);
  if (!addressText.trim()) throw new Error("Paste a deployed mandate contract address first.");
  const address = getAddress(addressText.trim());
  const code = await ctx.publicClient.getCode({ address });
  if (!isCanonicalWifMandateRuntime(code as Hex | undefined)) {
    throw new Error("This address does not contain the pinned Moltworld WIF mandate bytecode. No signature or transaction was sent.");
  }
  const [owner, token, permit2, exactProxy, payTo] = await Promise.all([
    ctx.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "owner" }),
    ctx.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "token" }),
    ctx.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "permit2" }),
    ctx.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "exactProxy" }),
    ctx.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "payTo" }),
  ]);
  if (getAddress(String(owner)) !== ctx.account) throw new Error("Connected wallet is not the mandate owner; only its owner can manage this contract.");
  if (getAddress(String(token)) !== WIF || getAddress(String(permit2)) !== PERMIT2 || getAddress(String(exactProxy)) !== EXACT_PROXY) {
    throw new Error("Mandate immutable token or Permit2 configuration does not match Robinhood WIF mainnet.");
  }
  if (getAddress(String(payTo)) !== ctx.payTo) throw new Error("Mandate pay-to does not match the live gateway health response.");
  return address;
}

export function mountWifMandateSetup(root: HTMLElement) {
  let connected: WalletContext | null = null;
  const actionButtons = () => Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-action]"));
  const setBusy = (busy: boolean) => actionButtons().forEach((button) => { button.disabled = busy; });
  const run = async (label: string, operation: () => Promise<void>) => {
    setBusy(true);
    try {
      setStatus(root, label);
      await operation();
    } catch (error) {
      setStatus(root, messageOf(error), true);
    } finally {
      setBusy(false);
    }
  };

  const mandateInput = requiredInput(root, "mandate-address");
  const storedAddress = localStorage.getItem(STORAGE_KEY);
  if (storedAddress && !mandateInput.value) mandateInput.value = storedAddress;

  const connectButton = root.querySelector<HTMLButtonElement>('[data-action="connect"]');
  connectButton?.addEventListener("click", () => run("Connect your owner wallet…", async () => {
    connected = await walletContext();
    const owner = root.querySelector<HTMLElement>("[data-owner-address]");
    if (owner) owner.textContent = connected.account;
    setStatus(root, `Connected ${connected.account}. Robinhood Chain mainnet and live WIF/pay-to settings verified.`);
    if (mandateInput.value) await refresh();
  }));

  async function refresh() {
    if (!connected) throw new Error("Connect the owner wallet first.");
    const address = await ensureMandate(connected, mandateInput.value);
    const [active, agent, maxPerCall, expiry, allowance, tokenBalance, epoch] = await Promise.all([
      connected.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "active" }),
      connected.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "sessionAgent" }),
      connected.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "maxPerCall" }),
      connected.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "expiry" }),
      connected.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "remainingAllowance" }),
      connected.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "tokenBalance" }),
      connected.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "sessionEpoch" }),
    ]);
    localStorage.setItem(STORAGE_KEY, address);
    const details = root.querySelector<HTMLElement>("[data-mandate-details]");
    if (details) {
      details.textContent = `Owner ${connected.account} · agent ${String(agent)} · ${active ? "ACTIVE" : "INACTIVE"} · per call ${formatUnits(BigInt(String(maxPerCall)), 18)} WIF · remaining cap ${formatUnits(BigInt(String(allowance)), 18)} WIF · vault balance ${formatUnits(BigInt(String(tokenBalance)), 18)} WIF · expires ${new Date(Number(expiry) * 1000).toLocaleString()} · policy epoch ${String(epoch)}`;
    }
    setStatus(root, `Pinned WIF mandate verified at ${address}. State is ${active ? "active" : "inactive"}.`);
  }

  root.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.addEventListener("click", () => run("Reading the live contract…", refresh));

  root.querySelector<HTMLButtonElement>('[data-action="deploy"]')?.addEventListener("click", () => run("Review the deployment details…", async () => {
    requireRiskAcknowledgement(root);
    const ctx = connected ?? await walletContext();
    connected = ctx;
    await verifyCurrentGateway(ctx);
    const payTo = ctx.payTo;
    const summary = `Deploy the pinned WIF mandate contract on Robinhood Chain?\n\nOwner: ${ctx.account}\nToken: WIF ${WIF}\nPermit2: ${PERMIT2}\nExact payment proxy: ${EXACT_PROXY}\nFixed pay-to: ${payTo}\n\nThis deployment creates an inactive, empty vault. It moves no WIF and sets no agent, spending cap, allowance, or expiry; those are configured by a separate arm transaction. It costs gas. The code is not independently audited; only proceed if you accept that risk.`;
    if (!window.confirm(summary)) return;
    const hash = await ctx.walletClient.deployContract({
      abi: WIF_MANDATE_ARTIFACT.abi as any,
      bytecode: WIF_MANDATE_ARTIFACT.bytecode as Hex,
      args: [ctx.account, WIF, PERMIT2, EXACT_PROXY, payTo],
    } as any);
    setStatus(root, `Deployment submitted: ${hash}. Waiting for finality…`);
    const receipt = await waitForWifTransaction(ctx.publicClient, hash);
    if (!receipt.contractAddress) throw new Error(`Deployment receipt ${hash} has no contract address.`);
    const address = getAddress(receipt.contractAddress);
    mandateInput.value = address;
    localStorage.setItem(STORAGE_KEY, address);
    await ensureMandate(ctx, address);
    const link = root.querySelector<HTMLAnchorElement>("[data-deploy-tx]");
    if (link) { link.href = `${EXPLORER}/tx/${hash}`; link.textContent = `Deployment ${hash.slice(0, 10)}…`; link.hidden = false; }
    setStatus(root, `Contract deployed and pinned bytecode verified at ${address}. No WIF was moved; fund and arm are separate steps.`);
  }));

  root.querySelector<HTMLButtonElement>('[data-action="fund"]')?.addEventListener("click", () => run("Verify the funding amount…", async () => {
    requireRiskAcknowledgement(root);
    const ctx = connected ?? await walletContext();
    connected = ctx;
    const address = await ensureMandate(ctx, mandateInput.value);
    const active = await ctx.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "active" });
    if (active) throw new Error("Revoke the active mandate before adding more WIF to its vault.");
    const amountText = requiredInput(root, "fund-amount").value.trim();
    const amount = parseUnits(amountText, 18);
    if (amount <= 0n) throw new Error("Enter a positive WIF amount to transfer into the mandate.");
    const balance = await ctx.publicClient.readContract({ address: WIF, abi: erc20Abi, functionName: "balanceOf", args: [ctx.account] });
    if (amount > BigInt(String(balance))) throw new Error("Wallet WIF balance is below the transfer amount.");
    if (!window.confirm(`Transfer ${formatUnits(amount, 18)} WIF from ${ctx.account} to mandate ${address}?\n\nToken contract: ${WIF}\nThis is a real WIF transfer. The owner can withdraw it only after revoking the mandate.`)) return;
    const hash = await ctx.walletClient.writeContract({ address: WIF, abi: erc20Abi, functionName: "transfer", args: [address, amount] } as any);
    await waitForWifTransaction(ctx.publicClient, hash);
    setStatus(root, `WIF funding confirmed: ${hash}. Refresh mandate state before arming.`);
  }));

  root.querySelector<HTMLButtonElement>('[data-action="arm"]')?.addEventListener("click", () => run("Review the finite mandate limits…", async () => {
    requireRiskAcknowledgement(root);
    const ctx = connected ?? await walletContext();
    connected = ctx;
    const address = await ensureMandate(ctx, mandateInput.value);
    const agent = getAddress(requiredInput(root, "agent-address").value.trim());
    const perCall = parseUnits(requiredInput(root, "per-call").value.trim(), 18);
    const totalCap = parseUnits(requiredInput(root, "total-cap").value.trim(), 18);
    const days = Number(requiredInput(root, "duration-days").value);
    if (perCall <= 0n || totalCap < perCall) throw new Error("Set a positive per-call WIF cap no greater than the total cap.");
    if (!Number.isInteger(days) || days < 1 || days > 7) throw new Error("Experimental beta mandate expiry is limited to 1 to 7 days.");
    const balance = BigInt(String(await ctx.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "tokenBalance" })));
    if (totalCap > balance || totalCap === (1n << 256n) - 1n) throw new Error("Total cap must be finite and no greater than the WIF already held by the mandate.");
    const expiry = (await ctx.publicClient.getBlock()).timestamp + BigInt(days * 86_400);
    if (!window.confirm(`Arm mandate ${address} for agent ${agent}?\n\nWIF: ${WIF}\nFixed pay-to: ${ctx.payTo}\nPer-call maximum: ${formatUnits(perCall, 18)} WIF\nFinite aggregate Permit2 allowance: ${formatUnits(totalCap, 18)} WIF\nExpiry: ${days} days\n\nThe contract will approve Permit2 for this finite amount. You can revoke later; old unused signatures are epoch-invalidated.`)) return;
    const hash = await ctx.walletClient.writeContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "arm", args: [agent, perCall, expiry, totalCap] } as any);
    await waitForWifTransaction(ctx.publicClient, hash);
    setStatus(root, `Mandate armed on-chain: ${hash}. Refresh to confirm the live cap and expiry.`);
    await refresh();
  }));

  root.querySelector<HTMLButtonElement>('[data-action="revoke"]')?.addEventListener("click", () => run("Revoke the mandate…", async () => {
    const ctx = connected ?? await walletContext();
    connected = ctx;
    const address = await ensureMandate(ctx, mandateInput.value);
    if (!window.confirm(`Revoke mandate ${address}?\n\nThe owner wallet will disable the session, advance its epoch, and set its Permit2 allowance to zero. Confirm only in your wallet after reviewing the transaction.`)) return;
    const hash = await ctx.walletClient.writeContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "revoke" } as any);
    await waitForWifTransaction(ctx.publicClient, hash);
    setStatus(root, `Revocation confirmed: ${hash}. Reading inactive state and zero allowance…`);
    await refresh();
  }));

  root.querySelector<HTMLButtonElement>('[data-action="withdraw"]')?.addEventListener("click", () => run("Check the inactive mandate balance…", async () => {
    const ctx = connected ?? await walletContext();
    connected = ctx;
    const address = await ensureMandate(ctx, mandateInput.value);
    const [active, amount] = await Promise.all([
      ctx.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "active" }),
      Promise.resolve(parseUnits(requiredInput(root, "withdraw-amount").value.trim(), 18)),
    ]);
    if (active) throw new Error("Revoke the mandate and wait for confirmation before withdrawing WIF.");
    if (amount <= 0n) throw new Error("Enter a positive WIF amount to withdraw.");
    const balance = BigInt(String(await ctx.publicClient.readContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "tokenBalance" })));
    if (amount > balance) throw new Error("Withdrawal amount exceeds the mandate balance.");
    if (!window.confirm(`Withdraw ${formatUnits(amount, 18)} WIF from ${address} back to owner ${ctx.account}?\n\nThis is a real token transfer. Review the call in your wallet.`)) return;
    const hash = await ctx.walletClient.writeContract({ address, abi: WIF_MANDATE_ARTIFACT.abi as any, functionName: "withdraw", args: [amount] } as any);
    await waitForWifTransaction(ctx.publicClient, hash);
    setStatus(root, `Withdrawal confirmed: ${hash}.`);
    await refresh();
  }));

  root.querySelector<HTMLButtonElement>('[data-action="copy-config"]')?.addEventListener("click", () => run("Prepare local MCP settings…", async () => {
    const ctx = connected ?? await walletContext();
    connected = ctx;
    const address = await ensureMandate(ctx, mandateInput.value);
    const text = [
      `MOLTWORLD_URL=${location.origin}`,
      `MOLTWORLD_WIF_MANDATE_ADDRESS=${address}`,
      `MOLTWORLD_WIF_MANDATE_OWNER=${ctx.account}`,
      `MOLTWORLD_PAYMENT_TO=${ctx.payTo}`,
      "MOLTWORLD_WIF_SESSION_KEY_FILE=~/.moltworld/wif-agent.key",
      "MOLTWORLD_MAX_PER_REQUEST_USD=0.25",
      "MOLTWORLD_BUDGET_USD=5",
    ].join("\n");
    await navigator.clipboard.writeText(text);
    setStatus(root, "Local MCP environment copied. It contains public addresses only, never the session private key.");
  }));

  if (connectButton) connectButton.disabled = false;
  setStatus(root, "Ready. Connect the owner wallet to verify live WIF/pay-to settings and manage a real mainnet contract.");
}
