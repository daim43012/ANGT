import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("PresaleModule", (m) => {
  const usdt = m.getParameter<string>("usdt");
  const usdc = m.getParameter<string>("usdc");
  const treasury = m.getParameter<string>("treasury");

  const weekDuration = m.getParameter<number>("weekDuration");
  const pricesMicro = m.getParameter<(string | number)[]>("pricesMicro");

  const presale = m.contract("PresaleTimeWeeks", [
    usdt,
    usdc,
    treasury,
    0,
    0,
    weekDuration,
    pricesMicro,
  ]);

  m.call(presale, "transferOwnership", [treasury]);

  return { presale };
});
