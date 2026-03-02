# Legacy Agent Pass (2026-03-01)

## Scope
- Legacy agents reviewed:
  - `agents/sniper`
  - `agents/fortress`
  - `agents/aftershock`
- Goal: align with new contract economics and reduce revert/gas burn risk.

## What Was Updated

### Legacy Sniper
- Switched ROI math to use `pendingBounty` from contract stack data.
- Updated spawn-cost math to current contract cost (`20 KILL / unit` in wei).
- Added settings support:
  - `DRY_RUN`
  - `MIN_BOUNTY_FOR_SPAWN`
  - `MAX_GAS_LIMIT`
  - `MAX_GAS_PRICE_GWEI`
- Added preflight simulation (`callStatic.multicall`) before sending tx.

### Legacy Fortress
- Added settings support:
  - `DRY_RUN`
  - `TARGET_POWER` fallback
  - `MAX_GAS_LIMIT`
- Fixed BigNumber sort comparator bug for army selection.
- Added preflight simulation before send.

### Legacy Aftershock
- Added PK fallback: `AFTERSHOCK_PK || SNIPER_PK`.
- Added settings support:
  - `DRY_RUN`
  - `MAX_GAS_LIMIT`
  - `MAX_GAS_PRICE_GWEI`
- Added preflight simulation before send.

## Updated Legacy Config Defaults
- `agents/sniper/config.json`
  - `HUB_STACK=125`
  - `SPAWN_PROFITABILITY_THRESHOLD=1.15`
  - `MIN_BOUNTY_FOR_SPAWN=15000`
  - `DRY_RUN=true`
- `agents/fortress/config.json`
  - `HUB_STACK=125`
  - `TARGET_POWER=133200`
  - `REPLENISH_AMT=1332`
  - `HUB_PERIMETER=2`
  - `DRY_RUN=true`
- `agents/aftershock/config.json`
  - `MAX_KILL=250000`
  - `DRY_RUN=true`

## Dry-Run Startup Validation
- Legacy Sniper: boots and scans correctly; currently abstains when ROI < threshold.
- Legacy Fortress: boots and produces valid spawn plans in dry run.
- Legacy Aftershock: boots and tracks new kill events; pending attack queue works.

## Viability Ranking (New Contract)
1. **Aftershock** (most interesting upside)
- Event-driven ambush model is differentiated from static scanners.
- Strong candidate for “unexpected” gameplay moments.

2. **Sniper** (most controllable)
- Strong operator control over ROI and bounty gates.
- Good baseline executor when market has clear positive EV windows.

3. **Fortress** (defensive/support role)
- Useful for zone control and staged pressure.
- Less efficient as a solo profit engine.

## Most Fun Mode To Play
- **Aftershock Hunter Mode**
  - Why: it reacts to fresh combat events and creates revenge/ambush loops that feel dynamic.
  - Playstyle: moderate cadence, strict kill cap, and selective execution on newly weakened winners.

## Recommended Next Step
- Run a 10-minute dry bakeoff:
  - Legacy Aftershock vs Legacy Sniper (both dry)
  - Compare: opportunities detected, simulated sends, and estimated ROI spread.
- Promote winner to live for a short controlled burst.
