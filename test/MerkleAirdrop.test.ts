import { expect } from "chai";
import { network } from "hardhat";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import { ethers as ethersStatic } from "ethers";

const E18 = 10n ** 18n;

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
  const root = tree.getHexRoot();
  return { tree, root };
}

function proofOf(tree: MerkleTree, addr: string, amountWei: bigint): string[] {
  return tree.getHexProof(leafOf(addr, amountWei));
}

async function addrOf(c: any): Promise<string> {
  return c?.target ?? (await c.getAddress());
}

async function increaseBy(ethers: any, seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("MerkleAirdrop", function () {
  async function fixture() {
    const { ethers } = await network.connect();
    const [deployer, treasury, alice, bob, carol, eve] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("FlyANGT", deployer);
    const token: any = await Token.deploy(treasury.address);

    const claims: Claim[] = [
      { address: alice.address, amountWei: 100n * E18 },
      { address: bob.address, amountWei: 250n * E18 },
      { address: carol.address, amountWei: 50n * E18 },
    ];
    const totalClaim = claims.reduce((s, c) => s + c.amountWei, 0n);
    const { tree, root } = buildTree(claims);

    const Airdrop = await ethers.getContractFactory("MerkleAirdrop", deployer);
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = 0; // infinite
    const airdrop: any = await Airdrop.deploy(
      await addrOf(token),
      ethers.ZeroHash,
      startTime,
      endTime,
      treasury.address,
    );

    // Fund the airdrop contract
    await token
      .connect(treasury)
      .transfer(await addrOf(airdrop), totalClaim);

    return {
      ethers,
      deployer,
      treasury,
      alice,
      bob,
      carol,
      eve,
      token,
      airdrop,
      tree,
      root,
      claims,
      startTime,
      totalClaim,
    };
  }

  it("constructor: token, root=0, owner set, default flags", async function () {
    const { airdrop, treasury, token } = await fixture();
    expect(await airdrop.token()).to.equal(await addrOf(token));
    expect(await airdrop.merkleRoot()).to.equal(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(await airdrop.owner()).to.equal(treasury.address);
    expect(await airdrop.started()).to.equal(false);
    expect(await airdrop.rootFrozen()).to.equal(false);
  });

  it("setMerkleRoot: only owner, before start", async function () {
    const { airdrop, treasury, alice, root } = await fixture();
    await expect(airdrop.connect(alice).setMerkleRoot(root))
      .to.be.revertedWithCustomError(airdrop, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
    await airdrop.connect(treasury).setMerkleRoot(root);
    expect(await airdrop.merkleRoot()).to.equal(root);
  });

  it("start: requires root, freezes it, only owner", async function () {
    const { ethers, airdrop, treasury, root, alice } = await fixture();
    await expect(airdrop.connect(treasury).start()).to.be.revertedWith(
      "root not set",
    );
    await airdrop.connect(treasury).setMerkleRoot(root);
    await expect(airdrop.connect(alice).start())
      .to.be.revertedWithCustomError(airdrop, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
    await airdrop.connect(treasury).start();
    expect(await airdrop.started()).to.equal(true);
    expect(await airdrop.rootFrozen()).to.equal(true);
    // can't change root after start
    await expect(
      airdrop.connect(treasury).setMerkleRoot(ethers.ZeroHash),
    ).to.be.revertedWith("root frozen");
  });

  it("claim: valid proof transfers tokens, marks claimed", async function () {
    const { airdrop, treasury, alice, tree, root, token } = await fixture();
    await airdrop.connect(treasury).setMerkleRoot(root);
    await airdrop.connect(treasury).start();

    const aliceProof = proofOf(tree, alice.address, 100n * E18);
    await airdrop.connect(alice).claim(100n * E18, aliceProof);

    expect(await token.balanceOf(alice.address)).to.equal(100n * E18);
    expect(await airdrop.claimed(alice.address)).to.equal(true);
  });

  it("claim: double-claim reverts", async function () {
    const { airdrop, treasury, alice, tree, root } = await fixture();
    await airdrop.connect(treasury).setMerkleRoot(root);
    await airdrop.connect(treasury).start();
    const proof = proofOf(tree, alice.address, 100n * E18);
    await airdrop.connect(alice).claim(100n * E18, proof);
    await expect(airdrop.connect(alice).claim(100n * E18, proof))
      .to.be.revertedWith("already claimed");
  });

  it("claim: invalid proof reverts", async function () {
    const { airdrop, treasury, eve, tree, root } = await fixture();
    await airdrop.connect(treasury).setMerkleRoot(root);
    await airdrop.connect(treasury).start();
    const proof = proofOf(tree, eve.address, 100n * E18);
    await expect(
      airdrop.connect(eve).claim(100n * E18, proof),
    ).to.be.revertedWith("invalid proof");
  });

  it("claim: wrong amount with valid path reverts (leaf doesn't match)", async function () {
    const { airdrop, treasury, alice, tree, root } = await fixture();
    await airdrop.connect(treasury).setMerkleRoot(root);
    await airdrop.connect(treasury).start();
    const proof = proofOf(tree, alice.address, 100n * E18);
    await expect(
      airdrop.connect(alice).claim(999n * E18, proof),
    ).to.be.revertedWith("invalid proof");
  });

  it("claim: reverts if not started", async function () {
    const { airdrop, alice, tree } = await fixture();
    const proof = proofOf(tree, alice.address, 100n * E18);
    await expect(
      airdrop.connect(alice).claim(100n * E18, proof),
    ).to.be.revertedWith("not started");
  });

  it("claim: respects endTime", async function () {
    const { ethers, treasury, deployer, alice, tree, root, token } =
      await fixture();
    // redeploy with short endTime
    const Airdrop = await ethers.getContractFactory("MerkleAirdrop");
    const startTime = (await ethers.provider.getBlock("latest"))!.timestamp;
    const endTime = startTime + 100;
    const airdrop: any = await Airdrop.connect(deployer).deploy(
      await addrOf(token),
      root,
      startTime,
      endTime,
      treasury.address,
    );
    await token.connect(treasury).transfer(await addrOf(airdrop), 1000n * E18);
    await airdrop.connect(treasury).start();

    await increaseBy(ethers, 200);
    const proof = proofOf(tree, alice.address, 100n * E18);
    await expect(
      airdrop.connect(alice).claim(100n * E18, proof),
    ).to.be.revertedWith("ended");
  });

  it("sweep: locked until startTime + 30 days, only owner", async function () {
    const { ethers, airdrop, treasury, alice, root } = await fixture();
    await airdrop.connect(treasury).setMerkleRoot(root);
    await airdrop.connect(treasury).start();

    // sweep blocked early
    await expect(
      airdrop.connect(treasury).sweep(treasury.address, 1n),
    ).to.be.revertedWith("admin withdraw locked");

    // not owner
    await increaseBy(ethers, 31 * 24 * 60 * 60);
    await expect(airdrop.connect(alice).sweep(alice.address, 1n))
      .to.be.revertedWithCustomError(airdrop, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);

    // owner after delay
    await airdrop.connect(treasury).sweep(treasury.address, 1n);
  });
});
