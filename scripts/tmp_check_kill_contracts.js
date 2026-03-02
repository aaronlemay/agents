const hre = require('hardhat');
const { ethers } = hre;
require('dotenv').config({ path: '/Users/aaronlemay/agents/.env' });

async function main(){
  const wallet = new ethers.Wallet(process.env.SNIPER_PK, ethers.provider);
  const games = [
    '0xfd21c1c28d58e420837e8057A227C3D432D289Ec',
    '0x23e55f52C4215d7162861761C6063399E021BA3f'
  ];
  console.log('ADDR='+wallet.address);
  for (const g of games){
    try{
      const game = new ethers.Contract(g, ['function killToken() view returns(address)'], wallet);
      const t = await game.killToken();
      const token = new ethers.Contract(t,[
        'function balanceOf(address) view returns(uint256)',
        'function symbol() view returns(string)',
        'function decimals() view returns(uint8)'
      ], wallet);
      const [bal,sym,dec] = await Promise.all([
        token.balanceOf(wallet.address),
        token.symbol().catch(()=>'?'),
        token.decimals().catch(()=>18)
      ]);
      console.log(`GAME=${g} TOKEN=${t} SYMBOL=${sym} DEC=${dec} BAL=${ethers.utils.formatUnits(bal,dec)}`);
    } catch(e){
      console.log(`GAME=${g} ERR=${e.reason||e.message||e}`);
    }
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
