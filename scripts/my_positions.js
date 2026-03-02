const hre = require('hardhat');
const { ethers } = hre;
require('dotenv').config({ path: '/Users/aaronlemay/agents/.env' });

async function main(){
  const pk = process.env.SNIPER_PK;
  if(!pk) throw new Error('Missing SNIPER_PK');
  const wallet = new ethers.Wallet(pk, ethers.provider);
  const game = new ethers.Contract('0xfd21c1c28d58e420837e8057A227C3D432D289Ec', [
    'function getFullStack(uint16) view returns((address occupant,uint256 units,uint256 reapers,uint256 age,uint256 pendingBounty)[])',
    'function multicall(bytes[]) returns(bytes[])'
  ], wallet);
  const ids = Array.from({length:216},(_,i)=>i+1);
  const raw = await game.callStatic.multicall(ids.map((id)=>game.interface.encodeFunctionData('getFullStack',[id])));
  const me = wallet.address.toLowerCase();
  const out=[];
  for(let i=0;i<216;i++){
    const sid=i+1;
    const items = game.interface.decodeFunctionResult('getFullStack', raw[i])[0];
    const self = items.find((x)=>x.occupant.toLowerCase()===me && (x.units.gt(0)||x.reapers.gt(0)));
    if(self) out.push({sid, units:self.units.toString(), reapers:self.reapers.toString(), bounty:ethers.utils.formatEther(self.pendingBounty)});
  }
  console.log('ADDR='+wallet.address);
  console.log('MY_STACKS='+out.length);
  for(const r of out.slice(0,40)) console.log(`${r.sid},u=${r.units},r=${r.reapers},b=${r.bounty}`);
}
main().catch((e)=>{console.error(e.message||e); process.exit(1);});
