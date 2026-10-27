"""Check that this machine can use Gemini, step by step. Never prints the API key.

On the Azure VM:   sudo python3 /opt/bengaluru-transit/scripts/check_gemini.py
On your PC:        python scripts\\check_gemini.py

It reads the key the same way the app does: real environment variables first, then
/etc/bengaluru-transit.env (the Azure service's settings file), then the project's .env.
"""
import socket
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from transit import gemini  # noqa: E402

HOST = "generativelanguage.googleapis.com"


def step(title):
    print(f"\n== {title}")


def main() -> int:
    for env_file in (Path("/etc/bengaluru-transit.env"), ROOT / ".env"):
        try:
            gemini.load_dotenv(env_file)
        except PermissionError:
            print(f"(cannot read {env_file}; run with sudo)")
    config = gemini.settings()
    step("Settings")
    print(f"key: {'present (' + str(len(config['key'])) + ' characters)' if config['enabled'] else 'MISSING'}")
    print(f"model: {config['model']}   answer time limit: {gemini._timeout_setting():.0f} s")
    if not config["enabled"]:
        print("Put GEMINI_API_KEY=... in /etc/bengaluru-transit.env (Azure) or .env (PC), without a leading #.")
        return 1

    step(f"Address lookup for {HOST}")
    try:
        infos = socket.getaddrinfo(HOST, 443, type=socket.SOCK_STREAM)
    except OSError as error:
        print(f"FAILED: {error}  -> the server cannot resolve Google's address (DNS).")
        return 2
    ipv4 = sorted({info[4][0] for info in infos if info[0] == socket.AF_INET})
    ipv6 = sorted({info[4][0] for info in infos if info[0] == socket.AF_INET6})
    print(f"IPv4: {ipv4[:3] or 'none'}   IPv6: {ipv6[:3] or 'none'}")

    step("Opening a connection (port 443)")
    reachable = False
    for label, addresses, family in (("IPv4", ipv4, socket.AF_INET), ("IPv6", ipv6, socket.AF_INET6)):
        if not addresses:
            continue
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(6)
        started = time.monotonic()
        try:
            sock.connect((addresses[0], 443))
            print(f"{label}: OK in {time.monotonic() - started:.2f} s")
            reachable = reachable or family == socket.AF_INET or not ipv4
        except OSError as error:
            print(f"{label}: FAILED after {time.monotonic() - started:.1f} s ({type(error).__name__}: {error})")
        finally:
            sock.close()
    if not reachable:
        print("The server cannot open a connection to Google. Check the VM's outbound rules / firewall for port 443.")
        return 3

    step("Asking Gemini a tiny question")
    started = time.monotonic()
    try:
        action = gemini.understand("hi")
    except gemini.GeminiUnavailable as error:
        print(f"FAILED after {time.monotonic() - started:.1f} s: {error.reason} - {error.note}")
        print("The [Gemini] line above (if any) has Google's exact reason.")
        return 4
    print(f"OK in {time.monotonic() - started:.1f} s -> {action}")

    step("Place look-up (OpenStreetMap, for names that are not BMTC stops)")
    from transit import places  # noqa: E402
    started = time.monotonic()
    found = places.geocode("Brookefield")
    if found:
        print(f"OK in {time.monotonic() - started:.1f} s -> {found['name']} at {found['lat']}, {found['lon']}")
    else:
        print("Not available (switched off, or this server cannot reach nominatim.openstreetmap.org). "
              "Stop names still work; neighbourhood names will not.")
    print("\nGemini works from this machine. Restart the app if it is still using old settings:")
    print("  sudo systemctl restart bengaluru-app")
    return 0


if __name__ == "__main__":
    sys.exit(main())
