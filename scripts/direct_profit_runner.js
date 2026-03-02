const { ethers } = require("ethers");
require("dotenv").config({ path: "/Users/aaronlemay/.env" });

const RPC = "https://sepolia.base.org";
const GAME = "0xfd21c1c28d58e420837e8057A227C3D432D289Ec";

const MAX_TX = Number(process.env.MAX_TX || 10);
const MIN_FORCE_RATIO = Number(process.env.MIN_FORCE_RATIO || 1.4);
const LOOP_DELAY_MS = Number(process.env.LOOP_DELAY_MS || 4000);
const CYCLES = Number(process.env.CYCLES || 1);
const MIN_BOUNTY = ethers.utils.parseEther(process.env.MIN_BOUNTY || "5000");
const FALLBACK_MIN_BOUNTY = ethers.utils.parseEther(process.env.FALLBACK_MIN_BOUNTY || "1500");
const ENABLE_FALLBACK = process.env.ENABLE_FALLBACK !== "false";
const HIGH_TICKET_THRESHOLD = ethers.utils.parseEther(process.env.HIGH_TICKET_THRESHOLD || "30000");
const PRIORITY_STACKS = new Set(
  (process.env.PRIORITY_STACKS || "77,99,138,22,61,116,186,54,74,76,86,122")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0)
);

const REAPER = ethers.BigNumber.from(666);

function power(units, reapers) {
  return units.add(reapers.mul(REAPER));
}

async function runCycle(game, provider, wallet, cycleNum) {
  const [beforeProfit, beforeEth, beforeKillToken] = await Promise.all([
    game.agentTotalProfit(wallet.address),
    provider.getBalance(wallet.address),
    game.killToken(),
  ]);
  const token = new ethers.Contract(beforeKillToken, ["function balanceOf(address) view returns(uint256)"], provider);
  const beforeKill = await token.balanceOf(wallet.address);

  console.log(`CYCLE=${cycleNum}`);
  console.log(`ETH_BEFORE=${ethers.utils.formatEther(beforeEth)}`);
  console.log(`KILL_BEFORE=${ethers.utils.formatEther(beforeKill)}`);
  console.log(`PROFIT_BEFORE=${ethers.utils.formatEther(beforeProfit)}`);

  const ids = Array.from({ length: 216 }, (_, i) => i + 1);
  const raw = await game.callStatic.multicall(ids.map((id) => game.interface.encodeFunctionData("getFullStack", [id])));
  const me = wallet.address.toLowerCase();
  const candidates = [];

  for (let i = 0; i < raw.length; i++) {
    const stackId = i + 1;
    const items = game.interface.decodeFunctionResult("getFullStack", raw[i])[0];
    const self = items.find((it) => it.occupant.toLowerCase() === me && (it.units.gt(0) || it.reapers.gt(0)));
    if (!self) continue;

    const selfPower = power(self.units, self.reapers);
    for (const e of items) {
      if (e.occupant.toLowerCase() === me) continue;
      if (e.units.isZero() && e.reapers.isZero()) continue;
      const enemyPower = power(e.units, e.reapers);
      if (enemyPower.lte(0)) continue;
      const force = Number(selfPower.mul(10000).div(enemyPower).toString()) / 10000;
      if (force < MIN_FORCE_RATIO) continue;
      candidates.push({
        stackId,
        target: e.occupant,
        units: self.units,
        reapers: self.reapers,
        bounty: e.pendingBounty,
        force,
        prio: PRIORITY_STACKS.has(stackId) ? 1 : 0,
      });
    }
  }

  const rankCandidates = (arr) => arr.sort((a, b) => {
    if (a.prio !== b.prio) return b.prio - a.prio;
    if (!a.bounty.eq(b.bounty)) return b.bounty.gt(a.bounty) ? 1 : -1;
    return b.force - a.force;
  });

  const primary = rankCandidates(candidates.filter((c) => c.bounty.gte(MIN_BOUNTY)));
  let filtered = primary;
  let usedMinBounty = MIN_BOUNTY;
  if (filtered.length === 0 && ENABLE_FALLBACK) {
    filtered = rankCandidates(candidates.filter((c) => c.bounty.gte(FALLBACK_MIN_BOUNTY)));
    usedMinBounty = FALLBACK_MIN_BOUNTY;
  }
  console.log(`MIN_BOUNTY_ACTIVE=${ethers.utils.formatEther(usedMinBounty)}`);
  console.log(`CANDIDATES=${filtered.length}`);

  let sent = 0;
  let highTicketSent = 0;
  let bountyCaptured = ethers.BigNumber.from(0);
  const used = new Set();
  let nonce = await provider.getTransactionCount(wallet.address, "pending");

  for (const c of filtered) {
    if (sent >= MAX_TX) break;
    const key = `${c.stackId}:${c.target.toLowerCase()}`;
    if (used.has(key)) continue;

    const calls = [game.interface.encodeFunctionData("kill", [c.target, c.stackId, c.units, c.reapers])];
    try {
      await game.callStatic.multicall(calls);
    } catch {
      continue;
    }

    let tx;
    try {
      tx = await game.multicall(calls, {
        nonce,
        gasPrice: ethers.utils.parseUnits("0.2", "gwei"),
        gasLimit: 220000,
      });
    } catch (e) {
      const msg = (e.reason || e.message || "").toLowerCase();
      if (msg.includes("nonce") || msg.includes("replacement")) {
        nonce = await provider.getTransactionCount(wallet.address, "pending");
        tx = await game.multicall(calls, {
          nonce,
          gasPrice: ethers.utils.parseUnits("0.2", "gwei"),
          gasLimit: 220000,
        });
      } else {
        throw e;
      }
    }
    console.log(
      `TX_${sent + 1}=${tx.hash},STACK=${c.stackId},TARGET=${c.target},BOUNTY=${ethers.utils.formatEther(c.bounty)},FORCE=${c.force.toFixed(2)}`
    );
    const rc = await tx.wait();
    console.log(`TX_${sent + 1}_STATUS=${rc.status}`);

    used.add(key);
    bountyCaptured = bountyCaptured.add(c.bounty);
    if (c.bounty.gte(HIGH_TICKET_THRESHOLD)) highTicketSent += 1;
    sent += 1;
    nonce += 1;
  }

  const [afterProfit, afterEth, afterKill] = await Promise.all([
    game.agentTotalProfit(wallet.address),
    provider.getBalance(wallet.address),
    token.balanceOf(wallet.address),
  ]);

  console.log(`TX_SENT=${sent}`);
  console.log(`HIGH_TICKET_SENT=${highTicketSent}`);
  console.log(`BOUNTY_CAPTURED=${ethers.utils.formatEther(bountyCaptured)}`);
  console.log(`ETH_AFTER=${ethers.utils.formatEther(afterEth)}`);
  console.log(`KILL_AFTER=${ethers.utils.formatEther(afterKill)}`);
  console.log(`PROFIT_AFTER=${ethers.utils.formatEther(afterProfit)}`);
}

async function main() {
  if (!process.env.SNIPER_PK) throw new Error("Missing SNIPER_PK in /Users/aaronlemay/.env");
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.SNIPER_PK, provider);
  const game = new ethers.Contract(
    GAME,
    [
      "function getFullStack(uint16) view returns((address occupant,uint256 units,uint256 reapers,uint256 age,uint256 pendingBounty)[])",
      "function multicall(bytes[]) returns(bytes[])",
      "function kill(address,uint16,uint256,uint256)",
      "function agentTotalProfit(address) view returns(uint256)",
      "function killToken() view returns(address)",
    ],
    wallet
  );

  console.log(`ADDR=${wallet.address}`);
  for (let i = 1; i <= CYCLES; i++) {
    await runCycle(game, provider, wallet, i);
    if (i < CYCLES) await new Promise((r) => setTimeout(r, LOOP_DELAY_MS));
  }
}

main().catch((e) => {
  console.error(`ERR=${e.reason || e.message || e}`);
  process.exit(1);
});
