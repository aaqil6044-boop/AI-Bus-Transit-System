# Bengaluru Transit AI

Bengaluru Transit AI is a college-project journey planner focused on practical BMTC travel. It combines scheduled public-transport routing, relevant live-bus positions, step-by-step journey guidance, map-based stop selection, and an optional Gemini assistant in one interface.

The route planner does not ask an AI model to invent buses or arrival times. Journeys come from OpenTripPlanner and imported GTFS data; Gemini is only used to understand natural-language requests.

## Highlights

- Point-to-point BMTC journey planning with walking and transfers.
- Multiple route options ranked for speed, fewer transfers, or less walking.
- Route geometry and boarding, transfer, and destination stops on the map.
- Scheduled departure times and ordered stops for every bus leg.
- Live BMTC vehicles filtered to the selected journey and direction.
- Fresh, stale, and unavailable position labels instead of false "live" claims.
- Step-by-step journey mode with optional browser location hints.
- Stop-name search, map selection, route swapping, and departure-time selection.
- Optional Gemini chat for requests such as "Whitefield to Majestic at 9 AM".
- Built-in assistant fallback when Gemini is unavailable.
- No paid maps or routing API is required for local use.

## How it works

```text
Browser interface
      |
      v
Python HTTP application (port 8765)
      |-- local SQLite stop/network database
      |-- BMTC live-vehicle service (optional external feed)
      |-- Gemini API (optional)
      `-- OpenTripPlanner GraphQL API (port 8766)
                    |
                    `-- BMTC GTFS + Bengaluru OpenStreetMap graph
```

OpenTripPlanner supplies scheduled journeys and street geometry. The Python application validates, ranks, and explains those journeys. The live-bus layer separately checks BMTC vehicle positions against the selected route, direction, boarding stop, and alighting stop.

## Requirements

- Windows 10 or 11 for the included launch scripts.
- Python 3.12 or newer.
- Java 21.
- Node.js only when running the frontend tests.
- Approximately 2 GB of free disk space for the generated database, routing graph, OTP executable, and source datasets.
- At least 6 GB of available memory; the local OTP launcher allows up to 4 GB of Java heap.

## Required local data

Large generated and downloaded files are deliberately excluded from GitHub:

```text
data/bmtc_gtfs.zip
data/bengaluru_transit.db
otp/otp-shaded-2.8.1.jar
otp/bengaluru.osm.pbf
otp/graph.obj
```

Use a current, legally obtained BMTC-compatible GTFS dataset and OpenStreetMap extract. Record the dataset dates and sources in any report or demonstration because routes and timetables change.

### Build the stop database

Place the GTFS archive at `data/bmtc_gtfs.zip`, then run:

```powershell
python scripts/import_gtfs.py data/bmtc_gtfs.zip
```

This produces `data/bengaluru_transit.db`.

### Build the routing graph

Place the OpenTripPlanner 2.8.1 shaded JAR in `otp/`, then run:

```powershell
.\build-otp-graph.ps1
```

The build creates `otp/graph.obj`. Graph construction can take several minutes and needs substantially more memory than the Python application.

## Run locally

The simplest option is:

```powershell
.\run-local.ps1
```

You can also double-click `run-local.cmd`. The launcher starts OpenTripPlanner, waits until it is healthy, and then starts the web application.

Open:

```text
http://127.0.0.1:8765/
```

Keep the launcher window open while using the application. Closing it stops the local services.

## Gemini assistant

Gemini is optional. Without a key, journey search and the built-in assistant continue to work.

1. Copy `.env.example` to `.env`.
2. Add a Google AI Studio API key:

```dotenv
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.1-flash-lite
```

3. Restart the application.

Never commit `.env` or paste the API key into source code. For a hosted deployment, configure `GEMINI_API_KEY` using the hosting provider's secret-management settings.

Gemini interprets user intent only. It cannot create route numbers, journey geometry, schedules, or live positions; those continue to come from the transit systems.

## Tests

Run the backend suite:

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

Run the frontend state tests:

```powershell
node tests/map-state.test.cjs
node tests/live-buses.test.cjs
node tests/journey-live.test.cjs
node tests/live-alternates.test.cjs
```

The live-feed tests use controlled fixtures. Automated tests cannot guarantee that BMTC's external service is online or that a vehicle's published GPS position is accurate.

## Sharing a temporary public demo

The quickest free presentation option is a Cloudflare Quick Tunnel. Start the application locally and, in another terminal, run:

```powershell
cloudflared tunnel --url http://127.0.0.1:8765
```

Cloudflare prints a temporary `trycloudflare.com` URL. The computer, application, OTP router, and tunnel must remain running. The address changes when the tunnel restarts, so this is intended for demonstrations rather than permanent hosting.

## Permanent deployment

The complete application needs a machine capable of running both Java and Python. Small serverless or 512 MB free web instances cannot run the OTP graph reliably.

A deployment should provide:

- Java 21 and enough memory for the OTP graph.
- Python 3.12 or newer.
- The generated SQLite database, OTP graph, and OTP JAR.
- A process manager that starts OTP before the Python application and restarts failures.
- HTTPS, especially when browser location is used.
- `GEMINI_API_KEY` stored as a secret rather than in `.env`.
- Health checks for the web application and routing engine.

Because the runtime artifacts are not committed, they can be distributed as versioned GitHub Release assets or downloaded from private object storage during deployment. Do not rebuild the graph on every application start.

### Azure Ubuntu VM

This repository includes an existing-VM deployment package in `deploy/azure/`. It runs OTP and the
Python server privately on ports 8766 and 8765, with Nginx as the public entry point on port 80.

1. Clone the repository to `/opt/bengaluru-transit` on the VM.
2. From Windows, upload the ignored runtime files:

   ```powershell
   .\deploy\azure\upload-runtime.ps1 -VmIp <PUBLIC_IP> -KeyPath <PATH_TO_PEM>
   ```

3. On the VM, run:

   ```bash
   cd /opt/bengaluru-transit
   chmod +x deploy/azure/bootstrap.sh deploy/azure/verify.sh
   ./deploy/azure/bootstrap.sh
   ```

4. Put an optional Gemini key in `/etc/bengaluru-transit.env` using `sudo`; never commit it.
5. Allow inbound TCP port 80 in the VM network security group. Use HTTPS before relying on browser
   location outside localhost.

Useful checks:

```bash
sudo systemctl status bengaluru-otp bengaluru-app nginx
sudo journalctl -u bengaluru-otp -u bengaluru-app -n 100 --no-pager
/opt/bengaluru-transit/deploy/azure/verify.sh
```

To stop compute charges, use **Stop** in Azure Portal and wait for `Stopped (deallocated)`. The OS
disk and public IP can still have small storage/address charges while the VM is deallocated. Starting
the VM again restarts all three services automatically. Deleting the resource group removes the VM,
disk, public IP and network resources; only do that when the deployment is no longer needed.

For a no-credit-card student option, Azure for Students may provide temporary credits. For an always-free VM, Oracle Cloud's eligible Ampere instances may have sufficient resources, subject to regional availability. Verify current limits before creating infrastructure.

## Important accuracy notes

- Journey times are GTFS timetable times unless explicitly labelled otherwise.
- A displayed live vehicle position comes from BMTC's external mobile service, not from this repository.
- BMTC's service may be unavailable, stale, changed, or access-restricted without notice. Scheduled planning remains available when live tracking fails.
- Preferences re-rank the journeys returned by OpenTripPlanner; they do not manufacture additional service.
- GPS guidance provides distance hints. It does not automatically prove that a passenger boarded, transferred, or arrived.
- Validate presentation routes against current BMTC information and field observations.

## Repository layout

```text
app.py                  Python HTTP application and API
static/                 Browser interface, map, styling, and local MapLibre files
transit/                Journey planning, Gemini, GTFS, and live-bus modules
scripts/                GTFS import and development utilities
tests/                  Backend and frontend tests
data/                   Small examples plus local generated transit data
otp/                    OTP configuration and local generated routing files
run-local.ps1           Main Windows launcher
build-otp-graph.ps1     Local routing-graph builder
```

## Privacy and security

- The server exposes only the `static/` directory and API routes; local datasets and `.env` are not public files.
- Gemini receives the typed message and limited journey context when enabled. GPS coordinates are not sent to Gemini by this application.
- Do not commit API keys, local databases, logs, or downloaded datasets.
- Review the terms and licences of GTFS, OpenStreetMap, BMTC services, map tiles, and any external API before a public production launch.

## Project status

This is an educational prototype, not an official BMTC product. It should not be treated as the sole source for time-critical travel decisions.

