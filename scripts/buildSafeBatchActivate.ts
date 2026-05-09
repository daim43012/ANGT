/**
 * Build Safe Transaction Builder JSON for the airdrop & vesting activation.
 *
 * Use this LATER, after the initial distribution is done and you're ready to
 * open claims for users. Sequence:
 *   1. transfer ANGT from Safe → MerkleAirdrop (snapshot total)
 *   2. transfer ANGT from Safe → Vesting (snapshot total + optional OTC reserve)
 *   3. setMerkleRoot(root) on both
 *   4. start() on both
 *
 * Run AFTER MerkleAirdrop and Vesting are deployed.
 *
 * Env:
 *   ANGT_ADDRESS    — deployed FlyANGT
 *   AIRDROP_ADDRESS — deployed MerkleAirdrop
 *   VESTING_ADDRESS — deployed Vesting
 *   SAFE_ADDRESS    — Safe (treasury), default 0xBBC7Ee...490A
 *   VESTING_RESERVE — optional extra ANGT (whole tokens) for OTC top-ups, default 0
 *
 * Run:
 *   ANGT_ADDRESS=0x... AIRDROP_ADDRESS=0x... VESTING_ADDRESS=0x... \
 *     VESTING_RESERVE=10000000 npm run safe:activate
 *
 * Output:
 *   airdrop/safe-batch-activate.json
 */
import fs from "node:fs";
import path from "node:path";

const E18 = 10n ** 18n;

const SAFE = (
  process.env.SAFE_ADDRESS ?? "0xBBC7Ee82284416aaA9C3e6d9C73d7D1f7752490A"
).toLowerCase();
const ANGT = (process.env.ANGT_ADDRESS ?? "").toLowerCase();
const AIRDROP = (process.env.AIRDROP_ADDRESS ?? "").toLowerCase();
const VESTING = (process.env.VESTING_ADDRESS ?? "").toLowerCase();
const VESTING_RESERVE_TOKENS = BigInt(process.env.VESTING_RESERVE ?? "0");

if (!ANGT) throw new Error("ANGT_ADDRESS not set");
if (!AIRDROP) throw new Error("AIRDROP_ADDRESS not set");
if (!VESTING) throw new Error("VESTING_ADDRESS not set");

function readJson(p: string) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), p), "utf8"));
}

const airdropMerkle = readJson("airdrop/merkle.json") as {
  root: string;
  proofs: Record<string, { amountWei: string }>;
};
const vestingMerkle = readJson("airdrop/merkleVesting.json") as {
  root: string;
  proofs: Record<string, { amountWei: string }>;
};

let airdropTotalWei = 0n;
for (const k in airdropMerkle.proofs) airdropTotalWei += BigInt(airdropMerkle.proofs[k].amountWei);

let vestingTotalWei = 0n;
for (const k in vestingMerkle.proofs) vestingTotalWei += BigInt(vestingMerkle.proofs[k].amountWei);

// Add OTC reserve to vesting funding so admin can later call addInvestor* without re-funding
const vestingFundingWei = vestingTotalWei + VESTING_RESERVE_TOKENS * E18;

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

// 1. Fund both contracts
transactions.push(tx_transfer(ANGT, AIRDROP, airdropTotalWei));
transactions.push(tx_transfer(ANGT, VESTING, vestingFundingWei));

// 2. Set merkle roots (must match the deployed merkle.json / merkleVesting.json)
transactions.push(tx_setRoot(AIRDROP, airdropMerkle.root));
transactions.push(tx_setRoot(VESTING, vestingMerkle.root));

// 3. Start (freezes root, enables claim/activation)
transactions.push(tx_start(AIRDROP));
transactions.push(tx_start(VESTING));

const batch = {
  version: "1.0",
  chainId: "137",
  createdAt: Date.now(),
  meta: {
    name: "FlyANGT — airdrop & vesting activation",
    description: `Fund and activate MerkleAirdrop (${airdropTotalWei} wei) and Vesting (${vestingFundingWei} wei = snapshot ${vestingTotalWei} + OTC reserve ${VESTING_RESERVE_TOKENS} ANGT).`,
    txBuilderVersion: "1.16.0",
    createdFromSafeAddress: SAFE,
  },
  transactions,
};

const outPath = path.join(process.cwd(), "airdrop", "safe-batch-activate.json");
fs.writeFileSync(outPath, JSON.stringify(batch, null, 2), "utf8");

console.log(`Generated activation batch with ${transactions.length} transactions:`);
console.log(`  1. transfer ${airdropTotalWei.toString().padStart(28)} wei → MerkleAirdrop`);
console.log(`     (= ${(airdropTotalWei / E18).toString()} whole ANGT)`);
console.log(`  2. transfer ${vestingFundingWei.toString().padStart(28)} wei → PresaleVesting`);
console.log(`     (= ${vestingTotalWei.toString()} wei snapshot + ${(VESTING_RESERVE_TOKENS * E18).toString()} wei OTC reserve)`);
console.log(`  3. setMerkleRoot ${airdropMerkle.root.slice(0, 18)}… → MerkleAirdrop`);
console.log(`  4. setMerkleRoot ${vestingMerkle.root.slice(0, 18)}… → PresaleVesting`);
console.log(`  5. start() → MerkleAirdrop`);
console.log(`  6. start() → PresaleVesting`);
console.log(``);
console.log(`Saved: ${outPath}`);
