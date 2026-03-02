const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

function getCoords(id) {
    const v = Number(id) - 1;
    return { x: v % 6, y: Math.floor(v / 6) % 6, z: Math.floor(v / 36) };
}

function getManhattanDist(id1, id2) {
    const c1 = getCoords(id1);
    const c2 = getCoords(id2);
    return Math.abs(c1.x - c2.x) + Math.abs(c1.y - c2.y) + Math.abs(c1.z - c2.z);
}

function isAdjacent(id1, id2) { return getManhattanDist(id1, id2) === 1; }
function calcPower(units, reapers) { return units.add(reapers.mul(666)); }
function bnCmpDesc(a, b) {
    if (a.eq(b)) return 0;
    return a.gt(b) ? -1 : 1;
}
function strongestEnemy(enemies) {
    return enemies.reduce((best, e) => {
        if (!best) return e;
        const pBest = calcPower(best.units, best.reapers);
        const pE = calcPower(e.units, e.reapers);
        return pE.gt(pBest) ? e : best;
    }, null);
}

function hasMethod(contract, name) {
    return typeof contract[name] === "function";
}

async function countdown(seconds) {
    for (let i = seconds; i > 0; i--) {
        process.stdout.write(`\r[WAIT] Next scan in ${i}s... `);
        await new Promise(r => setTimeout(r, 1000));
    }
    process.stdout.write('\r\x1b[K');
}

async function main() {
    if (!process.env.FORTRESS_PK) throw new Error("Missing FORTRESS_PK in .env");
    const wallet = new ethers.Wallet(process.env.FORTRESS_PK, ethers.provider);
    const address = wallet.address;
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    const { kill_game_addr, kill_faucet_addr } = config.network;
    const {
        HUB_STACK,
        TARGET_POWER,
        REPLENISH_AMT,
        LOOP_DELAY_SECONDS,
        HUB_PERIMETER,
        MAX_GAS_PRICE_GWEI,
        DRY_RUN,
        MIN_RAID_FORCE_RATIO,
        MIN_HUB_UNITS
    } = config.settings;

    const killGame = new ethers.Contract(kill_game_addr, JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/abi/KILLGame.json'), 'utf8')).abi, wallet);
    const killTokenAddr = await killGame.killToken();
    const killToken = new ethers.Contract(killTokenAddr, ['function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)', 'function approve(address, uint256) returns (bool)', 'function transfer(address, uint256) returns (bool)'], wallet);

    const killFaucet = (
        kill_faucet_addr &&
        kill_faucet_addr !== ethers.constants.AddressZero
    ) ? new ethers.Contract(
        kill_faucet_addr,
        JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/abi/KILLFaucet.json'), 'utf8')).abi,
        wallet
    ) : null;

    const ALL_IDS = Array.from({length: 216}, (_, i) => i + 1);
    const PATROL_ZONE = ALL_IDS.filter(id => id !== HUB_STACK && getManhattanDist(HUB_STACK, id) <= HUB_PERIMETER);
    const SAFE_ZONE = [HUB_STACK, ...PATROL_ZONE];

    console.log(`\n--- FORTRESS AGENT: ATOMIC LIQUIDATION MODE ---`);

    if (killFaucet && hasMethod(killFaucet, "hasClaimed") && hasMethod(killFaucet, "pullKill")) {
        try {
            const alreadyClaimed = await killFaucet.hasClaimed(address);
            if (!alreadyClaimed) {
                console.log(`[STARTUP] Attempting KILL Faucet pull...`);
                const faucetTx = await killFaucet.pullKill({ gasLimit: 200000 });
                await faucetTx.wait();
                console.log(`[SUCCESS] 666,000 KILL pulled from faucet.`);
            } else {
                console.log(`[STARTUP] Faucet already claimed.`);
            }
        } catch (e) {
            console.log(`[STARTUP] Faucet skip: ${e.reason || e.message}`);
        }
    } else {
        console.log(`[STARTUP] Faucet unavailable on this deployment; continuing without faucet pull.`);
    }

    while (true) {
        try {
            const ethBal = await ethers.provider.getBalance(address);
            const killBal = await killToken.balanceOf(address);
            const allow = await killToken.allowance(address, kill_game_addr);

            console.log(`\n>> RESOURCE CHECK:`);
            console.table([{
                ETH: ethers.utils.formatEther(ethBal).substring(0, 6),
                KILL: ethers.utils.formatEther(killBal).split('.')[0],
                APPROVED: ethers.utils.formatEther(allow).split('.')[0]
            }]);

            const readCalls = ALL_IDS.map(id => killGame.interface.encodeFunctionData("getFullStack", [id]));
            const returnData = await killGame.callStatic.multicall(readCalls);

            let hubState = { self: null, enemies: [] };
            let validTargets = [];
            let myActiveStacks = [];
            let totalPowerGlobal = ethers.BigNumber.from(0);
            let tacticalData = [];

            for (let i = 0; i < returnData.length; i++) {
                const stackId = ALL_IDS[i];
                const items = killGame.interface.decodeFunctionResult("getFullStack", returnData[i])[0];
                const self = items.find(it => it.occupant.toLowerCase() === address.toLowerCase());
                const enemies = items.filter(it => it.occupant.toLowerCase() !== address.toLowerCase() && (it.units.gt(0) || it.reapers.gt(0)));
                const dist = getManhattanDist(HUB_STACK, stackId);

                if (self) {
                    const stackPower = calcPower(self.units, self.reapers);
                    totalPowerGlobal = totalPowerGlobal.add(stackPower);
                    myActiveStacks.push({ id: stackId, units: self.units, reapers: self.reapers, power: stackPower, dist });
                    if (stackId === HUB_STACK) hubState.self = self;
                }

                if (SAFE_ZONE.includes(stackId)) {
                    const ep = enemies.reduce((acc, e) => acc.add(calcPower(e.units, e.reapers)), ethers.BigNumber.from(0));
                    tacticalData.push({ 
                        ID: stackId, 
                        Dist: dist, 
                        EnemyPower: ep.toString(), 
                        MyPower: self ? calcPower(self.units, self.reapers).toString() : "0", 
                        Status: enemies.length > 0 ? "HOSTILE" : "SECURE" 
                    });
                    if (enemies.length > 0) validTargets.push({ id: stackId, target: strongestEnemy(enemies), dist });
                }
                if (stackId === HUB_STACK) hubState.enemies = enemies;
            }

            console.table(tacticalData.sort((a,b) => a.Dist - b.Dist));

            const txOpt = { gasLimit: 2000000, gasPrice: ethers.utils.parseUnits(MAX_GAS_PRICE_GWEI.toString(), "gwei") };
            let actionBatch = [];

            // PRIORITY 1: RECLAIM HUB if we drifted off hub.
            if (!hubState.self && myActiveStacks.length > 0) {
                const reclaimArmy = myActiveStacks.sort((a, b) => {
                    const distCmp = a.dist - b.dist;
                    if (distCmp !== 0) return distCmp;
                    return bnCmpDesc(a.power, b.power);
                })[0];
                const step = ALL_IDS
                    .filter(id => isAdjacent(reclaimArmy.id, id))
                    .sort((a, b) => getManhattanDist(a, HUB_STACK) - getManhattanDist(b, HUB_STACK))[0];
                if (step !== undefined) {
                    console.log(`[BATCH] Reclaiming Hub via ${reclaimArmy.id} -> ${step}...`);
                    actionBatch.push(killGame.interface.encodeFunctionData("move", [reclaimArmy.id, step, reclaimArmy.units, reclaimArmy.reapers]));
                }
            }
            // PRIORITY 2: DEFEND HUB
            else if (hubState.enemies.length > 0 && hubState.self) {
                const hubTarget = strongestEnemy(hubState.enemies);
                console.log(`[BATCH] Kill Hostile at Hub...`);
                actionBatch.push(killGame.interface.encodeFunctionData("kill", [hubTarget.occupant, HUB_STACK, hubState.self.units, hubState.self.reapers]));
            } 
            // PRIORITY 3: PERIMETER SWEEP
            else if (validTargets.length > 0 && myActiveStacks.length > 0) {
                const raid = validTargets.sort((a,b) => a.dist - b.dist)[0];
                const fieldArmies = myActiveStacks.filter((s) => s.id !== HUB_STACK);
                const army = fieldArmies.sort((a,b) => bnCmpDesc(a.power, b.power))[0];
                
                if (army) {
                    if (army.id === raid.id) {
                        actionBatch.push(killGame.interface.encodeFunctionData("kill", [raid.target.occupant, raid.id, army.units, army.reapers]));
                        let step = ALL_IDS.filter(id => isAdjacent(army.id, id)).sort((a,b) => getManhattanDist(a, HUB_STACK) - getManhattanDist(b, HUB_STACK))[0];
                        actionBatch.push(killGame.interface.encodeFunctionData("move", [army.id, step, army.units, army.reapers]));
                    } else {
                        let step = ALL_IDS.filter(id => isAdjacent(army.id, id)).sort((a,b) => getManhattanDist(a, raid.id) - getManhattanDist(b, raid.id))[0];
                        actionBatch.push(killGame.interface.encodeFunctionData("move", [army.id, step, army.units, army.reapers]));
                        if (step === raid.id) {
                            actionBatch.push(killGame.interface.encodeFunctionData("kill", [raid.target.occupant, step, army.units, army.reapers]));
                        }
                    }
                } else if (hubState.self && hubState.enemies.length === 0) {
                    const raidEnemyPower = calcPower(raid.target.units, raid.target.reapers);
                    const neededUnits = raidEnemyPower.mul(ethers.BigNumber.from(MIN_RAID_FORCE_RATIO || 6));
                    const minHubUnits = ethers.BigNumber.from(MIN_HUB_UNITS || 500000);
                    const maxSend = hubState.self.units.gt(minHubUnits) ? hubState.self.units.sub(minHubUnits) : ethers.BigNumber.from(0);
                    const sendUnits = maxSend.lt(neededUnits) ? maxSend : neededUnits;

                    if (sendUnits.gt(0)) {
                        const step = ALL_IDS
                            .filter(id => isAdjacent(HUB_STACK, id))
                            .sort((a,b) => getManhattanDist(a, raid.id) - getManhattanDist(b, raid.id))[0];
                        if (step !== undefined) {
                            console.log(`[BATCH] Hub detachment raid ${HUB_STACK} -> ${step} (${sendUnits.toString()} units)`);
                            actionBatch.push(killGame.interface.encodeFunctionData("move", [HUB_STACK, step, sendUnits, 0]));
                            if (step === raid.id) {
                                actionBatch.push(killGame.interface.encodeFunctionData("kill", [raid.target.occupant, step, sendUnits, 0]));
                            }
                        }
                    }
                }
            }
            // PRIORITY 4: SPAWN (POWER CHECK)
            else if (totalPowerGlobal.lt(ethers.BigNumber.from(TARGET_POWER))) {
                const spawnCost = ethers.BigNumber.from(REPLENISH_AMT).mul(20); // 20 KILL per unit
                if (allow.lt(spawnCost)) {
                    console.log(`[AUTH] Approving KILL tokens...`);
                    const appTx = await killToken.connect(wallet).approve(kill_game_addr, ethers.constants.MaxUint256);
                    await appTx.wait();
                }
                console.log(`[BATCH] Power ${totalPowerGlobal.toString()} < ${TARGET_POWER}. Spawning...`);
                actionBatch.push(killGame.interface.encodeFunctionData("spawn", [HUB_STACK, REPLENISH_AMT]));
            } 
            // PRIORITY 5: CONSOLIDATE
            else if (myActiveStacks.some(s => s.id !== HUB_STACK)) {
                const army = myActiveStacks.find(s => s.id !== HUB_STACK);
                let step = ALL_IDS.filter(id => isAdjacent(army.id, id)).sort((a,b) => getManhattanDist(a, HUB_STACK) - getManhattanDist(b, HUB_STACK))[0];
                actionBatch.push(killGame.interface.encodeFunctionData("move", [army.id, step, army.units, army.reapers]));
            }

            if (actionBatch.length > 0) {
                await killGame.callStatic.multicall(actionBatch);
                if (DRY_RUN) {
                    console.log(`[DRY_RUN] Simulation passed. Transaction not sent.`);
                } else {
                    const tx = await killGame.connect(wallet).multicall(actionBatch, txOpt);
                    console.log(`>> [TX SENT]: ${tx.hash}`);
                    await tx.wait();
                }
            }

        } catch (e) { console.error("[ERROR]:", e.reason || e.message); }
        await countdown(LOOP_DELAY_SECONDS);
    }
}
main();
