const fetch = require('node-fetch');

(async () => {
  const url = 'https://api.goldsky.com/api/public/project_cmlgypvyy520901u8f5821f19/subgraphs/kill-testnet-subgraph/1.0.2/gn';
  const query = `{
    killeds(first: 10, where: { id_contains: "b6694d0f" }) {
      id
      attacker
      target
      stackId
      attackerBounty
      block_number
    }
  }`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const j = await r.json();
  console.log(JSON.stringify(j));
})();
