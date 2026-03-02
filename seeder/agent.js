const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const YEL = "\x1b[33m";
const CYA = "\x1b[36m";
const PNK = "\x1b[35m";
const RES = "\x1b[0m";
const BRIGHT = "\x1b[1m";
const SPAWN_COST_PER_UNIT = ethers.utils.parseEther("20");

function getCoords(id) {
  const v = Number(id) - 1;
  return { x: v % 6, y: Math.floor(v / 6) % 6, z: Math.floor(v / 36) };
}

function chooseSeedTargets(candidates, maxCount) {
  return candidates
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.id - b.id;
    })
    .slice(0, maxCount);
}

async function main() {
  const pk = process.env.SEEDER_PK || process.env.SNIPER_PK;
  if (!pk) throw new Error("Missing SEEDER_PK or SNIPER_PK in .env");

  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const s = cfg.settings || {};
  const n = cfg.network || {};
  const conf = {
    LOOP_DELAY_SECONDS: Number(s.LOOP_DELAY_SECONDS ?? 10),
    SEED_UNITS: ethers.BigNumber.from(s.SEED_UNITS ?? 666),
    MAX_SEED_TX_PER_CYCLE: Number(s.MAX_SEED_TX_PER_CYCLE ?? 1),
    MAX_GAS_PRICE_GWEI: Number(s.MAX_GAS_PRICE_GWEI ?? 1),
    MAX_GAS_LIMIT: Number(s.MAX_GAS_LIMIT ?? 220000),
    MIN_ETH_BALANCE: ethers.utils.parseEther((s.MIN_ETH_BALANCE ?? "0.00015").toString()),
    DRY_RUN: Boolean(s.DRY_RUN ?? true),
    MAX_CYCLES: Number(s.MAX_CYCLES ?? 0)
  };

  const wallet = new ethers.Wallet(pk, ethers.provider);
  const address = wallet.address.toLowerCase();
  const game = new ethers.Contract(
    n.kill_game_addr,
    JSON.parse(fs.readFileSync(path.join(__dirname, "../../data/abi/KILLGame.json"), "utf8")).abi,
    wallet
  );
  const token = new ethers.Contract(
    await game.killToken(),
    ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
    wallet
  );

  const ids = Array.from({ length: 216 }, (_, i) => i + 1);
  let cycle = 0;
  console.log(`${BRIGHT}--- SEEDER AGENT ONLINE ---${RES}`);

  while (true) {
    cycle += 1;
    try {
      const [ethBal, killBal, allow] = await Promise.all([
        ethers.provider.getBalance(wallet.address),
        token.balanceOf(wallet.address),
        token.allowance(wallet.address, n.kill_game_addr)
      ]);

      const raw = await game.callStatic.multicall(ids.map((id) => game.interface.encodeFunctionData("getFullStack", [id])));
      const candidates = [];

      for (let i = 0; i < raw.length; i++) {
        const stackId = i + 1;
        const items = game.interface.decodeFunctionResult("getFullStack", raw[i])[0];
        const mine = items.find((it) => it.occupant.toLowerCase() === address && (it.units.gt(0) || it.reapers.gt(0)));
        if (mine) continue;
        const enemies = items.filter((it) => it.occupant.toLowerCase() !== address && (it.units.gt(0) || it.reapers.gt(0)));
        const z = getCoords(stackId).z;
        const bounty = enemies.reduce((acc, e) => acc.add(e.pendingBounty), ethers.BigNumber.from(0));
        const score = Number(ethers.utils.formatEther(bounty)) + (z * 0.1);
        candidates.push({ id: stackId, score });
      }

      const picks = chooseSeedTargets(candidates, conf.MAX_SEED_TX_PER_CYCLE);
      console.log(`${BRIGHT}--- SEEDER | STATUS ---${RES}`);
      console.table([{
        ETH: ethers.utils.formatEther(ethBal).substring(0, 7),
        KILL: Number(ethers.utils.formatEther(killBal)).toLocaleString(undefined, { maximumFractionDigits: 1 }),
        ALLOW: allow.gt(ethers.constants.MaxUint256.div(2)) ? "MAX" : "LOW",
        PICKS: picks.map((p) => p.id).join(",") || "none"
      }]);

      const calls = picks.map((p) => game.interface.encodeFunctionData("spawn", [p.id, conf.SEED_UNITS]));
      if (calls.length === 0) {
        console.log(`${YEL}[IDLE] no seed targets.${RES}`);
        } else {
          const seedCost = conf.SEED_UNITS.mul(SPAWN_COST_PER_UNIT).mul(calls.length);
          if (!conf.DRY_RUN && ethBal.lte(conf.MIN_ETH_BALANCE)) {
            console.log(`${YEL}[HOLD] ETH below floor.${RES}`);
          } else if (killBal.lt(seedCost)) {
            console.log(`${YEL}[HOLD] insufficient KILL for seed cost ${seedCost.toString()}.${RES}`);
          } else {
            if (allow.lt(seedCost)) {
              const ap = await token.approve(n.kill_game_addr, ethers.constants.MaxUint256);
              await ap.wait();
            }
            await game.callStatic.multicall(calls);
          if (conf.DRY_RUN) {
            console.log(`${YEL}[DRY_RUN] seed simulation passed for stacks ${picks.map((p) => p.id).join(",")}.${RES}`);
          } else {
            const gasPrice = ethers.utils.parseUnits(conf.MAX_GAS_PRICE_GWEI.toString(), "gwei");
            const tx = await game.multicall(calls, { gasPrice, gasLimit: conf.MAX_GAS_LIMIT });
            console.log(`${CYA}>> [TX] ${tx.hash}${RES}`);
            await tx.wait();
          }
        }
      }
    } catch (err) {
      console.log(`${PNK}[ERROR] ${err.reason || err.message}${RES}`);
    }

    if (conf.MAX_CYCLES > 0 && cycle >= conf.MAX_CYCLES) break;
    await new Promise((r) => setTimeout(r, conf.LOOP_DELAY_SECONDS * 1000));
  }
}

if (require.main === module) main();

module.exports = {
  chooseSeedTargets
};
