const { spawn } = require('child_process');
const fs = require('fs');

const envPath = '/Users/aaronlemay/agents/.env';
if (fs.existsSync(envPath)) {
  const txt = fs.readFileSync(envPath, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const runs = [
  { name: 'legacy-sniper', file: '/Users/aaronlemay/agents/agents/sniper/agent.js', ms: 14000 },
  { name: 'legacy-fortress', file: '/Users/aaronlemay/agents/agents/fortress/agent.js', ms: 14000 },
  { name: 'legacy-aftershock', file: '/Users/aaronlemay/agents/agents/aftershock/agent.js', ms: 16000 }
];

function runOne(r) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['hardhat', 'run', r.file, '--network', 'basesepolia'], {
      cwd: '/Users/aaronlemay/agents',
      env: process.env
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 1000);
    }, r.ms);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const text = `${out}\n${err}`;
      const sent = (text.match(/TX SENT|\[TX\]|https:\/\/sepolia\.basescan\.org\/tx\//g) || []).length;
      const errs = (text.match(/\[ERROR\]|revert|failed|Missing|invalid|noNetwork|HH/g) || []).length;
      const lines = text.split(/\r?\n/).filter(Boolean);
      resolve({ name: r.name, code, signal, sent, errs, tail: lines.slice(-20) });
    });
  });
}

(async () => {
  for (const r of runs) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runOne(r);
    console.log(`## ${res.name} code=${res.code} signal=${res.signal || 'none'} txMarks=${res.sent} errMarks=${res.errs}`);
    for (const l of res.tail) console.log(l);
  }
})();
