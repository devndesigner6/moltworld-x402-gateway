import { formatUnits } from "viem";
import { createClient, createWallets, type PayConfig } from "./pay.js";

export async function mountWifMarketplace(root: HTMLElement) {
  const field = (name: string) => root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`)!;
  const status = root.querySelector<HTMLElement>("[data-market-status]")!;
  const output = root.querySelector<HTMLElement>("[data-market-result]")!;
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const api = async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { ...init, cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
    return body;
  };
  const run = async (work: () => Promise<void>) => {
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
    buttons.forEach(button => { button.disabled = true; });
    try { await work(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  };
  const config: PayConfig = { ...JSON.parse(document.getElementById("payConfig")!.textContent!), origin: location.origin };
  const wallets = await createWallets(config);
  for (const option of wallets.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-ghost";
    button.textContent = `Connect ${option.name}`;
    button.addEventListener("click", () => run(async () => {
      field("earnings-address").value = await wallets.connect(option.id);
      status.textContent = `Connected ${wallets.address}. Review each signature and payment in your wallet.`;
    }));
    root.querySelector("[data-market-wallets]")!.append(button);
  }
  const requireWallet = () => {
    if (!wallets.address) throw new Error("Connect a wallet first.");
    return wallets.address;
  };
  let listings: Array<{ slug: string; name: string; description: string; price_usd: string; input_example: unknown }> = [];
  const selected = () => {
    const listing = listings.find(item => item.slug === field("listing").value);
    if (!listing) throw new Error("Choose an approved listing.");
    return listing;
  };
  const requestBody = () => {
    const body = JSON.parse(field("request-body").value);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request must be a JSON object.");
    return body;
  };
  const refresh = async () => {
    listings = (await api("/v1/market")).data;
    const select = field("listing") as HTMLSelectElement;
    select.replaceChildren();
    for (const listing of listings) {
      const option = document.createElement("option");
      option.value = listing.slug;
      option.textContent = `${listing.name} · ${listing.price_usd} USD quoted`;
      select.append(option);
    }
    const update = () => {
      const item = listings.find(listing => listing.slug === select.value);
      root.querySelector("[data-listing-description]")!.textContent = item?.description ?? "No approved listings yet. Creators can submit an API below for review.";
      field("request-body").value = item ? JSON.stringify(item.input_example ?? {}, null, 2) : "";
    };
    select.onchange = update;
    update();
  };
  root.querySelector("[data-market-refresh]")!.addEventListener("click", () => run(refresh));
  root.querySelector("[data-market-quote]")!.addEventListener("click", () => run(async () => {
    const listing = selected();
    const response = await fetch(`/v1/market/${listing.slug}/call`, post(requestBody()));
    const encoded = response.headers.get("payment-required");
    if (response.status !== 402 || !encoded) throw new Error((await response.json())?.error?.message ?? "Payment quote unavailable.");
    const challenge = JSON.parse(atob(encoded));
    const terms = challenge.accepts[0];
    status.textContent = `${formatUnits(BigInt(terms.amount), 18)} WIF. Your wallet payment will use a fresh exact quote within your cap.`;
    output.textContent = JSON.stringify(challenge, null, 2);
  }));
  root.querySelector("[data-market-pay]")!.addEventListener("click", () => run(async () => {
    requireWallet();
    const cap = Number(field("max-usd").value);
    if (!Number.isFinite(cap) || cap <= 0) throw new Error("Set a positive maximum USD quote per call.");
    const client = createClient(config, {
      evmSigner: wallets.signer() as any,
      ensureEvmAllowance: payment => wallets.ensureEvmAllowance!(payment.asset, payment.amount, message => { status.textContent = message; }),
    }, cap);
    status.textContent = "Review the exact WIF payment in your wallet…";
    const result = await client.market(selected().slug, requestBody());
    output.textContent = JSON.stringify(result, null, 2);
    status.textContent = result.verification?.ok ? "API response, signed receipt and response hashes verified." : "API call returned. Inspect receipt verification before retrying.";
  }));
  root.querySelector<HTMLFormElement>("[data-listing-form]")!.addEventListener("submit", event => {
    event.preventDefault();
    run(async () => {
      const input = field("input-example").value.trim();
      const listing = {
        action: "list", creator: requireWallet(), slug: field("slug").value.trim(), name: field("name").value.trim(),
        description: field("description").value.trim(), upstream_url: field("upstream-url").value.trim(),
        price_usd: field("price-usd").value.trim(), input_example: input ? JSON.parse(input) : null,
        nonce: crypto.randomUUID(), issued_at: Math.floor(Date.now() / 1000),
      };
      const draft = await api("/v1/market/listings/draft", post({ listing }));
      const signer = wallets.signer() as { signTypedData(data: any): Promise<string> };
      status.textContent = "Review the listing signature. It authorizes the listing and makes no token transfer.";
      const signature = await signer.signTypedData(draft.typed_data);
      const created = await api("/v1/market/listings", post({ listing: draft.listing, creator_sig: signature }));
      output.textContent = JSON.stringify(created, null, 2);
      status.textContent = `Listing ${created.listing.slug} is pending review. Save signing_secret to authenticate forwarded calls. It is shown only on creation.`;
    });
  });
  root.querySelector("[data-listing-status]")!.addEventListener("click", () => run(async () => {
    const slug = field("slug").value.trim();
    if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(slug)) throw new Error("Enter your listing slug.");
    output.textContent = JSON.stringify(await api(`/v1/market/listings/${slug}`), null, 2);
  }));
  root.querySelector<HTMLFormElement>("[data-earnings-form]")!.addEventListener("submit", event => {
    event.preventDefault();
    run(async () => {
      const address = field("earnings-address").value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Enter the creator wallet address.");
      output.textContent = JSON.stringify(await api(`/v1/market/creators/${address}/earnings`), null, 2);
      status.textContent = "Creator earnings loaded. Sent payouts have verified on-chain transfers.";
    });
  });
  await refresh();
  status.textContent = wallets.options.length ? "Connect your wallet to sign a listing or buy an API call." : "Open in a supported wallet browser or install an EVM wallet to sign listings and payments.";
}
