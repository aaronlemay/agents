const { ethers } = require("hardhat");
require("dotenv").config({ path: "/Users/aaronlemay/.env" });

const GAME_ADDR = "0xfd21c1c28d58e420837e8057A227C3D432D289Ec";
const MAX_GAS_PRICE_GWEI = "0.2";
const MAX_GAS_LIMIT = 180000;
const TRY_AMTS = [666, 1332];
const MAX_ATTEMPTS = 3;

async function main() {
  if (!process.env.SNIPER_PK) throw new Error("Missing SNIPER_PK in /Users/aaronlemay/.env");
  const wallet = new ethers.Wallet(process.env.SNIPER_PK, ethers.provider);
  const abi = require("/Users/aaronlemay/agents/data/abi/KILLGame.json").abi;
  const game = new ethers.Contract(GAME_ADDR, abi, wallet);
  const token = new ethers.Contract(
    await game.killToken(),
    ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
    wallet
  );

  const [ethBal, killBal] = await Promise.all([ethers.provider.getBalance(wallet.address), token.balanceOf(wallet.address)]);
  console.log(`ADDR=${wallet.address}`);
  console.log(`ETH=${ethers.utils.formatEther(ethBal)}`);
  console.log(`KILL=${ethers.utils.formatEther(killBal)}`);

  const ids = Array.from({ length: 216 }, (_, i) => i + 1);
  const gasPrice = ethers.utils.parseUnits(MAX_GAS_PRICE_GWEI, "gwei");
  let attempts = 0;
  let sent = false;

  while (attempts < MAX_ATTEMPTS && !sent) {
    attempts += 1;
    let chosen = null;
    for (const amt of TRY_AMTS) {
      const cost = ethers.BigNumber.from(amt).mul(ethers.utils.parseEther("20"));
      if (killBal.lt(cost)) continue;
      for (const id of ids) {
        const calls = [game.interface.encodeFunctionData("spawn", [id, amt])];
        try {
          await game.callStatic.multicall(calls);
          chosen = { id, amt, cost, calls };
          break;
        } catch (_) {}
      }
      if (chosen) break;
    }

    if (!chosen) {
      console.log(`ATTEMPT_${attempts}=no_valid_seed_target`);
      break;
    }

    let gasLimit = ethers.BigNumber.from(MAX_GAS_LIMIT);
    try {
      const est = await game.estimateGas.multicall(chosen.calls);
      const padded = est.mul(120).div(100);
      gasLimit = padded.lt(gasLimit) ? padded : gasLimit;
    } catch (_) {}

    const txCost = gasLimit.mul(gasPrice);
    const freshEth = await ethers.provider.getBalance(wallet.address);
    console.log(`ATTEMPT_${attempts}_STACK=${chosen.id}`);
    console.log(`ATTEMPT_${attempts}_UNITS=${chosen.amt}`);
    console.log(`ATTEMPT_${attempts}_EST_ETH_TX_COST=${ethers.utils.formatEther(txCost)}`);

    if (freshEth.lte(txCost.mul(105).div(100))) {
      console.log("RESULT=insufficient_eth_for_safe_send");
      break;
    }

    const allow = await token.allowance(wallet.address, GAME_ADDR);
    if (allow.lt(chosen.cost)) {
      const ap = await token.approve(GAME_ADDR, ethers.constants.MaxUint256);
      await ap.wait();
    }

    try {
      const tx = await game.multicall(chosen.calls, { gasPrice, gasLimit });
      console.log(`TX_HASH=${tx.hash}`);
      await tx.wait();
      console.log("RESULT=seed_sent");
      sent = true;
    } catch (err) {
      console.log(`ATTEMPT_${attempts}_ERROR=${err.reason || err.message}`);
    }
  }

  if (!sent) {
    console.log("RESULT=seed_not_sent");
  }
}

main().catch((e) => {
  console.error(e.reason || e.message || e);
  process.exit(1);
});
