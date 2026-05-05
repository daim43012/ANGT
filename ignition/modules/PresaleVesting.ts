import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import FlyANGTModule from "./FlyANGT.js";

const PresaleVestingModule = buildModule("PresaleVestingModule", (m) => {
  const { token } = m.useModule(FlyANGTModule);

  const owner = m.getParameter("owner");
  const merkleRoot = m.getParameter("merkleRoot");
  const startTime = m.getParameter("startTime");

  const vesting = m.contract("PresaleVesting", [
    token,
    merkleRoot,
    startTime,
    owner,
  ]);

  return { token, vesting };
});

export default PresaleVestingModule;
