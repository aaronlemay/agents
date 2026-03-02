const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const YEL = "\x1b[33m";
const CYA = "\x1b[36m";
const PNK = "\x1b[35m";
const RES = "\x1b[0m";
const BRIGHT = "\x1b[1m";
const REAPER_POWER = ethers.BigNumber.from(666);

function calcPower(units, reapers) {
  return units.add(reapers.mul(REAPER_POWER));
}

function ratioNum(n, d) {
  if (!d || d.lte(0)) return 0;
  return Number(n.mul(10000).div(d).toString()) / 10000;
}

function chooseDominantWallet(logsParsed) {
  const counts = new Map();
  for (const ev of logsParsed) {
    const addr = ev.args.attacker.toLowerCase();
    counts.set(addr, (counts.get(addr) || 0) + 1);
  }
  let dom = null;
  for (const [addr, count] of counts.entries()) {
    if (!dom || count > dom.count) dom = { addr, count };
  }
  return dom;
}

function chooseParasiteAction(candidates, minForce) {
  const valid = candidates
    .filter((c) => c.force >= minForce)
    .sort((a, b) => b.enemy.pendingBounty.gt(a.enemy.pendingBounty) ? 1 : -1);
  if (!valid[0]) return { type: "HOLD" };
  const c = valid[0];
  return {
    type: "DIRECT_KILL",
    stackId: c.id,
    target: c.enemy.occupant,
    units: c.self.units,
    reapers: c.self.reapers,
    force: c.force
  };
}

async function main() {
  const pk = process.env.PARASITE_PK || process.env.SNIPER_PK;
  if (!pk) throw new Error("Missing PARASITE_PK or SNIPER_PK in .env");

  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const s = cfg.settings || {};
  const n = cfg.network || {};
  const conf = {
    LOOP_DELAY_SECONDS: Number(s.LOOP_DELAY_SECONDS ?? 10),
    LOOKBACK_BLOCKS: Number(s.LOOKBACK_BLOCKS ?? 120),
    MIN_DIRECT_FORCE_RATIO: Number(s.MIN_DIRECT_FORCE_RATIO ?? 1.3),
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
  const scanIds = Array.from({ length: 216 }, (_, i) => i + 1);
  let cycle = 0;
  console.log(`${BRIGHT}--- PARASITE AGENT ONLINE ---${RES}`);

  while (true) {
    cycle += 1;
    try {
      const [ethBal, blockNum] = await Promise.all([ethers.provider.getBalance(wallet.address), ethers.provider.getBlockNumber()]);
      const killedTopic = game.interface.getEventTopic("Killed");
      const logs = await ethers.provider.getLogs({
        address: n.kill_game_addr,
        topics: [killedTopic],
        fromBlock: Math.max(0, blockNum - conf.LOOKBACK_BLOCKS),
        toBlock: blockNum
      });
      const parsed = logs.map((l) => game.interface.parseLog(l));
      const dominant = chooseDominantWallet(parsed);

      const raw = await game.callStatic.multicall(scanIds.map((id) => game.interface.encodeFunctionData("getFullStack", [id])));
      const candidates = [];
      for (let i = 0; i < raw.length; i++) {
        const stackId = i + 1;
        const items = game.interface.decodeFunctionResult("getFullStack", raw[i])[0];
        const self = items.find((it) => it.occupant.toLowerCase() === address && (it.units.gt(0) || it.reapers.gt(0)));
        const enemies = items.filter((it) => it.occupant.toLowerCase() !== address && (it.units.gt(0) || it.reapers.gt(0)));
        if (!self) continue;
        for (const e of enemies) {
          if (dominant && e.occupant.toLowerCase() === dominant.addr) continue;
          const force = ratioNum(calcPower(self.units, self.reapers), calcPower(e.units, e.reapers));
          candidates.push({ id: stackId, self, enemy: e, force });
        }
      }

      const action = chooseParasiteAction(candidates, conf.MIN_DIRECT_FORCE_RATIO);
      console.log(`${BRIGHT}--- PARASITE | STATUS ---${RES}`);
      console.table([{
        ETH: ethers.utils.formatEther(ethBal).substring(0, 7),
        DOM: dominant ? `${dominant.addr.slice(0, 8)}(${dominant.count})` : "none",
        CANDIDATES: candidates.length,
        ACTION: action.type
      }]);

      const calls = [];
      if (action.type === "DIRECT_KILL") {
        console.log(`${CYA}[PARASITE] direct kill @${action.stackId} force=${action.force.toFixed(2)}x${RES}`);
        calls.push(game.interface.encodeFunctionData("kill", [action.target, action.stackId, action.units, action.reapers]));
      } else {
        console.log(`${YEL}[IDLE] no parasitic edge.${RES}`);
      }

      if (calls.length > 0) {
        if (!conf.DRY_RUN && ethBal.lte(conf.MIN_ETH_BALANCE)) {
          console.log(`${YEL}[HOLD] ETH below floor.${RES}`);
        } else {
          await game.callStatic.multicall(calls);
          if (conf.DRY_RUN) {
            console.log(`${YEL}[DRY_RUN] simulation passed.${RES}`);
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
  chooseParasiteAction,
  chooseDominantWallet,
  calcPower,
  ratioNum
};
