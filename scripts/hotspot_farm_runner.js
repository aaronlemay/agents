const hre = require('hardhat');
const { ethers } = hre;
require('dotenv').config({ path: '/Users/aaronlemay/agents/.env' });

const GAME = '0xfd21c1c28d58e420837e8057A227C3D432D289Ec';
const REAPER = ethers.BigNumber.from(666);
const SPAWN_UNITS = ethers.BigNumber.from(process.env.SPAWN_UNITS || '666');
const SPAWN_COST = ethers.utils.parseEther('20').mul(SPAWN_UNITS);
const LOOP_MS = Number(process.env.LOOP_MS || 4000);
const MAX_TX_PER_CYCLE = Number(process.env.MAX_TX_PER_CYCLE || 3);
const MIN_FORCE_RATIO = Number(process.env.MIN_FORCE_RATIO || 1.2);
const MIN_DIRECT_BOUNTY = ethers.utils.parseEther(process.env.MIN_DIRECT_BOUNTY || '2500');
const MIN_SEED_STACK_BOUNTY = ethers.utils.parseEther(process.env.MIN_SEED_STACK_BOUNTY || '7000');
const SEED_ROI_GATE = Number(process.env.SEED_ROI_GATE || 0.6);
const MAX_KILL_DRAWDOWN = ethers.utils.parseEther(process.env.MAX_KILL_DRAWDOWN || '300000');
const MAX_ETH_DRAWDOWN = ethers.utils.parseEther(process.env.MAX_ETH_DRAWDOWN || '0.01');
const DRY_RUN = process.env.DRY_RUN === 'true';
const HOTSPOTS = (process.env.HOTSPOTS || '138,135,104,93,22,152,185,151').split(',').map((x)=>Number(x.trim())).filter(Boolean);
const FULL_SCAN_ON_IDLE = process.env.FULL_SCAN_ON_IDLE !== 'false';

function power(u, r){ return u.add(r.mul(REAPER)); }
function ratio(a,b){ if (b.lte(0)) return 0; return Number(a.mul(10000).div(b).toString())/10000; }

async function main(){
  const pk = process.env.SNIPER_PK;
  if(!pk) throw new Error('Missing SNIPER_PK in /Users/aaronlemay/agents/.env');
  const wallet = new ethers.Wallet(pk, ethers.provider);
  const game = new ethers.Contract(GAME, [
    'function getFullStack(uint16) view returns((address occupant,uint256 units,uint256 reapers,uint256 age,uint256 pendingBounty)[])',
    'function multicall(bytes[]) returns(bytes[])',
    'function killToken() view returns(address)'
  ], wallet);
  const token = new ethers.Contract(await game.killToken(), [
    'function balanceOf(address) view returns(uint256)',
    'function allowance(address,address) view returns(uint256)',
    'function approve(address,uint256) returns(bool)'
  ], wallet);

  const me = wallet.address.toLowerCase();
  const startEth = await ethers.provider.getBalance(wallet.address);
  const startKill = await token.balanceOf(wallet.address);
  let cycle = 0;

  console.log(`HOTSPOT_FARM ONLINE addr=${wallet.address} dry=${DRY_RUN}`);
  console.log(`START ETH=${ethers.utils.formatEther(startEth)} KILL=${ethers.utils.formatEther(startKill)}`);

  while(true){
    cycle += 1;
    const [ethBal, killBal, allowance] = await Promise.all([
      ethers.provider.getBalance(wallet.address),
      token.balanceOf(wallet.address),
      token.allowance(wallet.address, GAME)
    ]);

    const ethDown = startEth.sub(ethBal);
    const killDown = startKill.sub(killBal);
    if (ethDown.gte(MAX_ETH_DRAWDOWN) || killDown.gte(MAX_KILL_DRAWDOWN)) {
      console.log(`STOP_LOSS cycle=${cycle} ethDown=${ethers.utils.formatEther(ethDown)} killDown=${ethers.utils.formatEther(killDown)}`);
      break;
    }

    if (allowance.lt(ethers.utils.parseEther('1000000')) && !DRY_RUN) {
      const tx = await token.approve(GAME, ethers.constants.MaxUint256);
      await tx.wait();
      console.log(`APPROVE tx=${tx.hash}`);
    }

    const raw = await game.callStatic.multicall(HOTSPOTS.map((id)=>game.interface.encodeFunctionData('getFullStack', [id])));

    const actions = [];
    const notes = [];

    for(let i=0;i<HOTSPOTS.length;i++){
      if (actions.length >= MAX_TX_PER_CYCLE) break;
      const sid = HOTSPOTS[i];
      const items = game.interface.decodeFunctionResult('getFullStack', raw[i])[0];
      const self = items.find((x)=>x.occupant.toLowerCase()===me && (x.units.gt(0)||x.reapers.gt(0)));
      const enemies = items.filter((x)=>x.occupant.toLowerCase()!==me && (x.units.gt(0)||x.reapers.gt(0)));
      if (enemies.length === 0) continue;

      if (self) {
        const selfPower = power(self.units, self.reapers);
        const viable = enemies
          .map((e)=>({ e, p: power(e.units, e.reapers), f: ratio(selfPower, power(e.units, e.reapers)) }))
          .filter((x)=>x.f >= MIN_FORCE_RATIO && x.e.pendingBounty.gte(MIN_DIRECT_BOUNTY))
          .sort((a,b)=> b.e.pendingBounty.gt(a.e.pendingBounty) ? 1 : -1);
        if (viable.length > 0) {
          const t = viable[0];
          actions.push({ sid, type:'direct', calls:[game.interface.encodeFunctionData('kill', [t.e.occupant, sid, self.units, self.reapers])], bounty:t.e.pendingBounty, force:t.f });
          notes.push(`direct@${sid} bounty=${ethers.utils.formatEther(t.e.pendingBounty)} force=${t.f.toFixed(2)}`);
          continue;
        }
      }

      if (!self) {
        const seedReapers = SPAWN_UNITS.div(REAPER);
        const seedPower = power(SPAWN_UNITS, seedReapers);
        const viable = enemies
          .map((e)=>({ e, p: power(e.units, e.reapers), f: ratio(seedPower, power(e.units, e.reapers)) }))
          .filter((x)=>x.f >= MIN_FORCE_RATIO)
          .sort((a,b)=> b.e.pendingBounty.gt(a.e.pendingBounty) ? 1 : -1);
        if (viable.length > 0) {
          const top3Bounty = viable.slice(0,3).reduce((acc,x)=>acc.add(x.e.pendingBounty), ethers.BigNumber.from(0));
          const estRoi = Number(top3Bounty.mul(1000).div(SPAWN_COST).toString())/1000;
          if (top3Bounty.gte(MIN_SEED_STACK_BOUNTY) && estRoi >= SEED_ROI_GATE && killBal.gte(SPAWN_COST)) {
            const t = viable[0];
            const calls = [game.interface.encodeFunctionData('spawn', [sid, SPAWN_UNITS]), game.interface.encodeFunctionData('kill', [t.e.occupant, sid, SPAWN_UNITS, seedReapers])];
            actions.push({ sid, type:'spawnkill', calls, bounty:t.e.pendingBounty, force:t.f, estRoi });
            notes.push(`spawnkill@${sid} bounty=${ethers.utils.formatEther(t.e.pendingBounty)} force=${t.f.toFixed(2)} estRoi=${estRoi.toFixed(2)}`);
          }
        }
      }
    }

    if (actions.length === 0 && FULL_SCAN_ON_IDLE && killBal.gte(SPAWN_COST)) {
      const allIds = Array.from({ length: 216 }, (_, i) => i + 1);
      const allRaw = await game.callStatic.multicall(allIds.map((id)=>game.interface.encodeFunctionData('getFullStack', [id])));
      const seedReapers = SPAWN_UNITS.div(REAPER);
      const seedPower = power(SPAWN_UNITS, seedReapers);
      let best = null;
      for (let i = 0; i < 216; i++) {
        const sid = i + 1;
        const items = game.interface.decodeFunctionResult('getFullStack', allRaw[i])[0];
        for (const e of items) {
          if (e.occupant.toLowerCase() === me) continue;
          if (e.units.isZero() && e.reapers.isZero()) continue;
          const ep = power(e.units, e.reapers);
          const f = ratio(seedPower, ep);
          if (f < 0.6) continue;
          if (e.pendingBounty.lt(MIN_SEED_STACK_BOUNTY)) continue;
          const estRoi = Number(e.pendingBounty.mul(1000).div(SPAWN_COST).toString()) / 1000;
          if (estRoi < SEED_ROI_GATE) continue;
          if (!best || e.pendingBounty.gt(best.bounty)) {
            best = { sid, target: e.occupant, bounty: e.pendingBounty, force: f, estRoi };
          }
        }
      }
      if (best) {
        const calls = [
          game.interface.encodeFunctionData('spawn', [best.sid, SPAWN_UNITS]),
          game.interface.encodeFunctionData('kill', [best.target, best.sid, SPAWN_UNITS, seedReapers])
        ];
        actions.push({ sid: best.sid, type: 'spawnkill', calls, bounty: best.bounty, force: best.force, estRoi: best.estRoi });
        notes.push(`explore@${best.sid} bounty=${ethers.utils.formatEther(best.bounty)} force=${best.force.toFixed(2)} estRoi=${best.estRoi.toFixed(2)}`);
      }
    }

    console.log(`CYCLE=${cycle} ETH=${ethers.utils.formatEther(ethBal)} KILL=${ethers.utils.formatEther(killBal)} ACTIONS=${actions.length}`);
    if (notes.length) console.log(`PLANS=${notes.join(' | ')}`);

    let sent = 0;
    for (const a of actions) {
      if (sent >= MAX_TX_PER_CYCLE) break;
      try {
        await game.callStatic.multicall(a.calls);
      } catch {
        continue;
      }
      if (DRY_RUN) {
        console.log(`DRY ${a.type}@${a.sid}`);
        sent += 1;
        continue;
      }
      const tx = await game.multicall(a.calls, { gasLimit: 350000, gasPrice: ethers.utils.parseUnits('0.2', 'gwei') });
      console.log(`TX ${a.type}@${a.sid} hash=${tx.hash}`);
      await tx.wait();
      sent += 1;
    }

    await new Promise((r)=>setTimeout(r, LOOP_MS));
  }
}

main().catch((e)=>{ console.error(`ERR=${e.reason || e.message || e}`); process.exit(1); });
