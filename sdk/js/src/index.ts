import algosdk from "algosdk";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import { checkReceipt, decodeReceiptHeader, MoltworldReceipt, ReceiptCheck } from "./receipts.js";
import { createMandateSigner, MandateCredential, mandateTermsFromProgram } from "./mandates.js";
import { CappedMandateScheme } from "./mandateScheme.js";
import { fromBase64, toBase64 } from "./encoding.js";

export * from "./receipts.js";
export * from "./mandates.js";
export * from "./encoding.js";
export * from "./counter.js";
export * from "./evm-mandate.js";
export * from "./evm-mandate-client.js";
export { CappedMandateScheme } from "./mandateScheme.js";

const NETWORKS = {
  mainnet: ["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"],
  testnet: ["algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=", "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe"],
};

// Atomic cap allows at most 10,000 WIF per configured USD of per-request budget.
// The quote-validation hook below separately enforces the exact live USD amount.
const WIF_SPEND_CONTROL_ATOMIC_PER_USD_MICRO = 10n ** 16n;

export interface AvmSigner {
  address: string;
  signTransactions(txns: Uint8Array[], indexesToSign?: number[]): Promise<(Uint8Array | null)[]>;
}

export interface MoltworldClientOptions {
  baseUrl?: string;
  /** One of: an x402 AVM signer, a 25-word mnemonic, a base64 64-byte secret key, or a mandate credential. */
  signer?: AvmSigner;
  /** EIP-1193/viem-compatible signer for Robinhood Chain WIF payments. */
  evmSigner?: ClientEvmSigner;
  mnemonic?: string;
  privateKeyBase64?: string;
  mandate?: MandateCredential;
  /** The agent's own key (base64 secret), required with a mandate that is bound to it. */
  agentKey?: string;
  /** Hard per-request cap enforced before anything is signed. Default $1. */
  maxPerRequestUsd?: number;
  /** Total spend cap for this client instance. */
  budgetUsd?: number;
  /** Refuse to pay any address other than this (defaults to the gateway's published payTo). */
  expectedPayTo?: string;
  algodUrl?: string;
  /** Called before Permit2 payment creation; browser clients can request an exact, bounded WIF approval. */
  ensureEvmAllowance?: (payment: { asset: string; amount: string; network: string }) => Promise<void>;
  fetch?: typeof fetch;
}

export interface PaidResult<T> {
  data: T;
  requestId: string | null;
  receipt: MoltworldReceipt | null;
  /** Receipt signature and request/response hashes checked against the gateway key. */
  verification: ReceiptCheck | null;
  paidMicro: number;
  replayed: boolean;
}

export class MoltworldError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly body?: unknown) {
    super(message);
    this.name = "MoltworldError";
  }
}

export class MoltworldClient {
  readonly baseUrl: string;
  private readonly baseFetch: typeof fetch;
  private health: Promise<any> | null = null;
  private readonly signer?: AvmSigner;
  private readonly evmSigner?: ClientEvmSigner;
  private readonly options: MoltworldClientOptions;
  private spentMicro = 0;
  private keys: Map<string, string> | null = null;
  private payTo: string | null = null;

  constructor(options: MoltworldClientOptions) {
    if (options.budgetUsd !== undefined && (!Number.isFinite(options.budgetUsd) || options.budgetUsd < 0 || !Number.isSafeInteger(Math.floor(options.budgetUsd * 1_000_000)))) {
      throw new Error("budgetUsd must be a finite, non-negative amount in safe micro-USD units.");
    }
    this.options = options;
    this.baseUrl = (options.baseUrl ?? "https://motoworld-wif.vercel.app").replace(/\/$/, "");
    // Bound so it can be called as a method; browsers reject fetch with a foreign `this`.
    this.baseFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    if (options.evmSigner) this.evmSigner = options.evmSigner;
    else if (options.signer) this.signer = options.signer;
    else if (options.mandate) this.signer = createMandateSigner(options.mandate, options.agentKey);
    else if (options.mnemonic) this.signer = toClientAvmSigner(toBase64(algosdk.mnemonicToSecretKey(options.mnemonic).sk));
    else if (options.privateKeyBase64) this.signer = toClientAvmSigner(options.privateKeyBase64);
    else throw new Error("MoltworldClient needs an EVM signer, AVM signer, mnemonic, privateKeyBase64 or mandate.");
  }

  get address(): string {
    return this.evmSigner?.address ?? this.signer!.address;
  }

  get spentUsd(): number {
    return this.spentMicro / 1_000_000;
  }

  private async getJson(path: string): Promise<any> {
    const res = await this.baseFetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new MoltworldError(`GET ${path} failed`, res.status, undefined, await res.text());
    return res.json();
  }

  private async paymentFetch(reserve: (amount: number) => void, signed: () => void) {
    this.health ??= this.getJson("/health").catch((error) => { this.health = null; throw error; });
    const health = await this.health;
    this.payTo = this.options.expectedPayTo ?? health.pay_to;
    if (this.evmSigner) {
      const network = String(health.network_caip2 ?? "");
      const expectedAsset = String(health.payment_asset ?? "");
      if (!network.startsWith("eip155:") || !/^0x[0-9a-fA-F]{40}$/.test(expectedAsset)) {
        throw new Error("Gateway health does not advertise a valid Robinhood EVM WIF payment asset.");
      }
      const maxPerRequestUsd = this.options.maxPerRequestUsd ?? 1;
      const maxPerRequestMicro = Math.floor(maxPerRequestUsd * 1_000_000);
      if (!Number.isSafeInteger(maxPerRequestMicro) || maxPerRequestMicro <= 0) {
        throw new Error("maxPerRequestUsd must be a positive, finite amount.");
      }
      const maxWifAmountAtomic = (BigInt(maxPerRequestMicro) * WIF_SPEND_CONTROL_ATOMIC_PER_USD_MICRO).toString();
      const client = x402Client.fromConfig({
        schemes: [{ network: network as any, client: new ExactEvmClientScheme(this.evmSigner) as any }],
        spendControls: {
          maxAmountPerPayment: `$${maxPerRequestUsd}`,
          allowedAssets: [{ network: network as any, asset: expectedAsset, maxAmountPerPayment: maxWifAmountAtomic }],
        },
      });
      client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
        const extra = selectedRequirements.extra as Record<string, unknown> | undefined;
        const quotedUsdMicro = Number(extra?.quotedUsdMicro);
        if (!Number.isSafeInteger(quotedUsdMicro) || quotedUsdMicro <= 0) {
          return { abort: true, reason: "Gateway did not provide a valid USD quote bound to this WIF payment." };
        }
        if (extra?.symbol !== "WIF" || extra?.assetTransferMethod !== "permit2" || Number(extra?.decimals) !== 18) {
          return { abort: true, reason: "Gateway payment terms are not a supported 18-decimal WIF Permit2 payment." };
        }
        try {
          const amount = BigInt(String(selectedRequirements.amount));
          const price = BigInt(String(extra?.wifPriceUsdScaled18 ?? ""));
          const numerator = BigInt(quotedUsdMicro) * (10n ** 30n);
          const expectedAmount = (numerator + price - 1n) / price;
          if (amount <= 0n || price <= 0n || amount !== expectedAmount) {
            return { abort: true, reason: "WIF base-unit amount does not match the quote-bound price snapshot." };
          }
        } catch {
          return { abort: true, reason: "WIF payment amount or price snapshot is invalid." };
        }
        if (String(selectedRequirements.network) !== network) {
          return { abort: true, reason: `Refusing network ${selectedRequirements.network}; expected ${network}.` };
        }
        if (String(selectedRequirements.asset).toLowerCase() !== expectedAsset.toLowerCase()) {
          return { abort: true, reason: "Refusing to pay a token other than the gateway's published WIF contract." };
        }
        if (String(selectedRequirements.payTo).toLowerCase() !== String(this.payTo).toLowerCase()) {
          return { abort: true, reason: `Refusing to pay ${selectedRequirements.payTo}; expected ${this.payTo}.` };
        }
        if (quotedUsdMicro > maxPerRequestMicro) {
          return { abort: true, reason: `Costs more than your max per request ($${maxPerRequestUsd}).` };
        }
        reserve(quotedUsdMicro);
        if (extra?.assetTransferMethod === "permit2") {
          await this.options.ensureEvmAllowance?.({
            asset: String(selectedRequirements.asset),
            amount: String(selectedRequirements.amount),
            network,
          });
        }
      });
      client.onAfterPaymentCreation(async () => { signed(); });
      return wrapFetchWithPayment(this.baseFetch, client);
    }
    if (!this.signer) throw new Error("An AVM signer is required for Algorand payments.");
    const networks = String(health.network) === "mainnet" ? NETWORKS.mainnet : NETWORKS.testnet;
    // A mandate capped on-chain pays in a group that also calls the spend counter.
    const capped = this.options.mandate ? mandateTermsFromProgram(fromBase64(this.options.mandate.programB64))?.counter : undefined;
    const client = x402Client.fromConfig({
      schemes: networks.map((network) => ({
        network: network as any,
        client: capped
          ? (new CappedMandateScheme(this.options.mandate!, this.options.agentKey, this.options.algodUrl) as any)
          : new ExactAvmScheme(this.signer as any, this.options.algodUrl ? { algodUrl: this.options.algodUrl } : undefined),
      })),
      spendControls: { maxAmountPerPayment: `$${this.options.maxPerRequestUsd ?? 1}` },
    });
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const amount = Number(selectedRequirements.amount);
      if (selectedRequirements.payTo !== this.payTo) {
        return { abort: true, reason: `Refusing to pay ${selectedRequirements.payTo}; expected ${this.payTo}.` };
      }
      reserve(amount);
    });
    client.onAfterPaymentCreation(async () => { signed(); });
    return wrapFetchWithPayment(this.baseFetch, client);
  }

  /** Public keys that sign receipts, cached per client. */
  async receiptKeys(): Promise<Map<string, string>> {
    if (!this.keys) {
      const doc = await this.getJson("/.well-known/moltworld-receipts.json");
      this.keys = new Map(doc.keys.map((k: any) => [k.kid, k.publicKey]));
    }
    return this.keys;
  }

  async models(modality?: "chat" | "image" | "voice" | "video") {
    return (await this.getJson(`/v1/models${modality ? `?modality=${modality}` : ""}`)).data;
  }

  async marketplace() {
    return this.getJson("/v1/market");
  }

  /** Exact price of a request body, without paying. */
  async quote(model: string, body: Record<string, unknown>) {
    const res = await this.baseFetch(`${this.baseUrl}/v1/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, model }),
    });
    const json: any = await res.json();
    if (!res.ok) throw new MoltworldError(json?.error?.message ?? "Quote failed", res.status, json?.error?.code, json);
    return json.quote as { microUsdc: number; formattedPrice: string; units: Record<string, number> };
  }

  async call<T = any>(path: string, body: Record<string, unknown>): Promise<PaidResult<T>> {
    let reserved = 0;
    let signed = false;
    const release = () => { this.spentMicro -= reserved; reserved = 0; };
    const paidFetch = await this.paymentFetch((amount) => {
      if (reserved) throw new Error("A payment was already reserved for this request.");
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid payment budget amount.");
      if (this.options.budgetUsd !== undefined && this.spentMicro + amount > this.options.budgetUsd * 1_000_000) {
        throw new Error(`Budget of $${this.options.budgetUsd} would be exceeded.`);
      }
      // Reserve before wallet approval yields, so simultaneous calls share the cap.
      this.spentMicro += amount;
      reserved = amount;
    }, () => { signed = true; });
    const requestBytes = JSON.stringify(body);
    let res: Response;
    try {
      res = await paidFetch(`${this.baseUrl}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: requestBytes,
      });
    } catch (error) {
      if (!signed) release();
      throw error;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) {
      if (res.headers.get("Moltworld-Payment-Status") === "uncharged" || !signed) release();
      throw new MoltworldError(data?.error?.message ?? `HTTP ${res.status}`, res.status, data?.error?.code, data);
    }
    const header = res.headers.get("moltworld-receipt");
    const receipt = header ? decodeReceiptHeader(header) : null;
    let verification: ReceiptCheck | null = null;
    if (receipt) {
      const key = (await this.receiptKeys()).get(receipt.kid);
      verification = key
        ? checkReceipt(receipt, key, { request: requestBytes, response: bytes })
        : { signatureValid: false, requestMatches: null, responseMatches: null, ok: false };
    }
    return {
      data,
      requestId: res.headers.get("moltworld-request-id"),
      receipt,
      verification,
      paidMicro: receipt?.quotedUsdMicro ?? receipt?.amountMicro ?? 0,
      replayed: res.headers.get("moltworld-replay") === "true",
    };
  }

  chat(model: string, body: { messages: Array<{ role: "system" | "user" | "assistant"; content: string }>; max_tokens?: number; temperature?: number }) {
    return this.call(`/v1/models/${model}/chat/completions`, body);
  }

  image(model: string, body: { prompt: string; n?: number; size?: string }) {
    return this.call(`/v1/models/${model}/images/generations`, body);
  }

  speech(model: string, body: { input: string; voice?: string; response_format?: string; speed?: number }) {
    return this.call(`/v1/models/${model}/audio/speech`, body);
  }

  video(model: string, body: { prompt: string; duration?: number; aspect_ratio?: string }) {
    return this.call(`/v1/models/${model}/videos/generations`, body);
  }

  market(slug: string, body: Record<string, unknown>) {
    if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(slug)) throw new Error("Marketplace slug must be 3-48 lowercase letters, numbers, or hyphens.");
    return this.call(`/v1/market/${encodeURIComponent(slug)}/call`, body);
  }

  async job(jobId: string) {
    return this.getJson(`/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  /** Polls a video job until it completes or fails (failed jobs are refunded by the gateway). */
  async waitForJob(jobId: string, { timeoutMs = 15 * 60_000, intervalMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.job(jobId);
      if (job.status === "completed" || job.status === "failed") return job;
      if (Date.now() > deadline) throw new Error(`Job ${jobId} still ${job.status} after ${timeoutMs}ms.`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async receipt(requestId: string) {
    return this.getJson(`/v1/receipts/${encodeURIComponent(requestId)}`);
  }
}
