/**
 * Build Safe Transaction Builder JSON for the TGE distribution batch.
 *
 * This batch covers ONLY the immediate TGE distribution:
 *   - Transfer ANGT from Safe to 3 GPs + Devs + MM (5 transfers)
 *   - Renounce FlyANGT ownership (clean scanners)
 *
 * Airdrop and Vesting funding/activation is in scripts/buildSafeBatchActivate.ts —
 * to be used LATER when you're ready to open claims.
 *
 * Run AFTER FlyANGT is deployed and verified on Polygonscan.
 *
 * Env:
 *   ANGT_ADDRESS  — deployed FlyANGT
 *   SAFE_ADDRESS  — Safe (treasury), default 0xBBC7Ee...490A
 *
 * Run:
 *   ANGT_ADDRESS=0x... npm run safe:distribution
 *
 * Output:
 *   airdrop/safe-batch-distribution.json
 *
 * Load it at https://app.safe.global → Apps → Transaction Builder → Drag-drop file.
 * 3 GPs sign once → all 6 operations execute atomically.
 */
import fs from "node:fs";
import path from "node:path";

const E18 = 10n ** 18n;

const SAFE = (
  process.env.SAFE_ADDRESS ?? "0xBBC7Ee82284416aaA9C3e6d9C73d7D1f7752490A"
).toLowerCase();
const ANGT = (process.env.ANGT_ADDRESS ?? "").toLowerCase();

if (!ANGT) throw new Error("ANGT_ADDRESS not set");

// --- Distribution (matches parameters.polygon.json) ---
const DISTRIBUTION = [
  { label: "GP #1", to: "0x27c624630fF922Bb675dBFB420C10d745c0f8568", wei: 100_000_000n * E18 },
  { label: "GP #2", to: "0x9adC93CEA02c5DDF5A8fC0139c79708a5bd8f667", wei:  50_000_000n * E18 },
  { label: "GP #3", to: "0x4261f9534A92e3f9bb5ec5fD9484eE3f9332Eb3F", wei:  25_000_000n * E18 },
  { label: "Devs", to: "0x59589d7630077f2eCAf1b44A59EDaF12b1100bdb",  wei:  25_000_000n * E18 },
  { label: "MM",   to: "0xad98403fe174A46E3E4d0793AF579C23b666EFEd",  wei:  12_500_000n * E18 },
];

type SafeTx = {
  to: string;
  value: string;
  data: null;
  contractMethod: {
    name: string;
    payable: boolean;
    inputs: { name: string; type: string; internalType: string }[];
  };
  contractInputsValues: Record<string, string>;
};

const tx_transfer = (token: string, to: string, amount: bigint): SafeTx => ({
  to: token,
  value: "0",
  data: null,
  contractMethod: {
    name: "transfer",
    payable: false,
    inputs: [
      { name: "to", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
  },
  contractInputsValues: { to, amount: amount.toString() },
});

const tx_renounce = (target: string): SafeTx => ({
  to: target,
  value: "0",
  data: null,
  contractMethod: {
    name: "renounceOwnership",
    payable: false,
    inputs: [],
  },
  contractInputsValues: {},
});

const transactions: SafeTx[] = [];

// 1. Distribute to GP / Dev / MM
for (const d of DISTRIBUTION) {
  transactions.push(tx_transfer(ANGT, d.to, d.wei));
}

// 2. Renounce FlyANGT ownership (no admin functions remain — clean for scanners)
transactions.push(tx_renounce(ANGT));

const batch = {
  version: "1.0",
  chainId: "137",
  createdAt: Date.now(),
  meta: {
    name: "FlyANGT TGE — distribution",
    description:
      "Distribute 212.5M ANGT to GP/Dev/MM (5 transfers) and renounceOwnership of FlyANGT. Treasury keeps the rest (287.5M).",
    txBuilderVersion: "1.16.0",
    createdFromSafeAddress: SAFE,
  },
  transactions,
};

const outPath = path.join(process.cwd(), "airdrop", "safe-batch-distribution.json");
fs.writeFileSync(outPath, JSON.stringify(batch, null, 2), "utf8");

let total = 0n;
console.log(`Generated Safe distribution batch with ${transactions.length} transactions:`);
let i = 1;
for (const d of DISTRIBUTION) {
  total += d.wei;
  console.log(`  ${i++}. transfer ${(d.wei / E18).toString().padStart(11)} ANGT → ${d.label} (${d.to})`);
}
console.log(`  ${i++}. renounceOwnership() → FlyANGT`);
console.log(``);
console.log(`Total transferred: ${(total / E18).toString().padStart(11)} ANGT`);
console.log(`Treasury keeps:   ${((500_000_000n * E18 - total) / E18).toString().padStart(11)} ANGT`);
console.log(``);
console.log(`Saved: ${outPath}`);
console.log(`Load it at https://app.safe.global → Apps → Transaction Builder.`);
