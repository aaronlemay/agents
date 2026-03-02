const hre = require('hardhat');
const { ethers } = hre;

const TXS = [
  '0xfa28764b90e5a2ee81d346cdb89224c23ae21224272c4c071d37448ce59bbc3c',
  '0x802e9a5112361e0c2ad2c6b21882545dd28b7dcf57a398b21f1d7799db7803c1',
  '0xb4f6e9516af7e369f9136f6cd346486c4cd66bfa0556f740a7e1ded29659ff6c'
];

const wallet = '0x3944793e9EB7C838178c52B66f09B8B24c887AfE'.toLowerCase();
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');

async function main(){
  const p = ethers.provider;
  for (const h of TXS){
    const [tx, rc] = await Promise.all([p.getTransaction(h), p.getTransactionReceipt(h)]);
    if (!tx){
      console.log(`TX=${h} MISSING`);
      continue;
    }
    console.log(`TX=${h}`);
    console.log(` status=${rc ? rc.status : 'pending'} block=${rc ? rc.blockNumber : 'n/a'} gasUsed=${rc ? rc.gasUsed.toString() : 'n/a'} effectiveGasPrice=${rc ? rc.effectiveGasPrice.toString() : 'n/a'}`);
    console.log(` to=${tx.to} nonce=${tx.nonce}`);
    const logs = (rc?.logs || []).filter(l => l.topics && l.topics[0] === TRANSFER_TOPIC);
    if (!logs.length){
      console.log(' transferLogs=0');
      continue;
    }
    console.log(` transferLogs=${logs.length}`);
    for (const l of logs){
      const from = '0x'+l.topics[1].slice(26);
      const to = '0x'+l.topics[2].slice(26);
      const val = ethers.BigNumber.from(l.data);
      const fromMe = from.toLowerCase()===wallet;
      const toMe = to.toLowerCase()===wallet;
      if (fromMe || toMe){
        console.log(`  token=${l.address} from=${from} to=${to} value=${ethers.utils.formatEther(val)} meDir=${fromMe?'OUT':'IN'}`);
      }
    }
  }
}

main().catch(e=>{console.error(e); process.exit(1);});
