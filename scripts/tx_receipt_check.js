const hre = require('hardhat');
const { ethers } = hre;

async function main(){
  const hs=[
    '0x4be458adc307808222b998badf619ca369f77849893e00b1fcad576a26ec0e31',
    '0x7f85e452d18f201c39617e4280a8727197504f30518d6f682c366903fa5aec8b'
  ];
  for(const h of hs){
    const tx = await ethers.provider.getTransaction(h);
    const r = await ethers.provider.getTransactionReceipt(h);
    if(!r){
      console.log(`${h} receipt=MISSING`);
      continue;
    }
    console.log(`${h} status=${r.status} gasUsed=${r.gasUsed.toString()} gasLimit=${tx&&tx.gasLimit?tx.gasLimit.toString():'?'} to=${tx&&tx.to?tx.to:'?'} block=${r.blockNumber}`);
  }
}

main().catch((e)=>{ console.error(e.message||e); process.exit(1); });
