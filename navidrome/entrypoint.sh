#!/bin/sh
# Navidrome + Syncthing combined entrypoint.
#
# Both processes share the volume at /var/lib/navidrome:
#   $ND_MUSICFOLDER       — music library (Syncthing writes, Navidrome reads)
#   $ND_DATAFOLDER        — Navidrome's SQLite DB + caches
#   $ND_DATAFOLDER/syncthing — Syncthing's config/state (persists across deploys)
#
# Public exposure:
#   :$ND_PORT (default 4533) — Navidrome web UI + Subsonic API
#   :8384                    — Syncthing GUI (set up via env on first run)
#   :22000 TCP/UDP           — Syncthing peer sync (works through Syncthing's
#                              global relay network; we don't need a public
#                              port on Railway for it)

set -e

mkdir -p "$ND_MUSICFOLDER" "$ND_DATAFOLDER" "$ND_DATAFOLDER/syncthing"
chmod -R 0777 "$ND_MUSICFOLDER" 2>/dev/null || true

ST_HOME="$ND_DATAFOLDER/syncthing"
: "${SYNCTHING_USER:=admin}"

# Bootstrap on first run only. We seed the GUI credentials before Syncthing
# ever listens on a public address, so the GUI is never publicly reachable
# without auth — even briefly.
if [ ! -f "$ST_HOME/config.xml" ]; then
  if [ -z "$SYNCTHING_PASSWORD" ]; then
    echo "[entrypoint] FATAL: SYNCTHING_PASSWORD env var is required on first boot." >&2
    echo "[entrypoint] Set it on the Railway service and redeploy." >&2
    exit 1
  fi
  echo "[entrypoint] Generating initial Syncthing config at $ST_HOME"
  syncthing generate --home="$ST_HOME" --no-default-folder

  # bcrypt the password (Syncthing stores it hashed). htpasswd emits "$2y$",
  # Go's bcrypt expects "$2a$" — same algorithm, different prefix.
  PASS_HASH=$(htpasswd -bnBC 10 "" "$SYNCTHING_PASSWORD" | tr -d ':\n' | sed 's/\$2y/\$2a/')

  # Inject <user> + <password> right after the <gui ...> opening tag. The
  # default config from `syncthing generate` has no auth fields.
  awk -v u="$SYNCTHING_USER" -v p="$PASS_HASH" '
    /<gui [^>]*>/ {
      print
      print "        <user>" u "</user>"
      print "        <password>" p "</password>"
      next
    }
    { print }
  ' "$ST_HOME/config.xml" > "$ST_HOME/config.xml.new"
  mv "$ST_HOME/config.xml.new" "$ST_HOME/config.xml"
  echo "[entrypoint] Syncthing config seeded for user '$SYNCTHING_USER'."
fi

# Run Syncthing in the background. --no-restart keeps it from forking itself
# during upgrades (we let the container restart handle that).
syncthing serve \
  --no-browser \
  --no-restart \
  --gui-address=0.0.0.0:8384 \
  --home="$ST_HOME" &

# Foreground: Navidrome. Container exits + restarts as a unit if it dies.
exec /app/navidrome
