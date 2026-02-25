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
const SPAWN_COST_PER_UNIT = ethers.BigNumber.from(10);

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
        const fromId = getId(current.x, current.y, current.z);
        if (current.x !== target.x) current.x += target.x > current.x ? 1 : -1;
        else if (current.y !== target.y) current.y += target.y > current.y ? 1 : -1;
        else if (current.z !== target.z) current.z += target.z > current.z ? 1 : -1;
        path.push({ from: fromId, to: getId(current.x, current.y, current.z) });
    }
    return path;
}

function calcPower(units, reapers) {
    return units.add(reapers.mul(REAPER_POWER));
}

function roundUpToStep(value, step) {
    if (value.isZero()) return value;
    const rem = value.mod(step);
    return rem.isZero() ? value : value.add(step.sub(rem));
}

function toFloatRatio(numerator, denominator) {
    if (denominator.lte(0)) return 0;
    return parseFloat(ethers.utils.formatEther(numerator.mul(10000).div(denominator))) / 10000;
}

function calcSpawnPlan(enemyPower, cfg) {
    const requiredPower = enemyPower.mul(cfg.OVERKILL_RATIO);
    let spawnAmt = requiredPower.add(POWER_PER_666_SPAWN.sub(1)).div(POWER_PER_666_SPAWN).mul(cfg.SPAWN_STEP);
    if (spawnAmt.lt(cfg.MIN_SPAWN)) spawnAmt = cfg.MIN_SPAWN;
    spawnAmt = roundUpToStep(spawnAmt, cfg.SPAWN_STEP);

    const spawnReaper = spawnAmt.div(REAPER_POWER);
    const spawnPower = calcPower(spawnAmt, spawnReaper);
    const attackCost = spawnAmt.mul(SPAWN_COST_PER_UNIT).add(cfg.GAS_BUFFER_KILL);
    return { spawnAmt, spawnReaper, spawnPower, attackCost };
}

function formatK(value) {
    return parseFloat(ethers.utils.formatEther(value)).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function pickHighestBountyEnemy(enemies) {
    return enemies.reduce((best, next) => (
        !best || next.pendingBounty.gt(best.pendingBounty) ? next : best
    ), null);
}

async function main() {
    if (!process.env.SNIPER_PK) throw new Error("Missing SNIPER_PK in .env");

    const wallet = new ethers.Wallet(process.env.SNIPER_PK, ethers.provider);
    const address = wallet.address.toLowerCase();
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    const { kill_game_addr, kill_faucet_addr } = config.network;

    const settings = config.settings || {};
    const cfg = {
        HUB_STACK: Number(settings.HUB_STACK ?? 125),
        LOOP_DELAY_SECONDS: Number(settings.LOOP_DELAY_SECONDS ?? 12),
        SPAWN_PROFITABILITY_THRESHOLD: Number(settings.SPAWN_PROFITABILITY_THRESHOLD ?? 1.05),
        MIN_FORCE_RATIO: Number(settings.MIN_FORCE_RATIO ?? 5),
        DIRECT_KILL_MIN_FORCE_RATIO: Number(settings.DIRECT_KILL_MIN_FORCE_RATIO ?? 1.5),
        MIN_BOUNTY_FOR_SPAWN: ethers.utils.parseEther((settings.MIN_BOUNTY_FOR_SPAWN ?? "250000").toString()),
        THREAT_MIN_FORCE_RATIO: Number(settings.THREAT_MIN_FORCE_RATIO ?? 6),
        OVERKILL_RATIO: ethers.BigNumber.from(settings.OVERKILL_RATIO ?? 8),
        MIN_SPAWN: ethers.BigNumber.from(settings.MIN_SPAWN ?? 666),
        SPAWN_STEP: ethers.BigNumber.from(settings.SPAWN_STEP ?? 666),
        GAS_BUFFER_KILL: ethers.BigNumber.from(settings.GAS_BUFFER_KILL ?? 0),
        MIN_ETH_BALANCE: ethers.utils.parseEther((settings.MIN_ETH_BALANCE ?? "0.002").toString()),
        MAX_GAS_PRICE_GWEI: Number(settings.MAX_GAS_PRICE_GWEI ?? 2),
        MAX_GAS_LIMIT: Number(settings.MAX_GAS_LIMIT ?? 1200000),
        THREAT_STACK_THRESHOLD: Number(settings.THREAT_STACK_THRESHOLD ?? 14),
        THREAT_LAYER_STACK_THRESHOLD: Number(settings.THREAT_LAYER_STACK_THRESHOLD ?? 6),
        THREAT_POWER_THRESHOLD: ethers.BigNumber.from(settings.THREAT_POWER_THRESHOLD ?? "400000"),
        MAX_ATTACK_HOPS_FROM_HUB_UNDER_THREAT: Number(settings.MAX_ATTACK_HOPS_FROM_HUB_UNDER_THREAT ?? 2),
        MAX_STRANDED_BEFORE_RETREAT: Number(settings.MAX_STRANDED_BEFORE_RETREAT ?? 4),
        MAX_DISPLAY_TARGETS: Number(settings.MAX_DISPLAY_TARGETS ?? 10),
        DRY_RUN: Boolean(settings.DRY_RUN ?? false)
    };

    const killGame = new ethers.Contract(
        kill_game_addr,
        JSON.parse(fs.readFileSync(path.join(__dirname, "../../data/abi/KILLGame.json"), "utf8")).abi,
        wallet
    );

    const killTokenAddr = await killGame.killToken();
    const erc20Abi = [
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address, address) view returns (uint256)",
        "function approve(address, uint256) returns (bool)"
    ];
    const killToken = new ethers.Contract(killTokenAddr, erc20Abi, wallet);

    const killFaucet = new ethers.Contract(
        kill_faucet_addr,
        JSON.parse(fs.readFileSync(path.join(__dirname, "../../data/abi/KILLFaucet.json"), "utf8")).abi,
        wallet
    );

    console.log(`${BRIGHT}--- SNIPER AGENT ONLINE ---${RES}`);

    try {
        const alreadyClaimed = await killFaucet.hasClaimed(wallet.address);
        if (!alreadyClaimed) {
            console.log(`${YEL}[STARTUP] Claiming faucet...${RES}`);
            const faucetTx = await killFaucet.pullKill({ gasLimit: 200000 });
            await faucetTx.wait();
            console.log(`${CYA}[SUCCESS] 666,000 KILL claimed.${RES}`);
        } else {
            console.log("[STARTUP] Faucet already claimed.");
        }
    } catch (e) {
        console.log(`${PNK}[STARTUP] Faucet skipped: ${e.reason || e.message}${RES}`);
    }

    let hasTreasuryStats = true;
    while (true) {
        try {
            const [ethBal, killBal, killAllow] = await Promise.all([
                ethers.provider.getBalance(wallet.address),
                killToken.balanceOf(wallet.address),
                killToken.allowance(wallet.address, kill_game_addr)
            ]);
            let treasuryStats = {
                totalTreasury: ethers.BigNumber.from(0),
                globalMaxBounty: ethers.BigNumber.from(0)
            };
            if (hasTreasuryStats) {
                try {
                    treasuryStats = await killGame.getTreasuryStats();
                } catch (_err) {
                    hasTreasuryStats = false;
                    console.log(`${YEL}[WARN] getTreasuryStats unavailable on this deployment; continuing without treasury metrics.${RES}`);
                }
            }

            const scanIds = Array.from({ length: GRID_SIZE }, (_, i) => i + 1);
            const stackCalls = scanIds.map((id) => killGame.interface.encodeFunctionData("getFullStack", [id]));
            const results = await killGame.callStatic.multicall(stackCalls);

            const myStrandedStacks = [];
            const directKillOps = [];
            const targets = [];
            const enemyPressure = new Map();
            let hubSelf = null;
            let hubEnemy = null;

            for (let i = 0; i < GRID_SIZE; i++) {
                const stackId = i + 1;
                const items = killGame.interface.decodeFunctionResult("getFullStack", results[i])[0];
                const self = items.find((it) => it.occupant.toLowerCase() === address);
                const enemies = items.filter(
                    (it) => it.occupant.toLowerCase() !== address && (it.units.gt(0) || it.reapers.gt(0))
                );

                if (self && stackId !== cfg.HUB_STACK && (self.units.gt(0) || self.reapers.gt(0))) {
                    myStrandedStacks.push({ id: stackId, units: self.units, reapers: self.reapers });
                }

                if (stackId === cfg.HUB_STACK) {
                    hubSelf = self || null;
                    if (enemies.length > 0) {
                        hubEnemy = pickHighestBountyEnemy(enemies);
                    }
                }

                for (const e of enemies) {
                    const enemyPower = calcPower(e.units, e.reapers);
                    const spawnPlan = calcSpawnPlan(enemyPower, cfg);
                    const forceRatio = toFloatRatio(spawnPlan.spawnPower, enemyPower);
                    const roiRatio = toFloatRatio(e.pendingBounty, spawnPlan.attackCost);
                    const enemyAddr = e.occupant.toLowerCase();
                    const z = getCoords(stackId).z;
                    const cur = enemyPressure.get(enemyAddr) || {
                        count: 0,
                        totalPower: ethers.BigNumber.from(0),
                        layers: new Map()
                    };
                    cur.count += 1;
                    cur.totalPower = cur.totalPower.add(enemyPower);
                    cur.layers.set(z, (cur.layers.get(z) || 0) + 1);
                    enemyPressure.set(enemyAddr, cur);

                    targets.push({
                        id: stackId,
                        enemy: e,
                        enemyPower,
                        forceRatio,
                        roiRatio,
                        ...spawnPlan
                    });
                }

                // Capital-efficient: if we already occupy a stack with enemies, prefer direct kill (no spawn).
                if (self && stackId !== cfg.HUB_STACK && enemies.length > 0) {
                    const selfPower = calcPower(self.units, self.reapers);
                    const bestLocalEnemy = pickHighestBountyEnemy(enemies);
                    const localEnemyPower = calcPower(bestLocalEnemy.units, bestLocalEnemy.reapers);
                    const localForce = toFloatRatio(selfPower, localEnemyPower);
                    directKillOps.push({
                        id: stackId,
                        self,
                        enemy: bestLocalEnemy,
                        forceRatio: localForce
                    });
                }
            }

            const rankedTargets = targets.sort((a, b) => b.roiRatio - a.roiRatio);
            let dominantThreat = null;
            for (const [addr, p] of enemyPressure.entries()) {
                let maxLayerCount = 0;
                for (const c of p.layers.values()) maxLayerCount = Math.max(maxLayerCount, c);
                const threatening = (
                    p.count >= cfg.THREAT_STACK_THRESHOLD ||
                    maxLayerCount >= cfg.THREAT_LAYER_STACK_THRESHOLD ||
                    p.totalPower.gte(cfg.THREAT_POWER_THRESHOLD)
                );
                if (threatening) {
                    if (!dominantThreat || p.totalPower.gt(dominantThreat.totalPower)) {
                        dominantThreat = { addr, ...p, maxLayerCount };
                    }
                }
            }

            const effectiveMinForce = dominantThreat ? cfg.THREAT_MIN_FORCE_RATIO : cfg.MIN_FORCE_RATIO;
            const nearHubTargets = rankedTargets.filter((t) => getPath3D(cfg.HUB_STACK, t.id).length <= cfg.MAX_ATTACK_HOPS_FROM_HUB_UNDER_THREAT);
            const candidateTargetsBase = dominantThreat
                ? (nearHubTargets.length > 0 ? nearHubTargets : rankedTargets)
                : rankedTargets;
            const candidateTargets = dominantThreat
                ? candidateTargetsBase.slice().sort((a, b) => {
                    const aThreat = a.enemy.occupant.toLowerCase() === dominantThreat.addr ? 1 : 0;
                    const bThreat = b.enemy.occupant.toLowerCase() === dominantThreat.addr ? 1 : 0;
                    if (aThreat !== bThreat) return bThreat - aThreat;
                    if (!a.enemy.pendingBounty.eq(b.enemy.pendingBounty)) return b.enemy.pendingBounty.gt(a.enemy.pendingBounty) ? 1 : -1;
                    return b.roiRatio - a.roiRatio;
                })
                : candidateTargetsBase;
            const best = candidateTargets[0];

            console.clear();
            console.log(`${BRIGHT}--- SNIPER AGENT | STATUS ---${RES}`);
            console.table([{
                ETH: ethers.utils.formatEther(ethBal).substring(0, 7),
                KILL: formatK(killBal),
                APPROVED: killAllow.gt(ethers.constants.MaxUint256.div(2)) ? "MAX" : formatK(killAllow),
                TREASURY: formatK(treasuryStats.totalTreasury),
                MAX_BOUNTY: formatK(treasuryStats.globalMaxBounty)
            }]);
            if (dominantThreat) {
                console.log(
                    `${YEL}[THREAT] ${dominantThreat.addr.slice(0, 10)} stacks=${dominantThreat.count} maxLayer=${dominantThreat.maxLayerCount} power=${dominantThreat.totalPower.toString()}${RES}`
                );
            }

            if (myStrandedStacks.length > 0) {
                console.log(`\n${BRIGHT}${PNK}STRANDED UNITS${RES}`);
                myStrandedStacks.forEach((s) => {
                    const hops = getPath3D(s.id, cfg.HUB_STACK).length;
                    console.log(`ID: ${String(s.id).padEnd(4)} | Units: ${s.units.toString().padEnd(6)} | Hops: ${hops}`);
                });
            }

            console.log(`\n${BRIGHT}ID   | ENEMY      | POWER  | BOUNTY   | ROI   | FORCE | STATUS${RES}`);
            console.log("-----|------------|--------|----------|-------|-------|-------");
            rankedTargets.slice(0, cfg.MAX_DISPLAY_TARGETS).forEach((t) => {
                const passRoi = t.roiRatio >= cfg.SPAWN_PROFITABILITY_THRESHOLD;
                const passForce = t.forceRatio >= effectiveMinForce;
                let status = "LOW_ROI";
                if (passRoi && !passForce) status = "LOW_FORCE";
                if (passRoi && passForce && killBal.lt(t.attackCost)) status = "NO_KILL";
                if (passRoi && passForce && killBal.gte(t.attackCost)) status = `${CYA}READY${RES}`;
                console.log(
                    `${String(t.id).padEnd(4)} | ${t.enemy.occupant.slice(0, 10)} | ${t.enemyPower.toString().padEnd(6)} | ${formatK(t.enemy.pendingBounty).padEnd(8)} | ${t.roiRatio.toFixed(2)}x | ${t.forceRatio.toFixed(2)}x | ${status}`
                );
            });

            const calls = [];
            let defendedHub = false;
            const directKill = directKillOps
                .filter((op) => op.forceRatio >= cfg.DIRECT_KILL_MIN_FORCE_RATIO)
                .sort((a, b) => {
                    if (!a.enemy.pendingBounty.eq(b.enemy.pendingBounty)) return b.enemy.pendingBounty.gt(a.enemy.pendingBounty) ? 1 : -1;
                    return b.forceRatio - a.forceRatio;
                })[0];
            // Priority 1: Hub touched -> immediate purge.
            if (hubEnemy && hubSelf) {
                const ownHubPower = calcPower(hubSelf.units, hubSelf.reapers);
                const enemyHubPower = calcPower(hubEnemy.units, hubEnemy.reapers);
                const hubForceRatio = toFloatRatio(ownHubPower, enemyHubPower);

                if (hubForceRatio >= cfg.MIN_FORCE_RATIO) {
                    console.log(`\n${PNK}[DEFENSE] Hub purge at ${cfg.HUB_STACK} | ${hubForceRatio.toFixed(2)}x${RES}`);
                    calls.push(
                        killGame.interface.encodeFunctionData("kill", [
                            hubEnemy.occupant,
                            cfg.HUB_STACK,
                            hubSelf.units,
                            hubSelf.reapers
                        ])
                    );
                    defendedHub = true;
                } else {
                    console.log(`\n${YEL}[DEFENSE] Hub touched but force ${hubForceRatio.toFixed(2)}x below ${cfg.MIN_FORCE_RATIO}x; switching to counter actions.${RES}`);
                }
            }
            // Priority 2: Harvest guaranteed local bounty first (no spawn cost).
            if (!defendedHub && directKill) {
                console.log(`\n${CYA}[HUNTER] Direct kill on ${directKill.id} | force ${directKill.forceRatio.toFixed(2)}x${RES}`);
                calls.push(
                    killGame.interface.encodeFunctionData("kill", [
                        directKill.enemy.occupant,
                        directKill.id,
                        directKill.self.units,
                        directKill.self.reapers
                    ])
                );
            }
            // Priority 3: Under layer-wipe pressure, consolidate first.
            else if (!defendedHub && dominantThreat && myStrandedStacks.length > 0) {
                const retreat = myStrandedStacks
                    .map((s) => ({ ...s, hops: getPath3D(s.id, cfg.HUB_STACK).length }))
                    .sort((a, b) => b.hops - a.hops)[0];
                const moveStep = getPath3D(retreat.id, cfg.HUB_STACK)[0];
                if (moveStep) {
                    console.log(`\n${YEL}[COUNTER] Consolidating ${retreat.id} -> ${moveStep.to} under threat${RES}`);
                    calls.push(killGame.interface.encodeFunctionData("move", [moveStep.from, moveStep.to, retreat.units, retreat.reapers]));
                }
            }
            // Priority 4: Spawn+kill only for larger bounties with safe force.
            else if (!defendedHub && best && best.roiRatio >= cfg.SPAWN_PROFITABILITY_THRESHOLD && best.forceRatio >= effectiveMinForce) {
                if (best.enemy.pendingBounty.gte(cfg.MIN_BOUNTY_FOR_SPAWN) && ethBal.gt(cfg.MIN_ETH_BALANCE) && killBal.gte(best.attackCost)) {
                    if (killAllow.lt(best.attackCost)) {
                        console.log(`${YEL}[AUTH] Approving...${RES}`);
                        await (await killToken.approve(kill_game_addr, ethers.constants.MaxUint256)).wait();
                    }
                    console.log(`\n${PNK}[ATTACK] Snipe ${best.id} | ROI ${best.roiRatio.toFixed(2)}x | Force ${best.forceRatio.toFixed(2)}x${RES}`);
                    calls.push(killGame.interface.encodeFunctionData("spawn", [best.id, best.spawnAmt]));
                    calls.push(
                        killGame.interface.encodeFunctionData("kill", [
                            best.enemy.occupant,
                            best.id,
                            best.spawnAmt,
                            best.spawnReaper
                        ])
                    );
                }
            }
            // Priority 5: Consolidate one stranded stack.
            else if (!defendedHub && myStrandedStacks.length > 0) {
                const s = myStrandedStacks[0];
                const moveStep = getPath3D(s.id, cfg.HUB_STACK)[0];
                if (moveStep) {
                    console.log(`\n${YEL}[RETREAT] Moving ${s.id} -> ${moveStep.to}${RES}`);
                    calls.push(killGame.interface.encodeFunctionData("move", [moveStep.from, moveStep.to, s.units, s.reapers]));
                }
            }

            if (calls.length > 0) {
                if (!cfg.DRY_RUN && ethBal.lte(cfg.MIN_ETH_BALANCE)) {
                    console.log(`${YEL}[HOLD] ETH ${ethers.utils.formatEther(ethBal)} below floor ${ethers.utils.formatEther(cfg.MIN_ETH_BALANCE)}; skipping tx.${RES}`);
                } else {
                // Pre-flight simulation to avoid revert costs.
                await killGame.callStatic.multicall(calls);
                if (cfg.DRY_RUN) {
                    console.log(`${YEL}[DRY_RUN] Simulation passed. Transaction not sent.${RES}`);
                } else {
                    let gasLimit = ethers.BigNumber.from(cfg.MAX_GAS_LIMIT);
                    const gasPrice = ethers.utils.parseUnits(cfg.MAX_GAS_PRICE_GWEI.toString(), "gwei");
                    try {
                        const est = await killGame.estimateGas.multicall(calls);
                        const padded = est.mul(120).div(100);
                        gasLimit = padded.lt(gasLimit) ? padded : gasLimit;
                    } catch (_estErr) {
                        // Fallback to configured cap if estimate fails.
                    }

                    const txCostWei = gasLimit.mul(gasPrice);
                    if (ethBal.lte(txCostWei.mul(105).div(100))) {
                        console.log(`${YEL}[HOLD] Est. tx cost ${ethers.utils.formatEther(txCostWei)} ETH exceeds safe spend at current balance ${ethers.utils.formatEther(ethBal)}.${RES}`);
                    } else {
                        const tx = await killGame.multicall(calls, {
                            gasLimit,
                            gasPrice
                        });
                        console.log(`${CYA}>> [TX]: ${tx.hash}${RES}`);
                        await tx.wait();
                    }
                }
                }
            }
        } catch (err) {
            console.error("\n[ERROR]", err.reason || err.message);
        }
        await new Promise((r) => setTimeout(r, cfg.LOOP_DELAY_SECONDS * 1000));
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    calcPower,
    calcSpawnPlan,
    roundUpToStep,
    toFloatRatio,
    pickHighestBountyEnemy,
    getPath3D,
    getCoords,
    getId
};
