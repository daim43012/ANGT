import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import FlyANGTModule from "./FlyANGT.js";

/**
 * AllocationRegistry — immutable on-chain doc of the TGE distribution.
 *
 * Parameters:
 *   totalSupplyWei   — must equal sum of all `entries[i].amountWei`
 *   entries          — array of { label, recipient, amountWei, vested, note }
 *
 * Pass via parameters.<network>.json under "AllocationRegistryModule".
 */
const AllocationRegistryModule = buildModule("AllocationRegistryModule", (m) => {
  const { token } = m.useModule(FlyANGTModule);

  const totalSupplyWei = m.getParameter("totalSupplyWei");
  const entries = m.getParameter("entries");

  const registry = m.contract("AllocationRegistry", [
    token,
    totalSupplyWei,
    entries,
  ]);

  return { token, registry };
});

export default AllocationRegistryModule;
