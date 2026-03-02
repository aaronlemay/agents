const { spawn } = require('child_process');
const fs = require('fs');

const envFile = '/Users/aaronlemay/.env';
if (fs.existsSync(envFile)) {
  const txt = fs.readFileSync(envFile, 'utf8');
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
  { name: 'sniper', file: '/Users/aaronlemay/agents/sniper/agent.js', ms: 42000 },
  { name: 'fortress', file: '/Users/aaronlemay/agents/fortress/agent.js', ms: 42000 },
  { name: 'layer-harvester', file: '/Users/aaronlemay/agents/layer-harvester/agent.js', ms: 32000 }
];

function summarize(name, text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const keep = lines.filter((l) => {
    const s = l.toLowerCase();
    return s.includes('[dry_run]') || s.includes('[plan]') || s.includes('[target]') || s.includes('[status]') || s.includes('[error]') || s.includes('roi') || s.includes('ready') || s.includes('action') || s.includes('threat') || s.includes('resource');
  });
  return { name, lines: keep.slice(-30), totalLines: lines.length };
}

function runOne({ name, file, ms }) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['hardhat', 'run', file, '--network', 'basesepolia'], {
      cwd: '/Users/aaronlemay/agents',
      env: process.env
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 1500);
    }, ms);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        name,
        code,
        signal,
        summary: summarize(name, out + '\n' + err),
        rawTail: (out + '\n' + err).split(/\r?\n/).slice(-80)
      });
    });
  });
}

(async () => {
  const results = [];
  for (const r of runs) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runOne(r));
  }
  console.log('DRY_CADENCE_REPORT');
  for (const r of results) {
    console.log(`## ${r.name} code=${r.code} signal=${r.signal || 'none'} lines=${r.summary.totalLines}`);
    if (r.summary.lines.length) {
      for (const l of r.summary.lines) console.log(l);
    } else {
      console.log('(no key log lines captured; showing tail)');
      for (const l of r.rawTail.slice(-12)) console.log(l);
    }
  }
})();
