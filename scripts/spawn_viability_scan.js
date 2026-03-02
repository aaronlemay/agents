const hre = require('hardhat');
const { ethers } = hre;
require('dotenv').config({ path: '/Users/aaronlemay/agents/.env' });

function powerFromUnits(u){
  const r = u.div(666);
  return u.add(r.mul(666));
}

async function main(){
  const wallet = new ethers.Wallet(process.env.SNIPER_PK, ethers.provider);
  const game = new ethers.Contract('0xfd21c1c28d58e420837e8057A227C3D432D289Ec', [
    'function getFullStack(uint16) view returns((address occupant,uint256 units,uint256 reapers,uint256 age,uint256 pendingBounty)[])',
    'function multicall(bytes[]) returns(bytes[])',
    'function killToken() view returns(address)'
  ], wallet);
  const token = new ethers.Contract(await game.killToken(), ['function balanceOf(address) view returns(uint256)'], wallet);
  const killBal = await token.balanceOf(wallet.address);
  const ids = Array.from({length:216}, (_,i)=>i+1);
  const raw = await game.callStatic.multicall(ids.map((id)=>game.interface.encodeFunctionData('getFullStack',[id])));
  const me = wallet.address.toLowerCase();

  const forceReq = [0.8, 1.0, 1.2];
  for (const fr of forceReq) {
    let best = null;
    let count = 0;
    for(let i=0;i<216;i++){
      const sid=i+1;
      const items = game.interface.decodeFunctionResult('getFullStack', raw[i])[0];
      for(const e of items){
        if(e.occupant.toLowerCase()===me) continue;
        if(e.units.isZero()&&e.reapers.isZero()) continue;
        const enemyPower = e.units.add(e.reapers.mul(666));
        let u = enemyPower.mul(Math.round(fr*1000)).div(2000); // approx because power ~2u at scale
        if (u.lt(ethers.BigNumber.from(666))) u = ethers.BigNumber.from(666);
        const rem = u.mod(666);
        if (!rem.isZero()) u = u.add(ethers.BigNumber.from(666).sub(rem));
        // nudge until force satisfied
        for(let k=0;k<4;k++){
          const p = powerFromUnits(u);
          const f = Number(p.mul(10000).div(enemyPower).toString())/10000;
          if (f >= fr) break;
          u = u.add(666);
        }
        const cost = u.mul(ethers.utils.parseEther('20'));
        if (cost.gt(killBal)) continue;
        const roi = Number(e.pendingBounty.mul(1000).div(cost).toString())/1000;
        if (roi <= 0) continue;
        const rec = { sid, target:e.occupant, bounty:ethers.utils.formatEther(e.pendingBounty), cost:ethers.utils.formatEther(cost), roi, enemyPower:enemyPower.toString() };
        count += 1;
        if (!best || roi > best.roi) best = rec;
      }
    }
    console.log(`FORCE_REQ=${fr} feasible=${count}`);
    console.log(`BEST_${fr}=${best ? JSON.stringify(best) : 'NONE'}`);
  }
  console.log('KILL_BAL='+ethers.utils.formatEther(killBal));
}
main().catch((e)=>{console.error(e.message||e); process.exit(1);});
