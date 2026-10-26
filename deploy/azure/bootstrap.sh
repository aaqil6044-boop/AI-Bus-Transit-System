#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/bengaluru-transit
REPOSITORY_URL=https://github.com/aaqil6044-boop/AI-Bus-Transit-System.git

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y openjdk-21-jre-headless python3 git nginx curl

if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo install -d -o azureuser -g azureuser "$APP_DIR"
  git clone "$REPOSITORY_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" checkout main
  git -C "$APP_DIR" pull --ff-only origin main
fi

sudo install -m 0644 "$APP_DIR/deploy/azure/bengaluru-otp.service" /etc/systemd/system/bengaluru-otp.service
sudo install -m 0644 "$APP_DIR/deploy/azure/bengaluru-app.service" /etc/systemd/system/bengaluru-app.service
sudo install -m 0644 "$APP_DIR/deploy/azure/nginx.conf" /etc/nginx/sites-available/bengaluru-transit
sudo ln -sfn /etc/nginx/sites-available/bengaluru-transit /etc/nginx/sites-enabled/bengaluru-transit
sudo rm -f /etc/nginx/sites-enabled/default

if [[ ! -e /etc/bengaluru-transit.env ]]; then
  printf '%s\n' '# GEMINI_API_KEY=' 'GEMINI_MODEL=gemini-3.1-flash-lite' | sudo tee /etc/bengaluru-transit.env >/dev/null
fi
sudo chown root:root /etc/bengaluru-transit.env
sudo chmod 0600 /etc/bengaluru-transit.env

sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable nginx bengaluru-otp.service bengaluru-app.service

for required in data/bengaluru_transit.db otp/graph.obj otp/otp-shaded-2.8.1.jar; do
  if [[ ! -s "$APP_DIR/$required" ]]; then
    echo "Runtime file missing: $APP_DIR/$required" >&2
    echo "Upload runtime files, then rerun this script." >&2
    exit 2
  fi
done

sudo chown -R azureuser:azureuser "$APP_DIR/data" "$APP_DIR/otp"
sudo systemctl restart bengaluru-otp.service

for attempt in {1..36}; do
  if curl --fail --silent --show-error --max-time 5 \
      -H 'Content-Type: application/json' -d '{"query":"{__typename}"}' \
      http://127.0.0.1:8766/otp/gtfs/v1 >/dev/null; then
    break
  fi
  if [[ "$attempt" -eq 36 ]]; then
    sudo journalctl -u bengaluru-otp.service -n 80 --no-pager
    exit 3
  fi
  sleep 5
done

sudo systemctl restart bengaluru-app.service nginx
"$APP_DIR/deploy/azure/verify.sh"
