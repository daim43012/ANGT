/**
 * Generate presale-vesting claims combining off-chain DB + on-chain events.
 *
 * Sources:
 *   1) flyangt Postgres — PresaleTotal joined with WalletInfo.address.
 *      Captures Stripe (off-chain) presale buyers.
 *   2) On-chain Purchased events from the live Polygon Presale contract,
 *      read via Etherscan v2 logs API.
 *
 * Both sources are merged per wallet → final ANGT total.
 *
 * Output:
 *   airdrop/claimsVesting.json — [{ address, amount }] (amount = human ANGT)
 *
 * Env:
 *   POSTGRESQL_DB_URL — flyangt DB
 *   PRESALE_ADDRESS    — Polygon presale contract (default: 0xdd03b252...Bed0)
 *   PRESALE_FROM_BLOCK — first block (default: 82858156)
 *   ETHERSCAN_API_KEY  — etherscan key for Polygon (chainid 137)
 *
 * Run:
 *   POSTGRESQL_DB_URL=... ETHERSCAN_API_KEY=... \
 *     npx tsx scripts/generatePresaleClaims.ts
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { ethers, Interface, id, getAddress } from "ethers";

type Claim = { address: string; amount: string };

const DEFAULT_PRESALE = "0xdd03b252829A3ebE19F03cf5B6fa033b3DB3Bed0";
const DEFAULT_FROM_BLOCK = 82858156;
const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";

const PURCHASED_EVENT =
  "Purchased(address,address,uint256,uint256,uint256,uint256)";

const ABI = [
  "event Purchased(address indexed buyer, address indexed payToken, uint256 payAmount, uint256 tokenAmountWei, uint256 weekRef, uint256 priceRef)",
];

async function fetchOnchainTotals(
  presale: string,
  fromBlock: number,
  apiKey: string,
): Promise<Map<string, bigint>> {
  const iface = new Interface(ABI);
  const topic0 = id(PURCHASED_EVENT);
  const totals = new Map<string, bigint>();

  // Etherscan v2 logs API returns up to 1000 logs per page.
  const pageSize = 1000;
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      chainid: "137",
      module: "logs",
      action: "getLogs",
      address: presale,
      topic0,
      fromBlock: String(fromBlock),
      toBlock: "latest",
      page: String(page),
      offset: String(pageSize),
      apikey: apiKey,
    });

    const res = await fetch(`${ETHERSCAN_V2}?${params}`);
    const body = (await res.json()) as { status: string; message: string; result: any };

    if (body.status !== "1") {
      if (body.message === "No records found") break;
      throw new Error(`Etherscan: ${body.message} — ${JSON.stringify(body.result).slice(0, 200)}`);
    }
    const logs = body.result as { topics: string[]; data: string }[];
    if (!Array.isArray(logs) || logs.length === 0) break;

    for (const log of logs) {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;
      const buyer = String(parsed.args.buyer).toLowerCase();
      const tokensWei = BigInt(parsed.args.tokenAmountWei);
      totals.set(buyer, (totals.get(buyer) ?? 0n) + tokensWei);
    }

    if (logs.length < pageSize) break;
    page++;
  }

  return totals;
}

async function fetchOffchainTotals(
  dbUrl: string,
): Promise<Map<string, bigint>> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // PresaleTotal stores tokenAmount as Float — we round to nearest integer ANGT then to wei.
  const { rows } = await client.query<{
    walletAddress: string;
    totalTokenAmount: string;
  }>(
    `SELECT lower(w."address") AS "walletAddress",
            SUM(pt."totalTokenAmount")::float AS "totalTokenAmount"
       FROM "PresaleTotal" pt
       JOIN "WalletInfo"   w ON w.id = pt."walletId"
      WHERE w."address" IS NOT NULL
      GROUP BY lower(w."address")`,
  );

  await client.end();

  const totals = new Map<string, bigint>();
  for (const row of rows) {
    if (!row.walletAddress) continue;
    const human = Number(row.totalTokenAmount);
    if (!Number.isFinite(human) || human <= 0) continue;
    // Convert via parseUnits to wei (drops sub-wei precision).
    // Cap at 6 fractional digits to dodge Float noise.
    const human6 = human.toFixed(6);
    const wei = ethers.parseUnits(human6, 18);
    totals.set(row.walletAddress.toLowerCase(), (totals.get(row.walletAddress.toLowerCase()) ?? 0n) + wei);
  }
  return totals;
}

function weiToHumanString(wei: bigint): string {
  // claims.json stores amount as a human string parseable by ethers.parseUnits(amount, 18).
  const s = ethers.formatUnits(wei, 18);
  // Strip trailing zeros for readability, keep at least 1 fractional digit if any.
  if (s.includes(".")) {
    return s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

async function main() {
  const dbUrl = process.env.POSTGRESQL_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("POSTGRESQL_DB_URL not set");

  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error("ETHERSCAN_API_KEY not set");

  const presale = (process.env.PRESALE_ADDRESS || DEFAULT_PRESALE);
  const fromBlock = Number(process.env.PRESALE_FROM_BLOCK || DEFAULT_FROM_BLOCK);

  console.log("on-chain Presale: ", presale);
  console.log("from block:       ", fromBlock);

  const [offchain, onchain] = await Promise.all([
    fetchOffchainTotals(dbUrl),
    fetchOnchainTotals(presale, fromBlock, apiKey),
  ]);

  console.log(`off-chain wallets: ${offchain.size}`);
  console.log(`on-chain wallets:  ${onchain.size}`);

  // Merge: union of keys, sum per wallet.
  const allKeys = new Set<string>([...offchain.keys(), ...onchain.keys()]);
  const claims: Claim[] = [];
  let totalWei = 0n;

  for (const lowerAddr of allKeys) {
    let address: string;
    try {
      address = getAddress(lowerAddr);
    } catch {
      continue;
    }
    const wei = (offchain.get(lowerAddr) ?? 0n) + (onchain.get(lowerAddr) ?? 0n);
    if (wei <= 0n) continue;
    claims.push({ address, amount: weiToHumanString(wei) });
    totalWei += wei;
  }

  claims.sort((a, b) => (a.address < b.address ? -1 : 1));

  const outPath = path.join(process.cwd(), "airdrop", "claimsVesting.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(claims, null, 2), "utf8");

  console.log(`merged wallets:    ${claims.length}`);
  console.log(`total ANGT (wei):  ${totalWei.toString()}`);
  console.log(`total ANGT (hum):  ${weiToHumanString(totalWei)}`);
  console.log(`saved:             ${outPath}`);
  console.log(`next:              npx tsx scripts/buildMerkleVesting.ts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
