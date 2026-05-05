import { network } from "hardhat";

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function main() {
  const { ethers } = await network.connect();
  const [deployer, treasury] = await ethers.getSigners();

  console.log("Deployer:", deployer.address);
  console.log("Treasury :", treasury.address);

  // 1) Deploy mocks (6 decimals)
  const Mock = await ethers.getContractFactory("MockERC20", deployer);
  const usdt: any = await Mock.deploy("Tether USD", "USDT", 6);
  const usdc: any = await Mock.deploy("USD Coin", "USDC", 6);

  // 2) Presale params
const startTime = BigInt(Math.floor(Date.now() / 1000) - 60); // старт минуту назад
  const endTime = 0; // без конца
  const weekDuration = 7n * 24n * 60n * 60n;

  // prices in micro USD (1e6): week1=0.10$, week2=0.12$, week3=0.15$
// week1 = 0.005$, week2 = 0.0075$, week3 = 0.01$
const pricesMicro = [5_000n, 7_500n, 10_000n];

  const Presale = await ethers.getContractFactory("PresaleTimeWeeks", deployer);
  const presale: any = await Presale.deploy(
    await usdt.getAddress(),
    await usdc.getAddress(),
    treasury.address,
    startTime,
    endTime,
    Number(weekDuration), // weekDuration in uint32
    pricesMicro
  );

  // 3) Mint test balances to deployer (and optionally to others)
  const mintAmount = 100_000n * 1_000_000n; // 100k USDT/USDC (6 decimals)
  await usdt.mint(deployer.address, mintAmount);
  await usdc.mint(deployer.address, mintAmount);

  console.log("\n=== LOCAL ADDRESSES ===");
  console.log("USDT   :", await usdt.getAddress());
  console.log("USDC   :", await usdc.getAddress());
  console.log("PRESALE:", await presale.getAddress());
  console.log("Start  :", startTime.toString(), "(unix)");
  console.log("=======================\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
