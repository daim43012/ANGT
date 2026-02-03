import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const FlyANGTModule = buildModule("FlyANGTModule", (m) => {
  const treasury = m.getParameter("treasury");
  const token = m.contract("FlyANGT", [treasury]);
  return { token };
});

export default FlyANGTModule;
