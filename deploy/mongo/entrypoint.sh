#!/bin/bash
# A single-node replica set with authentication needs a key file. Create it once, with the permissions mongod requires,
# then hand over to the official MongoDB entrypoint.
set -euo pipefail
key=/data/configdb/replica.key
if [ ! -s "$key" ]; then
  head -c 756 /dev/urandom | base64 -w0 > "$key"
fi
chmod 400 "$key"
chown mongodb:mongodb "$key"
exec /usr/local/bin/docker-entrypoint.sh "$@"
