"""Network behaviour of the Gemini client: IPv4 first, separate connect / answer limits, clear errors.

A local HTTPS server with a throwaway certificate stands in for Google; nothing leaves the machine.
Run from the project folder:  python -m unittest discover -s tests
"""
import contextlib
import io
import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from transit import gemini

NO_PROXY_ENV = {name: "" for name in ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY")}


def make_certificate(folder):
    cert, key = os.path.join(folder, "cert.pem"), os.path.join(folder, "key.pem")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
                    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert],
                   check=True, capture_output=True)
    return cert, key


@unittest.skipUnless(shutil.which("openssl"), "openssl is needed to make a test certificate")
class GeminiNetworkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.mkdtemp()
        cls.cert, cls.key = make_certificate(cls.folder)
        cls.seen = []
        outer = cls

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.seen.append({"path": self.path, "key": self.headers.get("x-goog-api-key"), "body": body})
                answer = json.dumps({"candidates": [{"content": {"parts": [{"functionCall": {
                    "name": "reply", "args": {"text": "Hello from the test server.", "kind": "smalltalk"}}}]}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(answer)))
                self.end_headers()
                self.wfile.write(answer)

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, cls.key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.folder, ignore_errors=True)

    def setUp(self):
        env = patch.dict(os.environ, {"GEMINI_API_KEY": "net-test-key", "GEMINI_MODEL": "", **NO_PROXY_ENV})
        env.start()
        self.addCleanup(env.stop)
        trusted = ssl.create_default_context(cafile=self.cert)
        tls = patch.object(gemini.ssl, "create_default_context", return_value=trusted)
        tls.start()
        self.addCleanup(tls.stop)

    def test_https_request_goes_straight_to_the_server(self):
        status, data = gemini._post(f"https://localhost:{self.port}/v1beta/models/m:generateContent",
                                    {"hello": 1}, "net-test-key", 5)
        self.assertEqual(status, 200)
        self.assertEqual(data["candidates"][0]["content"]["parts"][0]["functionCall"]["name"], "reply")
        self.assertEqual(self.seen[-1]["key"], "net-test-key")
        self.assertEqual(self.seen[-1]["path"], "/v1beta/models/m:generateContent")

    def test_understand_end_to_end_over_https(self):
        with patch.object(gemini, "API_ROOT", f"https://localhost:{self.port}/v1beta"):
            action = gemini.understand("hi")
        self.assertEqual(action, {"action": "reply", "text": "Hello from the test server.", "kind": "smalltalk"})

    def test_ipv4_is_tried_before_ipv6(self):
        v6 = (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2001:db8::1", 443, 0, 0))
        v4 = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.1", 443))
        with patch.object(gemini.socket, "getaddrinfo", return_value=[v6, v4]):
            self.assertEqual([info[0] for info in gemini._addresses("example", 443)], [socket.AF_INET, socket.AF_INET6])

    def test_unreachable_server_is_reported_as_a_network_problem(self):
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        port = closed.getsockname()[1]
        closed.close()                                  # nothing listens here now
        out = io.StringIO()
        with patch.object(gemini, "API_ROOT", f"https://127.0.0.1:{port}/v1beta"), contextlib.redirect_stdout(out):
            with self.assertRaises(gemini.GeminiUnavailable) as caught:
                gemini.understand("hi")
        self.assertEqual(caught.exception.reason, "network")
        self.assertIn("could not connect to 127.0.0.1", out.getvalue())
        self.assertIn("port 443", out.getvalue())
        self.assertNotIn("net-test-key", out.getvalue())

    def test_connected_but_silent_server_is_a_timeout_with_a_hint(self):
        silent = socket.socket()
        silent.bind(("127.0.0.1", 0))
        silent.listen(1)                                # accepts the connection, never answers TLS
        port = silent.getsockname()[1]
        out = io.StringIO()
        try:
            with patch.object(gemini, "API_ROOT", f"https://127.0.0.1:{port}/v1beta"), contextlib.redirect_stdout(out):
                with self.assertRaises(gemini.GeminiUnavailable) as caught:
                    gemini.understand("hi", timeout=1)
        finally:
            silent.close()
        self.assertEqual(caught.exception.reason, "timeout")
        self.assertIn("GEMINI_TIMEOUT", out.getvalue())

    def test_timeout_setting(self):
        for value, expected in (("", 20.0), ("35", 35.0), ("1", 3.0), ("999", 60.0), ("abc", 20.0)):
            with self.subTest(value=value), patch.dict(os.environ, {"GEMINI_TIMEOUT": value}):
                self.assertEqual(gemini._timeout_setting(), expected)


if __name__ == "__main__":
    unittest.main()
