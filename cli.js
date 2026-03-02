#!/usr/bin/env node
const { program } = require('commander');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = __dirname;
require('dotenv').config({ path: path.join(ROOT, '.env') });

const stackValidator = (val) => {
    const n = parseInt(val);
    if (n >= 1 && n <= 216) return true;
    return "Stack ID must be between 1 and 216";
};

program.command('setup').action(async () => {
  const ans = await inquirer.prompt([
    { type: 'input', name: 'pk', message: 'Enter Private Key (used for all agents):', mask: '*' },
    { type: 'input', name: 'hub', message: 'Hub Stack [1-216]:', default: '1', validate: stackValidator },
    { type: 'input', name: 'units', message: 'Target Units:', default: '666' },
    { type: 'input', name: 'f_replenish', message: 'Fortress: REPLENISH_AMT:', default: '666' },
    { type: 'input', name: 'f_perimeter', message: 'Fortress: HUB_PERIMETER:', default: '1' },
    { type: 'input', name: 's_mult', message: 'Sniper/Aftershock: KILL_MULTIPLIER:', default: '3' },
    { type: 'input', name: 's_thresh', message: 'Sniper: PROFIT_THRESHOLD:', default: '0.25' },
    { type: 'input', name: 'a_max_kill', message: 'Aftershock: MAX_KILL (effective power limit):', default: '1000000' }
  ]);

  fs.writeFileSync(path.join(ROOT, '.env'), `SNIPER_PK=${ans.pk}\nFORTRESS_PK=${ans.pk}\nAFTERSHOCK_PK=${ans.pk}\n`);

  // Fortress Config
  const fPath = path.join(ROOT, 'agents/fortress/config.json');
  if(fs.existsSync(fPath)) {
    let fConf = JSON.parse(fs.readFileSync(fPath, 'utf8'));
    fConf.settings.HUB_STACK = parseInt(ans.hub);
    fConf.settings.TARGET_UNITS = parseInt(ans.units);
    fConf.settings.REPLENISH_AMT = parseInt(ans.f_replenish);
    fConf.settings.HUB_PERIMETER = parseInt(ans.f_perimeter);
    fs.writeFileSync(fPath, JSON.stringify(fConf, null, 2));
  }

  // Sniper Config
  const sPath = path.join(ROOT, 'agents/sniper/config.json');
  if(fs.existsSync(sPath)) {
    let sConf = JSON.parse(fs.readFileSync(sPath, 'utf8'));
    sConf.settings.HUB_STACK = parseInt(ans.hub);
    sConf.settings.KILL_MULTIPLIER = parseInt(ans.s_mult);
    sConf.settings.SPAWN_PROFITABILITY_THRESHOLD = parseFloat(ans.s_thresh);
    sConf.settings.SUBGRAPH_URL = "https://api.goldsky.com/api/public/project_cmlgypvyy520901u8f5821f19/subgraphs/kill-testnet-subgraph/1.0.2/gn";
    fs.writeFileSync(sPath, JSON.stringify(sConf, null, 2));
  }
  
  // Aftershock Config - Writes config based on prompt
  const aPath = path.join(ROOT, 'agents/aftershock/config.json');
  if(fs.existsSync(aPath)) {
    let aConf = JSON.parse(fs.readFileSync(aPath, 'utf8'));
    aConf.settings.KILL_MULTIPLIER = parseInt(ans.s_mult);
    aConf.settings.MAX_KILL = parseInt(ans.a_max_kill);
    aConf.settings.SUBGRAPH_URL = "https://api.goldsky.com/api/public/project_cmlgypvyy520901u8f5821f19/subgraphs/kill-testnet-subgraph/1.0.2/gn";
    fs.writeFileSync(aPath, JSON.stringify(aConf, null, 2));
  }
  console.log('✅ Setup Complete.');
});

program.command('list agents').action(() => {
    console.log(JSON.stringify(['fortress', 'sniper', 'aftershock']));
});

program.command('start <role>').action((role) => {
  const agentDir = path.join(ROOT, 'agents', role);
  if (!fs.existsSync(agentDir)) { console.error(`❌ Role ${role} not found. Use 'killgame list agents' to see available agents.`); return; }
  const agentPath = path.join(agentDir, 'agent.js');
  const config = JSON.parse(fs.readFileSync(path.join(agentDir, 'config.json'), 'utf8'));
  const networkName = config.network.network_name || "basesepolia";
  const pk = process.env[`${role.toUpperCase()}_PK`];
  if(!pk) { console.error(`❌ Run 'killgame setup' first.`); process.exit(1); }

  spawn('npx', ['hardhat', 'run', agentPath, '--network', networkName], { 
    cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, PRIVATE_KEY: pk, FORCE_COLOR: "1" } 
  });
});
program.parse(process.argv);
