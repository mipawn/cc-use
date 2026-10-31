#!/usr/bin/env python3
"""Local mock upstream for cc-use gateway end-to-end tests.

Records every request (method, path, headers, body) as one JSON line in
--record, then answers a minimal OpenAI/Anthropic-compatible catalogue and
chat/messages endpoint. No network access, no real credentials.

Endpoints:
  GET  */models                 -> {"object":"list","data":[{"id":"mock-alpha"},{"id":"mock-beta"}]}
  POST */chat/completions       -> OpenAI chat completion (SSE when body.stream is true)
  POST */messages               -> Anthropic message (SSE when body.stream is true)
  Any other path                -> 404 JSON

Special model ids:
  mock-error  -> 400 error response
  mock-empty  -> empty catalogue (GET models only)
"""
import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RECORDS = []
LOCK = threading.Lock()
RECORD_PATH = "/tmp/cc-use-e2e/upstream-records.jsonl"


def record(entry):
    with LOCK:
        RECORDS.append(entry)
        with open(RECORD_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep stdout clean for the readiness signal
        pass

    def _read_body(self):
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length else b""

    def _send(self, status, payload, content_type="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _headers(self):
        return {key.lower(): value for key, value in self.headers.items()}

    def do_GET(self):
        body = self._read_body()
        record({"method": "GET", "path": self.path, "headers": self._headers(), "body": ""})
        if self.path.split("?")[0].endswith("/models"):
            self._send(200, {"object": "list", "data": [{"id": "mock-alpha", "object": "model"}, {"id": "mock-beta", "object": "model"}]})
        else:
            self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        raw = self._read_body()
        record({
            "method": "POST",
            "path": self.path,
            "headers": self._headers(),
            "body": raw.decode("utf-8", "replace"),
        })
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": {"message": "bad json"}})
            return
        model = payload.get("model") or ""
        if model == "mock-error":
            self._send(400, {"error": {"message": "mock upstream rejection", "type": "invalid_request_error"}})
            return
        path = self.path.split("?")[0]
        stream = bool(payload.get("stream"))
        if path.endswith("/chat/completions"):
            if stream:
                self._sse([
                    {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "model": model, "choices": [{"index": 0, "delta": {"content": "hello "}}]},
                    {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "model": model, "choices": [{"index": 0, "delta": {"content": "world"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}},
                ])
            else:
                self._send(200, {
                    "id": "chatcmpl-mock",
                    "object": "chat.completion",
                    "model": model,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "hello world"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
                })
        elif path.endswith("/messages"):
            if stream:
                self._sse([
                    {"type": "message_start", "message": {"id": "msg_mock", "type": "message", "role": "assistant", "model": model, "usage": {"input_tokens": 9, "output_tokens": 1}}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hello"}},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 5}},
                ], anthropic=True)
            else:
                self._send(200, {
                    "id": "msg_mock",
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [{"type": "text", "text": "hello world"}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 9, "output_tokens": 5},
                })
        else:
            self._send(404, {"error": {"message": "not found"}})

    def _sse(self, events, anthropic=False):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        for event in events:
            data = "data: " + json.dumps(event) + "\n\n"
            self.wfile.write(data.encode())
            self.wfile.flush()
        if not anthropic:
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            self.wfile.write(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
            self.wfile.flush()
        self.close_connection = True


def main():
    global RECORD_PATH
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--record", default=RECORD_PATH)
    args = parser.parse_args()
    RECORD_PATH = args.record
    open(RECORD_PATH, "w", encoding="utf-8").close()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"READY {args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
