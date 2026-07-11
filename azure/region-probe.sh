#!/usr/bin/env bash
# Probe candidate Azure regions for CardTrader scrapability BEFORE provisioning the
# real deployment: launches a throwaway Container Instance per region, each running
# region-probe.js (egress IP + geolocation + offer counts for a few blueprints),
# prints every region's log, then offers to delete everything. Cost: a few seconds
# of ACI per region — fractions of a cent total.
#
# Run in Azure Cloud Shell (works from the Azure mobile app too):
#   curl -s https://raw.githubusercontent.com/PaludaNCode/MTG-Pricerunner/<ref>/azure/region-probe.sh | bash
# Overridables: REGIONS="westeurope ..." RG=mtg-probe REF=<branch-with-region-probe.js>
set -uo pipefail

REGIONS=${REGIONS:-"westeurope northeurope swedencentral germanywestcentral francecentral polandcentral italynorth"}
RG=${RG:-mtg-probe}
REF=${REF:-main}
PROBE_URL="https://raw.githubusercontent.com/PaludaNCode/MTG-Pricerunner/${REF}/azure/region-probe.js"

az group create -n "$RG" -l westeurope -o none

echo "launching probes: $REGIONS"
for LOC in $REGIONS; do
  az container create -g "$RG" -n "probe-$LOC" -l "$LOC" \
    --image node:20-alpine --os-type Linux --restart-policy Never \
    --cpu 1 --memory 1 \
    --environment-variables PROBE_REGION="$LOC" \
    --command-line "sh -c 'wget -qO /tmp/probe.js $PROBE_URL && node /tmp/probe.js'" \
    -o none --no-wait \
    || echo "  $LOC: container create failed (region may lack ACI quota) — skipping"
done

echo "waiting for results…"
for LOC in $REGIONS; do
  for _ in $(seq 1 60); do
    state=$(az container show -g "$RG" -n "probe-$LOC" \
      --query "containers[0].instanceView.currentState.state" -o tsv 2>/dev/null || true)
    [ "$state" = "Terminated" ] && break
    sleep 5
  done
  echo "===== $LOC ====="
  az container logs -g "$RG" -n "probe-$LOC" 2>/dev/null || echo "(no logs — probe never started here)"
done

echo
echo "How to read this:"
echo "  - 'NON-JSON (Cloudflare challenge/block?)' or HTTP 403 -> that region's IPs are blocked; avoid it."
echo "  - geo=XX shows the country CardTrader filters offers for in that region."
echo "  - jp counts on bp 27088: compare against the Pages site (official API, unfiltered) —"
echo "    the closer, the better that region sees the EU market. Page 1 caps at ~25 offers."
echo
read -r -p "Delete resource group $RG now? [Y/n] " ans || ans=Y
case "${ans:-Y}" in
  [Nn]*) echo "kept $RG — delete later with: az group delete -n $RG --yes" ;;
  *) az group delete -n "$RG" --yes --no-wait; echo "deleting $RG in the background" ;;
esac
