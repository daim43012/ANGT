import { expect } from "chai";
import { network } from "hardhat";

const E18 = 10n ** 18n;
const TOTAL_SUPPLY = 500_000_000n * E18;

describe("FlyANGT", function () {
  async function deployFixture() {
    const { ethers } = await network.connect();
    const [deployer, treasury, other] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("FlyANGT", deployer);
    const token: any = await Token.deploy(treasury.address);

    return { ethers, deployer, treasury, other, token };
  }

  it("constructor: name/symbol/decimals", async function () {
    const { token } = await deployFixture();
    expect(await token.name()).to.equal("FlyANGT");
    expect(await token.symbol()).to.equal("ANGT");
    expect(await token.decimals()).to.equal(18);
  });

  it("constructor: total supply == 500M, all minted to treasury", async function () {
    const { token, treasury } = await deployFixture();
    expect(await token.TOTAL_SUPPLY()).to.equal(TOTAL_SUPPLY);
    expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
    expect(await token.balanceOf(treasury.address)).to.equal(TOTAL_SUPPLY);
  });

  it("constructor: owner == treasury, NOT deployer", async function () {
    const { token, treasury, deployer } = await deployFixture();
    expect(await token.owner()).to.equal(treasury.address);
    expect(await token.owner()).to.not.equal(deployer.address);
  });

  it("constructor: reverts on zero treasury (OZ Ownable runs first)", async function () {
    const { ethers } = await deployFixture();
    const Token = await ethers.getContractFactory("FlyANGT");
    // OZ Ownable's Ownable(address(0)) check fires before our require.
    await expect(Token.deploy(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(Token, "OwnableInvalidOwner")
      .withArgs(ethers.ZeroAddress);
  });

  it("transfer: works between accounts", async function () {
    const { token, treasury, other } = await deployFixture();
    await token.connect(treasury).transfer(other.address, 100n * E18);
    expect(await token.balanceOf(other.address)).to.equal(100n * E18);
    expect(await token.balanceOf(treasury.address)).to.equal(
      TOTAL_SUPPLY - 100n * E18,
    );
  });

  it("transferOwnership: only owner (=treasury) can call", async function () {
    const { token, treasury, other, deployer } = await deployFixture();
    await expect(token.connect(deployer).transferOwnership(other.address))
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
      .withArgs(deployer.address);
    await token.connect(treasury).transferOwnership(other.address);
    expect(await token.owner()).to.equal(other.address);
  });
});
