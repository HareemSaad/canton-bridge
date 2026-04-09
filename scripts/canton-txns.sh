#!/usr/bin/env bash
# Show all bridge transactions recorded on the Canton ledger.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANTON_URL="http://localhost:7575"

PARTY=$(grep LOCAL_CANTON_PARTY_ID "$ROOT/relayer/.env" | cut -d= -f2)
[[ -n "$PARTY" ]] || { echo "LOCAL_CANTON_PARTY_ID not set in relayer/.env"; exit 1; }

END=$(curl -s "$CANTON_URL/v2/state/ledger-end" | python3 -c "import json,sys; print(json.load(sys.stdin)['offset'])")

RESPONSE=$(curl -s -X POST "$CANTON_URL/v2/updates" \
  -H "Content-Type: application/json" \
  -d "{\"beginExclusive\":0,\"endInclusive\":$END,\"filter\":{\"filtersByParty\":{\"$PARTY\":{}}}}")

echo "$RESPONSE" | python3 -c "
import json, sys

data = json.load(sys.stdin)
for entry in data:
    tx = entry.get('update', {}).get('Transaction', {}).get('value', {})
    if not tx:
        continue
    print('commandId :', tx.get('commandId', '?'))
    print('updateId  :', tx.get('updateId', '?'))
    print('time      :', tx.get('effectiveAt', '?'))
    for event in tx.get('events', []):
        if 'CreatedEvent' in event:
            c = event['CreatedEvent']
            tpl = c.get('templateId', '').split(':')[-1]
            args = c.get('createArgument', {})
            active = '  [active]' if c.get('acsDelta') else ''
            print('  created :', tpl + active)
            for k, v in args.items():
                print('   ', k, '=', v)
        elif 'ExercisedEvent' in event:
            e = event['ExercisedEvent']
            tpl = e.get('templateId', '').split(':')[-1]
            print('  exercised:', tpl + '.' + e.get('choice', '?'))
    print()
"
