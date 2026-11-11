import { clientFromEnv } from "../sdk/js/src/mcp.js";

if (!process.env.MOLTWORLD_WIF_MANDATE_ADDRESS) throw new Error("Set the owner-deployed MOLTWORLD_WIF_MANDATE_ADDRESS and local MCP session configuration first.");
const { client, mandateBacked } = clientFromEnv();
if (!mandateBacked) throw new Error("This check requires an owner-armed WIF mandate.");
const healthResponse = await fetch(`${client.baseUrl}/health`);
const health = await healthResponse.json() as any;
if (!healthResponse.ok || !health.ready || health.mock_providers !== false || health.network_caip2 !== "eip155:4663") throw new Error("A ready Robinhood mainnet gateway with live providers is required.");
const policyResponse = await fetch(`${client.baseUrl}/v1/mandates/${client.address}`);
const policy = await policyResponse.json() as any;
if (!policyResponse.ok) throw new Error(policy?.error?.message ?? "Could not read the live mandate.");
console.log(JSON.stringify({ gateway: client.baseUrl, mandate: policy.mandate }, null, 2));
if (process.argv.includes("--pay")) {
  if (policy.mandate.status !== "active") throw new Error("The mandate is not active.");
  const result = await client.chat("gpt", { messages: [{ role: "user", content: "Reply with one sentence confirming this AI request succeeded." }], max_tokens: 24 });
  if (!result.verification?.ok || !result.receipt?.txid) throw new Error("A verified live receipt was not returned. Inspect the result before retrying.");
  console.log(JSON.stringify({ response: result.data, receipt: result.receipt, verification: result.verification }, null, 2));
} else {
  console.log("Read-only check complete. Pass --pay to make one real WIF-paid GPT request using this mandate's session key.");
}
