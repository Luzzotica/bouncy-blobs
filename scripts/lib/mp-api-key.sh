# Sourced by the build scripts (needs $ROOT = repo root).
# bb-net bakes BB_PARTII_KEY (the game's partii publishable key) and
# optionally BB_PARTII_API in at compile time (option_env!), so release
# builds need them exported before cargo runs. Precedence:
#   1. BB_PARTII_KEY already in the environment (CI secret, manual override)
#   2. STAGING_BB_KEY in ~/.config/partii/staging.env (staging builds)
# The value is never printed.
if [[ -z "${BB_PARTII_KEY:-}" && -f "$HOME/.config/partii/staging.env" ]] && grep -q '^STAGING_BB_KEY=' "$HOME/.config/partii/staging.env"; then
  BB_PARTII_KEY="$(grep '^STAGING_BB_KEY=' "$HOME/.config/partii/staging.env" | head -1 | cut -d= -f2- | tr -d '\r"'"'")"
  echo "BB_PARTII_KEY: from ~/.config/partii/staging.env"
fi
if [[ -n "${BB_PARTII_KEY:-}" ]]; then
  export BB_PARTII_KEY
else
  echo "warning: BB_PARTII_KEY not set — online/phone play will be disabled in this build" >&2
fi
