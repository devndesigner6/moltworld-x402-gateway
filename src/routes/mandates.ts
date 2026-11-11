import type { Context } from "hono";
import algosdk from "algosdk";
import { config } from "../config.js";
import { defaultModelRegistry } from "../models/registry.js";
import { getMandate, listMandates, mandateSpendLast24h, MandateRecord, revokeMandate, upsertMandate } from "../ledger/index.js";
import {
  assembleMandate,
  ROUNDS_PER_DAY,
  mandateId,
  mandateTeal,
  newMandateSalt,
  parseMandateProgram,
  verifyDelegation,
  verifyOwnerMessage,
} from "../mandates/index.js";
import { currentRound } from "../chain/algod.js";
import { microToUsdString, usdToMicroCeil } from "../pricing/index.js";
import { apiError } from "../payments/gateway.js";
import { readWifMandate } from "../payments/wif-mandate.js";

const MESSAGE_MAX_AGE_S = 600;

function freshness(issuedAt: unknown): string | null {
  if (typeof issuedAt !== "number") return "issued_at (unix seconds) is required.";
  if (Math.abs(Date.now() / 1000 - issuedAt) > MESSAGE_MAX_AGE_S) return "issued_at is more than 10 minutes from server time.";
  return null;
}

function view(m: MandateRecord, spent?: number) {
  const terms = parseMandateProgram(new Uint8Array(Buffer.from(m.program_b64, "base64")));
  return {
    id: m.id,
    owner: m.owner,
    agent: terms?.agent ?? null,
    // Whether the daily cap is enforced by Algorand (the spend counter), not only by this gateway.
    on_chain_cap: terms?.counter ? { app_id: terms.counter.appId, cap: microToUsdString(terms.counter.capMicro), window_rounds: terms.counter.windowRounds } : null,
    label: m.label,
    status: m.status,
    max_per_call: microToUsdString(m.max_per_call_micro),
    daily_cap: microToUsdString(m.daily_cap_micro),
    spent_24h: spent === undefined ? undefined : microToUsdString(spent),
    remaining_24h: spent === undefined ? undefined : microToUsdString(Math.max(0, m.daily_cap_micro - spent)),
    allowed_models: m.allowed_models,
    expiry_round: m.expiry_round,
    created_at: m.created_at,
    revoked_at: m.revoked_at,
  };
}

/**
 * Step 1: build the mandate program for an owner. Nothing is stored; the owner
 * signs the program (delegation) and the registration message with their wallet.
 */
export async function handleMandateDraft(c: Context): Promise<Response> {
  const body: any = await c.req.json().catch(() => null);
  if (!body || !algosdk.isValidAddress(body.owner ?? "")) return apiError(c, 400, "validation_error", "owner must be an Algorand address.");
  if (!algosdk.isValidAddress(body.agent ?? "")) {
    return apiError(c, 400, "validation_error", "agent must be the Algorand address of the agent's own key (moltworld-mcp keygen prints it).");
  }
  if (body.agent === body.owner) return apiError(c, 400, "validation_error", "agent must be a separate key from the owner.");
  const maxPerCallUsd = Number(body.max_per_call_usd);
  const dailyCapUsd = Number(body.daily_cap_usd);
  if (!(maxPerCallUsd > 0 && maxPerCallUsd <= 100)) return apiError(c, 400, "validation_error", "max_per_call_usd must be in (0, 100].");
  if (!(dailyCapUsd >= maxPerCallUsd && dailyCapUsd <= 10_000)) {
    return apiError(c, 400, "validation_error", "daily_cap_usd must be at least max_per_call_usd and at most 10000.");
  }
  const validDays = Number(body.valid_days ?? 30);
  if (!(validDays >= 1 && validDays <= 365)) return apiError(c, 400, "validation_error", "valid_days must be between 1 and 365.");
  const round = await currentRound();
  if (round === null) return apiError(c, 503, "algod_unavailable", "Could not read the current Algorand round.");

  const terms = {
    payTo: config.payToAddress,
    assetId: Number(config.usdcAsaId),
    maxPerCallMicro: usdToMicroCeil(maxPerCallUsd),
    expiryRound: round + Math.ceil(validDays * ROUNDS_PER_DAY),
    salt: newMandateSalt(),
    agent: String(body.agent),
    ...(config.mandateCounterAppId
      ? { counter: { appId: config.mandateCounterAppId, capMicro: usdToMicroCeil(dailyCapUsd), windowRounds: ROUNDS_PER_DAY } }
      : {}),
  };
  const program = assembleMandate(terms);
  const id = mandateId(program);
  const allowedModels = Array.isArray(body.allowed_models) ? body.allowed_models.map(String) : null;
  const unknown = (allowedModels ?? []).filter((s: string) => !defaultModelRegistry.getModel(s));
  if (unknown.length) return apiError(c, 400, "validation_error", `Unknown models: ${unknown.join(", ")}.`);

  const registration = {
    action: "register",
    mandate_id: id,
    owner: body.owner,
    label: String(body.label ?? "agent").slice(0, 80),
    daily_cap_micro: usdToMicroCeil(dailyCapUsd),
    allowed_models: allowedModels,
  };
  return c.json({
    mandate_id: id,
    program_b64: Buffer.from(program).toString("base64"),
    teal: mandateTeal(terms),
    terms: {
      pay_to: terms.payTo,
      asset_id: terms.assetId,
      max_per_call_micro: terms.maxPerCallMicro,
      expiry_round: terms.expiryRound,
      current_round: round,
      agent: terms.agent,
      counter: terms.counter ? { app_id: terms.counter.appId, cap_micro: terms.counter.capMicro, window_rounds: terms.counter.windowRounds } : null,
    },
    registration,
    next_steps: [
      "Sign the program as a delegated LogicSig with the owner key (algosdk LogicSigAccount.sign) -> delegation_sig.",
      "Add issued_at (unix seconds) to `registration` and sign it with algosdk.signBytes over its canonical JSON -> owner_sig.",
      "POST /v1/mandates with program_b64, delegation_sig, registration (incl. issued_at) and owner_sig.",
      "Give the agent program_b64 + delegation_sig. With its own key it can pay Moltworld, and only Moltworld, within these limits; without that key the credential cannot pay.",
    ],
  });
}

/** Step 2: register the signed mandate so Moltworld enforces its daily cap and model allow-list. */
export async function handleMandateRegister(c: Context): Promise<Response> {
  const body: any = await c.req.json().catch(() => null);
  const reg = body?.registration;
  if (!reg || typeof body.program_b64 !== "string" || typeof body.delegation_sig !== "string" || typeof body.owner_sig !== "string") {
    return apiError(c, 400, "validation_error", "program_b64, delegation_sig, registration and owner_sig are required.");
  }
  const stale = freshness(reg.issued_at);
  if (stale) return apiError(c, 400, "validation_error", stale);
  if (reg.action !== "register" || !algosdk.isValidAddress(reg.owner ?? "")) {
    return apiError(c, 400, "validation_error", "registration.action must be 'register' with a valid owner.");
  }

  const program = new Uint8Array(Buffer.from(body.program_b64, "base64"));
  const terms = parseMandateProgram(program);
  if (!terms) return apiError(c, 400, "invalid_mandate", "Program is not a Moltworld mandate.");
  if (!terms.agent) return apiError(c, 400, "invalid_mandate", "New mandates must be bound to an agent key. Draft one with an agent address.");
  if (terms.payTo !== config.payToAddress || String(terms.assetId) !== config.usdcAsaId) {
    return apiError(c, 400, "invalid_mandate", "Mandate must pay this gateway's address in USDC.");
  }
  const id = mandateId(program);
  if (reg.mandate_id !== id) return apiError(c, 400, "invalid_mandate", "registration.mandate_id does not match the program.");
  if (!verifyDelegation(program, body.delegation_sig, reg.owner)) {
    return apiError(c, 401, "invalid_signature", "delegation_sig is not the owner's signature over this program.");
  }
  if (!verifyOwnerMessage(reg, body.owner_sig, reg.owner)) {
    return apiError(c, 401, "invalid_signature", "owner_sig does not sign this registration.");
  }
  const dailyCap = Number(reg.daily_cap_micro);
  if (!(Number.isInteger(dailyCap) && dailyCap >= terms.maxPerCallMicro)) {
    return apiError(c, 400, "validation_error", "daily_cap_micro must be an integer >= the per-call maximum.");
  }
  if (terms.counter) {
    if (terms.counter.appId !== config.mandateCounterAppId) return apiError(c, 400, "invalid_mandate", "Mandate uses a different spend counter than this gateway.");
    if (terms.counter.capMicro !== dailyCap) return apiError(c, 400, "invalid_mandate", "daily_cap_micro must equal the cap in the program.");
    if (terms.counter.windowRounds < ROUNDS_PER_DAY) return apiError(c, 400, "invalid_mandate", "The program's cap window is shorter than a day.");
  } else if (config.mandateCounterAppId) {
    return apiError(c, 400, "invalid_mandate", "This gateway caps mandates on-chain; draft a new one.");
  }

  try {
    const mandate = await upsertMandate({
      id,
      owner: reg.owner,
      label: String(reg.label ?? "agent").slice(0, 80),
      program_b64: body.program_b64,
      max_per_call_micro: terms.maxPerCallMicro,
      expiry_round: terms.expiryRound,
      daily_cap_micro: dailyCap,
      allowed_models: Array.isArray(reg.allowed_models) && reg.allowed_models.length ? reg.allowed_models.map(String) : null,
    });
    return c.json({ mandate: view(mandate, 0) }, 201);
  } catch (err: any) {
    return apiError(c, 409, "mandate_revoked", err.message);
  }
}

export async function handleMandateGet(c: Context): Promise<Response> {
  if (config.paymentChain === "robinhood") {
    const address = c.req.param("id") ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return apiError(c, 400, "validation_error", "Use the deployed WIF mandate contract address.");
    try { return c.json({ mandate: await readWifMandate(address) }); }
    catch (error: any) { return apiError(c, 422, "mandate_unavailable", error?.shortMessage ?? error?.message ?? "Could not verify the on-chain mandate."); }
  }
  const mandate = await getMandate(c.req.param("id") ?? "");
  if (!mandate) return apiError(c, 404, "mandate_not_found", "No such mandate.");
  return c.json({ mandate: view(mandate, await mandateSpendLast24h(mandate.id)) });
}

export async function handleMandateList(c: Context): Promise<Response> {
  if (config.paymentChain === "robinhood") return apiError(c, 400, "address_required", "Look up an owner-deployed WIF mandate at GET /v1/mandates/{contract-address}. Setup and revocation are signed in the owner's wallet at /products/mandates.");
  const owner = c.req.query("owner") ?? "";
  if (!algosdk.isValidAddress(owner)) return apiError(c, 400, "validation_error", "?owner=<address> is required.");
  const mandates = await listMandates(owner);
  return c.json({ data: await Promise.all(mandates.map(async (m) => view(m, await mandateSpendLast24h(m.id)))) });
}

/** Revocation is final. With the payee pinned to Moltworld, it stops all spending under the mandate. */
export async function handleMandateRevoke(c: Context): Promise<Response> {
  const mandate = await getMandate(c.req.param("id") ?? "");
  if (!mandate) return apiError(c, 404, "mandate_not_found", "No such mandate.");
  const body: any = await c.req.json().catch(() => null);
  const message = { action: "revoke", mandate_id: mandate.id, issued_at: body?.issued_at };
  const stale = freshness(message.issued_at);
  if (stale) return apiError(c, 400, "validation_error", stale);
  if (typeof body?.owner_sig !== "string" || !verifyOwnerMessage(message, body.owner_sig, mandate.owner)) {
    return apiError(c, 401, "invalid_signature", "owner_sig must sign {action:'revoke', mandate_id, issued_at}.");
  }
  await revokeMandate(mandate.id);
  return c.json({ mandate: view((await getMandate(mandate.id))!) });
}
