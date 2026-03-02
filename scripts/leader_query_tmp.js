const fetch = require('node-fetch');

(async () => {
  const url = 'https://api.goldsky.com/api/public/project_cmlgypvyy520901u8f5821f19/subgraphs/kill-testnet-subgraph/1.0.2/gn';
  const query = `{
    agents(first: 15, orderBy: netPnL, orderDirection: desc, where: { id_not: "0x0000000000000000000000000000000000000000" }) {
      id
      totalSpent
      totalEarned
      netPnL
    }
    killeds(first: 20, orderBy: block_number, orderDirection: desc, where: { attacker: "0x3944793e9eb7c838178c52b66f09b8b24c887afe" }) {
      id
      attacker
      target
      stackId
      attackerBounty
      defenderBounty
      block_number
    }
  }`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query })
  });

  const j = await r.json();
  if (j.errors) {
    console.log('ERRORS=' + JSON.stringify(j.errors));
    process.exit(0);
  }

  console.log('TOP_AGENTS=' + j.data.agents.length);
  for (const a of j.data.agents.slice(0, 10)) {
    console.log(`AGENT,${a.id},${a.netPnL},${a.totalEarned},${a.totalSpent}`);
  }

  console.log('MY_KILLS=' + j.data.killeds.length);
  for (const k of j.data.killeds.slice(0, 5)) {
    console.log(`KILL,${k.block_number},${k.stackId},${k.attackerBounty},${k.target}`);
  }
})();
