const hre = require('hardhat');
const { ethers } = hre;
require('dotenv').config({ path: '/Users/aaronlemay/agents/.env' });

async function main(){
  const w = new ethers.Wallet(process.env.SNIPER_PK, ethers.provider);
  const game = new ethers.Contract('0xfd21c1c28d58e420837e8057A227C3D432D289Ec', [
    'function getFullStack(uint16) view returns((address occupant,uint256 units,uint256 reapers,uint256 age,uint256 pendingBounty)[])',
    'function multicall(bytes[]) returns(bytes[])'
  ], w);
  const ids = Array.from({length:216}, (_,i)=>i+1);
  const raw = await game.callStatic.multicall(ids.map((id)=>game.interface.encodeFunctionData('getFullStack',[id])));
  const me = w.address.toLowerCase();
  const seedUnits = ethers.BigNumber.from(666);
  const seedPower = seedUnits.add(seedUnits.div(666).mul(666));
  const seedCost = ethers.utils.parseEther('20').mul(seedUnits);
  let bestRoi = null;
  let bestForce = null;
  let bestBlend = null;
  let count=0;
  for(let i=0;i<216;i++){
    const sid=i+1;
    const items = game.interface.decodeFunctionResult('getFullStack', raw[i])[0];
    for(const e of items){
      if(e.occupant.toLowerCase()===me) continue;
      if(e.units.isZero()&&e.reapers.isZero()) continue;
      const p = e.units.add(e.reapers.mul(666));
      const f = Number(seedPower.mul(10000).div(p).toString())/10000;
      const roi = Number(e.pendingBounty.mul(1000).div(seedCost).toString())/1000;
      const rec={sid,target:e.occupant,bounty:ethers.utils.formatEther(e.pendingBounty),power:p.toString(),force:f,roi};
      if(!bestRoi || roi>bestRoi.roi) bestRoi=rec;
      if(!bestForce || f>bestForce.force) bestForce=rec;
      if((f>=0.6||roi>=0.6) && (!bestBlend || (roi*f)>(bestBlend.roi*bestBlend.force))) bestBlend=rec;
      count++;
    }
  }
  console.log('CANDIDATE_COUNT='+count);
  console.log('BEST_ROI='+JSON.stringify(bestRoi));
  console.log('BEST_FORCE='+JSON.stringify(bestForce));
  console.log('BEST_BLEND='+JSON.stringify(bestBlend));
}
main().catch((e)=>{console.error(e.message||e); process.exit(1);});
