const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: "/Users/aaronlemay/.env" });

const REPORT_PATH = "/Users/aaronlemay/agents/intel_report.md";
const GAME_ADDR = "0x23e55f52C4215d7162861761C6063399E021BA3f";
const RPC_URL = "https://sepolia.base.org";
const LOOP_SECONDS = 20;

const REAPER_POWER = ethers.BigNumber.from(666);
const POWER_PER_666_SPAWN = ethers.BigNumber.from(1332);
const SPAWN_STEP = ethers.BigNumber.from(666);
const MIN_SPAWN = ethers.BigNumber.from(666);
const OVERKILL_RATIO = ethers.BigNumber.from(8);
const SPAWN_COST_PER_UNIT = ethers.BigNumber.from(10);
const HUB_STACK = 125;

function getCoords(id) {
    const v = Number(id) - 1;
    return { x: v % 6, y: Math.floor(v / 6) % 6, z: Math.floor(v / 36) };
}

function getPath3D(startId, endId) {
    let current = getCoords(startId);
    const target = getCoords(endId);
    const out = [];
    while (current.x !== target.x || current.y !== target.y || current.z !== target.z) {
        const from = current.z * 36 + current.y * 6 + current.x + 1;
        if (current.x !== target.x) current.x += target.x > current.x ? 1 : -1;
        else if (current.y !== target.y) current.y += target.y > current.y ? 1 : -1;
        else current.z += target.z > current.z ? 1 : -1;
        const to = current.z * 36 + current.y * 6 + current.x + 1;
        out.push({ from, to });
    }
    return out;
}

function calcPower(units, reapers) {
    return units.add(reapers.mul(REAPER_POWER));
}

function roundUpStep(v, step) {
    if (v.isZero()) return v;
    const rem = v.mod(step);
    return rem.isZero() ? v : v.add(step.sub(rem));
}

function spawnPlan(enemyPower) {
    let spawnAmt = enemyPower.mul(OVERKILL_RATIO).add(POWER_PER_666_SPAWN.sub(1)).div(POWER_PER_666_SPAWN).mul(SPAWN_STEP);
    if (spawnAmt.lt(MIN_SPAWN)) spawnAmt = MIN_SPAWN;
    spawnAmt = roundUpStep(spawnAmt, SPAWN_STEP);
    const spawnReaper = spawnAmt.div(REAPER_POWER);
    const spawnPower = calcPower(spawnAmt, spawnReaper);
    const cost = spawnAmt.mul(SPAWN_COST_PER_UNIT);
    return { spawnAmt, spawnReaper, spawnPower, cost };
}

function ratioNum(n, d) {
    if (d.lte(0)) return 0;
    return Number(ethers.utils.formatEther(n.mul(10000).div(d))) / 10000;
}

function fmtNum(v) {
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

async function main() {
    if (!process.env.SNIPER_PK) throw new Error("Missing SNIPER_PK in /Users/aaronlemay/.env");

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(process.env.SNIPER_PK, provider);
    const address = wallet.address.toLowerCase();
    const gameAbi = JSON.parse(fs.readFileSync(path.join("/Users/aaronlemay/data/abi/KILLGame.json"), "utf8")).abi;
    const game = new ethers.Contract(GAME_ADDR, gameAbi, wallet);
    const token = new ethers.Contract(await game.killToken(), ["function balanceOf(address) view returns (uint256)"], wallet);

    while (true) {
        try {
            const [ethBal, killBal, blockNum] = await Promise.all([
                provider.getBalance(wallet.address),
                token.balanceOf(wallet.address),
                provider.getBlockNumber()
            ]);

            const ids = Array.from({ length: 216 }, (_, i) => i + 1);
            const readCalls = ids.map((id) => game.interface.encodeFunctionData("getFullStack", [id]));
            const readData = await game.callStatic.multicall(readCalls);

            const myStacks = [];
            const directCandidates = [];
            const spawnCandidates = [];
            const pressure = new Map();

            for (let i = 0; i < readData.length; i++) {
                const stackId = i + 1;
                const items = game.interface.decodeFunctionResult("getFullStack", readData[i])[0];
                const self = items.find((it) => it.occupant.toLowerCase() === address);
                const enemies = items.filter((it) => it.occupant.toLowerCase() !== address && (it.units.gt(0) || it.reapers.gt(0)));

                if (self && (self.units.gt(0) || self.reapers.gt(0))) {
                    myStacks.push({ id: stackId, units: self.units, reapers: self.reapers, power: calcPower(self.units, self.reapers) });
                }

                for (const e of enemies) {
                    const enemyPower = calcPower(e.units, e.reapers);
                    const sp = spawnPlan(enemyPower);
                    const roi = ratioNum(e.pendingBounty, sp.cost);
                    spawnCandidates.push({ id: stackId, enemy: e, enemyPower, roi, ...sp });

                    const k = e.occupant.toLowerCase();
                    pressure.set(k, (pressure.get(k) || 0) + 1);
                }

                if (self && enemies.length > 0) {
                    const topEnemy = enemies.sort((a, b) => b.pendingBounty.gt(a.pendingBounty) ? 1 : -1)[0];
                    const force = ratioNum(calcPower(self.units, self.reapers), calcPower(topEnemy.units, topEnemy.reapers));
                    directCandidates.push({ id: stackId, self, enemy: topEnemy, force });
                }
            }

            let topThreat = null;
            for (const [addrK, cnt] of pressure.entries()) {
                if (!topThreat || cnt > topThreat.count) topThreat = { addr: addrK, count: cnt };
            }

            const launchQueue = [];

            const directSorted = directCandidates
                .filter((d) => d.force >= 1.5)
                .sort((a, b) => b.enemy.pendingBounty.gt(a.enemy.pendingBounty) ? 1 : -1);
            if (directSorted[0]) {
                launchQueue.push({
                    type: "DIRECT_KILL",
                    summary: `stack ${directSorted[0].id} on ${directSorted[0].enemy.occupant.slice(0, 10)} force ${directSorted[0].force.toFixed(2)}x`,
                    calls: [game.interface.encodeFunctionData("kill", [directSorted[0].enemy.occupant, directSorted[0].id, directSorted[0].self.units, directSorted[0].self.reapers])]
                });
            }

            const farthest = myStacks
                .filter((s) => s.id !== HUB_STACK)
                .sort((a, b) => getPath3D(b.id, HUB_STACK).length - getPath3D(a.id, HUB_STACK).length)[0];
            if (farthest) {
                const step = getPath3D(farthest.id, HUB_STACK)[0];
                if (step) {
                    launchQueue.push({
                        type: "CONSOLIDATE",
                        summary: `${step.from} -> ${step.to} (${farthest.units.toString()}u/${farthest.reapers.toString()}r)`,
                        calls: [game.interface.encodeFunctionData("move", [step.from, step.to, farthest.units, farthest.reapers])]
                    });
                }
            }

            const spawnSorted = spawnCandidates
                .filter((s) => s.roi >= 1.1)
                .sort((a, b) => {
                    const aThreat = topThreat && a.enemy.occupant.toLowerCase() === topThreat.addr ? 1 : 0;
                    const bThreat = topThreat && b.enemy.occupant.toLowerCase() === topThreat.addr ? 1 : 0;
                    if (aThreat !== bThreat) return bThreat - aThreat;
                    if (a.roi !== b.roi) return b.roi - a.roi;
                    return b.enemy.pendingBounty.gt(a.enemy.pendingBounty) ? 1 : -1;
                });
            if (spawnSorted[0]) {
                const s = spawnSorted[0];
                launchQueue.push({
                    type: "SPAWN_KILL",
                    summary: `stack ${s.id} spawn ${s.spawnAmt.toString()} roi ${s.roi.toFixed(2)}x on ${s.enemy.occupant.slice(0, 10)}`,
                    calls: [
                        game.interface.encodeFunctionData("spawn", [s.id, s.spawnAmt]),
                        game.interface.encodeFunctionData("kill", [s.enemy.occupant, s.id, s.spawnAmt, s.spawnReaper])
                    ]
                });
            }

            const queueChecks = [];
            for (const q of launchQueue.slice(0, 3)) {
                try {
                    await game.callStatic.multicall(q.calls);
                    queueChecks.push({ ...q, executable: true });
                } catch (e) {
                    queueChecks.push({ ...q, executable: false, reason: e.reason || e.message });
                }
            }

            const lines = [];
            lines.push(`# Intel Report`);
            lines.push(`- Updated: ${new Date().toISOString()}`);
            lines.push(`- Block: ${blockNum}`);
            lines.push(`- Wallet: ${wallet.address}`);
            lines.push(`- ETH: ${ethers.utils.formatEther(ethBal)}`);
            lines.push(`- KILL: ${ethers.utils.formatEther(killBal)}`);
            lines.push(`- Top threat: ${topThreat ? `${topThreat.addr} (${topThreat.count} stacks)` : "none"}`);
            lines.push(``);
            lines.push(`## Top Executable Targets`);
            const topExec = [];
            for (const d of directSorted.slice(0, 6)) {
                topExec.push(`- Direct kill @${d.id} target ${d.enemy.occupant} bounty ${fmtNum(ethers.utils.formatEther(d.enemy.pendingBounty))} force ${d.force.toFixed(2)}x`);
            }
            for (const s of spawnSorted.slice(0, 6)) {
                topExec.push(`- Spawn+kill @${s.id} target ${s.enemy.occupant} bounty ${fmtNum(ethers.utils.formatEther(s.enemy.pendingBounty))} roi ${s.roi.toFixed(2)}x`);
            }
            if (topExec.length === 0) lines.push(`- No current opportunities`);
            else lines.push(...topExec.slice(0, 10));
            lines.push(``);
            lines.push(`## Launch Queue (First 3 TX)`);
            if (queueChecks.length === 0) {
                lines.push(`- No queued actions`);
            } else {
                for (const [idx, q] of queueChecks.entries()) {
                    lines.push(`- TX${idx + 1} ${q.type}: ${q.summary} | executable=${q.executable}${q.reason ? ` | reason=${q.reason}` : ""}`);
                }
            }
            lines.push(``);
            fs.writeFileSync(REPORT_PATH, `${lines.join("\n")}\n`, "utf8");
        } catch (err) {
            fs.writeFileSync(
                REPORT_PATH,
                `# Intel Report\n- Updated: ${new Date().toISOString()}\n- Error: ${err.message}\n`,
                "utf8"
            );
        }
        await new Promise((r) => setTimeout(r, LOOP_SECONDS * 1000));
    }
}

main().catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
});
