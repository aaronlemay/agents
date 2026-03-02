const hre=require('hardhat'); const {ethers}=hre;
const h=process.env.TX;
(async()=>{const tx=await ethers.provider.getTransaction(h); const rc=await ethers.provider.getTransactionReceipt(h); console.log('TX='+h); console.log('found='+(!!tx)); console.log('status='+(rc?rc.status:'na')); console.log('gasUsed='+(rc?rc.gasUsed.toString():'na')); console.log('block='+(rc?rc.blockNumber:'na'));})();
