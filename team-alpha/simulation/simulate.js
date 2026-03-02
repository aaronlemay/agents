const assert = require("assert");
const { ethers } = require("ethers");

const { chooseSentinelAction } = require("/Users/aaronlemay/agents/sentinel/agent.js");
const { chooseParasiteAction, chooseDominantWallet } = require("/Users/aaronlemay/agents/parasite/agent.js");
const { chooseSeedTargets } = require("/Users/aaronlemay/agents/seeder/agent.js");

function bn(v) { return ethers.BigNumber.from(v); }

function runSentinelTests() {
  const conf = { HUB_STACK: 125, MIN_DIRECT_FORCE_RATIO: 2 };
  const action1 = chooseSentinelAction({
    hubSelf: { units: bn(1000), reapers: bn(3) },
    hubEnemies: [{ occupant: "0xabc", units: bn(100), reapers: bn(0), pendingBounty: bn(1000) }],
    stranded: []
  }, conf);
  assert.strictEqual(action1.type, "HUB_PURGE");

  const action2 = chooseSentinelAction({
    hubSelf: null,
    hubEnemies: [],
    stranded: [{ id: 1, units: bn(666), reapers: bn(1) }]
  }, conf);
  assert.strictEqual(action2.type, "CONSOLIDATE");
}

function runParasiteTests() {
  const logs = [
    { args: { attacker: "0xAAA" } },
    { args: { attacker: "0xAAA" } },
    { args: { attacker: "0xBBB" } }
  ];
  const dom = chooseDominantWallet(logs);
  assert.strictEqual(dom.addr, "0xaaa");

  const action = chooseParasiteAction([
    { id: 10, force: 1.1, enemy: { pendingBounty: bn(10) }, self: { units: bn(1), reapers: bn(0) } },
    { id: 11, force: 1.5, enemy: { pendingBounty: bn(20), occupant: "0xdef" }, self: { units: bn(1), reapers: bn(0) } }
  ], 1.3);
  assert.strictEqual(action.type, "DIRECT_KILL");
  assert.strictEqual(action.stackId, 11);
}

function runSeederTests() {
  const picks = chooseSeedTargets([
    { id: 12, score: 1.2 },
    { id: 11, score: 2.4 },
    { id: 2, score: 1.5 }
  ], 2);
  assert.strictEqual(picks.length, 2);
  assert.strictEqual(picks[0].id, 11);
}

function main() {
  runSentinelTests();
  runParasiteTests();
  runSeederTests();
  console.log("[SIM] Strategy simulations passed.");
}

main();
