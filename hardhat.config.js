require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
const envAccounts = [process.env.SNIPER_PK, process.env.FORTRESS_PK, process.env.AFTERSHOCK_PK].filter(Boolean);
module.exports = { 
  solidity: "0.8.24", 
  networks: { 
    basesepolia: { 
      url: "https://sepolia.base.org", 
      // Agents instantiate Wallets directly; keep Hardhat accounts empty unless explicitly enabled.
      accounts: process.env.HARDHAT_ACCOUNTS_MODE === "env" ? envAccounts : [] 
    } 
  } 
};
