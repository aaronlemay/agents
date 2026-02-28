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

function calcPower(units, reapers) {
    return units.add(reapers.mul(REAPER_POWER));
}

function ratioNum(n, d) {
    if (!d || d.lte(0)) return 0;
    return Number(ethers.utils.formatEther(n.mul(10000).div(d))) / 10000;
}

function fmtKill(v) {
    return parseFloat(ethers.utils.formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function roundUpStep(v, step) {
    if (v.isZero()) return v;
    const rem = v.mod(step);
    return rem.isZero() ? v : v.add(step.sub(rem));
}

function calcSpawn(enemyPower, overkillRatio) {
    let spawnAmt = enemyPower.mul(overkillRatio).add(POWER_PER_666_SPAWN.sub(1)).div(POWER_PER_666_SPAWN).mul(SPAWN_STEP);
    if (spawnAmt.lt(SPAWN_STEP)) spawnAmt = SPAWN_STEP;
    spawnAmt = roundUpStep(spawnAmt, SPAWN_STEP);
    const spawnReaper = spawnAmt.div(REAPER_POWER);
    const spawnPower = calcPower(spawnAmt, spawnReaper);
    const cost = spawnAmt.mul(SPAWN_COST_PER_UNIT);
    return { spawnAmt, spawnReaper, spawnPower, cost };
}

function pickTopLayers(layerStats, topN) {
    return [...layerStats.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, topN)
        .map(([z]) => z);
}

async function main() {
    const pk = process.env.LAYER_HARVESTER_PK || process.env.SNIPER_PK;
    if (!pk) throw new Error("Missing LAYER_HARVESTER_PK (or SNIPER_PK fallback) in .env");

    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    const settings = cfg.settings || {};
    const net = cfg.network || {};
    const conf = {
        HUB_STACK: Number(settings.HUB_STACK ?? 125),
        LOOP_DELAY_SECONDS: Number(settings.LOOP_DELAY_SECONDS ?? 10),
        TOP_LAYERS: Number(settings.TOP_LAYERS ?? 2),
        MIN_DIRECT_FORCE_RATIO: Number(settings.MIN_DIRECT_FORCE_RATIO ?? 1.4),
        MIN_SPAWN_FORCE_RATIO: Number(settings.MIN_SPAWN_FORCE_RATIO ?? 2.8),
        MIN_SPAWN_ROI: Number(settings.MIN_SPAWN_ROI ?? 1.25),
        MIN_BOUNTY_FOR_SPAWN: ethers.utils.parseEther((settings.MIN_BOUNTY_FOR_SPAWN ?? "25000").toString()),
        MAX_SPAWN_UNITS: ethers.BigNumber.from(settings.MAX_SPAWN_UNITS ?? "3330"),
        ENABLE_SEED_MODE: Boolean(settings.ENABLE_SEED_MODE ?? true),
        SEED_UNITS: ethers.BigNumber.from(settings.SEED_UNITS ?? "666"),
        LOW_TIER_MAX_BOUNTY: ethers.utils.parseEther((settings.LOW_TIER_MAX_BOUNTY ?? "250000").toString()),
        LOW_TIER_MAX_POWER: ethers.BigNumber.from(settings.LOW_TIER_MAX_POWER ?? "50000"),
        EXCLUDE_TOP_THREAT: Boolean(settings.EXCLUDE_TOP_THREAT ?? true),
        OVERKILL_RATIO: ethers.BigNumber.from(settings.OVERKILL_RATIO ?? 6),
        MAX_GAS_PRICE_GWEI: Number(settings.MAX_GAS_PRICE_GWEI ?? 1),
        MAX_GAS_LIMIT: Number(settings.MAX_GAS_LIMIT ?? 220000),
        MAX_ETH_SPEND_PER_TX: ethers.utils.parseEther((settings.MAX_ETH_SPEND_PER_TX ?? "0.00016").toString()),
        MIN_ETH_BALANCE: ethers.utils.parseEther((settings.MIN_ETH_BALANCE ?? "0.00012").toString()),
        PAUSE_AFTER_FAILURES: Number(settings.PAUSE_AFTER_FAILURES ?? 2),
        DRY_RUN: Boolean(settings.DRY_RUN ?? false)
    };

    const wallet = new ethers.Wallet(pk, ethers.provider);
    const address = wallet.address.toLowerCase();
    const game = new ethers.Contract(
        net.kill_game_addr,
        JSON.parse(fs.readFileSync(path.join(__dirname, "../../data/abi/KILLGame.json"), "utf8")).abi,
        wallet
    );
    const token = new ethers.Contract(
        await game.killToken(),
        [
            "function balanceOf(address) view returns (uint256)",
            "function allowance(address, address) view returns (uint256)",
            "function approve(address, uint256) returns (bool)"
        ],
        wallet
    );

    let failStreak = 0;
    const scanIds = Array.from({ length: GRID_SIZE }, (_, i) => i + 1);
    console.log(`${BRIGHT}--- LAYER HARVESTER ONLINE ---${RES}`);

    while (true) {
        try {
            const [ethBal, killBal, allowance] = await Promise.all([
                ethers.provider.getBalance(wallet.address),
                token.balanceOf(wallet.address),
                token.allowance(wallet.address, net.kill_game_addr)
            ]);

            const raw = await game.callStatic.multicall(
                scanIds.map((id) => game.interface.encodeFunctionData("getFullStack", [id]))
            );

            const layerStats = new Map();
            const direct = [];
            const spawn = [];
            const enemyCounts = new Map();
            for (let z = 0; z < 6; z++) layerStats.set(z, { enemies: 0, bounty: ethers.BigNumber.from(0), score: 0 });

            for (let i = 0; i < raw.length; i++) {
                const stackId = scanIds[i];
                const z = getCoords(stackId).z;
                const items = game.interface.decodeFunctionResult("getFullStack", raw[i])[0];
                const self = items.find((it) => it.occupant.toLowerCase() === address);
                const enemies = items.filter((it) => it.occupant.toLowerCase() !== address && (it.units.gt(0) || it.reapers.gt(0)));

                for (const e of enemies) {
                    const stat = layerStats.get(z);
                    stat.enemies += 1;
                    stat.bounty = stat.bounty.add(e.pendingBounty);
                    const k = e.occupant.toLowerCase();
                    enemyCounts.set(k, (enemyCounts.get(k) || 0) + 1);
                }

                if (self && enemies.length > 0) {
                    const selfPower = calcPower(self.units, self.reapers);
                    for (const e of enemies) {
                        const enemyPower = calcPower(e.units, e.reapers);
                        direct.push({
                            id: stackId,
                            z,
                            self,
                            enemy: e,
                            force: ratioNum(selfPower, enemyPower)
                        });
                    }
                }

                for (const e of enemies) {
                    const enemyPower = calcPower(e.units, e.reapers);
                    const sp = calcSpawn(enemyPower, conf.OVERKILL_RATIO);
                    spawn.push({
                        id: stackId,
                        z,
                        enemy: e,
                        enemyPower,
                        force: ratioNum(sp.spawnPower, enemyPower),
                        roi: ratioNum(e.pendingBounty, sp.cost),
                        ...sp
                    });
                }
            }

            for (const [, s] of layerStats.entries()) {
                const bountyEth = Number(ethers.utils.formatEther(s.bounty));
                s.score = (s.enemies * 10) + bountyEth;
            }
            const focusLayers = pickTopLayers(layerStats, conf.TOP_LAYERS);
            let topThreat = null;
            for (const [addrK, count] of enemyCounts.entries()) {
                if (!topThreat || count > topThreat.count) topThreat = { addr: addrK, count };
            }
            const isTopThreat = (addr) => conf.EXCLUDE_TOP_THREAT && topThreat && addr.toLowerCase() === topThreat.addr;
            const isLowTier = (enemyPower, pendingBounty) =>
                enemyPower.lte(conf.LOW_TIER_MAX_POWER) && pendingBounty.lte(conf.LOW_TIER_MAX_BOUNTY);

            const rankDirect = (arr) => arr.sort((a, b) => {
                if (!a.enemy.pendingBounty.eq(b.enemy.pendingBounty)) return b.enemy.pendingBounty.gt(a.enemy.pendingBounty) ? 1 : -1;
                return b.force - a.force;
            })[0];
            const rankSpawn = (arr) => arr.sort((a, b) => {
                if (a.roi !== b.roi) return b.roi - a.roi;
                return b.enemy.pendingBounty.gt(a.enemy.pendingBounty) ? 1 : -1;
            })[0];

            const directBase = direct.filter((d) => focusLayers.includes(d.z) && d.force >= conf.MIN_DIRECT_FORCE_RATIO);
            const directLowTier = directBase.filter((d) => {
                const ep = calcPower(d.enemy.units, d.enemy.reapers);
                return isLowTier(ep, d.enemy.pendingBounty) && !isTopThreat(d.enemy.occupant);
            });
            const directNonThreat = directBase.filter((d) => !isTopThreat(d.enemy.occupant));
            const directChoice = rankDirect(directLowTier) || rankDirect(directNonThreat) || rankDirect(directBase);

            const spawnBase = spawn.filter((s) =>
                focusLayers.includes(s.z) &&
                s.force >= conf.MIN_SPAWN_FORCE_RATIO &&
                s.roi >= conf.MIN_SPAWN_ROI &&
                s.enemy.pendingBounty.gte(conf.MIN_BOUNTY_FOR_SPAWN) &&
                s.spawnAmt.lte(conf.MAX_SPAWN_UNITS)
            );
            const spawnLowTier = spawnBase.filter((s) => isLowTier(s.enemyPower, s.enemy.pendingBounty) && !isTopThreat(s.enemy.occupant));
            const spawnNonThreat = spawnBase.filter((s) => !isTopThreat(s.enemy.occupant));
            const spawnChoice = rankSpawn(spawnLowTier) || rankSpawn(spawnNonThreat) || rankSpawn(spawnBase);

            console.log(`${BRIGHT}--- LAYER HARVESTER | STATUS ---${RES}`);
            console.table([{
                ETH: ethers.utils.formatEther(ethBal).substring(0, 7),
                KILL: fmtKill(killBal),
                ALLOW: allowance.gt(ethers.constants.MaxUint256.div(2)) ? "MAX" : fmtKill(allowance),
                LAYERS: focusLayers.join(","),
                FAILS: failStreak,
                THREAT: topThreat ? `${topThreat.addr.slice(0, 8)}(${topThreat.count})` : "none"
            }]);

            if (failStreak >= conf.PAUSE_AFTER_FAILURES) {
                console.log(`${PNK}[PAUSE] failure streak ${failStreak} reached threshold ${conf.PAUSE_AFTER_FAILURES}.${RES}`);
                await new Promise((r) => setTimeout(r, conf.LOOP_DELAY_SECONDS * 1000));
                continue;
            }

            const calls = [];
            let actionLabel = "";
            if (directChoice) {
                actionLabel = `[DIRECT] kill @${directChoice.id} force=${directChoice.force.toFixed(2)}x`;
                calls.push(game.interface.encodeFunctionData("kill", [
                    directChoice.enemy.occupant,
                    directChoice.id,
                    directChoice.self.units,
                    directChoice.self.reapers
                ]));
            } else if (spawnChoice && ethBal.gt(conf.MIN_ETH_BALANCE) && killBal.gte(spawnChoice.cost)) {
                actionLabel = `[SPAWN] spawn+kill @${spawnChoice.id} roi=${spawnChoice.roi.toFixed(2)}x`;
                if (allowance.lt(spawnChoice.cost) && !conf.DRY_RUN) {
                    console.log(`${YEL}[AUTH] approving token spend...${RES}`);
                    await (await token.approve(net.kill_game_addr, ethers.constants.MaxUint256)).wait();
                }
                calls.push(game.interface.encodeFunctionData("spawn", [spawnChoice.id, spawnChoice.spawnAmt]));
                calls.push(game.interface.encodeFunctionData("kill", [
                    spawnChoice.enemy.occupant,
                    spawnChoice.id,
                    spawnChoice.spawnAmt,
                    spawnChoice.spawnReaper
                ]));
            }

            if (calls.length === 0 && conf.ENABLE_SEED_MODE) {
                const seedTarget = spawn
                    .filter((s) =>
                        focusLayers.includes(s.z) &&
                        s.spawnAmt.lte(conf.MAX_SPAWN_UNITS) &&
                        !isTopThreat(s.enemy.occupant)
                    )
                    .sort((a, b) => b.enemy.pendingBounty.gt(a.enemy.pendingBounty) ? 1 : -1)[0];
                if (seedTarget && killBal.gte(conf.SEED_UNITS.mul(SPAWN_COST_PER_UNIT)) && conf.SEED_UNITS.lte(conf.MAX_SPAWN_UNITS)) {
                    actionLabel = `[SEED] spawn @${seedTarget.id} units=${conf.SEED_UNITS.toString()}`;
                    calls.push(game.interface.encodeFunctionData("spawn", [seedTarget.id, conf.SEED_UNITS]));
                }
            }

            if (calls.length === 0) {
                console.log(`${YEL}[IDLE] no actionable layer-harvest move.${RES}`);
                failStreak = 0;
                await new Promise((r) => setTimeout(r, conf.LOOP_DELAY_SECONDS * 1000));
                continue;
            }

            console.log(`${CYA}${actionLabel}${RES}`);
            await game.callStatic.multicall(calls);
            if (conf.DRY_RUN) {
                console.log(`${YEL}[DRY_RUN] simulation passed. tx skipped.${RES}`);
                failStreak = 0;
                await new Promise((r) => setTimeout(r, conf.LOOP_DELAY_SECONDS * 1000));
                continue;
            }

            const gasPrice = ethers.utils.parseUnits(conf.MAX_GAS_PRICE_GWEI.toString(), "gwei");
            let gasLimit = ethers.BigNumber.from(conf.MAX_GAS_LIMIT);
            try {
                const est = await game.estimateGas.multicall(calls);
                const padded = est.mul(120).div(100);
                gasLimit = padded.lt(gasLimit) ? padded : gasLimit;
            } catch (_e) {
                // Keep configured cap if estimate fails.
            }

            const txCost = gasLimit.mul(gasPrice);
            if (txCost.gt(conf.MAX_ETH_SPEND_PER_TX)) {
                console.log(`${YEL}[HOLD] tx cost ${ethers.utils.formatEther(txCost)} above cap ${ethers.utils.formatEther(conf.MAX_ETH_SPEND_PER_TX)}.${RES}`);
                await new Promise((r) => setTimeout(r, conf.LOOP_DELAY_SECONDS * 1000));
                continue;
            }
            if (ethBal.lte(txCost.mul(105).div(100))) {
                console.log(`${YEL}[HOLD] insufficient ETH for safe send.${RES}`);
                await new Promise((r) => setTimeout(r, conf.LOOP_DELAY_SECONDS * 1000));
                continue;
            }

            const tx = await game.multicall(calls, { gasLimit, gasPrice });
            console.log(`${CYA}>> [TX] ${tx.hash}${RES}`);
            await tx.wait();
            failStreak = 0;
        } catch (err) {
            failStreak += 1;
            console.log(`${PNK}[ERROR] ${err.reason || err.message}${RES}`);
        }
        await new Promise((r) => setTimeout(r, conf.LOOP_DELAY_SECONDS * 1000));
    }
}

if (require.main === module) {
    main();
}
