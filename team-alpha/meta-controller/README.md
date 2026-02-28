# Team Alpha Meta-Controller

Control-plane module for selecting a team playbook based on current intel, bankroll, and threat pressure.

## Files

- `config.json`: thresholds and output paths
- `playbooks.json`: strategy library and per-agent mode matrix
- `controller.js`: decision engine
- `decision.json`: latest machine-readable decision (generated)
- `decision.md`: latest operator-readable decision (generated)

## Run

```bash
node /Users/aaronlemay/agents/team-alpha/meta-controller/controller.js
```

Apply selected playbook to agent configs (`DRY_RUN` toggles):

```bash
node /Users/aaronlemay/agents/team-alpha/meta-controller/controller.js --apply
```

## Current Playbooks

- `scout_hardening`: all DRY_RUN, preserve gas
- `parasite_compound`: single live executor, farm leftovers
- `honeypot_lure`: bait/probe posture under constrained edge
- `sector_nuke_window`: timed burst play when bankroll and edge support it

## Behavior

- Without `--apply`: decision-only (no config mutation)
- With `--apply`: updates each agent `settings.DRY_RUN` according to selected playbook
