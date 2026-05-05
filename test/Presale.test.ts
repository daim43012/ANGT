import { expect } from "chai";
import { network } from "hardhat";

function u6(n: number | string | bigint) {
  return BigInt(n) * 10n ** 6n;
}

async function addr(c: any): Promise<string> {
  return c?.target ?? (await c.getAddress());
}

async function latestTs(ethers: any): Promise<number> {
  const b = await ethers.provider.getBlock("latest");
  if (!b) throw new Error("No latest block");
  return Number(b.timestamp);
}

async function increaseTo(ethers: any, ts: number) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [ts]);
  await ethers.provider.send("evm_mine", []);
}

describe("PresaleTimeWeeks (max tests)", function () {
  async function deployFixture() {
    const { ethers } = await network.connect();
    const [owner, buyer, treasury, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20", owner);
    const usdt: any = await Mock.deploy("Tether USD", "USDT", 6);
    const usdc: any = await Mock.deploy("USD Coin", "USDC", 6);

    const now = await latestTs(ethers);
    const startTime = now + 10;
    const endTime = 0;
    const weekDuration = 7 * 24 * 60 * 60;

    const pricesMicro = [100_000n, 120_000n, 150_000n]; // week1..week3

    const Presale = await ethers.getContractFactory("PresaleTimeWeeks", owner);
    const presale: any = await Presale.deploy(
      await addr(usdt),
      await addr(usdc),
      treasury.address,
      startTime,
      endTime,
      weekDuration,
      pricesMicro,
    );

    // mint pay tokens to buyer
    await usdt.mint(buyer.address, u6(100_000));
    await usdc.mint(buyer.address, u6(100_000));

    return {
      ethers,
      owner,
      buyer,
      treasury,
      other,
      usdt,
      usdc,
      presale,
      startTime,
      endTime,
      weekDuration,
      pricesMicro,
    };
  }

  // ---------------- constructor / views ----------------
  it("constructor: sets treasury, window, duration, pay tokens and pricesLength", async function () {
    const { presale, usdt, usdc, treasury, startTime, endTime, weekDuration } =
      await deployFixture();

    expect(await presale.treasury()).to.equal(treasury.address);
    expect(await presale.startTime()).to.equal(startTime);
    expect(await presale.endTime()).to.equal(endTime);
    expect(await presale.weekDuration()).to.equal(weekDuration);

    expect(await presale.isPayToken(await addr(usdt))).to.equal(true);
    expect(await presale.isPayToken(await addr(usdc))).to.equal(true);

    expect(await presale.pricesLength()).to.equal(3);
  });

  it("priceForWeek: week=0 returns 0, after last week keeps last price", async function () {
    const { presale } = await deployFixture();

    expect(await presale.priceForWeek(0)).to.equal(0);
    expect(await presale.priceForWeek(1)).to.equal(100_000n);
    expect(await presale.priceForWeek(2)).to.equal(120_000n);
    expect(await presale.priceForWeek(3)).to.equal(150_000n);
    expect(await presale.priceForWeek(4)).to.equal(150_000n);
    expect(await presale.priceForWeek(999)).to.equal(150_000n);
  });

  // ---------------- time logic ----------------
  it("isActive: false before start, true after start", async function () {
    const { ethers, presale, startTime } = await deployFixture();

    expect(await presale.isActive()).to.equal(false);
    await increaseTo(ethers, startTime + 1);
    expect(await presale.isActive()).to.equal(true);
  });

  it("currentWeek: 0 before start, then 1..", async function () {
    const { ethers, presale, startTime, weekDuration } = await deployFixture();

    expect(await presale.currentWeek()).to.equal(0);

    await increaseTo(ethers, startTime + 1);
    expect(await presale.currentWeek()).to.equal(1);

    await increaseTo(ethers, startTime + weekDuration + 1);
    expect(await presale.currentWeek()).to.equal(2);

    await increaseTo(ethers, startTime + 2 * weekDuration + 1);
    expect(await presale.currentWeek()).to.equal(3);

    await increaseTo(ethers, startTime + 3 * weekDuration + 1);
    expect(await presale.currentWeek()).to.equal(4);
  });

  it("currentPriceUsdMicro follows current week and then keeps last price", async function () {
    const { ethers, presale, startTime, weekDuration } = await deployFixture();

    await increaseTo(ethers, startTime + 1);
    expect(await presale.currentPriceUsdMicro()).to.equal(100_000n);

    await increaseTo(ethers, startTime + weekDuration + 1);
    expect(await presale.currentPriceUsdMicro()).to.equal(120_000n);

    await increaseTo(ethers, startTime + 2 * weekDuration + 1);
    expect(await presale.currentPriceUsdMicro()).to.equal(150_000n);

    // after schedule ends (week4), still last price
    await increaseTo(ethers, startTime + 3 * weekDuration + 1);
    expect(await presale.currentPriceUsdMicro()).to.equal(150_000n);
  });

  // ---------------- quote ----------------
  it("quote: 0 if payAmount=0 or price=0", async function () {
    const { ethers, presale, startTime } = await deployFixture();

    expect(await presale.quote(0)).to.equal(0);

    // before start => currentPriceUsdMicro = 0 => quote = 0
    expect(await presale.quote(u6(10))).to.equal(0);

    await increaseTo(ethers, startTime + 1);
    expect(await presale.quote(0)).to.equal(0);
  });

  it("quote: correct math and rounding floor", async function () {
    const { ethers, presale, startTime } = await deployFixture();
    await increaseTo(ethers, startTime + 1);

    // price week1 = 100_000 micro = 0.10$
    // pay=1 micro (0.000001$) => tokensWei = floor(1e18 / 100_000) = 1e13 (не ноль)
    const t = await presale.quote(1n);
    expect(t).to.equal((1n * 10n ** 18n) / 100_000n);

    // pay very small can become 0 only if price huge, но у нас цены норм.
    // Проверим на типичном: 100 USDT => 1000 tokens
    const pay = u6(100);
    const expected = (pay * 10n ** 18n) / 100_000n;
    expect(await presale.quote(pay)).to.equal(expected);
  });

  // ---------------- buy ----------------
  it("buy: USDT transfers to treasury, increases totalSoldWei, emits Purchased with args", async function () {
    const { ethers, presale, usdt, buyer, treasury, startTime } =
      await deployFixture();
    await increaseTo(ethers, startTime + 1);

    const presaleAddr = await addr(presale);
    const usdtAddr = await addr(usdt);

    const pay = u6(100);
    await usdt.connect(buyer).approve(presaleAddr, pay);

    const expectedTokens = (pay * 10n ** 18n) / 100_000n;

    const treasuryBefore = await usdt.balanceOf(treasury.address);
    const soldBefore = await presale.totalSoldWei();

    const tx = await presale.connect(buyer).buy(usdtAddr, pay);

    await expect(tx)
      .to.emit(presale, "Purchased")
      .withArgs(buyer.address, usdtAddr, pay, expectedTokens, 1n, 100_000n);

    const treasuryAfter = await usdt.balanceOf(treasury.address);
    expect(treasuryAfter - treasuryBefore).to.equal(pay);

    const soldAfter = await presale.totalSoldWei();
    expect(soldAfter - soldBefore).to.equal(expectedTokens);
  });

  it("buy: works with USDC too", async function () {
    const { ethers, presale, usdc, buyer, treasury, startTime } =
      await deployFixture();
    await increaseTo(ethers, startTime + 1);

    const pay = u6(50);
    await usdc.connect(buyer).approve(await addr(presale), pay);

    const treasuryBefore = await usdc.balanceOf(treasury.address);
    await presale.connect(buyer).buy(await addr(usdc), pay);
    const treasuryAfter = await usdc.balanceOf(treasury.address);

    expect(treasuryAfter - treasuryBefore).to.equal(pay);
  });

  it("buy: price changes by week", async function () {
    const { ethers, presale, usdt, buyer, treasury, startTime, weekDuration } =
      await deployFixture();
    const presaleAddr = await addr(presale);
    const usdtAddr = await addr(usdt);

    await usdt.connect(buyer).approve(presaleAddr, u6(10_000));

    // week1 (0.10)
    await increaseTo(ethers, startTime + 1);
    const pay = u6(100);
    const t1 = await presale.connect(buyer).buy(usdtAddr, pay);
    await t1.wait?.();

    // week2 (0.12)
    await increaseTo(ethers, startTime + weekDuration + 1);
    const tx2 = await presale.connect(buyer).buy(usdtAddr, pay);
    await expect(tx2)
      .to.emit(presale, "Purchased")
      .withArgs(
        buyer.address,
        usdtAddr,
        pay,
        (pay * 10n ** 18n) / 120_000n,
        2n,
        120_000n,
      );

    // treasury should receive both payments
    expect(await usdt.balanceOf(treasury.address)).to.equal(pay + pay);
  });

  it("buy: reverts InvalidToken if token not allowed", async function () {
    const { ethers, presale, other, startTime } = await deployFixture();
    await increaseTo(ethers, startTime + 1);

    await expect(
      presale.connect(other).buy(other.address, u6(1)),
    ).to.be.revertedWithCustomError(presale, "InvalidToken");
  });

  it("buy: reverts InvalidAmount if payAmount=0", async function () {
    const { ethers, presale, usdt, buyer, startTime } = await deployFixture();
    await increaseTo(ethers, startTime + 1);

    await expect(
      presale.connect(buyer).buy(await addr(usdt), 0),
    ).to.be.revertedWithCustomError(presale, "InvalidAmount");
  });

  it("buy: reverts NotActive before start", async function () {
    const { presale, usdt, buyer } = await deployFixture();

    await usdt.connect(buyer).approve(await addr(presale), u6(10));

    await expect(
      presale.connect(buyer).buy(await addr(usdt), u6(10)),
    ).to.be.revertedWithCustomError(presale, "NotActive");
  });

  it("buy: reverts TooSmall when tokensWei == 0 (force by setting huge price)", async function () {
    const { ethers, presale, owner, usdt, buyer, startTime } =
      await deployFixture();
    await increaseTo(ethers, startTime + 1);

    // делаем цену огромной, чтобы (pay*1e18)/price = 0
    await presale.connect(owner).setPriceForWeek(1, 10n ** 40n);

    const pay = 1n;
    await usdt.connect(buyer).approve(await addr(presale), pay);

    await expect(
      presale.connect(buyer).buy(await addr(usdt), pay),
    ).to.be.revertedWithCustomError(presale, "TooSmall");
  });

  // ---------------- pause / close ----------------
  it("pause/unpause: PausedError when paused, works after unpause", async function () {
    const { ethers, presale, owner, usdt, buyer, startTime } =
      await deployFixture();
    await increaseTo(ethers, startTime + 1);

    await usdt.connect(buyer).approve(await addr(presale), u6(100));

    await presale.connect(owner).pause();
    await expect(
      presale.connect(buyer).buy(await addr(usdt), u6(1)),
    ).to.be.revertedWithCustomError(presale, "PausedError");

    await presale.connect(owner).unpause();
    await expect(presale.connect(buyer).buy(await addr(usdt), u6(1))).to.emit(
      presale,
      "Purchased",
    );
  });

  it("closePresale: pauses and sets endTime, then isActive false", async function () {
    const { ethers, presale, owner, startTime } = await deployFixture();
    await increaseTo(ethers, startTime + 1);

    expect(await presale.isActive()).to.equal(true);

    const now = await latestTs(ethers);
    await presale.connect(owner).closePresale();

    expect(await presale.paused()).to.equal(true);
    expect(await presale.endTime()).to.be.gte(now);
    expect(await presale.isActive()).to.equal(false);
  });

  // ---------------- admin access control ----------------
  it("onlyOwner: protected methods revert NotOwner", async function () {
    const { presale, buyer } = await deployFixture();

    await expect(presale.connect(buyer).pause()).to.be.revertedWithCustomError(
      presale,
      "NotOwner",
    );
    await expect(
      presale.connect(buyer).unpause(),
    ).to.be.revertedWithCustomError(presale, "NotOwner");
    await expect(
      presale.connect(buyer).setTreasury(buyer.address),
    ).to.be.revertedWithCustomError(presale, "NotOwner");
    await expect(
      presale.connect(buyer).setPayToken(buyer.address, true),
    ).to.be.revertedWithCustomError(presale, "NotOwner");
    await expect(
      presale.connect(buyer).setWindow(1, 0),
    ).to.be.revertedWithCustomError(presale, "NotOwner");
    await expect(
      presale.connect(buyer).setWeekDuration(1),
    ).to.be.revertedWithCustomError(presale, "NotOwner");
    await expect(
      presale.connect(buyer).setWeekOverride(true, 1),
    ).to.be.revertedWithCustomError(presale, "NotOwner");
    await expect(
      presale.connect(buyer).setPriceForWeek(1, 1),
    ).to.be.revertedWithCustomError(presale, "NotOwner");
    await expect(
      presale.connect(buyer).appendWeekPrice(1),
    ).to.be.revertedWithCustomError(presale, "NotOwner");
    await expect(
      presale.connect(buyer).closePresale(),
    ).to.be.revertedWithCustomError(presale, "NotOwner");
  });

  // ---------------- admin validation ----------------
  it("setTreasury: ZeroAddress revert, then updates treasury", async function () {
    const { presale, owner, other } = await deployFixture();

    await expect(
      presale
        .connect(owner)
        .setTreasury("0x0000000000000000000000000000000000000000"),
    ).to.be.revertedWithCustomError(presale, "ZeroAddress");

    await expect(presale.connect(owner).setTreasury(other.address)).to.emit(
      presale,
      "TreasuryUpdated",
    );
    expect(await presale.treasury()).to.equal(other.address);
  });

  it("setPayToken: can disable token and then buy reverts InvalidToken", async function () {
    const { ethers, presale, owner, usdt, buyer, startTime } =
      await deployFixture();
    await increaseTo(ethers, startTime + 1);

    await presale.connect(owner).setPayToken(await addr(usdt), false);
    expect(await presale.isPayToken(await addr(usdt))).to.equal(false);

    await expect(
      presale.connect(buyer).buy(await addr(usdt), u6(1)),
    ).to.be.revertedWithCustomError(presale, "InvalidToken");
  });

  it("setWindow: BadTime reverts for zero start or end<=start; endTime makes isActive false after end", async function () {
    const { ethers, presale, owner } = await deployFixture();

    await expect(
      presale.connect(owner).setWindow(0, 0),
    ).to.be.revertedWithCustomError(presale, "BadTime");

    await expect(
      presale.connect(owner).setWindow(100, 50),
    ).to.be.revertedWithCustomError(presale, "BadTime");

    const now = await latestTs(ethers);
    const start = now + 10;
    const end = now + 20;

    await presale.connect(owner).setWindow(start, end);

    await increaseTo(ethers, start + 1);
    expect(await presale.isActive()).to.equal(true);

    await increaseTo(ethers, end + 1);
    expect(await presale.isActive()).to.equal(false);
  });

  it("setWeekDuration: InvalidAmount revert on 0, then affects week boundary", async function () {
    const { ethers, presale, owner, startTime } = await deployFixture();

    await expect(
      presale.connect(owner).setWeekDuration(0),
    ).to.be.revertedWithCustomError(presale, "InvalidAmount");

    await increaseTo(ethers, startTime + 1);
    expect(await presale.currentWeek()).to.equal(1);

    await presale.connect(owner).setWeekDuration(24 * 60 * 60); // 1 day
    await increaseTo(ethers, startTime + 24 * 60 * 60 + 2);
    expect(await presale.currentWeek()).to.equal(2);
  });

  it("setWeekOverride: enabled requires week>0", async function () {
    const { presale, owner } = await deployFixture();

    await expect(
      presale.connect(owner).setWeekOverride(true, 0),
    ).to.be.revertedWithCustomError(presale, "InvalidAmount");

    await presale.connect(owner).setWeekOverride(true, 5);
    expect(await presale.weekOverrideEnabled()).to.equal(true);
    expect(await presale.weekOverride()).to.equal(5);

    await presale.connect(owner).setWeekOverride(false, 0);
    expect(await presale.weekOverrideEnabled()).to.equal(false);
  });

  it("setPriceForWeek: invalid week or price reverts, valid updates price", async function () {
    const { ethers, presale, owner, startTime } = await deployFixture();
    await increaseTo(ethers, startTime + 1);

    await expect(
      presale.connect(owner).setPriceForWeek(0, 1),
    ).to.be.revertedWithCustomError(presale, "InvalidAmount");

    await expect(
      presale.connect(owner).setPriceForWeek(1, 0),
    ).to.be.revertedWithCustomError(presale, "InvalidPrice");

    // week=99 out of range => InvalidAmount
    await expect(
      presale.connect(owner).setPriceForWeek(99, 1),
    ).to.be.revertedWithCustomError(presale, "InvalidAmount");

    await presale.connect(owner).setPriceForWeek(1, 200_000n);
    expect(await presale.currentPriceUsdMicro()).to.equal(200_000n);
  });

  it("appendWeekPrice: InvalidPrice revert on 0, valid appends", async function () {
    const { presale, owner } = await deployFixture();

    await expect(
      presale.connect(owner).appendWeekPrice(0),
    ).to.be.revertedWithCustomError(presale, "InvalidPrice");

    const lenBefore = await presale.pricesLength();
    await presale.connect(owner).appendWeekPrice(999_000n);
    const lenAfter = await presale.pricesLength();

    expect(lenAfter).to.equal(lenBefore + 1n);
    expect(await presale.priceForWeek(999)).to.equal(999_000n);
  });
});
