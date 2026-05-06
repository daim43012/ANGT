/**
 * Build a Safe Transaction Builder JSON for the TGE batch.
 *
 * Run AFTER all 4 contracts (FlyANGT, MerkleAirdrop, PresaleVestingMerkle,
 * AllocationRegistry) are deployed and verified on Polygonscan.
 *
 * Output: airdrop/safe-batch-tge.json
 *
 * Load this file in Safe Tx Builder (https://app.safe.global → Apps → Transaction Builder
 * → Drag-drop file). Three GPs sign once → all 16 operations execute atomically.
 *
 * Env:
 *   ANGT_ADDRESS                — deployed FlyANGT
 *   AIRDROP_ADDRESS             — deployed MerkleAirdrop
 *   VESTING_ADDRESS             — deployed PresaleVestingMerkle
 *   SAFE_ADDRESS                — Safe (treasury)  default 0xBBC7Ee...490A
 *
 * Run:
 *   ANGT_ADDRESS=0x... AIRDROP_ADDRESS=0x... VESTING_ADDRESS=0x... \
 *     npx tsx scripts/buildSafeBatch.ts
 */
import fs from "node:fs";
import path from "node:path";

const E18 = 10n ** 18n;

const SAFE = (process.env.SAFE_ADDRESS ?? "0xBBC7Ee82284416aaA9C3e6d9C73d7D1f7752490A").toLowerCase();
const ANGT = (process.env.ANGT_ADDRESS ?? "").toLowerCase();
const AIRDROP = (process.env.AIRDROP_ADDRESS ?? "").toLowerCase();
const VESTING = (process.env.VESTING_ADDRESS ?? "").toLowerCase();

if (!ANGT) throw new Error("ANGT_ADDRESS not set");
if (!AIRDROP) throw new Error("AIRDROP_ADDRESS not set");
if (!VESTING) throw new Error("VESTING_ADDRESS not set");

// --- Distribution (matches parameters.polygon.json) ---
const DISTRIBUTION = [
  { label: "GP #1", to: "0x27c624630fF922Bb675dBFB420C10d745c0f8568", wei: 100_000_000n * E18 },
  { label: "GP #2", to: "0x9adC93CEA02c5DDF5A8fC0139c79708a5bd8f667", wei:  50_000_000n * E18 },
  { label: "GP #3", to: "0x4261f9534A92e3f9bb5ec5fD9484eE3f9332Eb3F", wei:  25_000_000n * E18 },
  { label: "Devs", to: "0x59589d7630077f2eCAf1b44A59EDaF12b1100bdb", wei:   25_000_000n * E18 },
  { label: "MM",   to: "0xad98403fe174A46E3E4d0793AF579C23b666EFEd", wei:   12_500_000n * E18 },
];

// --- Read merkle data for airdrop / vesting amounts and roots ---
function readJson(p: string) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), p), "utf8"));
}

const airdropMerkle = readJson("airdrop/merkle.json") as {
  root: string;
  proofs: Record<string, { amountWei: string; amount: string; proof: string[] }>;
};
const vestingMerkle = readJson("airdrop/merkleVesting.json") as {
  root: string;
  proofs: Record<string, { amountWei: string; amount: string; proof: string[] }>;
};

let airdropTotalWei = 0n;
for (const k in airdropMerkle.proofs) airdropTotalWei += BigInt(airdropMerkle.proofs[k].amountWei);

let vestingTotalWei = 0n;
for (const k in vestingMerkle.proofs) vestingTotalWei += BigInt(vestingMerkle.proofs[k].amountWei);

// --- Build Safe Tx Builder format ---

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

const tx_setRoot = (target: string, root: string): SafeTx => ({
  to: target,
  value: "0",
  data: null,
  contractMethod: {
    name: "setMerkleRoot",
    payable: false,
    inputs: [{ name: "newRoot", type: "bytes32", internalType: "bytes32" }],
  },
  contractInputsValues: { newRoot: root },
});

const tx_start = (target: string): SafeTx => ({
  to: target,
  value: "0",
  data: null,
  contractMethod: {
    name: "start",
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

// 2. Fund MerkleAirdrop and PresaleVestingMerkle
transactions.push(tx_transfer(ANGT, AIRDROP, airdropTotalWei));
transactions.push(tx_transfer(ANGT, VESTING, vestingTotalWei));

// 3. Set merkle roots
transactions.push(tx_setRoot(AIRDROP, airdropMerkle.root));
transactions.push(tx_setRoot(VESTING, vestingMerkle.root));

// 4. Start both contracts
transactions.push(tx_start(AIRDROP));
transactions.push(tx_start(VESTING));

// 5. Renounce FlyANGT ownership (clean scanners)
transactions.push(tx_renounce(ANGT));

const batch = {
  version: "1.0",
  chainId: "137",
  createdAt: Date.now(),
  meta: {
    name: "FlyANGT TGE batch",
    description:
      "Distribute 500M ANGT: 100M GP1, 50M GP2, 25M GP3, 25M Devs, 12.5M MM, fund Airdrop+Vesting, set roots, start, renounce FlyANGT.",
    txBuilderVersion: "1.16.0",
    createdFromSafeAddress: SAFE,
  },
  transactions,
};

const outPath = path.join(process.cwd(), "airdrop", "safe-batch-tge.json");
fs.writeFileSync(outPath, JSON.stringify(batch, null, 2), "utf8");

console.log(`Generated Safe batch with ${transactions.length} transactions:`);
let i = 1;
for (const d of DISTRIBUTION) {
  console.log(`  ${i++}. transfer ${(d.wei / E18).toString().padStart(11)} ANGT → ${d.label} (${d.to})`);
}
console.log(`  ${i++}. transfer ${(airdropTotalWei / E18).toString().padStart(11)} ANGT → MerkleAirdrop (${AIRDROP})`);
console.log(`  ${i++}. transfer ${vestingTotalWei.toString().padStart(11)} wei  → PresaleVesting (${VESTING})`);
console.log(`  ${i++}. setMerkleRoot                    → MerkleAirdrop`);
console.log(`  ${i++}. setMerkleRoot                    → PresaleVesting`);
console.log(`  ${i++}. start()                          → MerkleAirdrop`);
console.log(`  ${i++}. start()                          → PresaleVesting`);
console.log(`  ${i++}. renounceOwnership()              → FlyANGT`);
console.log(``);
console.log(`Saved: ${outPath}`);
console.log(`Load it at https://app.safe.global → Apps → Transaction Builder.`);
