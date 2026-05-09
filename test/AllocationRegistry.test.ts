import { expect } from "chai";
import { network } from "hardhat";

const E18 = 10n ** 18n;
const TOTAL_SUPPLY = 500_000_000n * E18;

async function addrOf(c: any): Promise<string> {
  return c?.target ?? (await c.getAddress());
}

describe("AllocationRegistry", function () {
  async function deployFixture() {
    const { ethers } = await network.connect();
    const [deployer, treasury, owner, devs, mm, airdrop, vesting] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("FlyANGT", deployer);
    const token: any = await Token.deploy(treasury.address);

    return {
      ethers,
      deployer,
      treasury,
      owner,
      devs,
      mm,
      airdrop,
      vesting,
      token,
    };
  }

  function makeEntries(
    addrs: { owner: string; devs: string; mm: string; airdrop: string; vesting: string; treasury: string },
    parts: { airdrop: bigint; vesting: bigint },
  ) {
    return [
      {
        label: "Owner",
        recipient: addrs.owner,
        amountWei: 175_000_000n * E18,
        vested: false,
        note: "founder, no lock",
      },
      {
        label: "Devs",
        recipient: addrs.devs,
        amountWei: 25_000_000n * E18,
        vested: false,
        note: "team, no lock",
      },
      {
        label: "Market makers",
        recipient: addrs.mm,
        amountWei: 12_500_000n * E18,
        vested: false,
        note: "MM provision",
      },
      {
        label: "Airdrop",
        recipient: addrs.airdrop,
        amountWei: parts.airdrop,
        vested: false,
        note: "MerkleAirdrop contract",
      },
      {
        label: "Presale Vesting",
        recipient: addrs.vesting,
        amountWei: parts.vesting,
        vested: true,
        note: "Vesting, 1080 days per-cohort",
      },
      {
        label: "Treasury",
        recipient: addrs.treasury,
        amountWei:
          TOTAL_SUPPLY -
          175_000_000n * E18 -
          25_000_000n * E18 -
          12_500_000n * E18 -
          parts.airdrop -
          parts.vesting,
        vested: false,
        note: "Safe, OTC reserve and ops",
      },
    ];
  }

  it("constructor: stores all entries, reads back via all()/get()/count()", async function () {
    const { ethers, token, treasury, owner, devs, mm, airdrop, vesting } =
      await deployFixture();

    const entries = makeEntries(
      {
        owner: owner.address,
        devs: devs.address,
        mm: mm.address,
        airdrop: airdrop.address,
        vesting: vesting.address,
        treasury: treasury.address,
      },
      { airdrop: 4_400n * E18, vesting: 162_460n * E18 },
    );

    const Registry = await ethers.getContractFactory("AllocationRegistry");
    const registry: any = await Registry.deploy(
      await addrOf(token),
      TOTAL_SUPPLY,
      entries,
    );

    expect(await registry.token()).to.equal(await addrOf(token));
    expect(await registry.totalSupplyDocumented()).to.equal(TOTAL_SUPPLY);
    expect(await registry.count()).to.equal(6n);

    const e0 = await registry.get(0);
    expect(e0.label).to.equal("Owner");
    expect(e0.recipient).to.equal(owner.address);
    expect(e0.amountWei).to.equal(175_000_000n * E18);
    expect(e0.vested).to.equal(false);
    expect(e0.note).to.equal("founder, no lock");

    const e4 = await registry.get(4);
    expect(e4.label).to.equal("Presale Vesting");
    expect(e4.vested).to.equal(true);

    const all = await registry.all();
    expect(all.length).to.equal(6);
  });

  it("constructor: reverts if sum != totalSupply", async function () {
    const { ethers, token, treasury, owner, devs, mm, airdrop, vesting } =
      await deployFixture();

    const bad = makeEntries(
      {
        owner: owner.address,
        devs: devs.address,
        mm: mm.address,
        airdrop: airdrop.address,
        vesting: vesting.address,
        treasury: treasury.address,
      },
      { airdrop: 4_400n * E18, vesting: 162_460n * E18 },
    );
    // mutate: drop treasury entry — sum becomes < totalSupply
    bad.pop();

    const Registry = await ethers.getContractFactory("AllocationRegistry");
    await expect(
      Registry.deploy(await addrOf(token), TOTAL_SUPPLY, bad),
    ).to.be.revertedWith("sum != totalSupply");
  });

  it("constructor: reverts on zero recipient", async function () {
    const { ethers, token } = await deployFixture();

    const Registry = await ethers.getContractFactory("AllocationRegistry");
    await expect(
      Registry.deploy(await addrOf(token), TOTAL_SUPPLY, [
        {
          label: "x",
          recipient: ethers.ZeroAddress,
          amountWei: TOTAL_SUPPLY,
          vested: false,
          note: "",
        },
      ]),
    ).to.be.revertedWith("zero recipient");
  });

  it("constructor: reverts on zero amount entry", async function () {
    const { ethers, token, owner } = await deployFixture();

    const Registry = await ethers.getContractFactory("AllocationRegistry");
    await expect(
      Registry.deploy(await addrOf(token), TOTAL_SUPPLY, [
        {
          label: "x",
          recipient: owner.address,
          amountWei: 0n,
          vested: false,
          note: "",
        },
      ]),
    ).to.be.revertedWith("zero amount");
  });

  it("constructor: reverts on empty entries", async function () {
    const { ethers, token } = await deployFixture();
    const Registry = await ethers.getContractFactory("AllocationRegistry");
    await expect(
      Registry.deploy(await addrOf(token), TOTAL_SUPPLY, []),
    ).to.be.revertedWith("no entries");
  });

  it("constructor: reverts on zero token", async function () {
    const { ethers, owner } = await deployFixture();
    const Registry = await ethers.getContractFactory("AllocationRegistry");
    await expect(
      Registry.deploy(ethers.ZeroAddress, 1n, [
        {
          label: "x",
          recipient: owner.address,
          amountWei: 1n,
          vested: false,
          note: "",
        },
      ]),
    ).to.be.revertedWith("token is zero");
  });

  it("get: reverts on out-of-range index", async function () {
    const { ethers, token, owner } = await deployFixture();
    const Registry = await ethers.getContractFactory("AllocationRegistry");
    const registry: any = await Registry.deploy(await addrOf(token), 1n, [
      {
        label: "single",
        recipient: owner.address,
        amountWei: 1n,
        vested: false,
        note: "",
      },
    ]);
    await expect(registry.get(5)).to.be.revertedWith("out of range");
  });

  it("emits AllocationRecorded for each entry", async function () {
    const { ethers, token, treasury, owner, devs, mm, airdrop, vesting } =
      await deployFixture();

    const entries = makeEntries(
      {
        owner: owner.address,
        devs: devs.address,
        mm: mm.address,
        airdrop: airdrop.address,
        vesting: vesting.address,
        treasury: treasury.address,
      },
      { airdrop: 4_400n * E18, vesting: 162_460n * E18 },
    );

    const Registry = await ethers.getContractFactory("AllocationRegistry");
    const tx = await Registry.deploy(await addrOf(token), TOTAL_SUPPLY, entries);

    const registry: any = tx;
    await registry.waitForDeployment();
    const receipt = await ethers.provider.getTransactionReceipt(
      registry.deploymentTransaction()!.hash,
    );
    expect(receipt!.logs.length).to.be.gte(6);
  });
});
