const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const YEL = "\x1b[33m";
const CYA = "\x1b[36m";
const PNK = "\x1b[35m";
const RES = "\x1b[0m";
const BRIGHT = "\x1b[1m";

const GRID_SIZE = 216;
const REAPER_POWER = ethers.BigNumber.from(666);
const POWER_PER_666_SPAWN = ethers.BigNumber.from(1332);
const SPAWN_STEP = ethers.BigNumber.from(666);
const SPAWN_COST_PER_UNIT = ethers.BigNumber.from(10);

function getCoords(id) {
    const v = Number(id) - 1;
    return { x: v % 6, y: Math.floor(v / 6) % 6, z: Math.floor(v / 36) };
}

function getId(x, y, z) {
    return (z * 36) + (y * 6) + x + 1;
}

function getNeighbors(id) {
    const c = getCoords(id);
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const out = [];
    for (const [dx, dy, dz] of dirs) {
        const x = c.x + dx; const y = c.y + dy; const z = c.z + dz;
        if (x >= 0 && x < 6 && y >= 0 && y < 6 && z >= 0 && z < 6) out.push(getId(x, y, z));
    }
    return out;
}

function calcPower(units, reapers) {
    return units.add(reapers.mul(REAPER_POWER));
}

function toRatio(n, d) {
    if (d.lte(0)) return 0;
    return parseFloat(n.mul(10000).div(d).toString()) / 10000;
}

function fmt(v) {
    return parseFloat(ethers.utils.formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function calcSpawn(enemyPower, overkillRatio) {
    let spawnAmt = enemyPower.mul(overkillRatio).add(POWER_PER_666_SPAWN.sub(1)).div(POWER_PER_666_SPAWN).mul(SPAWN_STEP);
    if (spawnAmt.lt(SPAWN_STEP)) spawnAmt = SPAWN_STEP;
    const rem = spawnAmt.mod(SPAWN_STEP);
    if (!rem.isZero()) spawnAmt = spawnAmt.add(SPAWN_STEP.sub(rem));
    const spawnReaper = spawnAmt.div(REAPER_POWER);
    const spawnPower = calcPower(spawnAmt, spawnReaper);
    const cost = spawnAmt.mul(SPAWN_COST_PER_UNIT);
    return { spawnAmt, spawnReaper, spawnPower, cost };
}

async function main() {
    if (!process.env.AFTERSHOCK_PK) throw new Error("Missing AFTERSHOCK_PK in .env");
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    const settings = cfg.settings || {};
    const net = cfg.network || {};

    const conf = {
        HUB_STACK: Number(settings.HUB_STACK ?? 125),
        LOOP_DELAY_SECONDS: Number(settings.LOOP_DELAY_SECONDS ?? 12),
        LOOKBACK_BLOCKS: Number(settings.LOOKBACK_BLOCKS ?? 120),
        HOT_STACK_MIN_KILLS: Number(settings.HOT_STACK_MIN_KILLS ?? 2),
        OVERKILL_RATIO: ethers.BigNumber.from(settings.OVERKILL_RATIO ?? 8),
        MIN_FORCE_RATIO: Number(settings.MIN_FORCE_RATIO ?? 4),
        MIN_BOUNTY_FOR_SPAWN: ethers.utils.parseEther((settings.MIN_BOUNTY_FOR_SPAWN ?? "200000").toString()),
        MAX_GAS_PRICE_GWEI: Number(settings.MAX_GAS_PRICE_GWEI ?? 1),
        MAX_GAS_LIMIT: Number(settings.MAX_GAS_LIMIT ?? 220000),
        MIN_ETH_BALANCE: ethers.utils.parseEther((settings.MIN_ETH_BALANCE ?? "0.0002").toString()),
        DRY_RUN: Boolean(settings.DRY_RUN ?? true)
    };

    const wallet = new ethers.Wallet(process.env.AFTERSHOCK_PK, ethers.provider);
    const address = wallet.address.toLowerCase();
    const game = new ethers.Contract(net.kill_game_addr, JSON.parse(fs.readFileSync(path.join(__dirname, "../../data/abi/KILLGame.json"), "utf8")).abi, wallet);
    const token = new ethers.Contract(await game.killToken(), ["function balanceOf(address) view returns (uint256)"], wallet);

    console.log(`${BRIGHT}--- AFTERSHOCK AGENT ONLINE ---${RES}`);

    while (true) {
        try {
            const [ethBal, killBal, blockNum] = await Promise.all([
                ethers.provider.getBalance(wallet.address),
                token.balanceOf(wallet.address),
                ethers.provider.getBlockNumber()
            ]);

            const from = Math.max(0, blockNum - conf.LOOKBACK_BLOCKS);
            const killedTopic = game.interface.getEventTopic("Killed");
            const logs = await ethers.provider.getLogs({
                address: net.kill_game_addr,
                topics: [killedTopic],
                fromBlock: from,
                toBlock: blockNum
            });

            const hotStacks = new Map();
            let dominant = null;
            const byAttacker = new Map();
            for (const l of logs) {
                const ev = game.interface.parseLog(l);
                const stackId = Number(ev.args.stackId);
                hotStacks.set(stackId, (hotStacks.get(stackId) || 0) + 1);
                const a = ev.args.attacker.toLowerCase();
                byAttacker.set(a, (byAttacker.get(a) || 0) + 1);
            }
            for (const [a, c] of byAttacker.entries()) {
                if (!dominant || c > dominant.count) dominant = { addr: a, count: c };
            }

            const focus = Array.from(hotStacks.entries())
                .filter(([, c]) => c >= conf.HOT_STACK_MIN_KILLS)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([id]) => id);
            const scoped = new Set([conf.HUB_STACK]);
            for (const s of focus) {
                scoped.add(s);
                for (const n of getNeighbors(s)) scoped.add(n);
            }
            const scanIds = Array.from(scoped.values());
            const raw = await game.callStatic.multicall(scanIds.map((id) => game.interface.encodeFunctionData("getFullStack", [id])));

            const myStacks = [];
            const direct = [];
            const spawnTargets = [];
            for (let i = 0; i < scanIds.length; i++) {
                const stackId = scanIds[i];
                const items = game.interface.decodeFunctionResult("getFullStack", raw[i])[0];
                const self = items.find((it) => it.occupant.toLowerCase() === address);
                const enemies = items.filter((it) => it.occupant.toLowerCase() !== address && (it.units.gt(0) || it.reapers.gt(0)));
                if (self && (self.units.gt(0) || self.reapers.gt(0))) myStacks.push({ id: stackId, self });

                if (self && enemies.length > 0) {
                    const e = enemies.sort((a, b) => b.pendingBounty.gt(a.pendingBounty) ? 1 : -1)[0];
                    const ratio = toRatio(calcPower(self.units, self.reapers), calcPower(e.units, e.reapers));
                    direct.push({ id: stackId, self, enemy: e, ratio });
                }
                for (const e of enemies) {
                    const ep = calcPower(e.units, e.reapers);
                    const sp = calcSpawn(ep, conf.OVERKILL_RATIO);
                    const roi = toRatio(e.pendingBounty, sp.cost);
                    spawnTargets.push({ id: stackId, enemy: e, enemyPower: ep, roi, ...sp });
                }
            }

            console.clear();
            console.log(`${BRIGHT}--- AFTERSHOCK | STATUS ---${RES}`);
            console.table([{
                ETH: ethers.utils.formatEther(ethBal).substring(0, 7),
                KILL: fmt(killBal),
                HOT: focus.length,
                DOM: dominant ? dominant.addr.slice(0, 10) : "none"
            }]);

            const calls = [];
            const bestDirect = direct
                .filter((d) => d.ratio >= conf.MIN_FORCE_RATIO)
                .sort((a, b) => b.enemy.pendingBounty.gt(a.enemy.pendingBounty) ? 1 : -1)[0];

            if (bestDirect) {
                console.log(`${CYA}[AFTERSHOCK] Direct kill @${bestDirect.id} force=${bestDirect.ratio.toFixed(2)}x${RES}`);
                calls.push(game.interface.encodeFunctionData("kill", [
                    bestDirect.enemy.occupant,
                    bestDirect.id,
                    bestDirect.self.units,
                    bestDirect.self.reapers
                ]));
            } else {
                const bestSpawn = spawnTargets
                    .filter((t) => t.roi > 1 && t.enemy.pendingBounty.gte(conf.MIN_BOUNTY_FOR_SPAWN))
                    .sort((a, b) => {
                        const aDom = dominant && a.enemy.occupant.toLowerCase() === dominant.addr ? 1 : 0;
                        const bDom = dominant && b.enemy.occupant.toLowerCase() === dominant.addr ? 1 : 0;
                        if (aDom !== bDom) return bDom - aDom;
                        if (a.roi !== b.roi) return b.roi - a.roi;
                        return b.enemy.pendingBounty.gt(a.enemy.pendingBounty) ? 1 : -1;
                    })[0];
                if (bestSpawn) {
                    console.log(`${PNK}[AFTERSHOCK] Spawn+Kill @${bestSpawn.id} roi=${bestSpawn.roi.toFixed(2)}x${RES}`);
                    calls.push(game.interface.encodeFunctionData("spawn", [bestSpawn.id, bestSpawn.spawnAmt]));
                    calls.push(game.interface.encodeFunctionData("kill", [
                        bestSpawn.enemy.occupant,
                        bestSpawn.id,
                        bestSpawn.spawnAmt,
                        bestSpawn.spawnReaper
                    ]));
                }
            }

            if (calls.length > 0) {
                if (!conf.DRY_RUN && ethBal.lte(conf.MIN_ETH_BALANCE)) {
                    console.log(`${YEL}[HOLD] Low ETH; skipping.${RES}`);
                } else {
                    await game.callStatic.multicall(calls);
                    if (conf.DRY_RUN) {
                        console.log(`${YEL}[DRY_RUN] valid plan, tx skipped.${RES}`);
                    } else {
                        const gasPrice = ethers.utils.parseUnits(conf.MAX_GAS_PRICE_GWEI.toString(), "gwei");
                        const tx = await game.multicall(calls, { gasLimit: conf.MAX_GAS_LIMIT, gasPrice });
                        console.log(`${CYA}>> [TX] ${tx.hash}${RES}`);
                        await tx.wait();
                    }
                }
            } else {
                console.log(`${YEL}[IDLE] No actionable aftershock target.${RES}`);
            }
        } catch (err) {
            console.log(`${PNK}[ERROR] ${err.reason || err.message}${RES}`);
        }
        await new Promise((r) => setTimeout(r, conf.LOOP_DELAY_SECONDS * 1000));
    }
}

if (require.main === module) {
    main();
}
