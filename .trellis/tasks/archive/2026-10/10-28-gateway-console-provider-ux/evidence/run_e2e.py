#!/usr/bin/env python3
"""Cross-process end-to-end test for the cc-use gateway + console log pipeline.

Flow:
  1. isolate HOME -> temporary dir (debug build data dir is com.mipawn.cc-use.dev)
  2. boot the real cc-use-daemon once so migrations create the SQLite DB
  3. seed provider / key / two gateway outlets with sqlite3
  4. start a local mock upstream and the real daemon process
  5. act as an external OpenAI-compatible client through the gateway:
       - GET /v1/models (gateway override must be used, not key clientConfigs)
       - POST /v1/chat/completions (non-streaming, assert upstream model/URL/auth/UA)
       - POST /v1/chat/completions stream=true (SSE)
       - POST with mock-error (upstream 4xx -> recorded upstream_error)
       - second gateway: base URL path prefix + x-api-key + UA follows inbound
  6. assert request_logs attribution/counts and console log files
  7. assert daemon management log-status + clear endpoints
Prints PASS/FAIL per assertion and writes evidence JSON. No real provider is
contacted and no production data directory is touched.
"""
import json
import os
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
E2E = "/tmp/cc-use-e2e"
HOME = os.path.join(E2E, "home")
RECORDS = os.path.join(E2E, "upstream-records.jsonl")
DB_DIR = os.path.join(HOME, "Library", "Application Support", "com.mipawn.cc-use.dev")
DB_PATH = os.path.join(DB_DIR, "data", "cc-use.db")
DAEMON = os.path.join(ROOT, "target", "debug", "cc-use-daemon")
MOCK = os.path.join(E2E, "mock_upstream.py")

results = []
evidence = {}


def check(name, condition, detail=""):
    results.append({"name": name, "pass": bool(condition), "detail": detail})
    print(("PASS " if condition else "FAIL ") + name + ((" :: " + detail) if detail else ""))


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_port(port, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def read_records(clear=False):
    if not os.path.exists(RECORDS):
        return []
    with open(RECORDS, encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    if clear:
        open(RECORDS, "w").close()
    return rows


def request(url, method="GET", token=None, body=None, headers=None):
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
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.read().decode("utf-8", "replace"), dict(resp.headers)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace"), dict(error.headers)


def db():
    return sqlite3.connect(DB_PATH)


def main():
    for path in (HOME, DB_PATH):
        if os.path.isdir(path):
            shutil.rmtree(path)
        elif os.path.exists(path):
            os.remove(path)
    os.makedirs(HOME, exist_ok=True)
    if os.path.exists(RECORDS):
        os.remove(RECORDS)

    mock_port = free_port()
    daemon_port = free_port()

    # 1. First daemon run creates + migrates the database (it may fail to bind
    # the default port if a real daemon is running; the DB already exists then).
    env = dict(os.environ, HOME=HOME)
    first = subprocess.Popen(
        [DAEMON, "start", "--foreground"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 30
    while time.time() < deadline and not os.path.exists(DB_PATH):
        time.sleep(0.1)
    time.sleep(0.4)
    first.send_signal(signal.SIGKILL)
    first.wait(timeout=10)
    check("database created and migrated by the real daemon binary", os.path.exists(DB_PATH), DB_PATH)
    if not os.path.exists(DB_PATH):
        finish()

    # 2. Seed settings + provider + key + two gateway outlets.
    now = "2026-10-29T00:00:00Z"
    client_configs = json.dumps({
        "claude_code": {
            "baseUrl": "http://127.0.0.1:1/legacy-claude",
            "authScheme": "x-api-key",
            "proxyUserAgent": "Legacy-Claude-UA/1.0",
        },
        "codex": {"baseUrl": "http://127.0.0.1:2/legacy-codex", "authScheme": "bearer"},
    })
    request_headers = json.dumps({
        "X-Provider-Additive": "provider-additive-value",
        "User-Agent": "Provider-Default-UA/9.9",
    })
    gateway_one = json.dumps({"authScheme": "bearer", "userAgent": "E2E-Gateway-UA/1.0"})
    gateway_two = json.dumps({"baseUrl": f"http://127.0.0.1:{mock_port}/relay", "authScheme": "x-api-key"})
    with db() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('proxyPort', ?)", (str(daemon_port),))
        conn.execute(
            """INSERT OR REPLACE INTO providers
               (id, name, base_url, request_headers, is_active, sort_order, preset_id, request_adapter)
               VALUES ('p1', 'MockProvider', ?, ?, 1, 0, 'custom', 'none')""",
            (f"http://127.0.0.1:{mock_port}", request_headers),
        )
        conn.execute(
            """INSERT OR REPLACE INTO providers
               (id, name, base_url, is_active, sort_order, preset_id, request_adapter)
               VALUES ('p2', 'OtherProvider', 'http://127.0.0.1:1', 1, 1, 'custom', 'none')""",
            (),
        )
        conn.execute(
            """INSERT OR REPLACE INTO api_keys
               (id, provider_id, alias, value, types, priority, is_active, client_configs)
               VALUES ('k1', 'p1', 'e2e-key', 'sk-upstream-secret', '["claude_code"]', 0, 1, ?)""",
            (client_configs,),
        )
        conn.execute(
            """INSERT OR REPLACE INTO api_keys
               (id, provider_id, alias, value, types, priority, is_active, client_configs)
               VALUES ('k2', 'p2', 'other-key', 'sk-other-secret', '["claude_code"]', 0, 1, NULL)""",
            (),
        )
        for token, name, config in (
            ("session-e2egateway0000000001", "E2E Gateway One", gateway_one),
            ("session-e2egateway0000000002", "E2E Gateway Two", gateway_two),
        ):
            conn.execute(
                """INSERT OR REPLACE INTO proxy_sessions
                   (session_token, provider_id, api_key_id, project_id, created_at, cli_type,
                    session_kind, last_seen_at, display_name, is_active, gateway_connection_config)
                   VALUES (?, 'p1', 'k1', NULL, ?, NULL, 'gateway', ?, ?, 1, ?)""",
                (token, now, now, name, config),
            )
        conn.commit()
    check("seeded two gateways on one key with explicit connection overrides", True)

    # 3. Start mock upstream then the real daemon.
    mock = subprocess.Popen([sys.executable, MOCK, "--port", str(mock_port), "--record", RECORDS],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    ready = mock.stdout.readline().strip()
    check("mock upstream ready", ready.startswith("READY"), ready)
    daemon = subprocess.Popen([DAEMON, "start", "--foreground"], env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    check("daemon listening on seeded port", wait_port(daemon_port), str(daemon_port))

    base = f"http://127.0.0.1:{daemon_port}"
    token_one = "session-e2egateway0000000001"
    token_two = "session-e2egateway0000000002"
    client_ua = "E2E-External-Client/4.4"

    try:
        # 4a. Model discovery through gateway one.
        with db() as conn:
            logs_before_discovery = conn.execute("SELECT COUNT(*) FROM request_logs").fetchone()[0]
        read_records(clear=True)
        status, body, _ = request(base + "/v1/models", token=token_one, headers={"User-Agent": client_ua})
        catalog = json.loads(body) if body.startswith("{") else {}
        ids = [entry.get("id") for entry in catalog.get("data", [])]
        check("GET /v1/models returns upstream catalogue", status == 200 and ids == ["mock-alpha", "mock-beta"],
              f"status={status} ids={ids}")
        records = read_records()
        discovery = next((r for r in records if r["method"] == "GET"), None)
        check("model discovery reached the provider upstream path",
              discovery is not None and discovery["path"].split("?")[0] == "/v1/models",
              discovery["path"] if discovery else "no record")
        check("model discovery uses the bound key as bearer credential",
              discovery is not None and discovery["headers"].get("authorization") == "Bearer sk-upstream-secret",
              discovery["headers"].get("authorization", "") if discovery else "")
        with db() as conn:
            logs_after_discovery = conn.execute("SELECT COUNT(*) FROM request_logs").fetchone()[0]
        check("model discovery is not written as billed inference",
              logs_after_discovery == logs_before_discovery,
              f"before={logs_before_discovery} after={logs_after_discovery}")
        check("model discovery sends the gateway UA override, not legacy clientConfigs UA",
              discovery is not None
              and discovery["headers"].get("user-agent") == "E2E-Gateway-UA/1.0"
              and "Legacy-Claude-UA" not in json.dumps(discovery["headers"]),
              discovery["headers"].get("user-agent", "") if discovery else "")

        # 4b. Non-streaming inference through gateway one.
        read_records(clear=True)
        status, body, _ = request(
            base + "/v1/chat/completions", method="POST", token=token_one,
            body={"model": "mock-alpha", "messages": [{"role": "user", "content": "ping"}], "stream": False},
            headers={"User-Agent": client_ua},
        )
        check("POST /v1/chat/completions succeeds", status == 200 and "chatcmpl-mock" in body, f"status={status}")
        records = read_records()
        inference = next((r for r in records if r["method"] == "POST"), None)
        check("inference reached the provider base URL (not key clientConfigs)",
              inference is not None and inference["path"].split("?")[0] == "/v1/chat/completions"
              and "legacy-claude" not in inference["path"] and "legacy-codex" not in inference["path"],
              inference["path"] if inference else "")
        sent = json.loads(inference["body"]) if inference else {}
        check("client model id is forwarded unchanged", sent.get("model") == "mock-alpha", str(sent.get("model")))
        check("gateway UA override wins over the inbound client UA",
              inference is not None and inference["headers"].get("user-agent") == "E2E-Gateway-UA/1.0",
              inference["headers"].get("user-agent", "") if inference else "")
        check("provider additive header reaches the upstream",
              inference is not None
              and inference["headers"].get("x-provider-additive") == "provider-additive-value",
              inference["headers"].get("x-provider-additive", "") if inference else "")

        # 4c. Streaming inference.
        read_records(clear=True)
        status, body, headers = request(
            base + "/v1/chat/completions", method="POST", token=token_one,
            body={"model": "mock-alpha", "messages": [{"role": "user", "content": "hi"}], "stream": True},
            headers={"User-Agent": client_ua},
        )
        check("streaming inference returns SSE content",
              status == 200 and "hello" in body and "[DONE]" in body,
              f"status={status} ct={headers.get('content-type', headers.get('Content-Type', ''))}")
        stream_record = next((r for r in read_records() if r["method"] == "POST"), None)
        check("streaming request reached the upstream", stream_record is not None,
              stream_record["path"] if stream_record else "")

        # 4d. Upstream rejection.
        read_records(clear=True)
        status, body, _ = request(
            base + "/v1/chat/completions", method="POST", token=token_one,
            body={"model": "mock-error", "messages": [], "stream": False},
            headers={"User-Agent": client_ua},
        )
        check("upstream 4xx is surfaced as a failure status", status >= 400, f"status={status}")
        check("upstream rejection reached the provider", any(
            json.loads(r["body"]).get("model") == "mock-error" for r in read_records() if r["method"] == "POST"))

        # 4e. Second gateway: path prefix, x-api-key auth, inbound UA preserved.
        read_records(clear=True)
        status, body, _ = request(base + "/v1/models", token=token_two, headers={"User-Agent": "client-two/2.0"})
        two = next((r for r in read_records() if r["method"] == "GET"), None)
        check("second gateway joins its base URL path prefix",
              two is not None and two["path"].split("?")[0] == "/relay/v1/models",
              two["path"] if two else "")
        check("second gateway authenticates with x-api-key and no Authorization",
              two is not None and two["headers"].get("x-api-key") == "sk-upstream-secret"
              and "authorization" not in two["headers"],
              json.dumps({k: v for k, v in (two["headers"] if two else {}).items()
                          if k in ("authorization", "x-api-key")}))
        check("second gateway without UA override keeps the inbound UA",
              two is not None and two["headers"].get("user-agent") == "client-two/2.0",
              two["headers"].get("user-agent", "") if two else "")
        read_records(clear=True)
        request(base + "/v1/chat/completions", method="POST", token=token_two,
                body={"model": "mock-beta", "messages": [], "stream": False},
                headers={"User-Agent": "client-two/2.0"})
        two_post = next((r for r in read_records() if r["method"] == "POST"), None)
        check("second gateway inference joins the prefix",
              two_post is not None and two_post["path"].split("?")[0] == "/relay/v1/chat/completions",
              two_post["path"] if two_post else "")

        # 5. Attribution in the statistics source of truth.
        time.sleep(0.6)
        with db() as conn:
            conn.row_factory = sqlite3.Row
            rows = [dict(row) for row in conn.execute(
                "SELECT provider_id, api_key_id, outcome, status_code, request_id, is_streaming, input_tokens, output_tokens, model "
                "FROM request_logs ORDER BY created_at") ]
        billed = [r for r in rows if r["input_tokens"] or r["output_tokens"] or r["is_streaming"]]
        check("inference requests are recorded with the gateway-bound attribution",
              rows and all(r["provider_id"] == "p1" and r["api_key_id"] == "k1" for r in rows),
              json.dumps([(r["provider_id"], r["api_key_id"]) for r in rows]))
        check("request ids are unique per recorded request",
              len({r["request_id"] for r in rows}) == len(rows) and all(r["request_id"] for r in rows),
              str([r["request_id"] for r in rows]))
        outcomes = [r["outcome"] for r in rows]
        rejected = [r for r in rows if r["model"] == "mock-error"]
        check("non-streaming success, stream success and upstream rejection are all recorded",
              outcomes.count("success") >= 2
              and len(rejected) == 1
              and rejected[0]["outcome"] in ("client_error", "upstream_error"),
              str([(r["model"], r["outcome"], r["status_code"]) for r in rows]))
        check("streaming request recorded as streaming with measured usage",
              any(r["is_streaming"] and (r["input_tokens"] or r["output_tokens"]) for r in rows),
              json.dumps([(r["is_streaming"], r["input_tokens"], r["output_tokens"]) for r in rows]))
        with db() as conn:
            other = conn.execute(
                "SELECT COUNT(*) FROM request_logs WHERE provider_id = 'p2' OR api_key_id = 'k2'"
            ).fetchone()[0]
        check("second provider/key is not polluted by gateway traffic", other == 0, f"rows={other}")
        check("every recorded row belongs to a real inference POST",
              len(rows) == 4 and all(r["model"] in ("mock-alpha", "mock-beta", "mock-error") for r in rows),
              json.dumps([(r["model"], r["outcome"]) for r in rows]))

        # 6. Console log files + management endpoints.
        log_dir = os.path.join(HOME, ".cc-use", "logs", "console")
        files = sorted(os.listdir(log_dir)) if os.path.isdir(log_dir) else []
        daemon_files = [name for name in files if name.startswith("daemon-")]
        check("daemon console log files exist", bool(daemon_files), str(daemon_files))
        if daemon_files:
            path = os.path.join(log_dir, daemon_files[0])
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            check("console log file contains JSONL records", "daemon booted" in text or '"event"' in text,
                  f"{len(text)} bytes")
        token_path = os.path.join(HOME, ".cc-use", "state", "management-token")
        management_token = open(token_path, encoding="utf-8").read().strip() if os.path.exists(token_path) else ""
        check("daemon management token exists", bool(management_token))

        def management_post(path):
            req = urllib.request.Request(base + path, data=b"", method="POST")
            req.add_header("x-cc-use-management-token", management_token)
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    return resp.status, resp.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as error:
                return error.code, error.read().decode("utf-8", "replace")

        def management_get(path):
            req = urllib.request.Request(base + path, method="GET")
            req.add_header("x-cc-use-management-token", management_token)
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    return resp.status, resp.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as error:
                return error.code, error.read().decode("utf-8", "replace")

        status, body = management_get("/_management/console/log-status")
        payload = json.loads(body) if body.strip().startswith("{") else {}
        check("daemon log-status reports per-owner counters",
              status == 200 and payload.get("available") is True and "dropped" in payload,
              body[:200])
        before_clear = [name for name in os.listdir(log_dir) if name.startswith("daemon-")]
        status, body = management_post("/_management/console/clear")
        check("daemon console clear acknowledges real removal", status == 200 and '"ok":true' in body.replace(" ", ""),
              f"status={status} body={body[:120]}")
        time.sleep(0.3)
        remaining = [name for name in os.listdir(log_dir)] if os.path.isdir(log_dir) else []
        check("daemon console files from before the clear are gone",
              not [n for n in remaining if n in before_clear],
              f"before={before_clear} remaining={remaining}")
    finally:
        for process in (daemon, mock):
            try:
                process.send_signal(signal.SIGKILL)
            except ProcessLookupError:
                pass
        for process in (daemon, mock):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        finish()


def finish():
    passed = sum(1 for row in results if row["pass"])
    total = len(results)
    evidence["results"] = results
    with open(os.path.join(E2E, "evidence.json"), "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, indent=2, ensure_ascii=False)
    print(f"\n===== E2E {passed}/{total} checks passed =====")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
