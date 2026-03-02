#!/bin/zsh
set -euo pipefail

cd /Users/aaronlemay/agents

BLOCKS="${BLOCKS:-40}"
TARGET_STACKS="${TARGET_STACKS:-61,116,138,99}"
TOPUP_UNITS="${TOPUP_UNITS:-666}"
TOPUP_TX="${TOPUP_TX:-2}"
SCOUT_BOUNTY="${SCOUT_BOUNTY:-30000}"
NO_TOPUP_MIN_BOUNTY="${NO_TOPUP_MIN_BOUNTY:-20000}"
NO_TOPUP_FALLBACK_BOUNTY="${NO_TOPUP_FALLBACK_BOUNTY:-5000}"

for i in $(seq 1 "$BLOCKS"); do
  echo "========== SAFE_BLOCK_${i} SCOUT =========="
  scout_out=$(
    CYCLES=1 \
    MAX_TX=8 \
    MIN_FORCE_RATIO=1.1 \
    MIN_BOUNTY="$SCOUT_BOUNTY" \
    ENABLE_FALLBACK=false \
    PRIORITY_STACKS="$TARGET_STACKS" \
    HIGH_TICKET_THRESHOLD=30000 \
    LOOP_DELAY_MS=400 \
    node scripts/direct_profit_runner.js
  )
  echo "$scout_out"

  scout_hits=$(echo "$scout_out" | sed -n 's/^HIGH_TICKET_SENT=//p' | tail -n 1)
  scout_hits=${scout_hits:-0}

  if [[ "$scout_hits" -gt 0 ]]; then
    echo "========== SAFE_BLOCK_${i} TOPUP =========="
    FORCE_TOPUP=true \
    MAX_TX="$TOPUP_TX" \
    SPAWN_UNITS="$TOPUP_UNITS" \
    TARGET_STACKS="$TARGET_STACKS" \
    node scripts/hotspot_bootstrap.js

    echo "========== SAFE_BLOCK_${i} STRIKE =========="
    CYCLES=2 \
    MAX_TX=10 \
    MIN_FORCE_RATIO=1.1 \
    MIN_BOUNTY=20000 \
    FALLBACK_MIN_BOUNTY=5000 \
    ENABLE_FALLBACK=true \
    PRIORITY_STACKS="$TARGET_STACKS" \
    HIGH_TICKET_THRESHOLD=30000 \
    LOOP_DELAY_MS=700 \
    node scripts/direct_profit_runner.js
  else
    echo "========== SAFE_BLOCK_${i} NO_TOPUP =========="
    CYCLES=2 \
    MAX_TX=6 \
    MIN_FORCE_RATIO=1.1 \
    MIN_BOUNTY="$NO_TOPUP_MIN_BOUNTY" \
    FALLBACK_MIN_BOUNTY="$NO_TOPUP_FALLBACK_BOUNTY" \
    ENABLE_FALLBACK=true \
    PRIORITY_STACKS="$TARGET_STACKS" \
    HIGH_TICKET_THRESHOLD=30000 \
    LOOP_DELAY_MS=700 \
    node scripts/direct_profit_runner.js
  fi

  echo "========== SAFE_BLOCK_${i} COMPLETE =========="
  sleep 1
done
