import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const RPC_URL = "http://127.0.0.1:8545";

const OUT_PATH = path.join(
  process.cwd(),
  "src",
  "lib",
  "web3",
  "hardhat-addresses.json"
);

// price: $0.0061 => 6100 microUSD
const PRICE_USD_MICRO = 6100;

function readArtifact(contractName: string) {
  const p = path.join(
    process.cwd(),
    "artifacts",
    "contracts",
    `${contractName}.sol`,
    `${contractName}.json`
  );

  if (!fs.existsSync(p)) {
    throw new Error(`Artifact not found: ${p}\nRun: npx hardhat compile`);
  }

  return JSON.parse(fs.readFileSync(p, "utf8")) as {
    abi: any[];
    bytecode: string;
  };
}

async function deploy(
  contractName: string,
  signer: ethers.Signer,
  args: any[] = []
) {
  const art = readArtifact(contractName);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Берём аккаунты прямо из hardhat node
  const accounts = await provider.send("eth_accounts", []);
  if (!accounts || accounts.length < 3) {
    throw new Error("No accounts from hardhat node. Is `npx hardhat node` running?");
  }

  const deployerAddress = accounts[0];
  const treasuryAddress = accounts[1];
  const mintToAddress = accounts[2];

  // JsonRpcSigner — подписывает через hardhat node (unlocked accounts)
  const deployer = await provider.getSigner(deployerAddress);

  console.log("RPC:", RPC_URL);
  console.log("Deployer:", deployerAddress);
  console.log("Treasury:", treasuryAddress);
  console.log("MintTo:", mintToAddress);

  // Deploy USDT/USDC (локальные тест-токены)
  const usdt = await deploy("USDT", deployer);
  const usdc = await deploy("USDC", deployer);

  // Deploy Presale
  const presale = await deploy("Presale", deployer, [
    await usdt.getAddress(),
    await usdc.getAddress(),
    treasuryAddress,
    PRICE_USD_MICRO,
  ]);

  // Mint balances to mintToAddress (6 decimals)
  await (await (usdt as any).mint(mintToAddress, 5000n * 1_000_000n)).wait();
  await (await (usdc as any).mint(mintToAddress, 1200n * 1_000_000n)).wait();

  const out = {
    chainId: 31337,
    rpc: RPC_URL,
    deployer: deployerAddress,
    treasury: treasuryAddress,
    mintTo: mintToAddress,
    usdt: await usdt.getAddress(),
    usdc: await usdc.getAddress(),
    presale: await presale.getAddress(),
    priceUsdMicro: PRICE_USD_MICRO,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");

  console.log("\nDEPLOY RESULT:");
  console.log(out);
  console.log("\nSaved:", OUT_PATH);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
