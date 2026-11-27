#!/usr/bin/env bash
# Deploy smoke test: runs the real operator image in a kind pod under the
# chart's securityContext, then restarts the container in place.
#
# It catches failures that unit tests cannot see:
#   1. chmod EPERM on the control-socket dir (runAsUser 65532, fsGroup, emptyDir).
#   2. A container restart in the same pod leaves a stale socket on the emptyDir
#      (fixed in lnr#269, src/lib/control-socket.ts clearStaleSocket).
#
# Pass criteria: liveness, Running state and restartCount only. Readiness needs
# a real queue poll and is deliberately out of scope.
#
# No real Linear or Cloudflare traffic:
#   - startOperator mints an OAuth token at startup and exits if the mint fails
#     (src/core/operator.ts, tokenCache.refreshToken). The mint URL is hard-coded
#     to https://api.linear.app/oauth/token, with no override. So the script runs
#     a fake Linear in the cluster, points api.linear.app at it with hostAliases,
#     and trusts its throwaway CA through NODE_EXTRA_CA_CERTS. These are applied
#     with a kubectl patch, because the chart exposes no hook for them.
#   - CF_ACCOUNT_ID / CF_QUEUE_ID / CF_API_TOKEN are created EMPTY. The chart
#     needs the Secret keys to exist. readQueueEnv() treats empty values as
#     absent, so the queue poller stays off and nothing calls Cloudflare.
#
# Usage: scripts/deploy-smoke.sh
# Env (all optional):
#   CLUSTER          kind cluster name              (default lnr-deploy-smoke)
#   KIND_NODE_IMAGE  kindest/node ref, pin by digest (default: kind's own default)
#   IMAGE            image ref to build and load     (default lnr-operator-ci:ci)
#   BUN_IMAGE        image that runs the fake Linear (default: the Dockerfile's pin)
#   SKIP_BUILD=1     reuse an existing local $IMAGE
#   KEEP_CLUSTER=1   leave the cluster after the run
#   HOLD_SECONDS     quiet period after the restart  (default 60)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${CLUSTER:-lnr-deploy-smoke}"
IMAGE="${IMAGE:-lnr-operator-ci:ci}"
HOLD_SECONDS="${HOLD_SECONDS:-60}"
NS=lnr-smoke
REL=lnr
DEPLOY="${REL}-operator"
CONTAINER=linearctl-operator
SEL="app.kubernetes.io/instance=${REL},app.kubernetes.io/name=linearctl"
KCTX="kind-${CLUSTER}"
NODE="${CLUSTER}-control-plane"
# Liveness probe timing from deploy/chart/values.yaml (initialDelay 5s, period 10s).
LIVE_DELAY=5
LIVE_PERIOD=10

# Private kubeconfig: never touch the caller's KUBECONFIG or ~/.kube/config.
# kind writes its context into the file it is given, so a shared kubeconfig
# would be switched to the kind cluster for everyone using it.
KCFG="$(mktemp)"
export KUBECONFIG="$KCFG"
WORK="$(mktemp -d)"
FAILED=1

k() { kubectl --context "$KCTX" -n "$NS" "$@"; }
log() { printf '\n== %s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Print only lines that do not look like they carry a secret.
scrub() { grep -v -i -E 'token|secret|key|password' || true; }

dump() {
  echo "---- diagnostics (lines matching token|secret|key|password removed) ----"
  k describe pod -l "$SEL" 2>&1 | scrub || true
  for prev in --previous ""; do
    echo "---- container logs ${prev:-current} ----"
    k logs -l "$SEL" -c "$CONTAINER" ${prev:+"$prev"} --tail=200 2>&1 | scrub || true
  done
  echo "---- events ----"
  k get events --sort-by=.lastTimestamp 2>&1 | scrub || true
}

cleanup() {
  if [ "$FAILED" -ne 0 ]; then
    dump || true
  fi
  if [ "${KEEP_CLUSTER:-0}" != "1" ]; then
    kind delete cluster --name "$CLUSTER" --kubeconfig "$KCFG" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK" "$KCFG"
}
trap cleanup EXIT

for tool in docker kind kubectl helm openssl; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done

# The Dockerfile pins the Bun builder by digest; reuse that pin for the fake.
BUN_IMAGE="${BUN_IMAGE:-$(sed -n 's/^FROM \(oven\/bun:[^ ]*\) AS build$/\1/p' "$ROOT/Dockerfile")}"
[ -n "$BUN_IMAGE" ] || die "could not read the bun image from the Dockerfile"

log "build image $IMAGE"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  docker build -t "$IMAGE" "$ROOT"
fi

log "create kind cluster $CLUSTER"
kind delete cluster --name "$CLUSTER" --kubeconfig "$KCFG" >/dev/null 2>&1 || true
kind_args=(create cluster --name "$CLUSTER" --kubeconfig "$KCFG" --wait 120s)
[ -n "${KIND_NODE_IMAGE:-}" ] && kind_args+=(--image "$KIND_NODE_IMAGE")
kind "${kind_args[@]}"

log "load images"
docker pull "$BUN_IMAGE" >/dev/null
# kind load fails on a pulled multi-platform index (missing blobs), and is
# unreliable with digest-only refs. Re-build it as a single-platform local tag.
printf 'FROM %s\n' "$BUN_IMAGE" | docker build -q -t lnr-fake-linear:ci -
kind load docker-image --name "$CLUSTER" "$IMAGE" lnr-fake-linear:ci

kubectl --context "$KCTX" create namespace "$NS"

log "fake Linear (throwaway CA, in-cluster)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=lnr-smoke-ca" \
  -keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=api.linear.app" \
  -keyout "$WORK/tls.key" -out "$WORK/tls.csr" 2>/dev/null
printf 'subjectAltName=DNS:api.linear.app\n' >"$WORK/san.ext"
openssl x509 -req -in "$WORK/tls.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
  -CAcreateserial -days 1 -extfile "$WORK/san.ext" -out "$WORK/tls.crt" 2>/dev/null

cat >"$WORK/fake-linear.ts" <<'TS'
// Fake Linear: answers the OAuth mint with a dummy token, everything else with {}.
Bun.serve({
  port: 8443,
  tls: { cert: Bun.file("/tls/tls.crt"), key: Bun.file("/tls/tls.key") },
  fetch(req) {
    const url = new URL(req.url);
    console.log(`fake-linear ${req.method} ${url.pathname}`);
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      return Response.json({ access_token: "fake-ci-value", token_type: "Bearer", expires_in: 2592000 });
    }
    return Response.json({});
  },
});
TS

k create secret tls fake-linear-tls --cert="$WORK/tls.crt" --key="$WORK/tls.key"
k create configmap fake-ca --from-file=ca.crt="$WORK/ca.crt"
k create configmap fake-linear-src --from-file=fake-linear.ts="$WORK/fake-linear.ts"
k apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: {name: fake-linear}
spec:
  replicas: 1
  selector: {matchLabels: {app: fake-linear}}
  template:
    metadata: {labels: {app: fake-linear}}
    spec:
      containers:
        - name: fake-linear
          image: lnr-fake-linear:ci
          imagePullPolicy: Never
          command: ["bun", "run", "/src/fake-linear.ts"]
          volumeMounts:
            - {name: src, mountPath: /src}
            - {name: tls, mountPath: /tls}
      volumes:
        - {name: src, configMap: {name: fake-linear-src}}
        - {name: tls, secret: {secretName: fake-linear-tls}}
---
apiVersion: v1
kind: Service
metadata: {name: fake-linear}
spec:
  selector: {app: fake-linear}
  ports: [{port: 443, targetPort: 8443}]
YAML
k rollout status deploy/fake-linear --timeout=120s
FAKE_IP="$(k get svc fake-linear -o jsonpath='{.spec.clusterIP}')"
[ -n "$FAKE_IP" ] || die "fake-linear has no ClusterIP"

log "dummy Secrets (names and keys the chart's secretKeyRefs expect)"
k create secret generic linearctl-oauth \
  --from-literal=client-id=ci-fake-client --from-literal=client-secret=ci-fake-value
k create secret generic linearctl-llm --from-literal=api-key=ci-fake-value
# Empty on purpose: keeps the queue poller off (see header).
k create secret generic linearctl-cf-queue \
  --from-literal=account-id= --from-literal=queue-id= --from-literal=api-token=

log "helm install (replicas 0 first, so the pod starts with the fake wired in)"
helm --kube-context "$KCTX" -n "$NS" install "$REL" "$ROOT/deploy/chart" --skip-crds \
  -f "$ROOT/deploy/ci/kind-values.yaml" --set deployment.replicas=0 \
  --set-string image.repository="${IMAGE%:*}" --set-string image.tag="${IMAGE##*:}"

k patch deployment "$DEPLOY" --type strategic -p "$(cat <<JSON
{"spec":{"template":{"spec":{
  "hostAliases":[{"ip":"${FAKE_IP}","hostnames":["api.linear.app"]}],
  "volumes":[{"name":"fake-ca","configMap":{"name":"fake-ca"}}],
  "containers":[{"name":"${CONTAINER}",
    "env":[{"name":"NODE_EXTRA_CA_CERTS","value":"/etc/fake-ca/ca.crt"}],
    "volumeMounts":[{"name":"fake-ca","mountPath":"/etc/fake-ca","readOnly":true}]}]}}}}
JSON
)"
k scale deployment "$DEPLOY" --replicas=1

pod_field() { k get pod -l "$SEL" -o "jsonpath=$1"; }
restarts() { pod_field '{.items[0].status.containerStatuses[0].restartCount}'; }
running_since() { pod_field '{.items[0].status.containerStatuses[0].state.running.startedAt}'; }

wait_running() {
  local deadline=$((SECONDS + ${1:-120}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ -n "$(running_since)" ] && return 0
    sleep 2
  done
  die "container did not reach Running"
}

# Liveness: the probe command itself, plus no restarts and no probe failures.
check_live() {
  k exec "$POD" -c "$CONTAINER" -- /app/linearctl operator --health >/dev/null \
    || die "liveness command (/app/linearctl operator --health) failed"
  # Readiness fails by design here (no queue), so only liveness events count.
  if k get events --field-selector "involvedObject.name=${POD},reason=Unhealthy" \
      -o custom-columns=MSG:.message --no-headers | grep -qi '^liveness probe'; then
    die "kubelet reported a failed liveness probe"
  fi
  return 0
}

# Wait until $1 full liveness periods have elapsed since the container started,
# then assert no restart and a passing probe.
settle_periods() {
  local periods="$1" want_restarts="$2" started now age need
  need=$((LIVE_DELAY + periods * LIVE_PERIOD + 5))
  while :; do
    started="$(running_since)"
    [ -n "$started" ] || die "container left Running while settling"
    now="$(date -u +%s)"
    age=$((now - $(date -u -d "$started" +%s)))
    [ "$(restarts)" = "$want_restarts" ] || die "restartCount $(restarts), want $want_restarts"
    [ "$age" -ge "$need" ] && break
    sleep 3
  done
  check_live
}

log "phase 1: Running and live for 3 probe periods, zero restarts"
wait_running 120
POD="$(pod_field '{.items[0].metadata.name}')"
UID_BEFORE="$(pod_field '{.items[0].metadata.uid}')"
[ "$(k get pod -l "$SEL" -o name | wc -l)" = "1" ] || die "expected exactly one pod"
settle_periods 3 0
echo "pod=$POD uid=$UID_BEFORE restartCount=0 liveness ok"

log "phase 2: kill the container in place (SIGKILL, same pod, same emptyDir)"
NODE_NAME="$(pod_field '{.items[0].spec.nodeName}')"
[ "$NODE_NAME" = "$NODE" ] || die "unexpected node $NODE_NAME"
CID="$(docker exec "$NODE" crictl ps --state running --name "^${CONTAINER}\$" \
  --label "io.kubernetes.pod.uid=${UID_BEFORE}" -q | head -n1)"
[ -n "$CID" ] || die "no running crictl container for pod $UID_BEFORE"
# --timeout 0 skips SIGTERM, so the daemon cannot unlink its socket on the way
# out. That leaves a stale socket on the emptyDir, which is the lnr#269 case.
docker exec "$NODE" crictl stop --timeout 0 "$CID" >/dev/null
SOCKDIR="/var/lib/kubelet/pods/${UID_BEFORE}/volumes/kubernetes.io~empty-dir/state/run"
echo "emptyDir after kill: $(docker exec "$NODE" ls -A "$SOCKDIR" 2>&1 | tr '\n' ' ')"

log "phase 3: container comes back in the same pod"
deadline=$((SECONDS + 120))
until [ "$(restarts)" = "1" ] && [ -n "$(running_since)" ]; do
  [ "$SECONDS" -lt "$deadline" ] || die "container did not return to Running with restartCount 1"
  [ "$(restarts)" -le 1 ] || die "restartCount $(restarts) (crash loop after restart)"
  sleep 2
done
[ "$(pod_field '{.items[0].metadata.uid}')" = "$UID_BEFORE" ] || die "pod UID changed; the pod was replaced"
[ "$(pod_field '{.items[0].metadata.name}')" = "$POD" ] || die "pod name changed"
echo "last exit: $(pod_field '{.items[0].status.containerStatuses[0].lastState.terminated.reason}') code $(pod_field '{.items[0].status.containerStatuses[0].lastState.terminated.exitCode}')"
check_live

log "phase 4: liveness holds for ${HOLD_SECONDS}s with no further restarts"
end=$((SECONDS + HOLD_SECONDS))
while [ "$SECONDS" -lt "$end" ]; do
  [ "$(restarts)" = "1" ] || die "restartCount $(restarts) during the hold, want 1"
  [ -n "$(running_since)" ] || die "container not Running during the hold"
  sleep 5
done
settle_periods 3 1
[ "$(pod_field '{.items[0].metadata.uid}')" = "$UID_BEFORE" ] || die "pod UID changed during the hold"

FAILED=0
log "PASS: pod $POD survived an in-place restart (uid unchanged, restartCount 1, liveness ok)"
