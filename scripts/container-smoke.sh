#!/usr/bin/env bash
# Container smoke test of the four images (docs/operations/release-checklist.md §2). Needs: the images built
# (docker build --target migrate|api|worker|web -t workeasy-<target> .), a bootstrapped and migrated PostgreSQL on
# host port 55432 (container we-smoke-pg) and Redis on 56379 (we-smoke-redis); see the checklist.
# Throwaway credentials only. Delivery stays disabled (CAMPAIGN_DELIVERY_MODE unset).
set -u
H=host.docker.internal
DB="-e DATABASE_URL=postgresql://workeasy_app:smoke-app-pw@$H:55432/workeasy -e IDENTITY_DATABASE_URL=postgresql://workeasy_identity:smoke-identity-pw@$H:55432/workeasy -e REPORTING_DATABASE_URL=postgresql://workeasy_reporting:smoke-reporting-pw@$H:55432/workeasy"
APP="-e APP_URL=https://app.smoke.test -e SESSION_SECRET=$(openssl rand -hex 32) -e DATA_FINGERPRINT_SECRET=$(openssl rand -hex 32) -e UNSUBSCRIBE_SECRET=$(openssl rand -hex 32) -e FILE_STORE_DIR=/tmp/files -e TRUST_PROXY=172.16.0.0/12 -e REDIS_URL=redis://$H:56379 -e MAIL_TRANSPORT=smtp -e MAIL_FROM=no-reply@smoke.test -e SMTP_HOST=$H -e SMTP_PORT=2525"
docker rm -f we-smoke-api we-smoke-jobs we-smoke-web we-smoke-worker >/dev/null 2>&1
docker run -d --name we-smoke-api -p 54000:4000 $DB $APP -e PROCESS_ROLES=http workeasy-api >/dev/null
docker run -d --name we-smoke-jobs $DB $APP -e PROCESS_ROLES=jobs,scheduler workeasy-api >/dev/null
docker run -d --name we-smoke-worker $DB workeasy-worker >/dev/null
docker run -d --name we-smoke-web -p 53000:3000 -e API_URL=http://$H:54000 workeasy-web >/dev/null
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got '$2', want '$3')"; fail=$((fail+1)); fi; }
for i in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54000/health)" = 200 ] && break; sleep 2; done
for i in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:53000/login)" = 200 ] && break; sleep 2; done
check "api /health" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54000/health)" 200
check "api /health/ready (db, job queue, redis)" "$(curl -s http://127.0.0.1:54000/health/ready | grep -o '"status":"ready"')" '"status":"ready"'
check "web /login" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:53000/login)" 200
check "web proxies /api to runtime API_URL" "$(curl -s http://127.0.0.1:53000/api/health)" '{"status":"ok"}'
check "web security headers" "$(curl -s -D - -o /dev/null http://127.0.0.1:53000/login | grep -ci '^x-frame-options: DENY')" 1
check "unauthenticated API call refused" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:53000/api/v1/me/context)" 401
check "webhooks for unconfigured providers do not exist" "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:54000/v1/webhooks/twilio)" 404
check "/metrics absent without METRICS_TOKEN" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54000/metrics)" 404
check "api runs as non-root" "$(docker exec we-smoke-api id -un)" workeasy
check "web keep-alive 65 s in the real start command" "$(docker exec we-smoke-web cat /proc/1/cmdline | tr '\0' ' ' | grep -c -- '--keepAliveTimeout 65000')" 1
sleep 25
check "campaign worker (jobs,scheduler) still running" "$(docker inspect --format '{{.State.Status}}' we-smoke-jobs)" running
check "audience worker still running 25 s after its first run" "$(docker inspect --format '{{.State.Status}}' we-smoke-worker)" running
check "api container healthy (HEALTHCHECK)" "$(docker inspect --format '{{.State.Health.Status}}' we-smoke-api)" healthy
for c in we-smoke-api we-smoke-jobs we-smoke-worker we-smoke-web; do
  s=$(date +%s%N); docker stop $c >/dev/null; e=$(date +%s%N)
  ms=$(( (e-s)/1000000 )); check "$c stops on SIGTERM well before the 10 s kill (${ms} ms)" "$([ $ms -lt 9000 ] && echo yes)" yes
done
echo "smoke: $pass passed, $fail failed"
