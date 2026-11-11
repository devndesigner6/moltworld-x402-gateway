// Bundles the browser libraries into vendor/, which the gateway serves from its own origin.
// Re-run after upgrading three, typegpu, use-wallet or the SDK:  pnpm vendor
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { build, type Plugin } from "esbuild";

// algokit-utils (used by @x402/avm) bundles an HD-wallet module that imports Node's crypto and
// util. Payments never call it, so those two imports resolve to throwing stubs, for that package only.
const stubHdWalletNodeImports: Plugin = {
  name: "stub-hd-wallet-node-imports",
  setup(b) {
    b.onResolve({ filter: /^(crypto|util)$/ }, (args) =>
      args.importer.includes("xhd-wallet-api") ? { path: path.resolve("web/node-stub.ts") } : undefined
    );
  },
};

rmSync("vendor", { recursive: true, force: true });
await build({
  entryPoints: { three: "three/webgpu", typegpu: "typegpu", pay: "web/pay.ts", mandate: "web/mandate.ts", market: "web/market.ts" },
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  minify: true,
  target: "es2022",
  inject: ["web/buffer-shim.ts"],
  legalComments: "eof",
  outdir: "vendor",
  chunkNames: "chunks/[name]-[hash]",
  plugins: [stubHdWalletNodeImports],
  logLevel: "info",
});

// Vercel serves public/** through its CDN. Keep the same bundle tree available there.
rmSync("public/assets/vendor", { recursive: true, force: true });
mkdirSync("public/assets", { recursive: true });
cpSync("vendor", "public/assets/vendor", { recursive: true });
