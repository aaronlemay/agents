# KILL Playtest Bug Report (2026-03-01)

## Summary
Observed "sudden KILL loss" was reproduced as a **reporting mismatch**, not a confirmed fund drain.

Two issues were identified:
1. **Old vs new contract context mismatch** in ad-hoc balance checks (legacy game/token vs current game/token).
2. **High ROI striker success accounting bug**: script logged tx hash and counted send without explicitly checking `receipt.status == 1`.

## Evidence
- Active game in current agent configs/scripts:
  - `0xfd21c1c28d58e420837e8057A227C3D432D289Ec`
- Current KILL token discovered from active game:
  - `0xF8c79ef1CFb65Fb55535DF03dFf7478dC65a5e0F`
- Live wallet snapshot (Base Sepolia, block `38327337`):
  - Address: `0x3944793e9EB7C838178c52B66f09B8B24c887AfE`
  - ETH: `0.195348960434873292`
  - KILL: `430022121.676288933639103314`

This confirms balance is on the active/new game token context and did not remain at the previously reported low value from old-context checks.

## Patch Applied
### 1) `scripts/high_roi_striker.js`
- Added explicit tx receipt validation:
  - if `receipt.status !== 1`, log `REVERT ...` and do not count strike as success.
- Added `gasUsed` to success log output for better execution diagnostics.

### 2) `scripts/balance_report.js`
- Added explicit output of:
  - `GAME=<address>`
  - `TOKEN=<address>`
- Added token symbol-aware balance line.

This prevents accidental old/new contract confusion during monitoring.

## Operational Note
RPC endpoint `https://sepolia.base.org` was intermittently unstable during forensic tracing (`could not detect network`), which limited full receipt-log extraction in one pass.

## Recommendation
- Treat this as a **monitoring/instrumentation bug**, not yet a protocol-level economic bug.
- Continue using the updated reporting scripts and include `GAME` + `TOKEN` in all incident screenshots/logs.
- If needed, run a deeper receipt/log audit once RPC stability improves.
