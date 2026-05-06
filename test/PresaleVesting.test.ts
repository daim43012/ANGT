import { expect } from "chai";
import { network } from "hardhat";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import { ethers as ethersStatic } from "ethers";

const E18 = 10n ** 18n;
const MONTH = 30 * 24 * 60 * 60;

type Claim = { address: string; amountWei: bigint };

function leafOf(addr: string, amountWei: bigint): Buffer {
  const hash = ethersStatic.solidityPackedKeccak256(
    ["address", "uint256"],
    [addr, amountWei],
  );
  return Buffer.from(hash.slice(2), "hex");
}

function buildTree(claims: Claim[]) {
  const leaves = claims.map((c) => leafOf(c.address, c.amountWei));
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  return { tree, root: tree.getHexRoot() };
}

function proofOf(tree: MerkleTree, addr: string, amountWei: bigint) {
  return tree.getHexProof(leafOf(addr, amountWei));
}

async function addrOf(c: any): Promise<string> {
  return c?.target ?? (await c.getAddress());
}

async function increaseBy(ethers: any, seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("PresaleVestingMerkle", function () {
  async function fixture() {
    const { ethers } = await network.connect();
    const [deployer, treasury, alice, bob, carol, eve] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("FlyANGT", deployer);
    const token: any = await Token.deploy(treasury.address);

    // Presale buyers (in claims tree)
    const claims: Claim[] = [
      { address: alice.address, amountWei: 1000n * E18 },
      { address: bob.address,   amountWei: 5000n * E18 },
    ];
    const { tree, root } = buildTree(claims);

    const Vesting = await ethers.getContractFactory(
      "PresaleVestingMerkle",
      deployer,
    );
    const vesting: any = await Vesting.deploy(
      await addrOf(token),
      ethers.ZeroHash,
      treasury.address, // owner
    );

    // Pre-fund with reasonable buffer
    await token
      .connect(treasury)
      .transfer(await addrOf(vesting), 1_000_000n * E18);

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
      tree,
      root,
      claims,
    };
  }

  // ---------------- constructor / admin ----------------
  it("constructor: token, root=0, owner=treasury, deployedAt set", async function () {
    const { vesting, treasury, token } = await fixture();
    expect(await vesting.token()).to.equal(await addrOf(token));
    expect(await vesting.owner()).to.equal(treasury.address);
    expect(await vesting.merkleRoot()).to.equal(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(await vesting.started()).to.equal(false);
    expect(Number(await vesting.deployedAt())).to.be.gt(0);
  });

  it("constants: 36 months × 30 days, 30-day sweep delay", async function () {
    const { vesting } = await fixture();
    expect(await vesting.DURATION_MONTHS()).to.equal(36n);
    expect(await vesting.MONTH()).to.equal(BigInt(MONTH));
    expect(await vesting.DURATION()).to.equal(BigInt(MONTH) * 36n);
    expect(await vesting.ADMIN_WITHDRAW_DELAY()).to.equal(BigInt(30 * 24 * 60 * 60));
  });

  it("setMerkleRoot: only owner, before start; cannot after start", async function () {
    const { vesting, treasury, alice, root } = await fixture();
    await expect(vesting.connect(alice).setMerkleRoot(root))
      .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
    await vesting.connect(treasury).setMerkleRoot(root);
    expect(await vesting.merkleRoot()).to.equal(root);

    await vesting.connect(treasury).start();
    await expect(
      vesting.connect(treasury).setMerkleRoot(root),
    ).to.be.revertedWith("root frozen");
  });

  it("start: requires root, only owner, idempotent", async function () {
    const { vesting, treasury, alice, root } = await fixture();
    await expect(vesting.connect(treasury).start()).to.be.revertedWith(
      "root not set",
    );
    await vesting.connect(treasury).setMerkleRoot(root);
    await expect(vesting.connect(alice).start())
      .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
    await vesting.connect(treasury).start();
    // second call no-op
    await vesting.connect(treasury).start();
    expect(await vesting.started()).to.equal(true);
  });

  // ---------------- merkle activation ----------------
  it("activateMerkle: claims allocation, starts per-user clock", async function () {
    const { ethers, vesting, treasury, alice, tree, root } = await fixture();
    await vesting.connect(treasury).setMerkleRoot(root);
    await vesting.connect(treasury).start();

    const proof = proofOf(tree, alice.address, 1000n * E18);
    const tx = await vesting.connect(alice).activateMerkle(1000n * E18, proof);
    const blk = await ethers.provider.getBlock(tx.blockNumber!);

    expect(await vesting.merkleActivated(alice.address)).to.equal(true);
    expect(await vesting.merkleAllocationWei(alice.address)).to.equal(
      1000n * E18,
    );
    expect(await vesting.vestingStartOf(alice.address)).to.equal(
      BigInt(blk!.timestamp),
    );
  });

  it("activateMerkle: cannot activate twice", async function () {
    const { vesting, treasury, alice, tree, root } = await fixture();
    await vesting.connect(treasury).setMerkleRoot(root);
    await vesting.connect(treasury).start();
    const proof = proofOf(tree, alice.address, 1000n * E18);
    await vesting.connect(alice).activateMerkle(1000n * E18, proof);
    await expect(
      vesting.connect(alice).activateMerkle(1000n * E18, proof),
    ).to.be.revertedWith("already activated");
  });

  it("activateMerkle: invalid proof / wrong amount reverts", async function () {
    const { vesting, treasury, eve, tree, root } = await fixture();
    await vesting.connect(treasury).setMerkleRoot(root);
    await vesting.connect(treasury).start();
    const proof = proofOf(tree, eve.address, 1000n * E18);
    await expect(
      vesting.connect(eve).activateMerkle(1000n * E18, proof),
    ).to.be.revertedWith("invalid proof");
  });

  it("activateMerkle: reverts if not started", async function () {
    const { vesting, treasury, alice, tree, root } = await fixture();
    await vesting.connect(treasury).setMerkleRoot(root);
    const proof = proofOf(tree, alice.address, 1000n * E18);
    await expect(
      vesting.connect(alice).activateMerkle(1000n * E18, proof),
    ).to.be.revertedWith("not started");
  });

  // ---------------- admin add ----------------
  it("addInvestorHuman: writes wei, starts clock for new user", async function () {
    const { ethers, vesting, treasury, carol } = await fixture();
    const tx = await vesting.connect(treasury).addInvestorHuman(carol.address, 2_500_000n);
    const blk = await ethers.provider.getBlock(tx.blockNumber!);

    expect(await vesting.adminAllocationWei(carol.address)).to.equal(
      2_500_000n * E18,
    );
    expect(await vesting.vestingStartOf(carol.address)).to.equal(
      BigInt(blk!.timestamp),
    );
  });

  it("addInvestorHuman: only owner", async function () {
    const { vesting, alice, carol } = await fixture();
    await expect(vesting.connect(alice).addInvestorHuman(carol.address, 100n))
      .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
  });

  it("addInvestorWei: precise wei version", async function () {
    const { vesting, treasury, carol } = await fixture();
    const w = 12_345_678_901_234_567_890n;
    await vesting.connect(treasury).addInvestorWei(carol.address, w);
    expect(await vesting.adminAllocationWei(carol.address)).to.equal(w);
  });

  it("addInvestor*: top-up does NOT reset clock", async function () {
    const { ethers, vesting, treasury, carol } = await fixture();
    await vesting.connect(treasury).addInvestorHuman(carol.address, 100n);
    const start1 = await vesting.vestingStartOf(carol.address);

    await increaseBy(ethers, 5 * MONTH);

    await vesting.connect(treasury).addInvestorHuman(carol.address, 200n);
    const start2 = await vesting.vestingStartOf(carol.address);

    expect(start2).to.equal(start1); // clock NOT reset
    expect(await vesting.adminAllocationWei(carol.address)).to.equal(
      300n * E18,
    );
  });

  it("addInvestorsHuman: batch", async function () {
    const { vesting, treasury, alice, bob } = await fixture();
    await vesting
      .connect(treasury)
      .addInvestorsHuman([alice.address, bob.address], [100n, 200n]);
    expect(await vesting.adminAllocationWei(alice.address)).to.equal(
      100n * E18,
    );
    expect(await vesting.adminAllocationWei(bob.address)).to.equal(200n * E18);
  });

  it("addInvestorsWei: batch", async function () {
    const { vesting, treasury, alice, bob } = await fixture();
    await vesting
      .connect(treasury)
      .addInvestorsWei([alice.address, bob.address], [1n, 2n]);
    expect(await vesting.adminAllocationWei(alice.address)).to.equal(1n);
    expect(await vesting.adminAllocationWei(bob.address)).to.equal(2n);
  });

  it("addInvestor*: rejects zero address & zero amount", async function () {
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

  // ---------------- vesting math ----------------
  it("monthsElapsedOf: per-user clock", async function () {
    const { ethers, vesting, treasury, carol } = await fixture();
    await vesting.connect(treasury).addInvestorHuman(carol.address, 360n);

    expect(await vesting.monthsElapsedOf(carol.address)).to.equal(0n);
    await increaseBy(ethers, MONTH);
    expect(await vesting.monthsElapsedOf(carol.address)).to.equal(1n);
    await increaseBy(ethers, 5 * MONTH);
    expect(await vesting.monthsElapsedOf(carol.address)).to.equal(6n);
  });

  it("monthsElapsedOf: caps at 36", async function () {
    const { ethers, vesting, treasury, carol } = await fixture();
    await vesting.connect(treasury).addInvestorHuman(carol.address, 360n);
    await increaseBy(ethers, 50 * MONTH);
    expect(await vesting.monthsElapsedOf(carol.address)).to.equal(36n);
  });

  it("vestedWei: linear by 1/36 each month", async function () {
    const { ethers, vesting, treasury, carol } = await fixture();
    await vesting
      .connect(treasury)
      .addInvestorHuman(carol.address, 3600n); // 3600 ANGT total

    await increaseBy(ethers, MONTH);
    expect(await vesting.vestedWei(carol.address)).to.equal(
      (3600n * E18) / 36n,
    );

    await increaseBy(ethers, 17 * MONTH); // 18 months total → half
    expect(await vesting.vestedWei(carol.address)).to.equal(
      ((3600n * E18) / 36n) * 18n,
    );
  });

  it("claim: pays out claimable, advances claimed counter", async function () {
    const { ethers, vesting, treasury, carol, token } = await fixture();
    await vesting.connect(treasury).addInvestorHuman(carol.address, 3600n);

    await increaseBy(ethers, MONTH);
    await vesting.connect(carol).claim();

    expect(await token.balanceOf(carol.address)).to.equal((3600n * E18) / 36n);
    expect(await vesting.claimedWei(carol.address)).to.equal(
      (3600n * E18) / 36n,
    );

    // claim immediately again — nothing to claim
    await expect(vesting.connect(carol).claim()).to.be.revertedWith(
      "nothing to claim",
    );
  });

  it("claim: top-up after claim immediately makes vested portion claimable", async function () {
    const { ethers, vesting, treasury, carol, token } = await fixture();
    await vesting.connect(treasury).addInvestorHuman(carol.address, 360n); // 360 ANGT
    await increaseBy(ethers, MONTH * 6); // 6 months
    await vesting.connect(carol).claim();
    expect(await token.balanceOf(carol.address)).to.equal(
      ((360n * E18) / 36n) * 6n, // 60 ANGT
    );

    // admin adds 360 more — total now 720, vested fraction 6/36 = 120
    await vesting.connect(treasury).addInvestorHuman(carol.address, 360n);
    // claimable should be (720 * 6/36) - 60 = 120 - 60 = 60
    expect(await vesting.claimableWei(carol.address)).to.equal(
      ((720n * E18) / 36n) * 6n - ((360n * E18) / 36n) * 6n,
    );
    await vesting.connect(carol).claim();
    expect(await token.balanceOf(carol.address)).to.equal(
      ((720n * E18) / 36n) * 6n,
    );
  });

  it("activateAndClaim: pure activate now reverts atomically (nothing claimable yet)", async function () {
    const { vesting, treasury, alice, tree, root } = await fixture();
    await vesting.connect(treasury).setMerkleRoot(root);
    await vesting.connect(treasury).start();

    // Just activated — clock starts now, 0 months elapsed → nothing to claim → revert.
    // The activation rolls back together with the claim.
    const proof = proofOf(tree, alice.address, 1000n * E18);
    await expect(
      vesting.connect(alice).activateAndClaim(1000n * E18, proof),
    ).to.be.revertedWith("nothing to claim");

    expect(await vesting.merkleActivated(alice.address)).to.equal(false);
  });

  it("activateAndClaim: works when vestingStart was pre-set by admin (5 months elapsed)", async function () {
    const { ethers, vesting, treasury, alice, tree, root, token } =
      await fixture();
    await vesting.connect(treasury).setMerkleRoot(root);
    await vesting.connect(treasury).start();

    // Admin adds alice via addInvestor first → vestingStartOf set NOW
    await vesting.connect(treasury).addInvestorHuman(alice.address, 100n);

    // 5 months pass
    await increaseBy(ethers, 5 * MONTH);

    // Now alice activates her merkle (1000 ANGT) AND claims in one tx
    const proof = proofOf(tree, alice.address, 1000n * E18);
    await vesting.connect(alice).activateAndClaim(1000n * E18, proof);

    // Total = 100 (admin) + 1000 (merkle) = 1100; vested 5/36; she claims that
    const total = 1100n * E18;
    const expected = (total * 5n) / 36n;
    expect(await token.balanceOf(alice.address)).to.equal(expected);
  });

  it("separate activate + wait month + claim", async function () {
    const { ethers, vesting, treasury, alice, tree, root, token } =
      await fixture();
    await vesting.connect(treasury).setMerkleRoot(root);
    await vesting.connect(treasury).start();

    await vesting
      .connect(alice)
      .activateMerkle(1000n * E18, proofOf(tree, alice.address, 1000n * E18));
    await increaseBy(ethers, MONTH);
    await vesting.connect(alice).claim();

    expect(await token.balanceOf(alice.address)).to.equal((1000n * E18) / 36n);
  });

  it("getAccountInfo: returns full state", async function () {
    const { ethers, vesting, treasury, carol } = await fixture();
    await vesting.connect(treasury).addInvestorHuman(carol.address, 3600n);
    await increaseBy(ethers, MONTH * 2);

    const info = await vesting.getAccountInfo(carol.address);
    expect(info.totalWei).to.equal(3600n * E18);
    expect(info.monthsElapsedNow).to.equal(2n);
    expect(info.vestedNowWei).to.equal(((3600n * E18) / 36n) * 2n);
    expect(info.claimedSoFarWei).to.equal(0n);
    expect(info.claimableNowWei).to.equal(((3600n * E18) / 36n) * 2n);
    expect(Number(info.vestingStart)).to.be.gt(0);
    expect(Number(info.nextUnlockTimestamp)).to.equal(
      Number(info.vestingStart) + 3 * MONTH,
    );
  });

  // ---------------- sweep ----------------
  it("sweep: locked for 30 days from deploy, only owner", async function () {
    const { ethers, vesting, treasury, alice } = await fixture();

    await expect(
      vesting.connect(treasury).sweep(treasury.address, 1n),
    ).to.be.revertedWith("admin withdraw locked");

    await increaseBy(ethers, 31 * 24 * 60 * 60);
    await expect(vesting.connect(alice).sweep(alice.address, 1n))
      .to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);

    await vesting.connect(treasury).sweep(treasury.address, 1n);
  });

  // ---------------- merkle + admin combined ----------------
  it("merkle activation + admin top-up: clock from activation, top-up adds without reset", async function () {
    const { ethers, vesting, treasury, alice, tree, root, token } =
      await fixture();
    await vesting.connect(treasury).setMerkleRoot(root);
    await vesting.connect(treasury).start();

    // alice activates 1000 from merkle
    const proof = proofOf(tree, alice.address, 1000n * E18);
    const txAct = await vesting.connect(alice).activateMerkle(1000n * E18, proof);
    const blkAct = await ethers.provider.getBlock(txAct.blockNumber!);
    const startAt = BigInt(blkAct!.timestamp);

    // 5 months later admin adds OTC 5000 to alice
    await increaseBy(ethers, 5 * MONTH);
    await vesting.connect(treasury).addInvestorHuman(alice.address, 5000n);

    // clock unchanged
    expect(await vesting.vestingStartOf(alice.address)).to.equal(startAt);

    // total = 6000, monthsElapsed=5, vested = 6000 * 5/36
    expect(await vesting.totalAllocationWei(alice.address)).to.equal(
      6000n * E18,
    );
    const vested = ((6000n * E18) * 5n) / 36n;
    expect(await vesting.vestedWei(alice.address)).to.equal(vested);

    // alice claims everything available
    await vesting.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(vested);
  });
});
