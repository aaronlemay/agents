const hre = require('hardhat');
const { ethers } = hre;
require('dotenv').config({ path: '/Users/aaronlemay/agents/.env' });

async function main(){
  const pk = process.env.SNIPER_PK || process.env.FORTRESS_PK;
  if(!pk) throw new Error('Missing SNIPER_PK/FORTRESS_PK in /Users/aaronlemay/agents/.env');
  const wallet = new ethers.Wallet(pk, ethers.provider);
  const GAME = '0xfd21c1c28d58e420837e8057A227C3D432D289Ec';
  const game = new ethers.Contract(GAME, [
    'function killToken() view returns(address)'
  ], wallet);
  const tokenAddr = await game.killToken();
  const token = new ethers.Contract(tokenAddr, [
    'function balanceOf(address) view returns(uint256)',
    'function symbol() view returns(string)'
  ], wallet);
  const [eth, kill, block] = await Promise.all([
    ethers.provider.getBalance(wallet.address),
    token.balanceOf(wallet.address),
    ethers.provider.getBlockNumber()
  ]);
  const symbol = await token.symbol().catch(()=> 'KILL');
  console.log('ADDR='+wallet.address);
  console.log('GAME='+GAME);
  console.log('TOKEN='+tokenAddr);
  console.log('BLOCK='+block);
  console.log('ETH='+ethers.utils.formatEther(eth));
  console.log(symbol+'='+ethers.utils.formatEther(kill));
}

main().catch((e)=>{console.error(e.message||e); process.exit(1);});
