const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
require("dotenv").config();

const YEL = "\x1b[33m"; const CYA = "\x1b[36m"; const PNK = "\x1b[35m"; const RES = "\x1b[0m"; const BRIGHT = "\x1b[1m";

async function getRecentKills(url) {
    const query = `{
        killeds(orderBy: block_number, orderDirection: desc, first: 10) {
            id
            stackId
            target
            block_number
        }
    }`;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query })
    });
    const result = await resp.json();
    return result.data.killeds;
}

async function main() {
    const pk = process.env.AFTERSHOCK_PK || process.env.SNIPER_PK;
    if (!pk) throw new Error("Missing AFTERSHOCK_PK or SNIPER_PK in .env");
    const wallet = new ethers.Wallet(pk, ethers.provider);
    
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    const {
        LOOP_DELAY_SECONDS = 12,
        SUBGRAPH_URL,
        KILL_MULTIPLIER = 3,
        MIN_SPAWN = 666,
        MAX_KILL = 1000000,
        DRY_RUN = true,
        MAX_GAS_LIMIT = 1400000,
        MAX_GAS_PRICE_GWEI = 1,
        FALLBACK_IDLE_CYCLES = 6,
        FALLBACK_STACKS = [138, 125, 93, 22, 152, 185],
        FALLBACK_MIN_BOUNTY = "15000",
        FALLBACK_MIN_ROI = 1.15
    } = config.settings;
    const { kill_game_addr } = config.network;
    
    const killGame = new ethers.Contract(kill_game_addr, JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/abi/KILLGame.json'), 'utf8')).abi, wallet);
    const killToken = new ethers.Contract(await killGame.killToken(), ["function balanceOf(address) view returns (uint256)", "function allowance(address, address) view returns (uint256)", "function approve(address, uint256) returns (bool)"], wallet);
    const fallbackMinBountyWei = ethers.utils.parseEther(String(FALLBACK_MIN_BOUNTY));
    
    let processedKills = new Set();
    let pendingAttacks = []; // Run A -> Run B memory
    let isFirstRun = true;
    let idleCycles = 0;

    async function trySpawnKill(attack, ethBal, killBal, killAllow) {
        const stackCall = [killGame.interface.encodeFunctionData("getFullStack", [attack.stackId])];
        const stackResults = await killGame.callStatic.multicall(stackCall);
        const freshItems = killGame.interface.decodeFunctionResult("getFullStack", stackResults[0])[0];
        const targetData = freshItems.find((it) => it.occupant.toLowerCase() === attack.target.toLowerCase());

        if (!targetData || targetData.units.eq(0)) {
            console.log(`${YEL}[SKIP] Target no longer present on stack ${attack.stackId}.${RES}`);
            return false;
        }

        const effectivePower = targetData.units.add(targetData.reapers.mul(666));
        if (effectivePower.gt(MAX_KILL)) {
            console.log(`${YEL}[SKIP] Target too powerful: ${effectivePower.toString()} > MAX_KILL ${MAX_KILL}${RES}`);
            return false;
        }

        let spawnAmt = effectivePower.mul(KILL_MULTIPLIER);
        if (spawnAmt.lt(MIN_SPAWN)) spawnAmt = ethers.BigNumber.from(MIN_SPAWN);
        const spawnReaper = spawnAmt.div(666);
        const requiredCostWei = ethers.utils.parseEther(spawnAmt.mul(20).toString());
        const roiNum = Number(targetData.pendingBounty.mul(1000).div(requiredCostWei).toString()) / 1000;
        console.log(`${YEL}[PLAN] stack=${attack.stackId} target=${targetData.occupant.slice(0,10)} bounty=${ethers.utils.formatEther(targetData.pendingBounty)} cost=${ethers.utils.formatEther(requiredCostWei)} roi=${roiNum.toFixed(2)}x${RES}`);

        if (targetData.pendingBounty.lt(fallbackMinBountyWei) || roiNum < Number(FALLBACK_MIN_ROI)) {
            console.log(`${YEL}[SKIP] Fallback gates failed (minBounty=${FALLBACK_MIN_BOUNTY}, minROI=${FALLBACK_MIN_ROI}).${RES}`);
            return false;
        }

        if (killAllow.lt(requiredCostWei)) {
            console.log(`${YEL}[AUTH] Allowance too low. Approving MAX...${RES}`);
            await (await killToken.approve(kill_game_addr, ethers.constants.MaxUint256)).wait();
        }

        if (killBal.lt(requiredCostWei)) {
            console.log(`${YEL}[SKIP] Insufficient KILL for planned spawn.${RES}`);
            return false;
        }
        if (ethBal.lte(ethers.utils.parseEther("0.002"))) {
            console.log(`${YEL}[SKIP] ETH below safety floor.${RES}`);
            return false;
        }

        const calls = [
            killGame.interface.encodeFunctionData("spawn", [attack.stackId, spawnAmt]),
            killGame.interface.encodeFunctionData("kill", [attack.target, attack.stackId, spawnAmt, spawnReaper])
        ];
        try {
            await killGame.callStatic.multicall(calls);
            if (DRY_RUN) {
                console.log(`${YEL}[DRY_RUN] Simulation passed. Transaction not sent.${RES}`);
            } else {
                const tx = await killGame.connect(wallet).multicall(calls, {
                    gasLimit: Number(MAX_GAS_LIMIT),
                    gasPrice: ethers.utils.parseUnits(String(MAX_GAS_PRICE_GWEI), "gwei")
                });
                console.log(`${CYA}>> [TX SENT]: ${tx.hash}${RES}`);
                await tx.wait();
                console.log(`${CYA}>> [TX CONFIRMED]${RES}`);
            }
            return true;
        } catch (e) {
            console.log(`${YEL}[TX REVERTED] Battle failed: ${e.message}${RES}`);
            return false;
        }
    }

    console.log(`${BRIGHT}--- AFTERSHOCK AGENT ONLINE ---${RES}`);

    while (true) {
        try {
            const ethBal = await ethers.provider.getBalance(wallet.address);
            const killBal = await killToken.balanceOf(wallet.address);
            const killAllow = await killToken.allowance(wallet.address, kill_game_addr);

            // 1. EXECUTION PHASE (Handle pending attacks from previous run)
            if (pendingAttacks.length > 0) {
                const attack = pendingAttacks.shift();
                console.log(`\n${PNK}[RUN B: EXECUTION] Killing ${attack.target.slice(0,10)} on Stack ${attack.stackId}${RES}`);
                const ok = await trySpawnKill(attack, ethBal, killBal, killAllow);
                if (ok) idleCycles = 0;
            }

            // 2. DETECTION PHASE (Run A)
            const recentKills = await getRecentKills(SUBGRAPH_URL);
            
            if (isFirstRun) {
                recentKills.forEach(k => processedKills.add(k.id));
                console.log(`${YEL}[BASELINE] ${processedKills.size} kills recorded. Watching for new aftershocks...${RES}`);
                isFirstRun = false;
            } else {
                for (const k of recentKills) {
                    if (processedKills.has(k.id)) continue;

                    const stackId = parseInt(k.stackId);
                    const stackCall = [killGame.interface.encodeFunctionData("getFullStack", [stackId])];
                    const stackResults = await killGame.callStatic.multicall(stackCall);
                    const items = killGame.interface.decodeFunctionResult("getFullStack", stackResults[0])[0];

                    // Find the address that just won the last battle
                    const targetData = items.find(it => it.occupant.toLowerCase() === k.target.toLowerCase());

                    if (targetData && targetData.occupant.toLowerCase() !== wallet.address.toLowerCase()) {
                        const effectivePower = targetData.units.add(targetData.reapers.mul(666));

                        if (effectivePower.gt(MAX_KILL)) {
                            console.log(`${YEL}[SKIP] Stack ${stackId} too powerful: ${effectivePower.toString()} > MAX_KILL ${MAX_KILL}${RES}`);
                        } else {
                            let spawnAmt = effectivePower.mul(KILL_MULTIPLIER);
                            if (spawnAmt.lt(MIN_SPAWN)) spawnAmt = ethers.BigNumber.from(MIN_SPAWN);
                            const estCost = spawnAmt.mul(20);

                            console.log(`\n${BRIGHT}[RUN A: DETECTION] New Kill on Stack ${stackId}${RES}`);
                            console.log(`Target: ${targetData.occupant}`);
                            console.log(`Units: ${targetData.units.toString()} | Reapers: ${targetData.reapers.toString()} | Effective: ${effectivePower.toString()}`);
                            console.log(`Sending: ~${spawnAmt.toString()} (est) | Cost: ${estCost.toString()} KILL`);

                            pendingAttacks.push({ stackId, target: targetData.occupant });
                        }
                    }
                    processedKills.add(k.id);
                }
            }

            if (pendingAttacks.length === 0) {
                idleCycles += 1;
            } else {
                idleCycles = 0;
            }

            if (idleCycles >= Number(FALLBACK_IDLE_CYCLES) && pendingAttacks.length === 0) {
                console.log(`${YEL}[FALLBACK] idle=${idleCycles}, probing hotspots...${RES}`);
                let best = null;
                const stackCalls = FALLBACK_STACKS.map((id) => killGame.interface.encodeFunctionData("getFullStack", [Number(id)]));
                const stackResults = await killGame.callStatic.multicall(stackCalls);
                for (let i = 0; i < FALLBACK_STACKS.length; i++) {
                    const sid = Number(FALLBACK_STACKS[i]);
                    const items = killGame.interface.decodeFunctionResult("getFullStack", stackResults[i])[0];
                    for (const it of items) {
                        if (it.occupant.toLowerCase() === wallet.address.toLowerCase()) continue;
                        const power = it.units.add(it.reapers.mul(666));
                        if (power.gt(MAX_KILL)) continue;
                        let spawnAmt = power.mul(KILL_MULTIPLIER);
                        if (spawnAmt.lt(MIN_SPAWN)) spawnAmt = ethers.BigNumber.from(MIN_SPAWN);
                        const requiredCostWei = ethers.utils.parseEther(spawnAmt.mul(20).toString());
                        if (requiredCostWei.lte(0)) continue;
                        const roiNum = Number(it.pendingBounty.mul(1000).div(requiredCostWei).toString()) / 1000;
                        if (it.pendingBounty.lt(fallbackMinBountyWei) || roiNum < Number(FALLBACK_MIN_ROI)) continue;
                        if (!best || it.pendingBounty.gt(best.pendingBounty)) {
                            best = { stackId: sid, target: it.occupant, pendingBounty: it.pendingBounty, roi: roiNum };
                        }
                    }
                }
                if (best) {
                    console.log(`${YEL}[FALLBACK] enqueue stack=${best.stackId} bounty=${ethers.utils.formatEther(best.pendingBounty)} roi=${best.roi.toFixed(2)}x${RES}`);
                    pendingAttacks.push({ stackId: best.stackId, target: best.target });
                } else {
                    console.log(`${YEL}[FALLBACK] no viable hotspot target.${RES}`);
                }
                idleCycles = 0;
            }

            // 3. STATUS LOGGING
            console.log(`${BRIGHT}--- STATUS | ETH: ${ethers.utils.formatEther(ethBal).slice(0,6)} | KILL: ${(parseFloat(ethers.utils.formatEther(killBal))/1000).toFixed(1)}k | PENDING: ${pendingAttacks.length} | IDLE: ${idleCycles} ---${RES}`);

        } catch (err) { console.error("\n[ERROR]", err.message); }
        await new Promise(r => setTimeout(r, LOOP_DELAY_SECONDS * 1000));
    }
}
main();
