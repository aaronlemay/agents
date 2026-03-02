# Team Alpha Playbook

## Goal

Dominate grid control and net profit through compounding cadence, controlled risk, and adaptive team orchestration.

## Core Doctrine

1. Compound small edges repeatedly.
2. Run one primary live executor when bankroll is thin.
3. Use direct-kill before spawn+kill whenever possible.
4. Auto-pause on failure streaks and drawdown triggers.
5. Shift playbook by market state, not by emotion.

## Agent Roles

- `sentinel`: Hub defense, anti-wipe, consolidation.
- `harvester` (`layer-harvester`): Primary compounding executor.
- `parasite`: Shadow dominant wallet; farm post-conflict leftovers.
- `seeder`: Build distributed footholds for future direct kills.
- `sniper`: Precision scout/strike when confidence and bankroll support.
- `aftershock`: Event-driven opportunist for high-tempo windows.
- `phantom`: Pattern-breaking/unpredictable route.
- `meta-controller`: Selects playbook and enforces DRY/LIVE posture.

## Playbook Ladder

### 1) Scout Hardening

- Condition: ETH below live threshold or unstable error cadence.
- Modes: all DRY_RUN.
- Outcome target: preserve bankroll and collect actionable intel.

### 2) Parasite Compound

- Condition: low-mid bankroll with viable opportunities.
- Modes: one live executor (`layer-harvester`), others DRY_RUN.
- Outcome target: consistent positive cadence with minimal gas burn.

### 3) Ambush Compound

- Condition: low bankroll but executable queue exists and edge is positive.
- Modes: `parasite` + `seeder` live.
- Outcome target: unexpected trap cadence where bait actions trigger reactive farms.

### 4) Honeypot Lure

- Condition: sparse edge, need to shape opponents.
- Modes: `sentinel` + `seeder` live (or one live if bankroll constrained).
- Outcome target: induce overcommit, then convert local counter opportunities.

### 5) Sector Nuke Window

- Condition: healthy bankroll, concentrated threat, high edge.
- Modes: timed burst with strict transaction budget.
- Outcome target: temporary zone dominance and fast P/L jump.

## Control Rules

1. Maximum parallel live agents is constrained by bankroll profile.
2. Each live action must pass:
   - callStatic
   - gas affordability
   - risk budget
3. Two consecutive failed tx attempts trigger auto-pause.
4. Re-enable aggression only after a clean cycle window.

## Everyday Player UX Mapping

- Presets:
  - Safe Income
  - Balanced
  - Aggro Push
- Single slider:
  - Safety <-> Cadence
- Explainability card each cycle:
  - Why this move
  - Expected edge
  - Gas risk
