const { ethers } = require("ethers");
require("dotenv").config({ path: "/Users/aaronlemay/.env" });

const RPC = "https://sepolia.base.org";
const GAME = "0xfd21c1c28d58e420837e8057A227C3D432D289Ec";

const TARGET_STACKS = (process.env.TARGET_STACKS || "2,61,186,116,138,83,99,119,122")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x >= 1 && x <= 216);
const SPAWN_UNITS = ethers.BigNumber.from(process.env.SPAWN_UNITS || "666");
const MAX_TX = Number(process.env.MAX_TX || 6);
const FORCE_TOPUP = process.env.FORCE_TOPUP === "true";

async function main() {
  if (!process.env.SNIPER_PK) throw new Error("Missing SNIPER_PK in /Users/aaronlemay/.env");
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.SNIPER_PK, provider);

  const game = new ethers.Contract(
    GAME,
    [
      "function killToken() view returns(address)",
      "function getFullStack(uint16) view returns((address occupant,uint256 units,uint256 reapers,uint256 age,uint256 pendingBounty)[])",
      "function spawn(uint16,uint256)",
      "function multicall(bytes[]) returns(bytes[])",
    ],
    wallet
  );

  const token = new ethers.Contract(
    await game.killToken(),
    [
      "function balanceOf(address) view returns(uint256)",
      "function allowance(address,address) view returns(uint256)",
      "function approve(address,uint256) returns(bool)",
    ],
    wallet
  );

  const me = wallet.address.toLowerCase();
  const [killBal, allow] = await Promise.all([
    token.balanceOf(wallet.address),
    token.allowance(wallet.address, GAME),
  ]);
  console.log(`ADDR=${wallet.address}`);
  console.log(`KILL_BEFORE=${ethers.utils.formatEther(killBal)}`);

  if (allow.lt(ethers.constants.MaxUint256.div(4))) {
    const ap = await token.approve(GAME, ethers.constants.MaxUint256, {
      gasPrice: ethers.utils.parseUnits("0.2", "gwei"),
    });
    console.log(`APPROVE_TX=${ap.hash}`);
    await ap.wait();
  }

  let sent = 0;
  let nonce = await provider.getTransactionCount(wallet.address, "pending");

  for (const sid of TARGET_STACKS) {
    if (sent >= MAX_TX) break;
    const items = await game.getFullStack(sid);
    const mine = items.find((it) => it.occupant.toLowerCase() === me && (it.units.gt(0) || it.reapers.gt(0)));
    if (mine && !FORCE_TOPUP) {
      console.log(`SKIP_STACK_${sid}=already_present`);
      continue;
    }
    if (mine && FORCE_TOPUP) {
      console.log(`TOPUP_STACK_${sid}=present,spawning_more`);
    }

    const calls = [game.interface.encodeFunctionData("spawn", [sid, SPAWN_UNITS])];
    try {
      await game.callStatic.multicall(calls);
    } catch {
      console.log(`SKIP_STACK_${sid}=not_executable`);
      continue;
    }

    const tx = await game.multicall(calls, {
      nonce,
      gasPrice: ethers.utils.parseUnits("0.2", "gwei"),
      gasLimit: 220000,
    });
    console.log(`TX_${sent + 1}=${tx.hash},STACK=${sid},SPAWN=${SPAWN_UNITS.toString()}`);
    const rc = await tx.wait();
    console.log(`TX_${sent + 1}_STATUS=${rc.status}`);

    sent += 1;
    nonce += 1;
  }

  const killAfter = await token.balanceOf(wallet.address);
  console.log(`TX_SENT=${sent}`);
  console.log(`KILL_AFTER=${ethers.utils.formatEther(killAfter)}`);
}

main().catch((e) => {
  console.error(`ERR=${e.reason || e.message || e}`);
  process.exit(1);
});
