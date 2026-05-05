import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import FlyANGTModule from "./FlyANGT.js";

const MerkleAirdropModule = buildModule("MerkleAirdropModule", (m) => {
  const { token } = m.useModule(FlyANGTModule);

  const owner = m.getParameter("owner");
  const merkleRoot = m.getParameter("merkleRoot");
  const startTime = m.getParameter("startTime");
  const endTime = m.getParameter("endTime");

  const airdrop = m.contract("MerkleAirdrop", [
    token,
    merkleRoot,
    startTime,
    endTime,
    owner,
  ]);

  return { token, airdrop };
});

export default MerkleAirdropModule;
