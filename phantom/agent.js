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
const SPAWN_COST_PER_UNIT = ethers.utils.parseEther("20");

function getCoords(id) {
    const v = Number(id) - 1;
    return { x: v % 6, y: Math.floor(v / 6) % 6, z: Math.floor(v / 36) };
}

function getId(x, y, z) {
    return (z * 36) + (y * 6) + x + 1;
}

function dist(a, b) {
    const c1 = getCoords(a);
    const c2 = getCoords(b);
    return Math.abs(c1.x - c2.x) + Math.abs(c1.y - c2.y) + Math.abs(c1.z - c2.z);
}

function calcPower(units, reapers) {
    return units.add(reapers.mul(REAPER_POWER));
}

function toRatio(numerator, denominator) {
    if (!denominator || denominator.lte(0)) return 0;
    return parseFloat(numerator.mul(10000).div(denominator).toString()) / 10000;
}

function toK(v) {
    return parseFloat(ethers.utils.formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function roundUpToStep(value, step) {
    if (value.isZero()) return value;
    const rem = value.mod(step);
    return rem.isZero() ? value : value.add(step.sub(rem));
}

function calcSpawnPlan(enemyPower, overkillRatio, minSpawn, spawnStep, gasBufferKill) {
    const requiredPower = enemyPower.mul(overkillRatio);
    let spawnAmt = requiredPower.add(POWER_PER_666_SPAWN.sub(1)).div(POWER_PER_666_SPAWN).mul(spawnStep);
    if (spawnAmt.lt(minSpawn)) spawnAmt = minSpawn;
    spawnAmt = roundUpToStep(spawnAmt, spawnStep);
    const spawnReaper = spawnAmt.div(REAPER_POWER);
    const spawnPower = calcPower(spawnAmt, spawnReaper);
    const attackCost = spawnAmt.mul(SPAWN_COST_PER_UNIT).add(gasBufferKill);
    return { spawnAmt, spawnReaper, spawnPower, attackCost };
}

function readAbiFromRepoRoot(relativePath) {
    const full = path.join(__dirname, "../../data/abi", relativePath);
    return JSON.parse(fs.readFileSync(full, "utf8")).abi;
}

function pickByBlockRotation(sortedCandidates, blockNumber, windowSize) {
    if (sortedCandidates.length === 0) return null;
    const topN = Math.max(1, Math.min(windowSize, sortedCandidates.length));
    return sortedCandidates[blockNumber % topN];
}

async function main() {
    if (!process.env.PHANTOM_PK) {
        throw new Error("Missing PHANTOM_PK in .env");
    }

    const wallet = new ethers.Wallet(process.env.PHANTOM_PK, ethers.provider);
    const address = wallet.address.toLowerCase();
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    const settings = cfg.settings || {};
    const net = cfg.network || {};

    const conf = {
        HUB_STACK: Number(settings.HUB_STACK ?? 125),
        LOOP_DELAY_SECONDS: Number(settings.LOOP_DELAY_SECONDS ?? 12),
        MAX_GAS_PRICE_GWEI: Number(settings.MAX_GAS_PRICE_GWEI ?? 3),
        MIN_FORCE_RATIO: Number(settings.MIN_FORCE_RATIO ?? 4),
        SPAWN_PROFITABILITY_THRESHOLD: Number(settings.SPAWN_PROFITABILITY_THRESHOLD ?? 1.1),
        OVERKILL_RATIO: ethers.BigNumber.from(settings.OVERKILL_RATIO ?? 8),
        MIN_SPAWN: ethers.BigNumber.from(settings.MIN_SPAWN ?? 666),
        SPAWN_STEP: ethers.BigNumber.from(settings.SPAWN_STEP ?? 666),
        GAS_BUFFER_KILL: ethers.BigNumber.from(settings.GAS_BUFFER_KILL ?? 0),
        TOP_TARGET_WINDOW: Number(settings.TOP_TARGET_WINDOW ?? 3),
        CLUSTER_RADIUS: Number(settings.CLUSTER_RADIUS ?? 1),
        CLUSTER_WEIGHT: Number(settings.CLUSTER_WEIGHT ?? 0.25),
        MIN_ETH_BALANCE: ethers.utils.parseEther((settings.MIN_ETH_BALANCE ?? "0.003").toString()),
        MIN_HUB_RESERVE: ethers.BigNumber.from(settings.MIN_HUB_RESERVE ?? "500000"),
        SCOUT_SEND_UNITS: ethers.BigNumber.from(settings.SCOUT_SEND_UNITS ?? "2664"),
        DRY_RUN: Boolean(settings.DRY_RUN ?? true)
    };

    const killGame = new ethers.Contract(net.kill_game_addr, readAbiFromRepoRoot("KILLGame.json"), wallet);
    const killTokenAddr = await killGame.killToken();
    const killToken = new ethers.Contract(
        killTokenAddr,
        [
            "function balanceOf(address) view returns (uint256)",
            "function allowance(address, address) view returns (uint256)"
        ],
        wallet
    );

    const allIds = Array.from({ length: GRID_SIZE }, (_, i) => i + 1);

    console.log(`${BRIGHT}--- PHANTOM AGENT ONLINE (UNPREDICTABLE RAIDER) ---${RES}`);

    while (true) {
        try {
            const [ethBal, killBal, allowance] = await Promise.all([
                ethers.provider.getBalance(wallet.address),
                killToken.balanceOf(wallet.address),
                killToken.allowance(wallet.address, net.kill_game_addr)
            ]);

            const readCalls = allIds.map((id) => killGame.interface.encodeFunctionData("getFullStack", [id]));
            const returnData = await killGame.callStatic.multicall(readCalls);

            const myStacks = [];
            const fieldStacks = [];
            const enemyNodes = [];
            let hubSelf = null;
            let hubEnemies = [];

            for (let i = 0; i < returnData.length; i++) {
                const stackId = i + 1;
                const items = killGame.interface.decodeFunctionResult("getFullStack", returnData[i])[0];
                const self = items.find((it) => it.occupant.toLowerCase() === address);
                const enemies = items.filter(
                    (it) => it.occupant.toLowerCase() !== address && (it.units.gt(0) || it.reapers.gt(0))
                );

                if (self && (self.units.gt(0) || self.reapers.gt(0))) {
                    const mine = {
                        id: stackId,
                        units: self.units,
                        reapers: self.reapers,
                        power: calcPower(self.units, self.reapers)
                    };
                    myStacks.push(mine);
                    if (stackId !== conf.HUB_STACK && enemies.length === 0) fieldStacks.push(mine);
                    if (stackId === conf.HUB_STACK) hubSelf = self;
                }

                if (enemies.length > 0) {
                    for (const e of enemies) {
                        enemyNodes.push({
                            id: stackId,
                            enemy: e,
                            enemyPower: calcPower(e.units, e.reapers),
                            bounty: e.pendingBounty ? e.pendingBounty : ethers.BigNumber.from(0)
                        });
                    }
                    if (stackId === conf.HUB_STACK) hubEnemies = enemies;
                }
            }

            console.clear();
            console.log(`${BRIGHT}--- PHANTOM AGENT | STATUS ---${RES}`);
            console.table([{
                ETH: ethers.utils.formatEther(ethBal).substring(0, 7),
                KILL: toK(killBal),
                APPROVED: allowance.gt(ethers.constants.MaxUint256.div(2)) ? "MAX" : toK(allowance),
                MINE: myStacks.length,
                ENEMIES: enemyNodes.length
            }]);

            const txCalls = [];
            const txOpt = {
                gasLimit: 2200000,
                gasPrice: ethers.utils.parseUnits(conf.MAX_GAS_PRICE_GWEI.toString(), "gwei")
            };

            if (hubSelf && hubEnemies.length > 0) {
                const strongest = hubEnemies.reduce((best, e) => {
                    if (!best) return e;
                    const bestPow = calcPower(best.units, best.reapers);
                    const curPow = calcPower(e.units, e.reapers);
                    return curPow.gt(bestPow) ? e : best;
                }, null);
                console.log(`${PNK}[DEFENSE] Hub purge at ${conf.HUB_STACK}${RES}`);
                txCalls.push(killGame.interface.encodeFunctionData("kill", [
                    strongest.occupant,
                    conf.HUB_STACK,
                    hubSelf.units,
                    hubSelf.reapers
                ]));
            } else if (fieldStacks.length > 0 && enemyNodes.length > 0) {
                const candidates = enemyNodes.map((node) => {
                    const nearest = fieldStacks
                        .map((s) => ({ ...s, d: dist(s.id, node.id) }))
                        .sort((a, b) => (a.d - b.d) || (b.power.gt(a.power) ? 1 : -1))[0] || null;

                    const clusterPower = enemyNodes
                        .filter((other) => dist(other.id, node.id) <= conf.CLUSTER_RADIUS)
                        .reduce((acc, other) => acc.add(other.enemyPower), ethers.BigNumber.from(0));

                    const spawnPlan = calcSpawnPlan(
                        node.enemyPower,
                        conf.OVERKILL_RATIO,
                        conf.MIN_SPAWN,
                        conf.SPAWN_STEP,
                        conf.GAS_BUFFER_KILL
                    );
                    const ratio = nearest ? toRatio(nearest.power, node.enemyPower) : 0;
                    const bountyScore = parseFloat(ethers.utils.formatEther(node.bounty));
                    const clusterScore = parseFloat(ethers.utils.formatEther(clusterPower)) * conf.CLUSTER_WEIGHT;
                    const score = nearest
                        ? (bountyScore + clusterScore) / (nearest.d + 1) * Math.max(0.5, ratio / conf.MIN_FORCE_RATIO)
                        : 0;
                    const roi = toRatio(node.bounty, spawnPlan.attackCost);

                    return { ...node, nearest, ratio, score, roi, ...spawnPlan };
                }).filter((c) => c.nearest).sort((a, b) => b.score - a.score);

                const blockNumber = await ethers.provider.getBlockNumber();
                const topN = Math.max(1, Math.min(conf.TOP_TARGET_WINDOW, candidates.length));
                const rotated = [];
                for (let i = 0; i < topN; i++) rotated.push(candidates[(blockNumber + i) % topN]);

                for (const chosen of rotated) {
                    const enoughDirect = chosen.ratio >= conf.MIN_FORCE_RATIO;
                    const attacker = enoughDirect ? chosen.nearest : null;
                    const candidateCalls = [];

                    if (attacker && attacker.id === chosen.id) {
                        candidateCalls.push(killGame.interface.encodeFunctionData("kill", [
                            chosen.enemy.occupant,
                            chosen.id,
                            attacker.units,
                            attacker.reapers
                        ]));
                        console.log(`${PNK}[EXECUTE] Testing direct kill on ${chosen.id}${RES}`);
                    } else if (chosen.roi >= conf.SPAWN_PROFITABILITY_THRESHOLD && killBal.gte(chosen.attackCost)) {
                        if (allowance.lt(chosen.attackCost) && !conf.DRY_RUN) {
                            console.log(`${YEL}[AUTH] Approving KILL spend...${RES}`);
                            await (await killToken.approve(net.kill_game_addr, ethers.constants.MaxUint256)).wait();
                        }
                        candidateCalls.push(killGame.interface.encodeFunctionData("spawn", [chosen.id, chosen.spawnAmt]));
                        candidateCalls.push(killGame.interface.encodeFunctionData("kill", [
                            chosen.enemy.occupant,
                            chosen.id,
                            chosen.spawnAmt,
                            chosen.spawnReaper
                        ]));
                        console.log(`${CYA}[BURST] Testing ${chosen.id} | ROI ${chosen.roi.toFixed(2)}x${RES}`);
                    }

                    if (candidateCalls.length === 0) continue;

                    try {
                        await killGame.callStatic.multicall(candidateCalls, txOpt);
                        txCalls.push(...candidateCalls);
                        console.log(`${CYA}[SELECTED] Candidate ${chosen.id}${RES}`);
                        break;
                    } catch (_err) {
                        console.log(`${YEL}[REJECTED] Candidate ${chosen.id} reverted; trying next.${RES}`);
                    }
                }
            }

            if (txCalls.length === 0) {
                console.log(`${YEL}[IDLE] No safe executable candidate this cycle.${RES}`);
            }

            if (txCalls.length > 0) {
                if (ethBal.lte(conf.MIN_ETH_BALANCE)) {
                    console.log(`${YEL}[SKIP] ETH below floor (${ethers.utils.formatEther(conf.MIN_ETH_BALANCE)}).${RES}`);
                } else {
                    await killGame.callStatic.multicall(txCalls, txOpt);
                    if (conf.DRY_RUN) {
                        console.log(`${YEL}[DRY_RUN] Plan valid; transaction not sent.${RES}`);
                    } else {
                        const tx = await killGame.multicall(txCalls, txOpt);
                        console.log(`${CYA}>> [TX] ${tx.hash}${RES}`);
                        await tx.wait();
                    }
                }
            } else {
                console.log(`${YEL}[IDLE] No valid action this cycle.${RES}`);
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

module.exports = {
    calcPower,
    dist,
    getCoords,
    getId,
    pickByBlockRotation
};
