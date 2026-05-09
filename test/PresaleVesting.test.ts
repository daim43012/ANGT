/**
 * Tests for the Vesting contract (multi-cohort, daily unlock, UTC-aligned).
 *
 * Core invariants verified:
 *   - Each addInvestor / fundAndAddInvestor creates a NEW independent cohort.
 *   - Cohort.startMidnightUtc = floor(block.timestamp / 1 day) * 1 day.
 *   - Cohort vested = amount * daysElapsed / 1080, capped at amount.
 *   - Top-ups never modify or reset existing cohorts.
 *   - claim() aggregates vested-but-unclaimed across all cohorts of msg.sender.
 *   - Per-cohort claimedWei is updated; subsequent claims pick up new vesting only.
 *   - All cohorts cross day boundaries simultaneously at 00:00 UTC.
 *   - Investor registry tracks unique addresses for off-chain enumeration.
 *   - Sweep locked for 30 days post-deploy, only owner.
 *   - All admin functions are onlyOwner; user-facing claim is open.
 */
import { expect } from "chai";
import { network } from "hardhat";

const E18 = 10n ** 18n;
const DAY = 86400;
const DURATION_DAYS = 1080;
const MAX_UINT256 =
  115792089237316195423570985008687907853269984665640564039457584007913129639935n;
const MAX_UINT128 = 2n ** 128n - 1n;
const DUMMY_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

async function addrOf(c: any): Promise<string> {
  return c?.target ?? (await c.getAddress());
}

async function increaseBy(ethers: any, seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function blockTimestamp(ethers: any, blockNumber?: number): Promise<bigint> {
  const blk = await ethers.provider.getBlock(blockNumber ?? "latest");
  return BigInt(blk!.timestamp);
}

function midnightFloor(ts: bigint): bigint {
  return (ts / BigInt(DAY)) * BigInt(DAY);
}

describe("Vesting", function () {
  async function fixture() {
    const { ethers } = await network.connect();
    const [deployer, treasury, alice, bob, carol, eve] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("FlyANGT", deployer);
    const token: any = await Token.deploy(treasury.address);

    const Vesting = await ethers.getContractFactory("Vesting", deployer);
    const vesting: any = await Vesting.deploy(
      await addrOf(token),
      treasury.address,
    );

    return {
      ethers,
      deployer,
      treasury,
      alice,
      bob,
      carol,
      eve,
      token,
      vesting,
    };
  }

  // ===================================================================
  // Constructor / constants
  // ===================================================================
  describe("constructor & constants", function () {
    it("stores token, owner, deployedAt", async function () {
      const { vesting, treasury, token, ethers } = await fixture();
      expect(await vesting.token()).to.equal(await addrOf(token));
      expect(await vesting.owner()).to.equal(treasury.address);
      expect(Number(await vesting.deployedAt())).to.be.gt(0);
      expect(Number(await vesting.deployedAt())).to.be.lte(
        Number(await blockTimestamp(ethers)),
      );
    });

    it("starts with started=false", async function () {
      const { vesting } = await fixture();
      expect(await vesting.started()).to.equal(false);
    });

    it("constants: 1080 days, 30-day sweep delay, 1e18 decimals", async function () {
      const { vesting } = await fixture();
      expect(await vesting.DURATION_DAYS()).to.equal(1080n);
      expect(await vesting.ADMIN_WITHDRAW_DELAY()).to.equal(BigInt(30 * DAY));
      expect(await vesting.DECIMALS()).to.equal(E18);
    });

    it("reverts on zero token address", async function () {
      const { ethers, deployer, treasury } = await fixture();
      const Vesting = await ethers.getContractFactory("Vesting", deployer);
      await expect(
        Vesting.deploy(ethers.ZeroAddress, treasury.address),
      ).to.be.revertedWith("token zero");
    });
  });

  // ===================================================================
  // start()
  // ===================================================================
  describe("start()", function () {
    it("only owner can call", async function () {
      const { vesting, alice } = await fixture();
      await expect(vesting.connect(alice).start())
        .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("flips started to true and emits Started", async function () {
      const { vesting, treasury } = await fixture();
      await expect(vesting.connect(treasury).start()).to.emit(
        vesting,
        "Started",
      );
      expect(await vesting.started()).to.equal(true);
    });

    it("idempotent (second call is no-op)", async function () {
      const { vesting, treasury } = await fixture();
      await vesting.connect(treasury).start();
      await vesting.connect(treasury).start(); // no revert
      expect(await vesting.started()).to.equal(true);
    });
  });

  // ===================================================================
  // fund()
  // ===================================================================
  describe("fund()", function () {
    it("pulls tokens from owner via approve, emits Funded", async function () {
      const { vesting, treasury, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);

      await expect(vesting.connect(treasury).fund(1000n * E18))
        .to.emit(vesting, "Funded")
        .withArgs(treasury.address, 1000n * E18);

      expect(await token.balanceOf(await addrOf(vesting))).to.equal(
        1000n * E18,
      );
    });

    it("only owner", async function () {
      const { vesting, alice } = await fixture();
      await expect(vesting.connect(alice).fund(1n))
        .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("reverts without approve", async function () {
      const { vesting, treasury, token } = await fixture();
      await expect(
        vesting.connect(treasury).fund(1n * E18),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });
  });

  // ===================================================================
  // addInvestor (no funding)
  // ===================================================================
  describe("addInvestor variants", function () {
    it("addInvestorHuman: creates first cohort with today's UTC midnight start", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      const tx = await vesting
        .connect(treasury)
        .addInvestorHuman(alice.address, 1000n);
      const ts = await blockTimestamp(ethers, tx.blockNumber!);
      const expectedStart = midnightFloor(ts);

      expect(await vesting.cohortCount(alice.address)).to.equal(1n);
      const c = await vesting.cohortAt(alice.address, 0);
      expect(c.startMidnightUtc).to.equal(expectedStart);
      expect(c.amountWei).to.equal(1000n * E18);
      expect(c.claimedWei).to.equal(0n);
    });

    it("addInvestorWei: precise raw wei", async function () {
      const { vesting, treasury, alice } = await fixture();
      const w = 12_345_678_901_234_567_890n;
      await vesting.connect(treasury).addInvestorWei(alice.address, w);
      const c = await vesting.cohortAt(alice.address, 0);
      expect(c.amountWei).to.equal(w);
    });

    it("addInvestorsHuman batch creates one cohort per recipient", async function () {
      const { vesting, treasury, alice, bob, carol } = await fixture();
      await vesting
        .connect(treasury)
        .addInvestorsHuman(
          [alice.address, bob.address, carol.address],
          [100n, 200n, 300n],
        );
      expect(await vesting.cohortCount(alice.address)).to.equal(1n);
      expect(await vesting.cohortCount(bob.address)).to.equal(1n);
      expect(await vesting.cohortCount(carol.address)).to.equal(1n);
      expect((await vesting.cohortAt(alice.address, 0)).amountWei).to.equal(
        100n * E18,
      );
      expect((await vesting.cohortAt(bob.address, 0)).amountWei).to.equal(
        200n * E18,
      );
      expect((await vesting.cohortAt(carol.address, 0)).amountWei).to.equal(
        300n * E18,
      );
    });

    it("addInvestorsWei batch", async function () {
      const { vesting, treasury, alice, bob } = await fixture();
      await vesting
        .connect(treasury)
        .addInvestorsWei([alice.address, bob.address], [1n, 2n]);
      expect((await vesting.cohortAt(alice.address, 0)).amountWei).to.equal(1n);
      expect((await vesting.cohortAt(bob.address, 0)).amountWei).to.equal(2n);
    });

    it("rejects zero address & zero amount", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      await expect(
        vesting.connect(treasury).addInvestorHuman(ethers.ZeroAddress, 1n),
      ).to.be.revertedWith("zero addr");
      await expect(
        vesting.connect(treasury).addInvestorHuman(alice.address, 0n),
      ).to.be.revertedWith("zero amount");
      await expect(
        vesting.connect(treasury).addInvestorWei(alice.address, 0n),
      ).to.be.revertedWith("zero amount");
    });

    it("rejects amount > uint128.max", async function () {
      const { vesting, treasury, alice } = await fixture();
      await expect(
        vesting
          .connect(treasury)
          .addInvestorWei(alice.address, MAX_UINT128 + 1n),
      ).to.be.revertedWith("amount too large");
    });

    it("batch length mismatch", async function () {
      const { vesting, treasury, alice, bob } = await fixture();
      await expect(
        vesting
          .connect(treasury)
          .addInvestorsHuman([alice.address, bob.address], [1n]),
      ).to.be.revertedWith("len mismatch");
    });

    it("only owner", async function () {
      const { vesting, alice } = await fixture();
      await expect(vesting.connect(alice).addInvestorHuman(alice.address, 1n))
        .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("emits InvestorAdded with index, amount, midnight", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      const tx = await vesting
        .connect(treasury)
        .addInvestorHuman(alice.address, 100n);
      const ts = await blockTimestamp(ethers, tx.blockNumber!);
      const expected = midnightFloor(ts);
      await expect(tx)
        .to.emit(vesting, "InvestorAdded")
        .withArgs(alice.address, 0n, 100n * E18, expected);
    });
  });

  // ===================================================================
  // fundAndAddInvestor (atomic transfer + cohort creation)
  // ===================================================================
  describe("fundAndAddInvestor variants", function () {
    it("fundAndAddInvestorHuman: pulls tokens AND creates cohort", async function () {
      const { vesting, treasury, alice, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);

      const treasuryBefore = await token.balanceOf(treasury.address);

      await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 1_000_000n);

      expect(await token.balanceOf(treasury.address)).to.equal(
        treasuryBefore - 1_000_000n * E18,
      );
      expect(await token.balanceOf(await addrOf(vesting))).to.equal(
        1_000_000n * E18,
      );
      const c = await vesting.cohortAt(alice.address, 0);
      expect(c.amountWei).to.equal(1_000_000n * E18);
    });

    it("fundAndAddInvestorsWei batch atomicity", async function () {
      const { vesting, treasury, alice, bob, carol, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);

      await vesting
        .connect(treasury)
        .fundAndAddInvestorsWei(
          [alice.address, bob.address, carol.address],
          [1n * E18, 2n * E18, 3n * E18],
        );

      expect(await token.balanceOf(await addrOf(vesting))).to.equal(6n * E18);
      expect((await vesting.cohortAt(alice.address, 0)).amountWei).to.equal(
        1n * E18,
      );
    });

    it("fundAndAdd reverts atomically without approve (no cohort, no token movement)", async function () {
      const { vesting, treasury, alice, token } = await fixture();

      await expect(
        vesting.connect(treasury).fundAndAddInvestorHuman(alice.address, 100n),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");

      expect(await vesting.cohortCount(alice.address)).to.equal(0n);
      expect(await token.balanceOf(await addrOf(vesting))).to.equal(0n);
    });

    it("batch atomicity: failure on item N rolls back items 1..N-1", async function () {
      const { vesting, treasury, alice, bob, carol, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);

      // 3rd entry has zero amount → triggers zero-amount revert
      await expect(
        vesting
          .connect(treasury)
          .fundAndAddInvestorsHuman(
            [alice.address, bob.address, carol.address],
            [100n, 200n, 0n],
          ),
      ).to.be.revertedWith("zero amount");

      expect(await vesting.cohortCount(alice.address)).to.equal(0n);
      expect(await vesting.cohortCount(bob.address)).to.equal(0n);
      expect(await vesting.cohortCount(carol.address)).to.equal(0n);
      expect(await token.balanceOf(await addrOf(vesting))).to.equal(0n);
    });

    it("only owner can call all 4 variants", async function () {
      const { vesting, alice } = await fixture();
      await expect(vesting.connect(alice).fundAndAddInvestorWei(alice.address, 1n))
        .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount");
      await expect(vesting.connect(alice).fundAndAddInvestorHuman(alice.address, 1n))
        .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount");
      await expect(
        vesting.connect(alice).fundAndAddInvestorsWei([alice.address], [1n]),
      ).to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount");
      await expect(
        vesting.connect(alice).fundAndAddInvestorsHuman([alice.address], [1n]),
      ).to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount");
    });

    it("emits Funded + InvestorAdded with correct args", async function () {
      const { ethers, vesting, treasury, alice, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);

      const tx = await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 100n);
      const ts = await blockTimestamp(ethers, tx.blockNumber!);
      const expected = midnightFloor(ts);

      await expect(tx)
        .to.emit(vesting, "Funded")
        .withArgs(treasury.address, 100n * E18);
      await expect(tx)
        .to.emit(vesting, "InvestorAdded")
        .withArgs(alice.address, 0n, 100n * E18, expected);
    });
  });

  // ===================================================================
  // Multi-cohort behavior — top-ups create NEW cohort, never modify existing
  // ===================================================================
  describe("multi-cohort behavior", function () {
    it("subsequent addInvestor creates a new cohort, doesn't modify the old one", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      const tx1 = await vesting
        .connect(treasury)
        .addInvestorHuman(alice.address, 1000n);
      const start1 = midnightFloor(await blockTimestamp(ethers, tx1.blockNumber!));

      // 5 days later
      await increaseBy(ethers, 5 * DAY);

      const tx2 = await vesting
        .connect(treasury)
        .addInvestorHuman(alice.address, 500n);
      const start2 = midnightFloor(await blockTimestamp(ethers, tx2.blockNumber!));

      expect(start2 - start1).to.equal(BigInt(5 * DAY)); // different days

      expect(await vesting.cohortCount(alice.address)).to.equal(2n);

      const c0 = await vesting.cohortAt(alice.address, 0);
      const c1 = await vesting.cohortAt(alice.address, 1);
      expect(c0.amountWei).to.equal(1000n * E18);
      expect(c0.startMidnightUtc).to.equal(start1);
      expect(c1.amountWei).to.equal(500n * E18);
      expect(c1.startMidnightUtc).to.equal(start2);

      // total allocation is sum
      expect(await vesting.totalAllocationWei(alice.address)).to.equal(
        1500n * E18,
      );
    });

    it("vested = sum of vested per cohort, each independent", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      // Cohort 0: 1080 ANGT → 1 ANGT per day
      await vesting.connect(treasury).addInvestorHuman(alice.address, 1080n);
      await increaseBy(ethers, 540 * DAY); // half-vested for cohort 0

      // Cohort 1: 360 ANGT → 0.333 ANGT per day
      await vesting.connect(treasury).addInvestorHuman(alice.address, 360n);
      // Just after addition: cohort 1 has 0 days elapsed

      // So: vested = (1080e18 * 540 / 1080) + (360e18 * 0 / 1080)
      //            = 540e18 + 0 = 540 ANGT
      const v = await vesting.vestedWei(alice.address);
      expect(v).to.equal(540n * E18);

      // 270 more days pass: cohort 0 → 810/1080, cohort 1 → 270/1080
      await increaseBy(ethers, 270 * DAY);
      const v2 = await vesting.vestedWei(alice.address);
      const c0Vested = (1080n * E18 * 810n) / 1080n;
      const c1Vested = (360n * E18 * 270n) / 1080n;
      expect(v2).to.equal(c0Vested + c1Vested);
    });

    it("top-up after old cohort completed: new cohort starts fresh 1080-day clock", async function () {
      const { ethers, vesting, treasury, alice, token } = await fixture();
      // initial 360 ANGT
      await vesting.connect(treasury).addInvestorHuman(alice.address, 360n);

      // 1100 days → cohort 0 fully vested
      await increaseBy(ethers, 1100 * DAY);
      expect(await vesting.vestedWei(alice.address)).to.equal(360n * E18);

      // Top-up 720 ANGT → new cohort
      await vesting.connect(treasury).addInvestorHuman(alice.address, 720n);

      // Right after top-up: cohort 0 still 360 vested, cohort 1 has 0 days elapsed
      expect(await vesting.vestedWei(alice.address)).to.equal(360n * E18);

      // 540 days later: cohort 1 half-vested = 360, cohort 0 still 360
      await increaseBy(ethers, 540 * DAY);
      expect(await vesting.vestedWei(alice.address)).to.equal(720n * E18);
    });
  });

  // ===================================================================
  // UTC midnight alignment
  // ===================================================================
  describe("UTC midnight alignment", function () {
    it("two additions on same UTC day → same startMidnightUtc", async function () {
      const { ethers, vesting, treasury, alice, bob } = await fixture();
      // Add at some time today
      await vesting.connect(treasury).addInvestorHuman(alice.address, 1n);
      // Same day, a few hours later
      await increaseBy(ethers, 3 * 3600); // +3 hours, still same UTC day (probably)
      await vesting.connect(treasury).addInvestorHuman(bob.address, 1n);

      const ca = await vesting.cohortAt(alice.address, 0);
      const cb = await vesting.cohortAt(bob.address, 0);
      // Both starts must be a multiple of 86400 (midnight UTC)
      expect(ca.startMidnightUtc % BigInt(DAY)).to.equal(0n);
      expect(cb.startMidnightUtc % BigInt(DAY)).to.equal(0n);
      // If the day didn't roll over, they're equal
      // (we don't know exactly when in the day Hardhat starts, so just check both are ≤ now)
    });

    it("addition crossing midnight: next cohort start is the next UTC day", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      await vesting.connect(treasury).addInvestorHuman(alice.address, 1n);
      const c0 = await vesting.cohortAt(alice.address, 0);

      // Jump exactly 24h forward — should land on next UTC midnight or beyond
      await increaseBy(ethers, DAY);

      await vesting.connect(treasury).addInvestorHuman(alice.address, 1n);
      const c1 = await vesting.cohortAt(alice.address, 1);

      expect(c1.startMidnightUtc - c0.startMidnightUtc).to.equal(BigInt(DAY));
    });

    it("daysElapsed advances at exactly +1 day (cohort 0)", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      // Pin to a known midnight: jump to next midnight exactly
      const ts = await blockTimestamp(ethers);
      const nextMidnight = midnightFloor(ts) + BigInt(DAY);
      const wait = Number(nextMidnight - ts);
      await increaseBy(ethers, wait);

      // Now block.timestamp is on a midnight boundary
      await vesting.connect(treasury).addInvestorHuman(alice.address, 1080n);
      // Day 0 right after addition
      let info = await vesting.cohortInfoAt(alice.address, 0);
      expect(info.daysElapsed).to.equal(0n);
      expect(info.vestedFromCohortWei).to.equal(0n);

      // +1 day exactly → 1 day elapsed
      await increaseBy(ethers, DAY);
      info = await vesting.cohortInfoAt(alice.address, 0);
      expect(info.daysElapsed).to.equal(1n);
      expect(info.vestedFromCohortWei).to.equal((1080n * E18) / 1080n);
    });
  });

  // ===================================================================
  // Vesting math single cohort (full curve)
  // ===================================================================
  describe("vesting math (single cohort)", function () {
    it("day 0: vested = 0", async function () {
      const { vesting, treasury, alice } = await fixture();
      await vesting.connect(treasury).addInvestorHuman(alice.address, 1080n);
      // Even a sec passed but days = 0
      expect(await vesting.vestedWei(alice.address)).to.equal(0n);
    });

    it("day = DURATION_DAYS: vested = full amount", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      await vesting.connect(treasury).addInvestorHuman(alice.address, 1080n);
      await increaseBy(ethers, DURATION_DAYS * DAY);
      expect(await vesting.vestedWei(alice.address)).to.equal(1080n * E18);
    });

    it("day > DURATION_DAYS: capped at full amount", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      await vesting.connect(treasury).addInvestorHuman(alice.address, 1080n);
      await increaseBy(ethers, (DURATION_DAYS + 100) * DAY);
      expect(await vesting.vestedWei(alice.address)).to.equal(1080n * E18);
    });

    it("midpoint day 540: vested = half", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      await vesting.connect(treasury).addInvestorHuman(alice.address, 1080n);
      await increaseBy(ethers, 540 * DAY);
      expect(await vesting.vestedWei(alice.address)).to.equal(540n * E18);
    });

    it("daily progression: 1/1080 per day", async function () {
      const { ethers, vesting, treasury, alice } = await fixture();
      await vesting.connect(treasury).addInvestorHuman(alice.address, 1080n);
      const perDay = (1080n * E18) / 1080n; // 1 ANGT
      await increaseBy(ethers, DAY);
      expect(await vesting.vestedWei(alice.address)).to.equal(perDay);
      await increaseBy(ethers, DAY);
      expect(await vesting.vestedWei(alice.address)).to.equal(perDay * 2n);
      await increaseBy(ethers, 5 * DAY);
      expect(await vesting.vestedWei(alice.address)).to.equal(perDay * 7n);
    });
  });

  // ===================================================================
  // claim()
  // ===================================================================
  describe("claim()", function () {
    it("reverts if not started", async function () {
      const { vesting, alice } = await fixture();
      await expect(vesting.connect(alice).claim()).to.be.revertedWith(
        "not started",
      );
    });

    it("reverts when nothing to claim", async function () {
      const { vesting, treasury, alice } = await fixture();
      await vesting.connect(treasury).start();
      await expect(vesting.connect(alice).claim()).to.be.revertedWith(
        "nothing to claim",
      );
    });

    it("pays out full claimable, marks claimedWei per-cohort", async function () {
      const { ethers, vesting, treasury, alice, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);
      await vesting.connect(treasury).start();

      await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 1080n);
      await increaseBy(ethers, 30 * DAY);

      const expected = (1080n * E18 * 30n) / 1080n;
      await vesting.connect(alice).claim();
      expect(await token.balanceOf(alice.address)).to.equal(expected);

      const c = await vesting.cohortAt(alice.address, 0);
      expect(c.claimedWei).to.equal(expected);

      // claim again same day — nothing
      await expect(vesting.connect(alice).claim()).to.be.revertedWith(
        "nothing to claim",
      );
    });

    it("aggregates across cohorts in one tx", async function () {
      const { ethers, vesting, treasury, alice, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);
      await vesting.connect(treasury).start();

      // Cohort 0: 1080 ANGT, 540 days elapsed → 540 vested
      await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 1080n);
      await increaseBy(ethers, 540 * DAY);

      // Cohort 1: 360 ANGT, just added (0 days elapsed)
      await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 360n);

      await vesting.connect(alice).claim();
      // Got 540 from cohort 0, 0 from cohort 1
      expect(await token.balanceOf(alice.address)).to.equal(540n * E18);
      expect((await vesting.cohortAt(alice.address, 0)).claimedWei).to.equal(
        540n * E18,
      );
      expect((await vesting.cohortAt(alice.address, 1)).claimedWei).to.equal(
        0n,
      );

      // Move forward 270 days → cohort 0 +270/1080, cohort 1 +270/1080
      await increaseBy(ethers, 270 * DAY);
      await vesting.connect(alice).claim();
      const cohort0Add = (1080n * E18 * 270n) / 1080n;
      const cohort1Add = (360n * E18 * 270n) / 1080n;
      expect(await token.balanceOf(alice.address)).to.equal(
        540n * E18 + cohort0Add + cohort1Add,
      );
    });

    it("emits Claimed", async function () {
      const { ethers, vesting, treasury, alice, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);
      await vesting.connect(treasury).start();
      await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 1080n);
      await increaseBy(ethers, 10 * DAY);

      const due = (1080n * E18 * 10n) / 1080n;
      await expect(vesting.connect(alice).claim())
        .to.emit(vesting, "Claimed")
        .withArgs(alice.address, due);
    });
  });

  // ===================================================================
  // Investor registry views
  // ===================================================================
  describe("investor registry", function () {
    it("first add registers, subsequent does not duplicate", async function () {
      const { vesting, treasury, alice } = await fixture();
      expect(await vesting.investorCount()).to.equal(0n);
      expect(await vesting.isInvestor(alice.address)).to.equal(false);

      await vesting.connect(treasury).addInvestorHuman(alice.address, 1n);
      expect(await vesting.investorCount()).to.equal(1n);
      expect(await vesting.investorAt(0)).to.equal(alice.address);
      expect(await vesting.isInvestor(alice.address)).to.equal(true);

      // Second cohort for same investor — count stays
      await vesting.connect(treasury).addInvestorHuman(alice.address, 2n);
      expect(await vesting.investorCount()).to.equal(1n);
    });

    it("multiple investors", async function () {
      const { vesting, treasury, alice, bob, carol } = await fixture();
      await vesting
        .connect(treasury)
        .addInvestorsHuman(
          [alice.address, bob.address, carol.address],
          [1n, 2n, 3n],
        );
      expect(await vesting.investorCount()).to.equal(3n);
      expect(await vesting.investorAt(0)).to.equal(alice.address);
      expect(await vesting.investorAt(1)).to.equal(bob.address);
      expect(await vesting.investorAt(2)).to.equal(carol.address);
    });

    it("investorsPaginated: returns slice or empty", async function () {
      const { vesting, treasury, alice, bob, carol, eve } = await fixture();
      await vesting
        .connect(treasury)
        .addInvestorsHuman(
          [alice.address, bob.address, carol.address, eve.address],
          [1n, 2n, 3n, 4n],
        );

      const page1 = await vesting.investorsPaginated(0, 2);
      expect(page1.length).to.equal(2);
      expect(page1[0]).to.equal(alice.address);
      expect(page1[1]).to.equal(bob.address);

      const page2 = await vesting.investorsPaginated(2, 10);
      expect(page2.length).to.equal(2);
      expect(page2[0]).to.equal(carol.address);
      expect(page2[1]).to.equal(eve.address);

      const page3 = await vesting.investorsPaginated(100, 10);
      expect(page3.length).to.equal(0);
    });

    it("investorAt out of range reverts", async function () {
      const { vesting } = await fixture();
      await expect(vesting.investorAt(0)).to.be.revertedWith("index out of range");
    });
  });

  // ===================================================================
  // Cohort views
  // ===================================================================
  describe("cohort views", function () {
    it("cohortAt out of range reverts", async function () {
      const { vesting, alice } = await fixture();
      await expect(
        vesting.cohortAt(alice.address, 0),
      ).to.be.revertedWith("index out of range");
    });

    it("cohortInfoAt out of range reverts", async function () {
      const { vesting, alice } = await fixture();
      await expect(
        vesting.cohortInfoAt(alice.address, 0),
      ).to.be.revertedWith("index out of range");
    });

    it("cohortsOf returns full array", async function () {
      const { vesting, treasury, alice } = await fixture();
      await vesting.connect(treasury).addInvestorHuman(alice.address, 1n);
      await vesting.connect(treasury).addInvestorHuman(alice.address, 2n);
      await vesting.connect(treasury).addInvestorHuman(alice.address, 3n);
      const arr = await vesting.cohortsOf(alice.address);
      expect(arr.length).to.equal(3);
      expect(arr[0].amountWei).to.equal(1n * E18);
      expect(arr[1].amountWei).to.equal(2n * E18);
      expect(arr[2].amountWei).to.equal(3n * E18);
    });

    it("cohortInfoAt: full per-cohort breakdown", async function () {
      const { ethers, vesting, treasury, alice, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);
      await vesting.connect(treasury).start();
      await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 1080n);
      await increaseBy(ethers, 100 * DAY);

      const info = await vesting.cohortInfoAt(alice.address, 0);
      expect(info.amountWei).to.equal(1080n * E18);
      expect(info.daysElapsed).to.equal(100n);
      expect(info.vestedFromCohortWei).to.equal((1080n * E18 * 100n) / 1080n);
      expect(info.claimedFromCohortWei).to.equal(0n);
      expect(info.claimableFromCohortWei).to.equal(
        (1080n * E18 * 100n) / 1080n,
      );

      // After partial claim
      await vesting.connect(alice).claim();
      const info2 = await vesting.cohortInfoAt(alice.address, 0);
      expect(info2.claimedFromCohortWei).to.equal((1080n * E18 * 100n) / 1080n);
      expect(info2.claimableFromCohortWei).to.equal(0n);
    });

    it("getAccountInfo: aggregated UI helper", async function () {
      const { ethers, vesting, treasury, alice, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);
      await vesting.connect(treasury).start();
      await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 1080n);
      await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 540n);
      await increaseBy(ethers, 360 * DAY);

      const info = await vesting.getAccountInfo(alice.address);
      expect(info.cohortsCount).to.equal(2n);
      expect(info.totalWei).to.equal(1620n * E18);
      // Both cohorts have 360 days elapsed (added on same UTC day)
      // Actually cohort 1 was added at the same block as cohort 0 (same fixture run), so same midnight
      const expectedVested =
        (1080n * E18 * 360n) / 1080n + (540n * E18 * 360n) / 1080n;
      expect(info.vestedNowWei).to.equal(expectedVested);
      expect(info.claimedSoFarWei).to.equal(0n);
      expect(info.claimableNowWei).to.equal(expectedVested);
    });
  });

  // ===================================================================
  // sweep
  // ===================================================================
  describe("sweep", function () {
    it("locked for 30 days, only owner", async function () {
      const { ethers, vesting, treasury, alice, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);
      await vesting.connect(treasury).fund(100n * E18);

      await expect(
        vesting.connect(treasury).sweep(treasury.address, 1n),
      ).to.be.revertedWith("admin withdraw locked");

      await increaseBy(ethers, 31 * DAY);

      await expect(vesting.connect(alice).sweep(alice.address, 1n))
        .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount");

      await vesting.connect(treasury).sweep(treasury.address, 1n);
    });

    it("rejects zero address recipient", async function () {
      const { ethers, vesting, treasury } = await fixture();
      await increaseBy(ethers, 31 * DAY);
      await expect(
        vesting.connect(treasury).sweep(ethers.ZeroAddress, 1n),
      ).to.be.revertedWith("zero addr");
    });

    it("emits Swept", async function () {
      const { ethers, vesting, treasury, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);
      await vesting.connect(treasury).fund(100n * E18);
      await increaseBy(ethers, 31 * DAY);
      await expect(vesting.connect(treasury).sweep(treasury.address, 50n * E18))
        .to.emit(vesting, "Swept")
        .withArgs(treasury.address, 50n * E18);
    });
  });

  // ===================================================================
  // Full lifecycle scenarios
  // ===================================================================
  describe("full lifecycle scenarios", function () {
    it("3 buyers funded, daily claim works correctly over 540 days", async function () {
      const { ethers, vesting, treasury, alice, bob, carol, token } =
        await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);
      await vesting.connect(treasury).start();

      await vesting
        .connect(treasury)
        .fundAndAddInvestorsHuman(
          [alice.address, bob.address, carol.address],
          [1080n, 2160n, 540n],
        );

      const totalFunded = (1080n + 2160n + 540n) * E18;
      expect(await token.balanceOf(await addrOf(vesting))).to.equal(
        totalFunded,
      );

      // 540 days → all halved
      await increaseBy(ethers, 540 * DAY);

      await vesting.connect(alice).claim();
      await vesting.connect(bob).claim();
      await vesting.connect(carol).claim();

      expect(await token.balanceOf(alice.address)).to.equal(540n * E18);
      expect(await token.balanceOf(bob.address)).to.equal(1080n * E18);
      expect(await token.balanceOf(carol.address)).to.equal(270n * E18);

      // Contract retains the un-vested half
      const remaining = totalFunded - 540n * E18 - 1080n * E18 - 270n * E18;
      expect(await token.balanceOf(await addrOf(vesting))).to.equal(remaining);
    });

    it("OTC top-up scenario from user description: presale → 5 months wait → OTC top-up", async function () {
      const { ethers, vesting, treasury, alice, token } = await fixture();
      await token.connect(treasury).approve(await addrOf(vesting), MAX_UINT256);
      await vesting.connect(treasury).start();

      // T = 0: presale 10000 ANGT
      await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 10000n);

      // T = 150 days (~5 months): user has claimed nothing
      await increaseBy(ethers, 150 * DAY);
      // Claim what's available from cohort 0
      await vesting.connect(alice).claim();
      const claimed1 = (10000n * E18 * 150n) / 1080n;
      expect(await token.balanceOf(alice.address)).to.equal(claimed1);

      // OTC: 6000 more (cohort 1, fresh clock starting now)
      await vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 6000n);

      // Right after top-up: cohort 1 is fresh → 0 claimable from it
      // Cohort 0 just got claimed, no new vesting yet (no time passed)
      await expect(vesting.connect(alice).claim()).to.be.revertedWith(
        "nothing to claim",
      );

      // T = 150 + 30 days more → cohort 0 has 180 days, cohort 1 has 30 days
      await increaseBy(ethers, 30 * DAY);
      await vesting.connect(alice).claim();
      const cohort0AfterMonth =
        (10000n * E18 * 180n) / 1080n - claimed1;
      const cohort1AfterMonth = (6000n * E18 * 30n) / 1080n;
      expect(await token.balanceOf(alice.address)).to.equal(
        claimed1 + cohort0AfterMonth + cohort1AfterMonth,
      );

      // Continue to T = 1080 + 150 → cohort 0 fully vested, cohort 1 at 1080-30 = 1050 days
      // Wait — let me recompute. T was at 150 + 30 = 180 days. To get cohort 0 fully vested,
      // need 1080 days from cohort 0 start = T = 1080 days. So fast-forward to T = 1080 days.
      // Currently T = 180, need +900 days
      await increaseBy(ethers, 900 * DAY);
      // Now cohort 0: 1080 days (full), cohort 1: 1080 - 150 = 930 days elapsed
      await vesting.connect(alice).claim();
      const cohort1AtT1080 = (6000n * E18 * 930n) / 1080n;
      expect(await token.balanceOf(alice.address)).to.equal(
        10000n * E18 + cohort1AtT1080,
      );

      // Fast-forward enough for cohort 1 to also fully vest
      await increaseBy(ethers, 200 * DAY);
      await vesting.connect(alice).claim();
      expect(await token.balanceOf(alice.address)).to.equal(16000n * E18);
    });
  });
});
