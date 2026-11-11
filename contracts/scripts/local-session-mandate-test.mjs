import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  hashTypedData,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// These keys are deliberately fixed, throwaway test keys. They must never hold real funds.
const OWNER_KEY = "0x" + "1".repeat(63) + "1";
const AGENT_KEY = "0x" + "2".repeat(63) + "2";
const CHAIN_ID = 31337;
const GANACHE_BALANCE = "1000000000000000000000";
const MAGIC_VALUE = "0x1626ba7e";
const FAILURE_VALUE = "0xffffffff";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(root, "src");
const testRoot = join(root, "test");

const permitTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
};

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function compileContracts(outputDir) {
  const input = {
    language: "Solidity",
    sources: {
      "src/WifPermit2SessionMandate.sol": { content: readFileSync(join(sourceRoot, "WifPermit2SessionMandate.sol"), "utf8") },
      "test/MockERC20.sol": { content: readFileSync(join(testRoot, "MockERC20.sol"), "utf8") },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      metadata: { bytecodeHash: "none" },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const result = spawnSync(
    "npx",
    ["--yes", "solc@0.8.30", "--standard-json"],
    { cwd: root, input: JSON.stringify(input), encoding: "utf8", shell: process.platform === "win32", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error(
      `solc compilation failed (exit ${result.status ?? "unknown"})\n${result.stdout}\n${result.stderr}`
    );
  }
  let compiled;
  try {
    const jsonStart = result.stdout.indexOf("{");
    if (jsonStart < 0) throw new Error("no JSON object found");
    compiled = JSON.parse(result.stdout.slice(jsonStart));
  } catch (error) {
    throw new Error(`solc returned non-JSON output: ${error}\n${result.stdout}\n${result.stderr}`);
  }
  const errors = (compiled.errors ?? []).filter((error) => error.severity === "error");
  if (errors.length > 0) throw new Error(`solc compilation errors:\n${JSON.stringify(errors, null, 2)}`);
  const readArtifact = (source, name) => {
    const artifact = compiled.contracts?.[source]?.[name];
    if (!artifact) throw new Error(`solc artifact not found: ${source}:${name}`);
    return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
  };
  return {
    mandate: readArtifact("src/WifPermit2SessionMandate.sol", "WifPermit2SessionMandate"),
    token: readArtifact("test/MockERC20.sol", "MockERC20"),
  };
}

async function waitForRpc(publicClient, process, logs) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Ganache exited before readiness (code ${process.exitCode})\n${logs()}`);
    }
    try {
      const chainId = await publicClient.getChainId();
      assert.equal(chainId, CHAIN_ID, "Ganache must expose the local test chain ID");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Ganache JSON-RPC did not become ready: ${lastError}\n${logs()}`);
}

async function stopProcess(process) {
  if (!process || process.exitCode !== null) return;
  if (globalThis.process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(process.pid), "/t", "/f"], { windowsHide: true });
    return;
  }
  try {
    globalThis.process.kill(-process.pid, "SIGTERM");
  } catch {
    process.kill("SIGTERM");
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (process.exitCode === null) {
        try {
          globalThis.process.kill(-process.pid, "SIGKILL");
        } catch {
          process.kill("SIGKILL");
        }
      }
      resolve();
    }, 2_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const owner = privateKeyToAccount(OWNER_KEY);
  const agent = privateKeyToAccount(AGENT_KEY);
  const port = await findFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const ganacheArgs = [
    "--yes",
    "ganache@7.9.2",
    "--server.host",
    "127.0.0.1",
    "--server.port",
    String(port),
    "--chain.chainId",
    String(CHAIN_ID),
    "--chain.hardfork",
    "shanghai",
    "--wallet.accounts",
    `${OWNER_KEY},${GANACHE_BALANCE}`,
    "--wallet.accounts",
    `${AGENT_KEY},${GANACHE_BALANCE}`,
    "--logging.quiet",
  ];
  let ganache;
  let stdout = "";
  let stderr = "";
  const logs = () => `${stdout.slice(-4000)}${stderr.slice(-4000)}`;
  const compileDir = mkdtempSync(join(tmpdir(), "wif-session-solc-"));

  try {
    const ganacheCli = process.env.GANACHE_CLI;
    ganache = spawn(ganacheCli ? process.execPath : "npx", ganacheCli ? [ganacheCli, ...ganacheArgs.slice(2)] : ganacheArgs, {
      cwd: root,
      shell: !ganacheCli && process.platform === "win32",
      windowsHide: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ganache.stdout.on("data", (chunk) => (stdout += chunk));
    ganache.stderr.on("data", (chunk) => (stderr += chunk));

    const chain = defineChain({
      id: CHAIN_ID,
      name: "Local Ganache Simulated EVM",
      nativeCurrency: { name: "Test Ether", symbol: "TETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const transport = http(rpcUrl);
    const publicClient = createPublicClient({ chain, transport });
    const ownerWallet = createWalletClient({ account: owner, chain, transport });
    const agentWallet = createWalletClient({ account: agent, chain, transport });

    await waitForRpc(publicClient, ganache, logs);
    const { mandate, token } = compileContracts(compileDir);

    const tokenHash = await ownerWallet.deployContract({ abi: token.abi, bytecode: token.bytecode });
    const tokenReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenHash });
    assert.ok(tokenReceipt.contractAddress, "MockERC20 deployment must return an address");
    const tokenAddress = tokenReceipt.contractAddress;

    // This EOA stands in for the Permit2 address on the simulated chain. No real Permit2
    // contract, facilitator, network, or payment is involved in this test.
    const permit2Address = owner.address;
    const exactProxy = "0x0000000000000000000000000000000000001003";
    const payTo = "0x0000000000000000000000000000000000001004";
    const wrongProxy = "0x0000000000000000000000000000000000001005";

    const mandateHash = await ownerWallet.deployContract({
      abi: mandate.abi,
      bytecode: mandate.bytecode,
      args: [owner.address, tokenAddress, permit2Address, exactProxy, payTo],
    });
    const mandateReceipt = await publicClient.waitForTransactionReceipt({ hash: mandateHash });
    assert.ok(mandateReceipt.contractAddress, "mandate deployment must return an address");
    const mandateAddress = mandateReceipt.contractAddress;

    const tokenSupply = 1_000n;
    const mintHash = await ownerWallet.writeContract({
      address: tokenAddress,
      abi: token.abi,
      functionName: "mint",
      args: [mandateAddress, tokenSupply],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    assert.equal(
      await publicClient.readContract({ address: tokenAddress, abi: token.abi, functionName: "balanceOf", args: [mandateAddress] }),
      tokenSupply,
      "test tokens must be funded to the mandate"
    );

    const blockBeforeArm = await publicClient.getBlock();
    const expiry = blockBeforeArm.timestamp + 3_600n;
    const maxPerCall = 250n;
    const configuredAllowance = 1_000n;
    await assert.rejects(ownerWallet.writeContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "arm",
      args: [agent.address, maxPerCall, expiry, tokenSupply + 1n],
    }), "owner cannot arm an allowance above the mandate's WIF balance");
    const armHash = await ownerWallet.writeContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "arm",
      args: [agent.address, maxPerCall, expiry, configuredAllowance],
    });
    await publicClient.waitForTransactionReceipt({ hash: armHash });
    assert.equal(await publicClient.readContract({ address: mandateAddress, abi: mandate.abi, functionName: "active" }), true);
    const sessionEpoch = await publicClient.readContract({ address: mandateAddress, abi: mandate.abi, functionName: "sessionEpoch" });
    assert.equal(sessionEpoch, 1n, "first arm must establish epoch one");
    assert.equal(
      await publicClient.readContract({ address: mandateAddress, abi: mandate.abi, functionName: "remainingAllowance" }),
      configuredAllowance,
      "owner arm must install the finite Permit2 allowance"
    );

    let agentRevokeRejected = false;
    try {
      const unauthorizedHash = await agentWallet.writeContract({
        address: mandateAddress,
        abi: mandate.abi,
        functionName: "revoke",
      });
      await publicClient.waitForTransactionReceipt({ hash: unauthorizedHash });
    } catch {
      agentRevokeRejected = true;
    }
    assert.equal(agentRevokeRejected, true, "non-owner revoke must be rejected");

    const blockBeforeSigning = await publicClient.getBlock();
    const amount = 250n;
    const nonce = 7n;
    const deadline = blockBeforeSigning.timestamp + 1_800n;
    const validAfter = blockBeforeSigning.timestamp > 30n ? blockBeforeSigning.timestamp - 30n : 0n;
    const domain = { name: "Permit2", chainId: CHAIN_ID, verifyingContract: permit2Address };
    const message = {
      permitted: { token: tokenAddress, amount },
      spender: exactProxy,
      nonce,
      deadline,
      witness: { to: payTo, validAfter },
    };
    const digest = hashTypedData({ domain, types: permitTypes, primaryType: "PermitWitnessTransferFrom", message });
    const sessionAuthTypes = {
      SessionAuthorization: [
        { name: "permit2Digest", type: "bytes32" },
        { name: "sessionEpoch", type: "uint256" },
      ],
    };
    const sessionAuthDomain = { name: "MoltworldWifSessionMandate", chainId: CHAIN_ID, verifyingContract: mandateAddress };
    const sessionSignature = await agent.signTypedData({
      domain: sessionAuthDomain,
      types: sessionAuthTypes,
      primaryType: "SessionAuthorization",
      message: { permit2Digest: digest, sessionEpoch },
    });

    const wrapper = (wrappedAmount, wrappedSpender, wrappedEpoch = sessionEpoch, signature = sessionSignature) =>
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "uint256" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes" },
        ],
        [tokenAddress, wrappedAmount, wrappedSpender, nonce, deadline, payTo, validAfter, wrappedEpoch, signature]
      );

    const validResult = await publicClient.readContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "isValidSignature",
      args: [digest, wrapper(amount, exactProxy)],
    });
    assert.equal(validResult.toLowerCase(), MAGIC_VALUE, "exact Permit2 witness signature must validate");

    const wrongAmountResult = await publicClient.readContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "isValidSignature",
      args: [digest, wrapper(amount + 1n, exactProxy)],
    });
    assert.equal(wrongAmountResult.toLowerCase(), FAILURE_VALUE, "wrong amount must be rejected");

    const wrongPolicyResult = await publicClient.readContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "isValidSignature",
      args: [digest, wrapper(amount, wrongProxy)],
    });
    assert.equal(wrongPolicyResult.toLowerCase(), FAILURE_VALUE, "wrong spender policy must be rejected");
    const wrongEpochResult = await publicClient.readContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "isValidSignature",
      args: [digest, wrapper(amount, exactProxy, sessionEpoch + 1n)],
    });
    assert.equal(wrongEpochResult.toLowerCase(), FAILURE_VALUE, "a signature cannot be relabeled with another epoch");

    // Fresh valid signatures prove the contract rejects policy violations, not just a changed digest.
    for (const [label, patch] of [
      ["over per-call cap", { permitted: { token: tokenAddress, amount: maxPerCall + 1n } }],
      ["wrong token", { permitted: { token: agent.address, amount } }],
      ["wrong recipient", { witness: { to: agent.address, validAfter } }],
      ["wrong proxy", { spender: wrongProxy }],
      ["future authorization", { witness: { to: payTo, validAfter: deadline - 1n } }],
      ["expired authorization", { deadline: blockBeforeSigning.timestamp - 1n }],
    ]) {
      const candidate = { ...message, ...patch };
      const candidateDigest = hashTypedData({ domain, types: permitTypes, primaryType: "PermitWitnessTransferFrom", message: candidate });
      const signature = await agent.signTypedData({ domain: sessionAuthDomain, types: sessionAuthTypes, primaryType: "SessionAuthorization", message: { permit2Digest: candidateDigest, sessionEpoch } });
      const encoded = encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
        [candidate.permitted.token, candidate.permitted.amount, candidate.spender, candidate.nonce, candidate.deadline, candidate.witness.to, candidate.witness.validAfter, sessionEpoch, signature]
      );
      const result = await publicClient.readContract({ address: mandateAddress, abi: mandate.abi, functionName: "isValidSignature", args: [candidateDigest, encoded] });
      assert.equal(result.toLowerCase(), FAILURE_VALUE, `${label} must fail even with the session key's valid signature`);
    }

    const deadlineBeyondExpiry = expiry + 1n;
    const messageBeyondExpiry = { ...message, deadline: deadlineBeyondExpiry };
    const digestBeyondExpiry = hashTypedData({ domain, types: permitTypes, primaryType: "PermitWitnessTransferFrom", message: messageBeyondExpiry });
    const signatureBeyondExpiry = await agent.signTypedData({
      domain: sessionAuthDomain,
      types: sessionAuthTypes,
      primaryType: "SessionAuthorization",
      message: { permit2Digest: digestBeyondExpiry, sessionEpoch },
    });
    const wrapperBeyondExpiry = encodeAbiParameters(
      [
        { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" },
        { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" },
      ],
      [tokenAddress, amount, exactProxy, nonce, deadlineBeyondExpiry, payTo, validAfter, sessionEpoch, signatureBeyondExpiry]
    );
    const beyondExpiryResult = await publicClient.readContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "isValidSignature",
      args: [digestBeyondExpiry, wrapperBeyondExpiry],
    });
    assert.equal(beyondExpiryResult.toLowerCase(), FAILURE_VALUE, "a Permit2 deadline cannot outlive the mandate");

    await assert.rejects(ownerWallet.writeContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "arm",
      args: [agent.address, maxPerCall, expiry, (1n << 256n) - 1n],
    }), "max uint256 allowance must be rejected rather than treated as a finite cap");

    // Exercise the mock's finite transferFrom allowance through the local Permit2 stand-in.
    const simulatedTransferHash = await ownerWallet.writeContract({
      address: tokenAddress,
      abi: token.abi,
      functionName: "transferFrom",
      args: [mandateAddress, payTo, 100n],
    });
    await publicClient.waitForTransactionReceipt({ hash: simulatedTransferHash });
    assert.equal(
      await publicClient.readContract({ address: tokenAddress, abi: token.abi, functionName: "allowance", args: [mandateAddress, permit2Address] }),
      900n,
      "mock transferFrom must decrement finite allowance"
    );

    const revokeHash = await ownerWallet.writeContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "revoke",
    });
    await publicClient.waitForTransactionReceipt({ hash: revokeHash });
    assert.equal(await publicClient.readContract({ address: mandateAddress, abi: mandate.abi, functionName: "active" }), false);
    assert.equal(
      await publicClient.readContract({ address: tokenAddress, abi: token.abi, functionName: "allowance", args: [mandateAddress, permit2Address] }),
      0n,
      "owner revoke must reset the Permit2 allowance to zero"
    );
    const postRevokeResult = await publicClient.readContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "isValidSignature",
      args: [digest, wrapper(amount, exactProxy)],
    });
    assert.equal(postRevokeResult.toLowerCase(), FAILURE_VALUE, "revoked mandate must reject the prior signature");

    const blockBeforeRearm = await publicClient.getBlock();
    const rearmExpiry = blockBeforeRearm.timestamp + 3_600n;
    const rearmHash = await ownerWallet.writeContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "arm",
      args: [agent.address, maxPerCall, rearmExpiry, 500n],
    });
    await publicClient.waitForTransactionReceipt({ hash: rearmHash });
    const rearmedEpoch = await publicClient.readContract({ address: mandateAddress, abi: mandate.abi, functionName: "sessionEpoch" });
    assert.equal(rearmedEpoch, sessionEpoch + 2n, "revoke and re-arm must each advance the epoch");
    const revivedResult = await publicClient.readContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "isValidSignature",
      args: [digest, wrapper(amount, exactProxy)],
    });
    assert.equal(revivedResult.toLowerCase(), FAILURE_VALUE, "an unused signature from before revoke must stay invalid after re-arm");
    const rearmedSignature = await agent.signTypedData({
      domain: sessionAuthDomain,
      types: sessionAuthTypes,
      primaryType: "SessionAuthorization",
      message: { permit2Digest: digest, sessionEpoch: rearmedEpoch },
    });
    const currentEpochResult = await publicClient.readContract({
      address: mandateAddress,
      abi: mandate.abi,
      functionName: "isValidSignature",
      args: [digest, wrapper(amount, exactProxy, rearmedEpoch, rearmedSignature)],
    });
    assert.equal(currentEpochResult.toLowerCase(), MAGIC_VALUE, "current epoch-bound session authorization must validate");

    console.log("LOCAL SIMULATED EVM TEST PASSED");
    console.log(`chainId=${CHAIN_ID} rpc=${rpcUrl}`);
    console.log(`owner=${owner.address} agent=${agent.address}`);
    console.log(`MockERC20=${tokenAddress} mandate=${mandateAddress}`);
    console.log("covered: owner arm, epoch-bound signature validation, wrong amount/policy/epoch rejection, max allowance rejection, owner-only revoke, finite allowance decrement, allowance reset, old signature invalidation after re-arm");
    console.log("This is local simulated EVM coverage only; it is not proof of a real facilitator, Permit2 deployment, network, or transaction.");
  } finally {
    await stopProcess(ganache);
    rmSync(compileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`LOCAL SIMULATED EVM TEST FAILED: ${error.stack ?? error}`);
  process.exitCode = 1;
});
