const { ethers } = require('ethers');
require('dotenv').config({ path: '/Users/aaronlemay/.env' });

const RPC = 'https://sepolia.base.org';
const GAME = '0xfd21c1c28d58e420837e8057A227C3D432D289Ec';
const MAX_TX = process.env.MAX_TX ? Number(process.env.MAX_TX) : 3;
const GAS_PRICE_GWEI = '1';
const GAS_LIMIT = 1200000;
const TARGET_LAYER = process.env.TARGET_LAYER ? Number(process.env.TARGET_LAYER) : null;
const TARGET_LAYERS = process.env.TARGET_LAYERS
  ? new Set(process.env.TARGET_LAYERS.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)))
  : null;
const REQUIRE_POSITIVE_NET = process.env.REQUIRE_POSITIVE_NET === 'true';
const MIN_NET_KILL = process.env.MIN_NET_KILL ? ethers.utils.parseEther(process.env.MIN_NET_KILL) : null;
const MAX_SPAWN_UNITS = process.env.MAX_SPAWN_UNITS ? ethers.BigNumber.from(process.env.MAX_SPAWN_UNITS) : null;

const REAPER = ethers.BigNumber.from(666);
const STEP = ethers.BigNumber.from(666);
const OVERKILL = ethers.BigNumber.from(8);
const POWER_PER_666 = ethers.BigNumber.from(1332);

function power(u, r) { return u.add(r.mul(REAPER)); }
function roundUpStep(v) {
  const rem = v.mod(STEP);
  return rem.isZero() ? v : v.add(STEP.sub(rem));
}

async function main() {
  if (!process.env.SNIPER_PK) throw new Error('Missing SNIPER_PK');
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.SNIPER_PK, provider);

  const game = new ethers.Contract(GAME, [
    'function killToken() view returns(address)',
    'function getFullStack(uint16) view returns((address occupant,uint256 units,uint256 reapers,uint256 age,uint256 pendingBounty)[])',
    'function spawn(uint16,uint256)',
    'function kill(address,uint16,uint256,uint256)',
    'function multicall(bytes[]) returns(bytes[])',
    'function agentTotalProfit(address) view returns(uint256)'
  ], wallet);

  const token = new ethers.Contract(await game.killToken(), [
    'function balanceOf(address) view returns(uint256)',
    'function allowance(address,address) view returns(uint256)',
    'function approve(address,uint256) returns(bool)'
  ], wallet);

  const [eth0, kill0, allow0, profit0] = await Promise.all([
    provider.getBalance(wallet.address),
    token.balanceOf(wallet.address),
    token.allowance(wallet.address, GAME),
    game.agentTotalProfit(wallet.address)
  ]);

  console.log('ADDR=' + wallet.address);
  console.log('ETH_BEFORE=' + ethers.utils.formatEther(eth0));
  console.log('KILL_BEFORE=' + ethers.utils.formatEther(kill0));
  console.log('PROFIT_BEFORE=' + ethers.utils.formatEther(profit0));

  if (allow0.lt(ethers.constants.MaxUint256.div(4))) {
    const ap = await token.approve(GAME, ethers.constants.MaxUint256, {
      gasPrice: ethers.utils.parseUnits(GAS_PRICE_GWEI, 'gwei')
    });
    console.log('APPROVE_TX=' + ap.hash);
    await ap.wait();
  }

  const ids = Array.from({ length: 216 }, (_, i) => i + 1);
  const readCalls = ids.map((id) => game.interface.encodeFunctionData('getFullStack', [id]));
  const raw = await game.callStatic.multicall(readCalls);

  const me = wallet.address.toLowerCase();
  const byKey = new Map();

  for (let i = 0; i < raw.length; i++) {
    const stackId = i + 1;
    const layer = Math.floor((stackId - 1) / 36);
    if (TARGET_LAYER !== null && layer !== TARGET_LAYER) continue;
    if (TARGET_LAYERS && !TARGET_LAYERS.has(layer)) continue;
    const items = game.interface.decodeFunctionResult('getFullStack', raw[i])[0];
    const enemies = items.filter((it) => it.occupant.toLowerCase() !== me && (it.units.gt(0) || it.reapers.gt(0)));
    for (const e of enemies) {
      const ep = power(e.units, e.reapers);
      let spawnAmt = ep.mul(OVERKILL).add(POWER_PER_666.sub(1)).div(POWER_PER_666).mul(STEP);
      if (spawnAmt.lt(STEP)) spawnAmt = STEP;
      spawnAmt = roundUpStep(spawnAmt);
      if (MAX_SPAWN_UNITS && spawnAmt.gt(MAX_SPAWN_UNITS)) continue;
      const spawnReaper = spawnAmt.div(REAPER);
      const cost = spawnAmt.mul(ethers.utils.parseEther('20'));
      const net = e.pendingBounty.sub(cost);
      if (REQUIRE_POSITIVE_NET && net.lte(0)) continue;
      if (MIN_NET_KILL && net.lt(MIN_NET_KILL)) continue;
      const key = `${stackId}:${e.occupant.toLowerCase()}`;
      const candidate = { stackId, layer, target: e.occupant, bounty: e.pendingBounty, spawnAmt, spawnReaper, cost, net };
      const prev = byKey.get(key);
      if (!prev || candidate.net.gt(prev.net)) byKey.set(key, candidate);
    }
  }
  const candidates = Array.from(byKey.values());

  candidates.sort((a, b) => {
    if (!a.net.eq(b.net)) return b.net.gt(a.net) ? 1 : -1;
    if (!a.bounty.eq(b.bounty)) return b.bounty.gt(a.bounty) ? 1 : -1;
    return a.cost.lt(b.cost) ? -1 : 1;
  });

  let sent = 0;
  let nonce = await provider.getTransactionCount(wallet.address, 'pending');
  const used = new Set();

  for (const c of candidates) {
    if (sent >= MAX_TX) break;
    const key = `${c.stackId}:${c.target.toLowerCase()}`;
    if (used.has(key)) continue;
    const calls = [
      game.interface.encodeFunctionData('spawn', [c.stackId, c.spawnAmt]),
      game.interface.encodeFunctionData('kill', [c.target, c.stackId, c.spawnAmt, c.spawnReaper])
    ];
    try {
      await game.callStatic.multicall(calls);
    } catch {
      continue;
    }

    const tx = await game.multicall(calls, {
      nonce,
      gasPrice: ethers.utils.parseUnits(GAS_PRICE_GWEI, 'gwei'),
      gasLimit: GAS_LIMIT
    });

    console.log(`TX_${sent + 1}=${tx.hash},STACK=${c.stackId},TARGET=${c.target},SPAWN=${c.spawnAmt.toString()}`);
    const rc = await tx.wait();
    console.log(`TX_${sent + 1}_STATUS=${rc.status}`);
    used.add(key);
    nonce += 1;
    sent += 1;
  }

  const [eth1, kill1, profit1] = await Promise.all([
    provider.getBalance(wallet.address),
    token.balanceOf(wallet.address),
    game.agentTotalProfit(wallet.address)
  ]);

  console.log('TX_SENT=' + sent);
  console.log('ETH_AFTER=' + ethers.utils.formatEther(eth1));
  console.log('KILL_AFTER=' + ethers.utils.formatEther(kill1));
  console.log('PROFIT_AFTER=' + ethers.utils.formatEther(profit1));
}

main().catch((e) => {
  console.error('ERR=' + (e.reason || e.message || e));
  process.exit(1);
});
