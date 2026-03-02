const assert = require("assert");
const { ethers } = require("hardhat");
const { calcPower, calcSpawnPlan, roundUpToStep, toFloatRatio } = require("./agent");

const cfg = {
    OVERKILL_RATIO: ethers.BigNumber.from(8),
    MIN_SPAWN: ethers.BigNumber.from(666),
    SPAWN_STEP: ethers.BigNumber.from(666),
    GAS_BUFFER_KILL: ethers.BigNumber.from(0)
};

function run() {
    const v1 = roundUpToStep(ethers.BigNumber.from(667), ethers.BigNumber.from(666));
    assert.strictEqual(v1.toString(), "1332", "roundUpToStep should round to next 666 step");

    const enemyPowerSmall = calcPower(ethers.BigNumber.from(100), ethers.BigNumber.from(0));
    const smallPlan = calcSpawnPlan(enemyPowerSmall, cfg);
    assert.strictEqual(smallPlan.spawnAmt.toString(), "666", "minimum spawn should be 666");
    assert.strictEqual(smallPlan.spawnReaper.toString(), "1", "666 spawn should emit 1 reaper");
    assert.strictEqual(smallPlan.spawnPower.toString(), "1332", "666 spawn should produce 1332 power");
    assert.strictEqual(
        smallPlan.attackCost.toString(),
        ethers.utils.parseEther("13320").toString(),
        "attack cost is unit-based"
    );

    const enemyPowerLarge = calcPower(ethers.BigNumber.from(2000), ethers.BigNumber.from(3));
    const largePlan = calcSpawnPlan(enemyPowerLarge, cfg);
    assert(largePlan.spawnAmt.mod(666).isZero(), "spawn should stay on 666 boundaries");
    assert(
        largePlan.spawnPower.gte(enemyPowerLarge.mul(cfg.OVERKILL_RATIO)),
        "spawn power should satisfy configured overkill ratio"
    );

    const roi = toFloatRatio(ethers.BigNumber.from(20000), ethers.BigNumber.from(10000));
    assert.strictEqual(roi, 2, "ratio helper should keep expected precision");

    console.log("sniper math tests passed");
}

run();
