/**
 * Deploy the Vesting contract on Polygon mainnet.
 *
 * Run:
 *   npx hardhat run scripts/deploy-vesting.ts --network polygon
 *
 * After deploy, verify on Polygonscan with:
 *   npx hardhat verify --network polygon <vestingAddr> "<ANGT>" "<OWNER>"
 */
import { network } from "hardhat";

const ANGT = "0x773131295d49d2a759D230c030A116068719306f";
const OWNER = "0xBBC7Ee82284416aaA9C3e6d9C73d7D1f7752490A"; // treasury Safe

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("Deployer       :", deployer.address);
  console.log("Token (ANGT)   :", ANGT);
  console.log("Owner (Safe)   :", OWNER);
  console.log("");

  const Factory = await ethers.getContractFactory("Vesting");
  const vesting = await Factory.deploy(ANGT, OWNER);
  await vesting.waitForDeployment();

  const addr = await vesting.getAddress();
  console.log("=".repeat(60));
  console.log("Vesting deployed at:", addr);
  console.log("=".repeat(60));
  console.log("");
  console.log("Next: verify on Polygonscan:");
  console.log(
    `  npx hardhat verify --network polygon ${addr} "${ANGT}" "${OWNER}"`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
