#!/usr/bin/env python3
"""Logging pass-through proxy to check what OpenCode sends upstream.

usage: capture.py PORT OUT.jsonl UPSTREAM_ORIGIN [--full]
  UPSTREAM_ORIGIN  e.g. https://example.com  (the part before /v1)
Point the provider's baseURL at http://127.0.0.1:PORT/v1. Requests are forwarded unchanged.
Each POST is recorded as one JSON line: session / parent-session headers, model, and every cache_control marker with
its position. With --full the whole body and all headers are recorded too; secret header values
(authorization, cookie, x-api-key, ...) are replaced by "<redacted>".
"""
import json, sys, http.client, ssl, threading
from urllib.parse import urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, out, upstream = int(sys.argv[1]), sys.argv[2], urlparse(sys.argv[3])
full = "--full" in sys.argv[4:]
lock = threading.Lock()
SECRET = ("authorization", "cookie", "x-api-key", "proxy-authorization")

def markers(body):
    found = []
    def walk(n, path):
        if isinstance(n, dict):
            if "cache_control" in n: found.append({"at": path, "cc": n["cache_control"]})
            for k, v in n.items():
                if k != "cache_control": walk(v, f"{path}.{k}")
        elif isinstance(n, list):
            for i, v in enumerate(n): walk(v, f"{path}[{i}]")
    walk(body, "$")
    return found

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def fwd(self, method):
        n = int(self.headers.get("content-length", 0)); body = self.rfile.read(n) if n else b""
        fwd_headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length", "accept-encoding", "connection")}
        rec = None
        if method == "POST":
            try: j = json.loads(body)
            except Exception: j = {}
            lo = {k.lower(): v for k, v in self.headers.items()}
            rec = {"path": self.path, "model": j.get("model"), "session": lo.get("x-opencode-session-id"),
                   "parent": lo.get("x-opencode-parent-session-id"), "client": lo.get("x-opencode-client"),
                   "markers": markers(j)}
            if full:
                rec["headers"] = {k: ("<redacted>" if k in SECRET else v) for k, v in lo.items()}
                rec["body_bytes"] = len(body); rec["body"] = j
        cls = http.client.HTTPSConnection if upstream.scheme == "https" else http.client.HTTPConnection
        kw = {"context": ssl.create_default_context()} if upstream.scheme == "https" else {}
        c = cls(upstream.netloc, timeout=600, **kw)
        c.request(method, self.path, body=body, headers=fwd_headers); r = c.getresponse()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() not in ("transfer-encoding", "content-length", "connection"): self.send_header(k, v)
        self.send_header("Connection", "close"); self.end_headers()
        while True:
            ch = r.read1(65536)
            if not ch: break
            try: self.wfile.write(ch); self.wfile.flush()
            except Exception: break
        if rec is not None:
            rec["status"] = r.status
            with lock: open(out, "a").write(json.dumps(rec) + "\n")
        self.close_connection = True
    def do_GET(self): self.fwd("GET")
    def do_POST(self): self.fwd("POST")

ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
