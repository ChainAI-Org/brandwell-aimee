#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <staging|production> <40-character commit SHA>" >&2
  exit 64
}

TARGET="${1:-}"
DEPLOY_SHA="${2:-}"
case "${TARGET}" in
  staging)
    DEFAULT_READINESS_URL="https://staging-ai.brandwell.ai/ready"
    ;;
  production)
    DEFAULT_READINESS_URL="https://ai.brandwell.ai/ready"
    ;;
  *)
    usage
    ;;
esac

if [[ ! "${DEPLOY_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Deployment revision must be a lowercase 40-character commit SHA" >&2
  exit 64
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
ENV_FILE="${BRANDWELL_ENV_FILE:-${REPO_DIR}/.env}"
BACKUP_ROOT="${BRANDWELL_BACKUP_ROOT:-/var/backups/brandwell-aimee-${TARGET}}"
READINESS_URL="${BRANDWELL_READINESS_URL:-${BRANDWELL_HEALTH_URL:-${DEFAULT_READINESS_URL}}}"
LOCK_FILE="${BRANDWELL_DEPLOY_LOCK_FILE:-/tmp/brandwell-aimee-${TARGET}.lock}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-brandwell-aimee-${TARGET}}"
COMPOSE_FILE="${REPO_DIR}/infra/compose/docker-compose.prod.yml"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "BrandWell environment file is missing: ${ENV_FILE}" >&2
  exit 66
fi
if [[ "${REPO_DIR}" == "/" || "${BACKUP_ROOT}" == "/" ]]; then
  echo "Refusing to deploy with a broad repository or backup path" >&2
  exit 64
fi

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Another ${TARGET} deployment is already running" >&2
  exit 75
fi

cd "${REPO_DIR}"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Deployment checkout has tracked local changes" >&2
  exit 65
fi

PREVIOUS_SHA="$(git rev-parse HEAD)"
compose=(docker compose --project-name "${COMPOSE_PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

backup_running_state() {
  local running stamp snapshot_dir
  running="$("${compose[@]}" ps --status running --services 2>/dev/null || true)"
  if ! grep -qx "postgres" <<<"${running}"; then
    echo "No running database found. Skipping the pre-deploy backup for this first start."
    return
  fi

  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  snapshot_dir="${BACKUP_ROOT}/${stamp}-${PREVIOUS_SHA}"
  install -d -m 700 "${BACKUP_ROOT}" "${snapshot_dir}"
  # Expand these variables inside the Postgres container, not in the deployment shell.
  # shellcheck disable=SC2016
  "${compose[@]}" exec -T postgres sh -c \
    'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' \
    > "${snapshot_dir}/database.dump"
  "${compose[@]}" exec -T postgres pg_restore --list \
    < "${snapshot_dir}/database.dump" >/dev/null

  if grep -qx "api" <<<"${running}"; then
    "${compose[@]}" exec -T api tar -czf - -C /data . > "${snapshot_dir}/appdata.tgz"
    tar -tzf "${snapshot_dir}/appdata.tgz" >/dev/null
  fi

  sha256sum "${snapshot_dir}"/* > "${snapshot_dir}/SHA256SUMS"
  chmod 600 "${snapshot_dir}"/*
  echo "Verified pre-deploy backup: ${snapshot_dir}"
}

start_revision() {
  local revision="$1"
  GIT_SHA="${revision}" "${compose[@]}" up -d --build --remove-orphans postgres api worker web
  ensure_proxy_route
}

ensure_proxy_route() {
  local proxy_container expected_proxy app_network proxy_mount
  expected_proxy="${COMPOSE_PROJECT_NAME}-caddy-1"
  app_network="${COMPOSE_PROJECT_NAME}_app"
  proxy_container="$(docker ps --filter publish=80 --format '{{.Names}}' | head -n 1)"

  if [[ -z "${proxy_container}" ]]; then
    GIT_SHA="$(git rev-parse HEAD)" "${compose[@]}" up -d --no-deps caddy
    proxy_container="${expected_proxy}"
  fi

  if ! docker network inspect "${app_network}" >/dev/null 2>&1; then
    echo "Application network is missing: ${app_network}" >&2
    return 1
  fi
  if ! docker inspect "${proxy_container}" --format '{{json .NetworkSettings.Networks}}' |
    grep -Fq "\"${app_network}\""; then
    docker network connect "${app_network}" "${proxy_container}"
  fi

  proxy_mount="$(docker inspect "${proxy_container}" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
  if [[ "${proxy_mount}" != "${REPO_DIR}/infra/compose/Caddyfile.prod" ]]; then
    echo "Active proxy does not use this deployment's Caddyfile: ${proxy_mount:-unknown}" >&2
    return 1
  fi

  # One Caddy container owns ports 80 and 443 on a shared staging/production host.
  # Reload its bind-mounted configuration after connecting it to this stack's app network.
  docker exec "${proxy_container}" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
}

wait_for_readiness() {
  local expected_sha="$1" response
  for _ in $(seq 1 24); do
    if response="$(curl --fail --silent --show-error --max-time 10 "${READINESS_URL}" 2>/dev/null)"; then
      if grep -Fq '"ok":true' <<<"${response}" &&
        grep -Fq "\"revision\":\"${expected_sha}\"" <<<"${response}"; then
        echo "Ready ${TARGET} revision ${expected_sha}"
        return 0
      fi
    fi
    sleep 5
  done
  return 1
}

backup_running_state
git fetch --no-tags origin "${DEPLOY_SHA}"
git cat-file -e "${DEPLOY_SHA}^{commit}"
git checkout --detach "${DEPLOY_SHA}"

if start_revision "${DEPLOY_SHA}" && wait_for_readiness "${DEPLOY_SHA}"; then
  exit 0
fi

echo "Deployment failed readiness verification. Restoring ${PREVIOUS_SHA}." >&2
git checkout --detach "${PREVIOUS_SHA}"
start_revision "${PREVIOUS_SHA}"
if ! wait_for_readiness "${PREVIOUS_SHA}"; then
  echo "Rollback also failed readiness verification. Operator action is required." >&2
  exit 70
fi
exit 1
