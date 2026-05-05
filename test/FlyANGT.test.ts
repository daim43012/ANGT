import { expect } from "chai";
import { network } from "hardhat";

describe("FlyANGT", function () {
  it("deploy: should mint total supply to treasury and set correct metadata", async function () {
    const { ethers } = await network.connect();

    const [deployer, treasury] = await ethers.getSigners();

    const FlyANGT = await ethers.getContractFactory("FlyANGT", deployer);
    const token = await FlyANGT.deploy(treasury.address);

    expect(await token.name()).to.equal("FlyANGT");
    expect(await token.symbol()).to.equal("ANGT");
    expect(await token.decimals()).to.equal(18);

    const expected = ethers.parseUnits("200000000", 18);
    expect(await token.totalSupply()).to.equal(expected);
    expect(await token.balanceOf(treasury.address)).to.equal(expected);

    // owner = deployer (как в твоём constructor Ownable(msg.sender))
    expect(await token.owner()).to.equal(deployer.address);
  });

  it("deploy: should revert if treasury is zero address", async function () {
    const { ethers } = await network.connect();

    const FlyANGT = await ethers.getContractFactory("FlyANGT");
    await expect(FlyANGT.deploy(ethers.ZeroAddress)).to.be.revertedWith(
      "treasury is zero"
    );
  });

  it("transfer: should transfer tokens from treasury to another account", async function () {
    const { ethers } = await network.connect();

    const [, treasury, receiver] = await ethers.getSigners();

    const FlyANGT = await ethers.getContractFactory("FlyANGT");
    const token = await FlyANGT.deploy(treasury.address);

    const amount = ethers.parseUnits("1000", 18);

    const treasuryBefore = await token.balanceOf(treasury.address);
    const receiverBefore = await token.balanceOf(receiver.address);

    await token.connect(treasury).transfer(receiver.address, amount);

    expect(await token.balanceOf(receiver.address)).to.equal(
      receiverBefore + amount
    );
    expect(await token.balanceOf(treasury.address)).to.equal(
      treasuryBefore - amount
    );
  });
});
