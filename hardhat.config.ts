import "dotenv/config";
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

// Network configs are added conditionally — `compile` and `test` work without
// any env vars. For deploy on a network, set the corresponding RPC + private key
// in .env (see .env.example).

const networks: Record<string, any> = {
  localhost: {
    type: "http",
    chainType: "l1",
    url: "http://127.0.0.1:8545",
  },
};

if (process.env.POLYGON_RPC_URL && process.env.POLYGON_PRIVATE_KEY) {
  networks.polygon = {
    type: "http",
    chainType: "l1",
    url: process.env.POLYGON_RPC_URL,
    accounts: [process.env.POLYGON_PRIVATE_KEY],
  };
}

if (process.env.AMOY_RPC_URL && process.env.AMOY_PRIVATE_KEY) {
  networks.amoy = {
    type: "http",
    chainType: "l1",
    url: process.env.AMOY_RPC_URL,
    accounts: [process.env.AMOY_PRIVATE_KEY],
  };
}

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: { version: "0.8.28" },
      production: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
  },
  networks,
});
