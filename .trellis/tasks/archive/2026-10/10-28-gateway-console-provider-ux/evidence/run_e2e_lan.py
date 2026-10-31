#!/usr/bin/env python3
"""Cross-process end-to-end test for R8 (LAN access).

Uses the real `cc-use-daemon` binary, an isolated HOME and a local mock
upstream. Verifies:
  1. default scope (`loopback`): the port is NOT reachable through the host's
     LAN IP, loopback still works;
  2. scope `lan`: the gateway works from the LAN IP (models + inference);
  3. `/_management/*` is rejected from a non-loopback peer (403) even with a
     correct management token, and accepted from 127.0.0.1;
  4. provider-credential pass-through is rejected from a non-loopback peer;
  5. a LAN inference is still attributed to the bound provider/key.

No real provider is contacted; no production data directory is touched.
"""
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = "/Users/dongzhan/Desktop/mipawn/cc-use"
E2E = "/tmp/cc-use-e2e-lan"
HOME = os.path.join(E2E, "home")
RECORDS = os.path.join(E2E, "upstream-records.jsonl")
DB_PATH = os.path.join(HOME, "Library", "Application Support", "com.mipawn.cc-use.dev", "data", "cc-use.db")
DAEMON = os.path.join(ROOT, "target", "debug", "cc-use-daemon")
MOCK = os.path.join(ROOT, ".trellis/tasks/10-28-gateway-console-provider-ux/evidence/mock_upstream.py")
GATEWAY_TOKEN = "session-e2e-lan-gateway000001"

results = []


def check(name, condition, detail=""):
    results.append({"name": name, "pass": bool(condition), "detail": detail})
    print(("PASS " if condition else "FAIL ") + name + ((" :: " + detail) if detail else ""))


def finish():
    passed = sum(1 for row in results if row["pass"])
    total = len(results)
    with open(os.path.join(E2E, "evidence-lan.json"), "w", encoding="utf-8") as handle:
        json.dump({"results": results, "lan_ip": LAN_IP}, handle, indent=2, ensure_ascii=False)
    print(f"\n===== LAN E2E {passed}/{total} checks passed =====")
    sys.exit(0 if passed == total else 1)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def lan_ip():
    try:
        output = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    candidates = []
    for match in re.finditer(r"inet (\d+\.\d+\.\d+\.\d+)", output):
        ip = match.group(1)
        if ip.startswith("127.") or ip == "0.0.0.0":
            continue
        candidates.append(ip)
    for ip in candidates:
        if ip.startswith(("192.168.", "10.", "172.")):
            return ip
    return candidates[0] if candidates else None


def wait_port(host, port, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def request(url, method="GET", token=None, body=None, headers=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except Exception as error:  # connection refused / timeout
        return None, str(error)


def db():
    return sqlite3.connect(DB_PATH)


def start_daemon():
    process = subprocess.Popen(
        [DAEMON, "start", "--foreground"], env=dict(os.environ, HOME=HOME),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return process


def stop(process):
    try:
        process.send_signal(signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


LAN_IP = lan_ip()


def main():
    global LAN_IP
    if not LAN_IP:
        print("SKIP: no non-loopback IPv4 address on this host")
        finish()
    print(f"using LAN IP {LAN_IP}")
    if os.path.isdir(HOME):
        shutil.rmtree(HOME)
    os.makedirs(HOME, exist_ok=True)
    if os.path.exists(RECORDS):
        os.remove(RECORDS)
    mock_port = free_port()
    daemon_port = free_port()

    # 1. First boot creates + migrates the database.
    first = start_daemon()
    deadline = time.time() + 30
    while time.time() < deadline and not os.path.exists(DB_PATH):
        time.sleep(0.1)
    time.sleep(0.4)
    stop(first)
    check("database created by the real daemon", os.path.exists(DB_PATH), DB_PATH)
    if not os.path.exists(DB_PATH):
        finish()

    now = "2026-10-29T00:00:00Z"
    with db() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('proxyPort', ?)", (str(daemon_port),))
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('proxyListenScope', 'loopback')")
        conn.execute(
            """INSERT OR REPLACE INTO providers
               (id, name, base_url, is_active, sort_order, preset_id, request_adapter)
               VALUES ('p1', 'MockProvider', ?, 1, 0, 'custom', 'none')""",
            (f"http://127.0.0.1:{mock_port}",),
        )
        conn.execute(
            """INSERT OR REPLACE INTO api_keys
               (id, provider_id, alias, value, types, priority, is_active)
               VALUES ('k1', 'p1', 'lan-key', 'sk-upstream-secret', '["claude_code"]', 0, 1)"""
        )
        conn.execute(
            """INSERT OR REPLACE INTO proxy_sessions
               (session_token, provider_id, api_key_id, project_id, created_at, cli_type,
                session_kind, last_seen_at, display_name, is_active, gateway_connection_config)
               VALUES (?, 'p1', 'k1', NULL, ?, NULL, 'gateway', ?, 'LAN Gateway', 1,
                       '{"authScheme":"bearer","userAgent":"E2E-LAN-UA/1.0"}')""",
            (GATEWAY_TOKEN, now, now),
        )
        conn.commit()

    mock = subprocess.Popen([sys.executable, MOCK, "--port", str(mock_port), "--record", RECORDS],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    mock.stdout.readline()
    management_token = ""

    def read_token():
        path = os.path.join(HOME, ".cc-use", "state", "management-token")
        return open(path, encoding="utf-8").read().strip() if os.path.exists(path) else ""

    # 2. Default scope: loopback only.
    daemon = start_daemon()
    check("daemon listening on loopback (default scope)", wait_port("127.0.0.1", daemon_port), str(daemon_port))
    management_token = read_token()
    check("management token exists", bool(management_token))
    status, _ = request(f"http://127.0.0.1:{daemon_port}/v1/models", token=GATEWAY_TOKEN)
    check("loopback gateway works with default scope", status == 200, f"status={status}")
    lan_status, lan_error = request(f"http://{LAN_IP}:{daemon_port}/v1/models", token=GATEWAY_TOKEN)
    check("LAN IP is NOT reachable with default loopback scope", lan_status is None, str(lan_error)[:120])
    stop(daemon)

    # 3. Switch scope to lan and restart.
    with db() as conn:
        conn.execute("UPDATE settings SET value = 'lan' WHERE key = 'proxyListenScope'")
        conn.commit()
    daemon = start_daemon()
    check("daemon listening after LAN restart", wait_port("127.0.0.1", daemon_port), str(daemon_port))
    time.sleep(0.3)

    # 3a. Gateway traffic from the LAN IP.
    status, body = request(f"http://{LAN_IP}:{daemon_port}/v1/models", token=GATEWAY_TOKEN)
    catalog = json.loads(body) if (body or "").startswith("{") else {}
    ids = [entry.get("id") for entry in catalog.get("data", [])]
    check("LAN client gets the model catalogue through the gateway",
          status == 200 and ids == ["mock-alpha", "mock-beta"], f"status={status} ids={ids}")
    status, body = request(
        f"http://{LAN_IP}:{daemon_port}/v1/chat/completions", method="POST", token=GATEWAY_TOKEN,
        body={"model": "mock-alpha", "messages": [{"role": "user", "content": "lan"}], "stream": False},
    )
    check("LAN client completes an inference call", status == 200 and "chatcmpl-mock" in body, f"status={status}")

    # 3b. Management API must stay loopback-only.
    status, body = request(f"http://{LAN_IP}:{daemon_port}/_management/health",
                           headers={"x-cc-use-management-token": management_token})
    check("LAN peer cannot read management health", status == 403, f"status={status} body={body[:100]}")
    status, body = request(f"http://{LAN_IP}:{daemon_port}/_management/console/log-status",
                           headers={"x-cc-use-management-token": management_token})
    check("LAN peer cannot read management log-status", status == 403, f"status={status}")
    status, body = request(f"http://{LAN_IP}:{daemon_port}/_management/console/clear", method="POST",
                           headers={"x-cc-use-management-token": management_token})
    check("LAN peer cannot clear management history", status == 403, f"status={status}")
    status, body = request(f"http://127.0.0.1:{daemon_port}/_management/health",
                           headers={"x-cc-use-management-token": management_token})
    check("loopback management health still works", status == 200, f"status={status}")

    # 3c. Provider-credential pass-through is rejected from the LAN.
    read_before = len(open(RECORDS, encoding="utf-8").read().splitlines()) if os.path.exists(RECORDS) else 0
    status, body = request(
        f"http://{LAN_IP}:{daemon_port}/v1/chat/completions", method="POST",
        headers={"Authorization": "Bearer sk-real-provider-secret-should-not-leak"},
        body={"model": "claude-3", "messages": [], "stream": False},
    )
    check("LAN provider-credential pass-through is rejected", status == 403, f"status={status} body={body[:120]}")
    check("rejection does not echo the credential",
          "sk-real-provider-secret" not in (body or ""))
    read_after = len(open(RECORDS, encoding="utf-8").read().splitlines()) if os.path.exists(RECORDS) else 0
    check("rejected pass-through never reached an upstream", read_after == read_before,
          f"before={read_before} after={read_after}")

    # 3d. Attribution of LAN inference is unchanged.
    time.sleep(0.6)
    with db() as conn:
        conn.row_factory = sqlite3.Row
        rows = [dict(row) for row in conn.execute(
            "SELECT provider_id, api_key_id, model, outcome FROM request_logs")]
    check("LAN inference is attributed to the bound provider/key",
          bool(rows) and all(row["provider_id"] == "p1" and row["api_key_id"] == "k1" for row in rows),
          json.dumps(rows[:3]))
    check("LAN inference recorded exactly one request", len(rows) == 1, f"rows={len(rows)}")

    # 3e. Back to loopback: LAN address becomes unreachable again.
    stop(daemon)
    with db() as conn:
        conn.execute("UPDATE settings SET value = 'loopback' WHERE key = 'proxyListenScope'")
        conn.commit()
    daemon = start_daemon()
    wait_port("127.0.0.1", daemon_port)
    status, _ = request(f"http://{LAN_IP}:{daemon_port}/v1/models", token=GATEWAY_TOKEN)
    check("turning LAN off restores loopback-only reachability", status is None, str(status))
    status, _ = request(f"http://127.0.0.1:{daemon_port}/v1/models", token=GATEWAY_TOKEN)
    check("loopback still works after turning LAN off", status == 200, str(status))

    stop(daemon)
    stop(mock)
    finish()


if __name__ == "__main__":
    main()
