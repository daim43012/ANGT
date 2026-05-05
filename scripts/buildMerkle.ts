import fs from "node:fs";
import path from "node:path";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import { ethers } from "ethers";

type Claim = { address: string; amount: string };

function leafPacked(address: string, amountWei: bigint): Buffer {
  const hash = ethers.solidityPackedKeccak256(
    ["address", "uint256"],
    [address, amountWei]
  );
  return Buffer.from(hash.slice(2), "hex");
}

async function main() {
  const inputPath = path.join(process.cwd(), "airdrop", "claims.json");
  const outPath = path.join(process.cwd(), "airdrop", "merkle.json");

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }

  const claims: Claim[] = JSON.parse(fs.readFileSync(inputPath, "utf8"));

  if (!Array.isArray(claims) || claims.length === 0) {
    throw new Error("claims.json must be a non-empty array");
  }

  const normalized = claims.map((c, i) => {
    if (!c?.address || !c?.amount) {
      throw new Error(`Bad entry at index ${i}: expected {address, amount}`);
    }
    const address = ethers.getAddress(c.address);
    const amountWei = ethers.parseUnits(c.amount, 18);
    return { address, amount: c.amount, amountWei };
  });

  const leaves = normalized.map((c) => leafPacked(c.address, c.amountWei));

  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = tree.getHexRoot();

  const proofs: Record<string, { amount: string; amountWei: string; proof: string[] }> = {};

  for (const c of normalized) {
    const lf = leafPacked(c.address, c.amountWei);
    proofs[c.address] = {
      amount: c.amount,
      amountWei: c.amountWei.toString(),
      proof: tree.getHexProof(lf),
    };
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ root, proofs }, null, 2), "utf8");

  console.log("Merkle root:", root);
  console.log("Saved:", outPath);
  console.log("Recipients:", normalized.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
