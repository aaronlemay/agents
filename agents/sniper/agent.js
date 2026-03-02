const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
require("dotenv").config();

const YEL = "\x1b[33m"; const CYA = "\x1b[36m"; const PNK = "\x1b[35m"; const RES = "\x1b[0m"; const BRIGHT = "\x1b[1m";

function getCoords(id) {
    const v = id - 1;
    return { x: v % 6, y: Math.floor(v / 6) % 6, z: Math.floor(v / 36) };
}

function getId(x, y, z) { return (z * 36) + (y * 6) + x + 1; }

function getPath3D(startId, endId) {
    let current = getCoords(startId);
    const target = getCoords(endId);
    const path = [];
    while (current.x !== target.x || current.y !== target.y || current.z !== target.z) {
        let fromId = getId(current.x, current.y, current.z);
        if (current.x !== target.x) current.x += (target.x > current.x ? 1 : -1);
        else if (current.y !== target.y) current.y += (target.y > current.y ? 1 : -1);
        else if (current.z !== target.z) current.z += (target.z > current.z ? 1 : -1);
        path.push({ from: fromId, to: getId(current.x, current.y, current.z) });
    }
    return path;
}

async function getTopStacksFromSubgraph(url) {
    const query = `{
        stacks(orderBy: totalStandardUnits, orderDirection: desc, first: 20) { 
            id 
            totalStandardUnits 
            totalBoostedUnits 
        }
    }`;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query })
    });
    const result = await resp.json();
    return result.data.stacks;
}

function hasMethod(contract, name) {
    return typeof contract[name] === "function";
}

async function main() {
    if (!process.env.SNIPER_PK) throw new Error("Missing SNIPER_PK in .env");
    const wallet = new ethers.Wallet(process.env.SNIPER_PK, ethers.provider);
    console.log(`[AGENT] Running as: ${wallet.address}`);
    
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    const {
        HUB_STACK = 125,
        LOOP_DELAY_SECONDS = 12,
        KILL_MULTIPLIER = 3,
        SPAWN_PROFITABILITY_THRESHOLD = 1.1,
        MIN_BOUNTY_FOR_SPAWN = "10000",
        MIN_SPAWN = 666,
        MAX_GAS_LIMIT = 1400000,
        MAX_GAS_PRICE_GWEI = 1,
        DRY_RUN = true,
        SUBGRAPH_URL
    } = config.settings;
    const { kill_game_addr, kill_faucet_addr } = config.network;
    
    const killGame = new ethers.Contract(kill_game_addr, JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/abi/KILLGame.json'), 'utf8')).abi, wallet);
    const killTokenAddr = await killGame.killToken();
    const erc20Abi = [
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address, address) view returns (uint256)",
        "function approve(address, uint256) returns (bool)",
        "function transfer(address, uint256) returns (bool)"
    ];
    const killToken = new ethers.Contract(killTokenAddr, erc20Abi, wallet);
    const killFaucet = (
        kill_faucet_addr &&
        kill_faucet_addr !== ethers.constants.AddressZero
    ) ? new ethers.Contract(
        kill_faucet_addr,
        JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/abi/KILLFaucet.json'), 'utf8')).abi,
        wallet
    ) : null;
    
    const SPAWN_COST_PER_UNIT = ethers.utils.parseEther("20");
    const MIN_BOUNTY_WEI = ethers.utils.parseEther(String(MIN_BOUNTY_FOR_SPAWN));

    console.log(`${BRIGHT}--- SNIPER AGENT ONLINE ---${RES}`);

    if (killFaucet && hasMethod(killFaucet, "hasClaimed") && hasMethod(killFaucet, "pullKill")) {
        try {
            const alreadyClaimed = await killFaucet.hasClaimed(wallet.address);
            if (!alreadyClaimed) {
                console.log(`${YEL}[STARTUP] Claiming faucet...${RES}`);
                const faucetTx = await killFaucet.pullKill({ gasLimit: 200000 });
                await faucetTx.wait();
            }
        } catch (e) {
            console.log(`${PNK}[STARTUP] Faucet skipped: ${e.reason || e.message}${RES}`);
        }
    } else {
        console.log(`${YEL}[STARTUP] Faucet unavailable on this deployment; continuing without faucet pull.${RES}`);
    }

    while (true) {
        try {
            const ethBal = await ethers.provider.getBalance(wallet.address);
            const killBal = await killToken.balanceOf(wallet.address);
            const killAllow = await killToken.allowance(wallet.address, kill_game_addr);

            const topStacks = await getTopStacksFromSubgraph(SUBGRAPH_URL);
            
            const stackCalls = topStacks.map(s => killGame.interface.encodeFunctionData("getFullStack", [parseInt(s.id)]));
            const results = await killGame.callStatic.multicall(stackCalls);
            
            let myStrandedStacks = [];
            let targets = [];

            for (let i = 0; i < topStacks.length; i++) {
                const stackId = parseInt(topStacks[i].id);
                const items = killGame.interface.decodeFunctionResult("getFullStack", results[i])[0];
                const self = items.find(it => it.occupant.toLowerCase() === wallet.address.toLowerCase());
                const enemies = items.filter(it => it.occupant.toLowerCase() !== wallet.address.toLowerCase() && it.units.gt(0));

                if (self && stackId !== HUB_STACK && (self.units.gt(0) || self.reapers.gt(0))) {
                    myStrandedStacks.push({ id: stackId, units: self.units, reapers: self.reapers });
                }

                for (const e of enemies) {
                    const bountyVal = e.pendingBounty;
                    let spawnAmt = e.units.mul(KILL_MULTIPLIER);
                    if (spawnAmt.lt(MIN_SPAWN)) spawnAmt = ethers.BigNumber.from(MIN_SPAWN);
                    
                    const spawnReaper = spawnAmt.div(666);
                    const attackCost = spawnAmt.mul(SPAWN_COST_PER_UNIT);

                    const ratio = parseFloat(bountyVal.mul(1000).div(attackCost.gt(0) ? attackCost : 1).toString()) / 1000;
                    targets.push({ id: stackId, enemy: e, ratio, spawnAmt, spawnReaper, bountyVal, attackCost });
                }
            }

            console.clear();
            console.log(`${BRIGHT}--- SNIPER AGENT | STATUS ---${RES}`);
            console.table([{
                ETH: ethers.utils.formatEther(ethBal).substring(0, 6),
                KILL: (parseFloat(ethers.utils.formatEther(killBal))).toFixed(1) + "K",
                APPROVED: killAllow.gt(ethers.constants.MaxUint256.div(2)) ? "MAX" : (parseFloat(ethers.utils.formatEther(killAllow))).toFixed(1) + "K"
            }]);

            console.log(`\n${BRIGHT}ID   | ENEMY      | UNITS | BOUNTY   | RATIO | STATUS | MY UNITS | MY REAPERS${RES}`);
            console.log(`-----|------------|-------|----------|-------|--------|----------|-----------`);
            targets.sort((a,b) => b.ratio - a.ratio).slice(0, 10).forEach(t => {
                const isPass = t.ratio >= SPAWN_PROFITABILITY_THRESHOLD;
                const bountyStr = Number(ethers.utils.formatEther(t.bountyVal)).toLocaleString(undefined, { maximumFractionDigits: 1 });
                let status = !isPass ? "LOW_ROI" : (killBal.lt(t.attackCost) ? "NO_KILL" : (t.bountyVal.lt(MIN_BOUNTY_WEI) ? "LOW_BOUNTY" : CYA + "READY" + RES));
                
                // Find my units on this specific target stack for the table
                const myUnitsOnTarget = myStrandedStacks.find(s => s.id === t.id);
                const myU = myUnitsOnTarget ? myUnitsOnTarget.units.toString() : "0";
                const myR = myUnitsOnTarget ? myUnitsOnTarget.reapers.toString() : "0";
                
                console.log(`${t.id.toString().padEnd(4)} | ${t.enemy.occupant.slice(0,10)} | ${t.enemy.units.toString().padEnd(5)} | ${bountyStr.padEnd(8)} | ${t.ratio.toFixed(2)}x | ${status.padEnd(15)} | ${myU.padEnd(8)} | ${myR.padEnd(10)}`);
            });

            const calls = [];
            
            // Priority 1: Attack if profitable
            const best = targets.sort((a, b) => b.ratio - a.ratio)[0];
            if (best && best.ratio >= SPAWN_PROFITABILITY_THRESHOLD) {
                if (killBal.gte(best.attackCost) && best.bountyVal.gte(MIN_BOUNTY_WEI)) {
                    if (killAllow.lt(best.attackCost)) {
                        console.log(`${YEL}[AUTH] Approving...${RES}`);
                        await (await killToken.connect(wallet).approve(kill_game_addr, ethers.constants.MaxUint256)).wait();
                    }
                    if (ethBal.gt(ethers.utils.parseEther("0.002"))) {
                        console.log(`\n${PNK}[ATTACK] Snipe ${best.id} | Ratio: ${best.ratio}x | Spawn: ${best.spawnAmt} | Reapers: ${best.spawnReaper}${RES}`);
                        calls.push(killGame.interface.encodeFunctionData("spawn", [best.id, best.spawnAmt]));
                        calls.push(killGame.interface.encodeFunctionData("kill", [best.enemy.occupant, best.id, best.spawnAmt, best.spawnReaper]));
                    }
                }
            } 
            // Priority 2: Move if no attacks
            else if (myStrandedStacks.length > 0) {
                const s = myStrandedStacks[0];
                const moveStep = getPath3D(s.id, HUB_STACK)[0];
                console.log(`\n${YEL}[RETREAT] Moving ${s.id} -> ${moveStep.to} | Units: ${s.units} | Reapers: ${s.reapers}${RES}`);
                calls.push(killGame.interface.encodeFunctionData("move", [moveStep.from, moveStep.to, s.units, s.reapers]));
            }

            if (calls.length > 0) {
                await killGame.callStatic.multicall(calls);
                if (DRY_RUN) {
                    console.log(`${YEL}[DRY_RUN] Simulation passed. Transaction not sent.${RES}`);
                } else {
                    console.log(`${CYA}[TX] Executing multicall...${RES}`);
                    const tx = await killGame.connect(wallet).multicall(calls, {
                        gasLimit: Number(MAX_GAS_LIMIT),
                        gasPrice: ethers.utils.parseUnits(String(MAX_GAS_PRICE_GWEI), "gwei")
                    });
                    console.log(`${CYA}>> [TX SENT]: ${tx.hash}${RES}`);
                    console.log(`${CYA}>> https://sepolia.basescan.org/tx/${tx.hash}${RES}`);
                    await tx.wait();
                    console.log(`${BRIGHT}>> [TX] Success!${RES}`);
                }
            }
        } catch (err) { console.error("\n[ERROR]", err.message); }
        await new Promise(r => setTimeout(r, LOOP_DELAY_SECONDS * 1000));
    }
}
main();
