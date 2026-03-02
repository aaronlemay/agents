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

function getCoords(id) {
  const v = Number(id) - 1;
  return { x: v % 6, y: Math.floor(v / 6) % 6, z: Math.floor(v / 36) };
}

function getId(x, y, z) {
  return (z * 36) + (y * 6) + x + 1;
}

function getPath3D(startId, endId) {
  let current = getCoords(startId);
  const target = getCoords(endId);
  const path = [];
  while (current.x !== target.x || current.y !== target.y || current.z !== target.z) {
    const from = getId(current.x, current.y, current.z);
    if (current.x !== target.x) current.x += target.x > current.x ? 1 : -1;
    else if (current.y !== target.y) current.y += target.y > current.y ? 1 : -1;
    else current.z += target.z > current.z ? 1 : -1;
    path.push({ from, to: getId(current.x, current.y, current.z) });
  }
  return path;
}

function calcPower(units, reapers) {
  return units.add(reapers.mul(REAPER_POWER));
}

function ratioNum(n, d) {
  if (!d || d.lte(0)) return 0;
  return Number(n.mul(10000).div(d).toString()) / 10000;
}

function chooseSentinelAction(input, conf) {
  const { hubSelf, hubEnemies, stranded } = input;
  if (hubSelf && hubEnemies && hubEnemies.length > 0) {
    const topEnemy = [...hubEnemies].sort((a, b) => b.pendingBounty.gt(a.pendingBounty) ? 1 : -1)[0];
    const force = ratioNum(calcPower(hubSelf.units, hubSelf.reapers), calcPower(topEnemy.units, topEnemy.reapers));
    if (force >= conf.MIN_DIRECT_FORCE_RATIO) {
      return { type: "HUB_PURGE", target: topEnemy.occupant, stackId: conf.HUB_STACK, units: hubSelf.units, reapers: hubSelf.reapers, force };
    }
  }

  if (stranded.length > 0) {
    const far = [...stranded]
      .map((s) => ({ ...s, hops: getPath3D(s.id, conf.HUB_STACK).length }))
      .sort((a, b) => b.hops - a.hops)[0];
    const step = getPath3D(far.id, conf.HUB_STACK)[0];
    if (step) {
      return { type: "CONSOLIDATE", from: step.from, to: step.to, units: far.units, reapers: far.reapers };
    }
  }

  return { type: "HOLD" };
}

async function main() {
  const pk = process.env.SENTINEL_PK || process.env.SNIPER_PK;
  if (!pk) throw new Error("Missing SENTINEL_PK or SNIPER_PK in .env");

  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const settings = cfg.settings || {};
  const net = cfg.network || {};
  const conf = {
    HUB_STACK: Number(settings.HUB_STACK ?? 125),
    LOOP_DELAY_SECONDS: Number(settings.LOOP_DELAY_SECONDS ?? 10),
    MIN_DIRECT_FORCE_RATIO: Number(settings.MIN_DIRECT_FORCE_RATIO ?? 2),
    MIN_ETH_BALANCE: ethers.utils.parseEther((settings.MIN_ETH_BALANCE ?? "0.00015").toString()),
    MAX_GAS_PRICE_GWEI: Number(settings.MAX_GAS_PRICE_GWEI ?? 1),
    MAX_GAS_LIMIT: Number(settings.MAX_GAS_LIMIT ?? 220000),
    DRY_RUN: Boolean(settings.DRY_RUN ?? true),
    MAX_CYCLES: Number(settings.MAX_CYCLES ?? 0)
  };

  const wallet = new ethers.Wallet(pk, ethers.provider);
  const address = wallet.address.toLowerCase();
  const game = new ethers.Contract(
    net.kill_game_addr,
    JSON.parse(fs.readFileSync(path.join(__dirname, "../../data/abi/KILLGame.json"), "utf8")).abi,
    wallet
  );

  const ids = Array.from({ length: 216 }, (_, i) => i + 1);
  let cycle = 0;
  console.log(`${BRIGHT}--- SENTINEL AGENT ONLINE ---${RES}`);

  while (true) {
    cycle += 1;
    try {
      const ethBal = await ethers.provider.getBalance(wallet.address);
      const raw = await game.callStatic.multicall(ids.map((id) => game.interface.encodeFunctionData("getFullStack", [id])));

      let hubSelf = null;
      let hubEnemies = [];
      const stranded = [];

      for (let i = 0; i < raw.length; i++) {
        const stackId = i + 1;
        const items = game.interface.decodeFunctionResult("getFullStack", raw[i])[0];
        const self = items.find((it) => it.occupant.toLowerCase() === address && (it.units.gt(0) || it.reapers.gt(0)));
        const enemies = items.filter((it) => it.occupant.toLowerCase() !== address && (it.units.gt(0) || it.reapers.gt(0)));

        if (stackId === conf.HUB_STACK) {
          hubSelf = self || null;
          hubEnemies = enemies;
        }
        if (self && stackId !== conf.HUB_STACK) {
          stranded.push({ id: stackId, units: self.units, reapers: self.reapers });
        }
      }

      const action = chooseSentinelAction({ hubSelf, hubEnemies, stranded }, conf);
      console.log(`${BRIGHT}--- SENTINEL | STATUS ---${RES}`);
      console.table([{
        ETH: ethers.utils.formatEther(ethBal).substring(0, 7),
        HUB_ENEMIES: hubEnemies.length,
        STRANDED: stranded.length,
        ACTION: action.type
      }]);

      const calls = [];
      if (action.type === "HUB_PURGE") {
        console.log(`${PNK}[SENTINEL] Hub purge force=${action.force.toFixed(2)}x${RES}`);
        calls.push(game.interface.encodeFunctionData("kill", [action.target, action.stackId, action.units, action.reapers]));
      } else if (action.type === "CONSOLIDATE") {
        console.log(`${YEL}[SENTINEL] Consolidate ${action.from} -> ${action.to}${RES}`);
        calls.push(game.interface.encodeFunctionData("move", [action.from, action.to, action.units, action.reapers]));
      } else {
        console.log(`${YEL}[IDLE] No defensive action.${RES}`);
      }

      if (calls.length > 0) {
        if (!conf.DRY_RUN && ethBal.lte(conf.MIN_ETH_BALANCE)) {
          console.log(`${YEL}[HOLD] ETH below floor; skip send.${RES}`);
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
  chooseSentinelAction,
  calcPower,
  ratioNum,
  getPath3D
};
