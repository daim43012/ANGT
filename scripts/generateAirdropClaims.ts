/**
 * Generate airdrop claims from flyangt Postgres DB.
 *
 * Source (off-chain only):
 *   RewardTotal — aggregated ANGT reward per wallet (from RewardLedger).
 *
 * Output:
 *   airdrop/claims.json — [{ address, amount }]   (amount = human ANGT, no decimals)
 *
 * Env:
 *   POSTGRESQL_DB_URL — same as flyangt .env
 *
 * Run:
 *   POSTGRESQL_DB_URL=postgresql://... npx tsx scripts/generateAirdropClaims.ts
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { ethers } from "ethers";

type Claim = { address: string; amount: string };

async function main() {
  const dbUrl = process.env.POSTGRESQL_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      "POSTGRESQL_DB_URL not set. Pass it via env (same as flyangt/.env).",
    );
  }

  const minAmount = Number(process.env.MIN_AIRDROP_ANGT ?? "1"); // skip dust
  const outPath = path.join(process.cwd(), "airdrop", "claims.json");

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // RewardTotal stores aggregated rewards per (userId, walletAddress).
  // It can have multiple users sharing the same wallet — we aggregate again by walletAddress.
  const { rows } = await client.query<{
    walletAddress: string;
    total: string;
  }>(
    `SELECT lower("walletAddress") AS "walletAddress",
            SUM("totalAmount")::bigint AS total
       FROM "RewardTotal"
      WHERE "walletAddress" IS NOT NULL
        AND "walletAddress" <> ''
      GROUP BY lower("walletAddress")
      HAVING SUM("totalAmount") >= $1
      ORDER BY total DESC`,
    [minAmount],
  );

  await client.end();

  const claims: Claim[] = [];
  let skipped = 0;
  let totalAngt = 0n;

  for (const row of rows) {
    if (!row.walletAddress) {
      skipped++;
      continue;
    }
    let address: string;
    try {
      address = ethers.getAddress(row.walletAddress);
    } catch {
      skipped++;
      continue;
    }
    const angt = BigInt(row.total);
    if (angt <= 0n) {
      skipped++;
      continue;
    }
    claims.push({ address, amount: angt.toString() });
    totalAngt += angt;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(claims, null, 2), "utf8");

  console.log(`recipients: ${claims.length}`);
  console.log(`skipped:    ${skipped}`);
  console.log(`total ANGT: ${totalAngt.toString()}`);
  console.log(`saved:      ${outPath}`);
  console.log(`next:       npx tsx scripts/buildMerkle.ts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
