const hre = require('hardhat');
const { ethers } = hre;
require('dotenv').config({ path: '/Users/aaronlemay/agents/.env' });

const GAME = '0xfd21c1c28d58e420837e8057A227C3D432D289Ec';
const FORCE_REQ = Number(process.env.FORCE_REQ || 1.2);
const MIN_ROI = Number(process.env.MIN_ROI || 2.0);
const MIN_BOUNTY = ethers.utils.parseEther(process.env.MIN_BOUNTY || '500000');
const MAX_TX = Number(process.env.MAX_TX || 1);
const MAX_GAS_LIMIT = Number(process.env.MAX_GAS_LIMIT || 500000);
const GAS_GWEI = process.env.GAS_GWEI || '0.3';
const DRY_RUN = process.env.DRY_RUN === 'true';

const REAPER = ethers.BigNumber.from(666);

function powerFromUnits(u){
  const r = u.div(666);
  return u.add(r.mul(666));
}

function reqUnits(enemyPower, forceReq){
  // first estimate using p ~ 2u for large u
  let u = enemyPower.mul(Math.round(forceReq * 1000)).div(2000);
  if (u.lt(ethers.BigNumber.from(666))) u = ethers.BigNumber.from(666);
  const rem = u.mod(666);
  if (!rem.isZero()) u = u.add(ethers.BigNumber.from(666).sub(rem));
  for(let i=0;i<6;i++){
    const p = powerFromUnits(u);
    const f = Number(p.mul(10000).div(enemyPower).toString())/10000;
    if (f >= forceReq) return u;
    u = u.add(666);
  }
  return u;
}

async function main(){
  const pk = process.env.SNIPER_PK;
  if(!pk) throw new Error('Missing SNIPER_PK in /Users/aaronlemay/agents/.env');
  const wallet = new ethers.Wallet(pk, ethers.provider);
  const game = new ethers.Contract(GAME, [
    'function getFullStack(uint16) view returns((address occupant,uint256 units,uint256 reapers,uint256 age,uint256 pendingBounty)[])',
    'function multicall(bytes[]) returns(bytes[])',
    'function spawn(uint16,uint256)',
    'function kill(address,uint16,uint256,uint256)',
    'function killToken() view returns(address)'
  ], wallet);
  const token = new ethers.Contract(await game.killToken(), [
    'function balanceOf(address) view returns(uint256)',
    'function allowance(address,address) view returns(uint256)',
    'function approve(address,uint256) returns(bool)'
  ], wallet);

  const me = wallet.address.toLowerCase();
  const [ethBal, killBal, allowance] = await Promise.all([
    ethers.provider.getBalance(wallet.address),
    token.balanceOf(wallet.address),
    token.allowance(wallet.address, GAME)
  ]);

  const ids = Array.from({length:216}, (_,i)=>i+1);
  const raw = await game.callStatic.multicall(ids.map((id)=>game.interface.encodeFunctionData('getFullStack', [id])));

  const cands=[];
  for(let i=0;i<216;i++){
    const sid = i + 1;
    const items = game.interface.decodeFunctionResult('getFullStack', raw[i])[0];
    for(const e of items){
      if (e.occupant.toLowerCase()===me) continue;
      if (e.units.isZero() && e.reapers.isZero()) continue;
      if (e.pendingBounty.lt(MIN_BOUNTY)) continue;
      const enemyPower = e.units.add(e.reapers.mul(REAPER));
      if (enemyPower.lte(0)) continue;
      const u = reqUnits(enemyPower, FORCE_REQ);
      const r = u.div(666);
      const attackPower = powerFromUnits(u);
      const force = Number(attackPower.mul(10000).div(enemyPower).toString())/10000;
      const cost = ethers.utils.parseEther('20').mul(u);
      if (cost.gt(killBal)) continue;
      const roi = Number(e.pendingBounty.mul(1000).div(cost).toString())/1000;
      if (roi < MIN_ROI) continue;
      cands.push({ sid, target:e.occupant, bounty:e.pendingBounty, enemyPower, u, r, cost, roi, force });
    }
  }

  cands.sort((a,b)=>{
    if (a.roi !== b.roi) return b.roi - a.roi;
    if (!a.bounty.eq(b.bounty)) return b.bounty.gt(a.bounty) ? 1 : -1;
    return a.sid - b.sid;
  });

  console.log(`ADDR=${wallet.address}`);
  console.log(`ETH=${ethers.utils.formatEther(ethBal)} KILL=${ethers.utils.formatEther(killBal)} ALLOW=${allowance.gt(ethers.constants.MaxUint256.div(2))?'MAX':ethers.utils.formatEther(allowance)}`);
  console.log(`CANDIDATES=${cands.length}`);
  for (const c of cands.slice(0, 8)) {
    console.log(`PLAN sid=${c.sid} target=${c.target} bounty=${ethers.utils.formatEther(c.bounty)} cost=${ethers.utils.formatEther(c.cost)} roi=${c.roi.toFixed(2)} force=${c.force.toFixed(2)} u=${c.u.toString()} r=${c.r.toString()}`);
  }

  if (cands.length === 0) return;

  if (!DRY_RUN && allowance.lt(ethers.utils.parseEther('1000000'))) {
    const app = await token.approve(GAME, ethers.constants.MaxUint256);
    await app.wait();
    console.log(`APPROVE=${app.hash}`);
  }

  let sent = 0;
  for (const c of cands) {
    if (sent >= MAX_TX) break;
    const calls = [
      game.interface.encodeFunctionData('spawn', [c.sid, c.u]),
      game.interface.encodeFunctionData('kill', [c.target, c.sid, c.u, c.r])
    ];
    try {
      await game.callStatic.multicall(calls);
    } catch {
      continue;
    }

    if (DRY_RUN) {
      console.log(`DRY sid=${c.sid} roi=${c.roi.toFixed(2)}`);
      sent += 1;
      continue;
    }

    const tx = await game.multicall(calls, {
      gasLimit: MAX_GAS_LIMIT,
      gasPrice: ethers.utils.parseUnits(GAS_GWEI, 'gwei')
    });
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) {
      console.log(`REVERT tx=${tx.hash} sid=${c.sid} roi=${c.roi.toFixed(2)}`);
      continue;
    }
    console.log(`TX=${tx.hash} sid=${c.sid} roi=${c.roi.toFixed(2)} gasUsed=${rcpt.gasUsed.toString()}`);
    sent += 1;
  }

  const [ethAfter, killAfter] = await Promise.all([
    ethers.provider.getBalance(wallet.address),
    token.balanceOf(wallet.address)
  ]);
  console.log(`DONE sent=${sent} ETH_AFTER=${ethers.utils.formatEther(ethAfter)} KILL_AFTER=${ethers.utils.formatEther(killAfter)}`);
}

main().catch((e)=>{ console.error(`ERR=${e.reason || e.message || e}`); process.exit(1); });
