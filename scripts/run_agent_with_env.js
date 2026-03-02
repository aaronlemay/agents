const fs = require('fs');
const path = require('path');

const target = process.env.AGENT_ENTRY;
if (!target) throw new Error('Missing AGENT_ENTRY env var');

const envPath = '/Users/aaronlemay/.env';
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

require(path.resolve(target));
