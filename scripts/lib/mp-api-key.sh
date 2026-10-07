# Sourced by the build scripts (needs $ROOT = repo root).
# bb-net bakes BB_MP_API_KEY in at compile time (option_env!), so release
# builds need it exported before cargo runs. Precedence:
#   1. BB_MP_API_KEY already in the environment (CI secret, manual override)
#   2. VITE_MP_API_KEY= in $BB_ENV_FILE, $ROOT/.env.local, or ../bouncy-blobs/.env.local
# (.env.production.local holds a REVOKED key; never use it.) The value is never printed.
if [[ -z "${BB_MP_API_KEY:-}" ]]; then
  for _f in "${BB_ENV_FILE:-}" "$ROOT/.env.local" "$ROOT/../bouncy-blobs/.env.local"; do
    if [[ -n "$_f" && -f "$_f" ]] && grep -q '^VITE_MP_API_KEY=' "$_f"; then
      BB_MP_API_KEY="$(grep '^VITE_MP_API_KEY=' "$_f" | head -1 | cut -d= -f2- | tr -d '\r"'"'")"
      echo "BB_MP_API_KEY: from $_f"
      break
    fi
  done
  unset _f
fi
if [[ -n "${BB_MP_API_KEY:-}" ]]; then
  export BB_MP_API_KEY
else
  echo "warning: BB_MP_API_KEY not set — online/phone play will be disabled in this build" >&2
fi
