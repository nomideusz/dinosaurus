# Custom Navidrome image bundled with Syncthing for music sync.
#
# Why: a Railway volume can only attach to one service at a time, so we run
# Navidrome (music streaming) and Syncthing (file sync) in the same container
# and have them share the volume directly. Local Syncthing pushes files into
# the music folder, Navidrome scans them and they're available in the dino.
#
# Two processes inside the container:
#   - syncthing serve  (background) — :8384 GUI, sync via Syncthing's relays
#   - /app/navidrome   (foreground) — Subsonic API + web UI on $ND_PORT

FROM deluan/navidrome:latest

USER root

# tini       — proper signal handling for the multi-process container
# syncthing  — file sync daemon
# apache2-utils — provides htpasswd, used to bcrypt the Syncthing GUI password
RUN apk add --no-cache tini syncthing apache2-utils

COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh /app/navidrome

# Run as the navidrome user (UID 1000) so files in the shared volume stay
# owned by the same user that Navidrome reads them as. The chmod above
# ensures the binary stays executable through any layer-rewriting that
# adding apk packages might do.
USER 1000:1000

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
