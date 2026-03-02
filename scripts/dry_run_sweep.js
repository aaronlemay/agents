const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: "/Users/aaronlemay/.env" });

const AGENTS = [
  { name: "sniper", config: "/Users/aaronlemay/agents/sniper/config.json", pks: ["SNIPER_PK"] },
  { name: "fortress", config: "/Users/aaronlemay/agents/fortress/config.json", pks: ["FORTRESS_PK"] },
  { name: "layer-harvester", config: "/Users/aaronlemay/agents/layer-harvester/config.json", pks: ["LAYER_HARVESTER_PK", "SNIPER_PK"] },
  { name: "aftershock", config: "/Users/aaronlemay/agents/aftershock/config.json", pks: ["AFTERSHOCK_PK"] },
  { name: "phantom", config: "/Users/aaronlemay/agents/phantom/config.json", pks: ["PHANTOM_PK"] },
  { name: "parasite", config: "/Users/aaronlemay/agents/parasite/config.json", pks: ["PARASITE_PK", "SNIPER_PK"] },
  { name: "seeder", config: "/Users/aaronlemay/agents/seeder/config.json", pks: ["SEEDER_PK", "SNIPER_PK"] },
  { name: "sentinel", config: "/Users/aaronlemay/agents/sentinel/config.json", pks: ["SENTINEL_PK", "SNIPER_PK"] }
];

function readAbi(file) {
  return JSON.parse(fs.readFileSync(file, "utf8")).abi;
}

function pickPk(keys) {
  for (const k of keys) {
    if (process.env[k] && process.env[k].trim()) return process.env[k].trim();
  }
  return null;
}

function hasMethod(contract, name) {
  return typeof contract[name] === "function";
}

async function checkAgent(a) {
  const out = {
    agent: a.name,
    status: "PASS",
    details: []
  };

  try {
    const rawCfg = JSON.parse(fs.readFileSync(a.config, "utf8"));
    const gameAddr = rawCfg.network && rawCfg.network.kill_game_addr;
    const faucetAddr = rawCfg.network && rawCfg.network.kill_faucet_addr;

    const pk = pickPk(a.pks);
    if (!pk) {
      out.status = "SKIP";
      out.details.push(`missing pk: ${a.pks.join("|")}`);
      return out;
    }

    const wallet = new ethers.Wallet(pk, ethers.provider);
    const gameAbi = readAbi("/Users/aaronlemay/agents/data/abi/KILLGame.json");
    const game = new ethers.Contract(gameAddr, gameAbi, wallet);

    if (!hasMethod(game, "killToken") || !hasMethod(game, "multicall") || !hasMethod(game, "getFullStack")) {
      out.status = "FAIL";
      out.details.push("required game methods missing in ABI binding");
      return out;
    }

    const killTokenAddr = await game.killToken();
    out.details.push(`wallet=${wallet.address}`);
    out.details.push(`killToken=${killTokenAddr}`);

    const calls = [1, 125, 216].map((id) => game.interface.encodeFunctionData("getFullStack", [id]));
    const raw = await game.callStatic.multicall(calls);
    const decoded0 = game.interface.decodeFunctionResult("getFullStack", raw[0])[0] || [];
    out.details.push(`multicall_ok stacks=3 stack1_entries=${decoded0.length}`);

    if (hasMethod(game, "getTreasuryStats")) {
      try {
        const t = await game.getTreasuryStats();
        out.details.push(`treasury_stats_ok max=${ethers.utils.formatEther(t.globalMaxBounty || 0)}`);
      } catch (e) {
        out.details.push(`treasury_stats_call_failed=${e.reason || e.message}`);
      }
    } else {
      out.details.push("treasury_stats_unavailable (expected on this deployment)");
    }

    if (faucetAddr && faucetAddr !== ethers.constants.AddressZero) {
      const faucetAbi = readAbi("/Users/aaronlemay/agents/data/abi/KILLFaucet.json");
      const faucet = new ethers.Contract(faucetAddr, faucetAbi, wallet);
      const faucetHasMethods = hasMethod(faucet, "hasClaimed") && hasMethod(faucet, "pullKill");
      out.details.push(`faucet_methods=${faucetHasMethods ? "ok" : "missing"}`);
      if (faucetHasMethods) {
        try {
          const claimed = await faucet.hasClaimed(wallet.address);
          out.details.push(`faucet_hasClaimed=${claimed}`);
        } catch (e) {
          out.details.push(`faucet_hasClaimed_call_failed=${e.reason || e.message}`);
        }
      }
    } else {
      out.details.push("faucet_not_configured");
    }

    return out;
  } catch (e) {
    out.status = "FAIL";
    out.details.push(e.reason || e.message || String(e));
    return out;
  }
}

async function main() {
  const results = [];
  for (const a of AGENTS) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await checkAgent(a));
  }

  console.log("DRY_RUN_SWEEP_RESULTS");
  for (const r of results) {
    console.log(`- ${r.agent}: ${r.status}`);
    for (const d of r.details) console.log(`  ${d}`);
  }

  const failed = results.filter((r) => r.status === "FAIL").length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
