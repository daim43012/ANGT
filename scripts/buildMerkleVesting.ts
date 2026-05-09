/**
 * Build Merkle tree for presale-vesting claims.
 *
 * Reads:  airdrop/claimsVesting.json — [{ address, amount }] (amount = human ANGT, may be fractional)
 * Writes: airdrop/merkleVesting.json — { root, proofs }
 *
 * Leaf encoding matches Vesting.activateMerkle:
 *   keccak256(abi.encodePacked(address, totalAllocationAmountWei))
 *
 * Run:
 *   npx tsx scripts/buildMerkleVesting.ts
 */
import fs from "node:fs";
import path from "node:path";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import { ethers } from "ethers";

type Claim = { address: string; amount: string };

function leafPacked(address: string, amountWei: bigint): Buffer {
  const hash = ethers.solidityPackedKeccak256(
    ["address", "uint256"],
    [address, amountWei],
  );
  return Buffer.from(hash.slice(2), "hex");
}

async function main() {
  const inputPath = path.join(process.cwd(), "airdrop", "claimsVesting.json");
  const outPath = path.join(process.cwd(), "airdrop", "merkleVesting.json");

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8")) as Claim[];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("claimsVesting.json must be a non-empty array");
  }

  const normalized = raw.map((c, i) => {
    if (!c?.address || !c?.amount) {
      throw new Error(`Bad entry at index ${i}: expected {address, amount}`);
    }
    const address = ethers.getAddress(c.address);
    const amountWei = ethers.parseUnits(c.amount, 18);
    if (amountWei <= 0n) {
      throw new Error(`Entry ${i} (${address}) has non-positive amount`);
    }
    return { address, amount: c.amount, amountWei };
  });

  const leaves = normalized.map((c) => leafPacked(c.address, c.amountWei));
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = tree.getHexRoot();

  const proofs: Record<
    string,
    { amount: string; amountWei: string; proof: string[] }
  > = {};

  for (const c of normalized) {
    const lf = leafPacked(c.address, c.amountWei);
    proofs[c.address] = {
      amount: c.amount,
      amountWei: c.amountWei.toString(),
      proof: tree.getHexProof(lf),
    };
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ root, proofs }, null, 2),
    "utf8",
  );

  console.log("Merkle root:", root);
  console.log("Recipients: ", normalized.length);
  console.log("Saved:      ", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
