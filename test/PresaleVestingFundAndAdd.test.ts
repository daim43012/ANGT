/**
 * Tests for the new fundAndAddInvestor* functions on Vesting.
 *
 * These atomically (1) pull tokens from the owner via transferFrom (requires
 * a prior ERC20 approve from the owner to this contract) and (2) credit the
 * investor's adminAllocationWei via the same path as addInvestor*.
 *
 * Coverage:
 *   - happy path: 4 variants (Wei/Human, single/batch)
 *   - balance accounting: owner -, contract +, allocation +
 *   - vesting clock: starts on first, NOT reset on top-ups
 *   - access control: only owner
 *   - input validation: zero addr, zero amount, length mismatch
 *   - approve preconditions: missing/insufficient allowance reverts (atomically)
 *   - integration: claim works on funded allocation
 *   - integration: mixed flows (addInvestor + fundAndAdd) coexist correctly
 *   - events: Funded + InvestorAdded
 */
import { expect } from "chai";
import { network } from "hardhat";

const E18 = 10n ** 18n;
const MONTH = 30 * 24 * 60 * 60;
const MAX_UINT256 =
  115792089237316195423570985008687907853269984665640564039457584007913129639935n;

async function addrOf(c: any): Promise<string> {
  return c?.target ?? (await c.getAddress());
}

async function increaseBy(ethers: any, seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("Vesting — fundAndAddInvestor*", function () {
  /**
   * In this fixture treasury is BOTH the owner of the vesting contract AND
   * the token holder funding it. Vesting is deployed empty; no presale-fill
   * happens here. Each test sets up its own approve → fundAndAdd flow.
   */
  async function fixture() {
    const { ethers } = await network.connect();
    const [deployer, treasury, alice, bob, carol, eve] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("FlyANGT", deployer);
    const token: any = await Token.deploy(treasury.address);

    const Vesting = await ethers.getContractFactory(
      "Vesting",
      deployer,
    );
    const vesting: any = await Vesting.deploy(
      await addrOf(token),
      ethers.ZeroHash,
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
  // Happy path
  // ===================================================================

  it("fundAndAddInvestorHuman: pulls tokens AND records allocation atomically", async function () {
    const { ethers, treasury, alice, token, vesting } = await fixture();

    // approve the vesting contract once
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    const treasuryBefore = await token.balanceOf(treasury.address);
    const vestingBefore = await token.balanceOf(await addrOf(vesting));

    const tx = await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 1_000_000n);

    // token movement
    expect(await token.balanceOf(treasury.address)).to.equal(
      treasuryBefore - 1_000_000n * E18,
    );
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(
      vestingBefore + 1_000_000n * E18,
    );

    // allocation recorded
    expect(await vesting.adminAllocationWei(alice.address)).to.equal(
      1_000_000n * E18,
    );

    // clock started at block timestamp
    const blk = await ethers.provider.getBlock(tx.blockNumber!);
    expect(await vesting.vestingStartOf(alice.address)).to.equal(
      BigInt(blk!.timestamp),
    );
  });

  it("fundAndAddInvestorWei: same but uses raw wei", async function () {
    const { treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    // Fractional amount that human-form can't express
    const w = 12_345_678_901_234_567_890n;
    await vesting.connect(treasury).fundAndAddInvestorWei(alice.address, w);

    expect(await vesting.adminAllocationWei(alice.address)).to.equal(w);
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(w);
  });

  it("fundAndAddInvestorsHuman: batch of 3 atomically", async function () {
    const { treasury, alice, bob, carol, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await vesting
      .connect(treasury)
      .fundAndAddInvestorsHuman(
        [alice.address, bob.address, carol.address],
        [1000n, 2000n, 3000n],
      );

    expect(await vesting.adminAllocationWei(alice.address)).to.equal(
      1000n * E18,
    );
    expect(await vesting.adminAllocationWei(bob.address)).to.equal(2000n * E18);
    expect(await vesting.adminAllocationWei(carol.address)).to.equal(
      3000n * E18,
    );
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(
      6000n * E18,
    );
  });

  it("fundAndAddInvestorsWei: batch with raw wei amounts", async function () {
    const { treasury, alice, bob, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await vesting
      .connect(treasury)
      .fundAndAddInvestorsWei(
        [alice.address, bob.address],
        [1n, 2n],
      );

    expect(await vesting.adminAllocationWei(alice.address)).to.equal(1n);
    expect(await vesting.adminAllocationWei(bob.address)).to.equal(2n);
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(3n);
  });

  // ===================================================================
  // Per-user vesting clock semantics
  // ===================================================================

  it("first call starts clock; subsequent calls do NOT reset", async function () {
    const { ethers, treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 100n);
    const start1 = await vesting.vestingStartOf(alice.address);

    await increaseBy(ethers, 5 * MONTH);

    await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 200n);
    const start2 = await vesting.vestingStartOf(alice.address);

    expect(start2).to.equal(start1);
    expect(await vesting.adminAllocationWei(alice.address)).to.equal(
      300n * E18,
    );
  });

  it("OTC top-up after 5 months immediately gives 5/36 of the new allocation", async function () {
    const { ethers, treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    // open contract for claims
    await vesting
      .connect(treasury)
      .setMerkleRoot(
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      );
    await vesting.connect(treasury).start();

    // initial 360 ANGT — clock starts now
    await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 360n);

    await increaseBy(ethers, 5 * MONTH);

    // first claim: 5/36 of 360 = 50
    await vesting.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(
      ((360n * E18) / 36n) * 5n,
    );

    // top-up 360 more — total 720; 5 months elapsed on same clock
    await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 360n);

    // claimable now: (720 * 5/36) - already_claimed_50 = 100 - 50 = 50
    const claimable = await vesting.claimableWei(alice.address);
    expect(claimable).to.equal(((720n * E18) / 36n) * 5n - ((360n * E18) / 36n) * 5n);

    await vesting.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(
      ((720n * E18) / 36n) * 5n,
    );
  });

  // ===================================================================
  // Mixed flow with regular addInvestor
  // ===================================================================

  it("addInvestor first, then fundAndAdd top-up — clock from addInvestor preserved", async function () {
    const { ethers, treasury, alice, token, vesting } = await fixture();

    // Admin adds without funding (just bookkeeping) — starts clock
    await vesting
      .connect(treasury)
      .addInvestorHuman(alice.address, 100n);
    const start1 = await vesting.vestingStartOf(alice.address);

    await increaseBy(ethers, 3 * MONTH);

    // Then later, OTC sale: fundAndAdd 200 more
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);
    await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 200n);

    expect(await vesting.vestingStartOf(alice.address)).to.equal(start1);
    expect(await vesting.adminAllocationWei(alice.address)).to.equal(
      300n * E18,
    );
    // contract holds only the funded part
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(200n * E18);
  });

  it("fundAndAdd first, then addInvestor adds bookkeeping w/o moving tokens", async function () {
    const { treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 500n);
    const balAfterFund = await token.balanceOf(await addrOf(vesting));
    expect(balAfterFund).to.equal(500n * E18);

    // addInvestor doesn't move tokens, only bumps the bookkeeping
    await vesting
      .connect(treasury)
      .addInvestorHuman(alice.address, 100n);

    expect(await vesting.adminAllocationWei(alice.address)).to.equal(
      600n * E18,
    );
    // contract balance unchanged
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(
      500n * E18,
    );
  });

  // ===================================================================
  // Access control
  // ===================================================================

  it("only owner can call fundAndAddInvestorHuman", async function () {
    const { vesting, alice, carol } = await fixture();
    await expect(
      vesting.connect(alice).fundAndAddInvestorHuman(carol.address, 1n),
    )
      .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
  });

  it("only owner can call fundAndAddInvestorWei", async function () {
    const { vesting, alice, carol } = await fixture();
    await expect(
      vesting.connect(alice).fundAndAddInvestorWei(carol.address, 1n),
    )
      .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
  });

  it("only owner can call fundAndAddInvestorsHuman batch", async function () {
    const { vesting, alice, carol } = await fixture();
    await expect(
      vesting
        .connect(alice)
        .fundAndAddInvestorsHuman([carol.address], [1n]),
    )
      .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
  });

  it("only owner can call fundAndAddInvestorsWei batch", async function () {
    const { vesting, alice, carol } = await fixture();
    await expect(
      vesting.connect(alice).fundAndAddInvestorsWei([carol.address], [1n]),
    )
      .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
  });

  // ===================================================================
  // Input validation
  // ===================================================================

  it("rejects zero address", async function () {
    const { ethers, treasury, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await expect(
      vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(ethers.ZeroAddress, 1n),
    ).to.be.revertedWith("zero addr");
  });

  it("rejects zero amount (Human)", async function () {
    const { treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await expect(
      vesting.connect(treasury).fundAndAddInvestorHuman(alice.address, 0n),
    ).to.be.revertedWith("zero amount");
  });

  it("rejects zero amount (Wei)", async function () {
    const { treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await expect(
      vesting.connect(treasury).fundAndAddInvestorWei(alice.address, 0n),
    ).to.be.revertedWith("zero amount");
  });

  it("batch length mismatch reverts (Human)", async function () {
    const { treasury, alice, bob, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await expect(
      vesting
        .connect(treasury)
        .fundAndAddInvestorsHuman(
          [alice.address, bob.address],
          [1n], // shorter
        ),
    ).to.be.revertedWith("len mismatch");
  });

  it("batch length mismatch reverts (Wei)", async function () {
    const { treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await expect(
      vesting
        .connect(treasury)
        .fundAndAddInvestorsWei([alice.address], [1n, 2n]),
    ).to.be.revertedWith("len mismatch");
  });

  // ===================================================================
  // Approve / allowance preconditions
  // ===================================================================

  it("reverts atomically when no approve given (no allocation written)", async function () {
    const { treasury, alice, token, vesting } = await fixture();
    // NO approve

    await expect(
      vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 100n),
    ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");

    // bookkeeping must NOT have been touched
    expect(await vesting.adminAllocationWei(alice.address)).to.equal(0n);
    expect(await vesting.vestingStartOf(alice.address)).to.equal(0n);
  });

  it("reverts atomically with insufficient allowance (no partial write)", async function () {
    const { treasury, alice, token, vesting } = await fixture();
    // approve 50 only, request 100
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), 50n * E18);

    await expect(
      vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 100n),
    ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");

    expect(await vesting.adminAllocationWei(alice.address)).to.equal(0n);
  });

  it("batch is atomic — failure on item N rolls back items 1..N-1", async function () {
    const { treasury, alice, bob, carol, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    // 3rd entry has zero amount → triggers zero-amount revert in inner call
    await expect(
      vesting
        .connect(treasury)
        .fundAndAddInvestorsHuman(
          [alice.address, bob.address, carol.address],
          [100n, 200n, 0n],
        ),
    ).to.be.revertedWith("zero amount");

    // No state should have been written for any of them
    expect(await vesting.adminAllocationWei(alice.address)).to.equal(0n);
    expect(await vesting.adminAllocationWei(bob.address)).to.equal(0n);
    expect(await vesting.adminAllocationWei(carol.address)).to.equal(0n);
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(0n);
  });

  // ===================================================================
  // Events
  // ===================================================================

  it("emits Funded(treasury, amountWei) and InvestorAdded(account, amountWei, start)", async function () {
    const { ethers, treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    const tx = await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 100n);
    const blk = await ethers.provider.getBlock(tx.blockNumber!);
    const start = BigInt(blk!.timestamp);

    await expect(tx)
      .to.emit(vesting, "Funded")
      .withArgs(treasury.address, 100n * E18);
    await expect(tx)
      .to.emit(vesting, "InvestorAdded")
      .withArgs(alice.address, 100n * E18, start);
  });

  // ===================================================================
  // Full integration: fundAndAdd → wait → claim
  // ===================================================================

  it("full lifecycle: fundAndAdd → 12 months → claim 1/3", async function () {
    const { ethers, treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await vesting
      .connect(treasury)
      .setMerkleRoot(
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      );
    await vesting.connect(treasury).start();

    await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 360n);

    await increaseBy(ethers, 12 * MONTH);

    await vesting.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(
      ((360n * E18) / 36n) * 12n,
    );
    // contract balance is now total - claimed
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(
      360n * E18 - ((360n * E18) / 36n) * 12n,
    );
  });

  it("full lifecycle: fundAndAdd → 36+ months → claim 100%", async function () {
    const { ethers, treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await vesting
      .connect(treasury)
      .setMerkleRoot(
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      );
    await vesting.connect(treasury).start();

    await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 360n);

    await increaseBy(ethers, 40 * MONTH);

    await vesting.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(360n * E18);
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(0n);
    // claimedWei equals total
    expect(await vesting.claimedWei(alice.address)).to.equal(360n * E18);
  });

  it("full lifecycle: 3 buyers, 18 months, partial claims, totals reconcile", async function () {
    const { ethers, treasury, alice, bob, carol, token, vesting } =
      await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await vesting
      .connect(treasury)
      .setMerkleRoot(
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      );
    await vesting.connect(treasury).start();

    await vesting
      .connect(treasury)
      .fundAndAddInvestorsHuman(
        [alice.address, bob.address, carol.address],
        [3600n, 7200n, 1800n],
      );

    const totalAlloc = (3600n + 7200n + 1800n) * E18;
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(totalAlloc);

    await increaseBy(ethers, 18 * MONTH); // half vested

    await vesting.connect(alice).claim();
    await vesting.connect(bob).claim();
    await vesting.connect(carol).claim();

    expect(await token.balanceOf(alice.address)).to.equal(
      ((3600n * E18) / 36n) * 18n,
    );
    expect(await token.balanceOf(bob.address)).to.equal(
      ((7200n * E18) / 36n) * 18n,
    );
    expect(await token.balanceOf(carol.address)).to.equal(
      ((1800n * E18) / 36n) * 18n,
    );

    // contract retained the un-vested half
    const claimedSum =
      ((3600n + 7200n + 1800n) * E18 * 18n) / 36n;
    expect(await token.balanceOf(await addrOf(vesting))).to.equal(
      totalAlloc - claimedSum,
    );
  });

  // ===================================================================
  // approve workflow note: revoke → next fundAndAdd reverts
  // ===================================================================

  it("after revoke (approve(0)), next fundAndAdd reverts; previous allocation stays", async function () {
    const { treasury, alice, token, vesting } = await fixture();
    await token
      .connect(treasury)
      .approve(await addrOf(vesting), MAX_UINT256);

    await vesting
      .connect(treasury)
      .fundAndAddInvestorHuman(alice.address, 100n);
    expect(await vesting.adminAllocationWei(alice.address)).to.equal(
      100n * E18,
    );

    // revoke
    await token.connect(treasury).approve(await addrOf(vesting), 0n);

    await expect(
      vesting
        .connect(treasury)
        .fundAndAddInvestorHuman(alice.address, 50n),
    ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");

    // earlier allocation untouched
    expect(await vesting.adminAllocationWei(alice.address)).to.equal(
      100n * E18,
    );
  });
});
