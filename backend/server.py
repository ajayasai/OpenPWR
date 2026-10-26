"""Serve the control room and one native FMU session on loopback only."""
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

try:
    from .fmi_host import FMIPlant, ServiceError, PROFILES
    from .experiments import ExperimentSession, MAX_REPLAY_BYTES, scenarios
except ImportError:  # python backend/server.py
    from fmi_host import FMIPlant, ServiceError, PROFILES
    from experiments import ExperimentSession, MAX_REPLAY_BYTES, scenarios


ROOT = Path(__file__).resolve().parent.parent
MAX_REQUEST_BYTES = 8192


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON field")
        value[key] = item
    return value


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, *, plant=None, unavailable=None, root=ROOT):
        self.plant = ExperimentSession(plant) if plant is not None and not isinstance(plant, ExperimentSession) else plant
        self.unavailable = unavailable or "Native FMU is unavailable. Build the engineering model and restart this service."
        self.root = Path(root).resolve()
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenPWRLocal/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def _headers(self, status, content_type="application/json; charset=utf-8", length=None, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        if length is not None:
            self.send_header("Content-Length", str(length))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def _json(self, status, value, extra=None):
        body = json.dumps(value, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self._headers(status, length=len(body), extra=extra)
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, error):
        self._json(error.status, {"error": error.error, "message": error.message})

    def _host(self):
        port = self.server.server_port
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "").lower()
        if host not in allowed:
            raise ServiceError(403, "invalid_host", "This service accepts its loopback address only.")
        return host

    def _body(self, max_bytes=MAX_REQUEST_BYTES):
        host = self._host()
        if self.headers.get("Origin") != f"http://{host}":
            raise ServiceError(403, "invalid_origin", "Control requests must originate from this local control room.")
        if self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
            raise ServiceError(403, "invalid_origin", "Cross-site control requests are not accepted.")
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ServiceError(415, "unsupported_media_type", "Use application/json for control requests.")
        if self.headers.get("Transfer-Encoding"):
            raise ServiceError(400, "invalid_body", "Chunked request bodies are not supported.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ServiceError(400, "invalid_body", "Invalid Content-Length.") from error
        if not 0 < length <= max_bytes:
            raise ServiceError(413, "invalid_body", f"A JSON body of 1 to {max_bytes} bytes is required.")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"), object_pairs_hook=unique_object,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
        except (ValueError, UnicodeError) as error:
            raise ServiceError(400, "invalid_json", "The body must be valid finite JSON.") from error
        if not isinstance(data, dict):
            raise ServiceError(400, "invalid_body", "The JSON body must be an object.")
        return data

    def _plant(self):
        if self.server.plant is None:
            raise ServiceError(503, "backend_unavailable", self.server.unavailable)
        return self.server.plant

    def do_POST(self):
        try:
            route = urlsplit(self.path).path
            data = self._body(MAX_REPLAY_BYTES if route == "/api/replay" else MAX_REQUEST_BYTES)
            plant = self._plant()
            if route == "/api/control":
                result = plant.control(data)
            elif route == "/api/step":
                if set(data) != {"seconds"}:
                    raise ServiceError(400, "invalid_step", "Supply only the seconds field.")
                result = plant.step(data["seconds"])
            elif route == "/api/reset":
                if data:
                    raise ServiceError(400, "invalid_reset", "Reset accepts an empty object.")
                result = plant.reset()
            elif route == "/api/experiment":
                if set(data) != {"scenario"} or not isinstance(data["scenario"], str):
                    raise ServiceError(400, "invalid_experiment", "Supply only a scenario identifier.")
                result = plant.start(data["scenario"])
            elif route == "/api/replay":
                result = plant.replay(data)
            elif route == "/api/experiment/stop":
                if data:
                    raise ServiceError(400, "invalid_experiment", "Stopping an experiment accepts an empty object.")
                result = plant.stop()
            else:
                raise ServiceError(404, "not_found", "Unknown API route.")
            self._json(200, result)
        except ServiceError as error:
            self._error(error)
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception:
            self._error(ServiceError(500, "internal_error", "The local service could not complete this request."))

    def do_GET(self):
        try:
            self._host()
            route = unquote(urlsplit(self.path).path)
            if route == "/api/health":
                self._json(200, self._plant().health())
            elif route == "/api/state":
                self._json(200, self._plant().state())
            elif route == "/api/commands":
                self._json(200, self._plant().export_commands(), {"Content-Disposition": 'attachment; filename="openpwr-engineering.commands.json"'})
            elif route == "/api/scenarios":
                self._json(200, self._plant().scenarios())
            elif route == "/api/history":
                parameters = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                try:
                    if set(parameters) - {"maxPoints"} or len(parameters.get("maxPoints", ["600"])) != 1:
                        raise ValueError("Invalid query")
                    max_points = int(parameters.get("maxPoints", ["600"])[0])
                except ValueError as error:
                    raise ServiceError(400, "invalid_history_limit", "Supply at most one integer maxPoints value.") from error
                self._json(200, self._plant().history_points(max_points))
            elif route == "/api/report":
                self._json(200, self._plant().report(), {"Content-Disposition": 'attachment; filename="openpwr-engineering.report.json"'})
            elif route == "/api/export":
                body = self._plant().export_csv().encode("utf-8")
                self._headers(200, "text/csv; charset=utf-8", len(body), {"Content-Disposition": 'attachment; filename="openpwr-engineering.csv"'})
                if self.command != "HEAD":
                    self.wfile.write(body)
            elif route.startswith("/api/"):
                raise ServiceError(404, "not_found", "Unknown API route.")
            else:
                self._static(route)
        except ServiceError as error:
            self._error(error)
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception:
            self._error(ServiceError(500, "internal_error", "The local service could not complete this request."))

    do_HEAD = do_GET

    def do_OPTIONS(self):
        self._error(ServiceError(405, "method_not_allowed", "Cross-origin API access is not enabled."))

    def _static(self, route):
        parts = route.lstrip("/").split("/")
        if "\\" in route or any(part in (".", "..") or part.startswith(".") for part in parts):
            raise ServiceError(404, "not_found", "Not found.")
        name = "/".join(parts) or "index.html"
        if name == "version.json":
            pkg = json.loads((self.server.root / "package.json").read_text(encoding="utf-8"))
            self._json(200, {"name": pkg["name"], "version": pkg["version"]})
            return
        report_paths = {
            "verification.json": "artifacts/verification.json",
            "benchmarks.json": "artifacts/benchmarks.json",
            "modelica-verification.json": "artifacts/modelica-verification.json",
            "engineering-verification.json": "artifacts/modelica-verification.json",
            "modelica-property-verification.json": "artifacts/modelica/property-verification.json",
            "plant-verification.json": "artifacts/plant-verification.json",
            "measured-validation.json": "artifacts/measured-validation.json",
            "pressurizer-validation.json": "artifacts/pressurizer-validation.json",
        }
        if name in report_paths:
            path = self.server.root / report_paths[name]
        elif name in {"index.html", "engineering.html", "engineering-evidence.html", "plant.html", "plant-evidence.html", "verification.html", "LICENSE", "NOTICE"} or parts[0] in {"src", "docs"}:
            path = self.server.root / name
        else:
            raise ServiceError(404, "not_found", "Not found.")
        path = path.resolve()
        if not path.is_relative_to(self.server.root) or not path.is_file():
            raise ServiceError(404, "not_found", "Not found.")
        data = path.read_bytes()
        kind = {".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".md": "text/plain"}.get(path.suffix)
        kind = kind or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if kind.startswith("text/") or kind == "application/json":
            kind += "; charset=utf-8"
        self._headers(200, kind, len(data))
        if self.command != "HEAD":
            self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=tuple(PROFILES), default="primary")
    parser.add_argument("--fmu", type=Path)
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    args.port = args.port if args.port is not None else PROFILES[args.model]["port"]
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    plant, unavailable = None, None
    try:
        plant = FMIPlant(args.fmu or ROOT / "artifacts/modelica" / PROFILES[args.model]["file"], profile=args.model)
    except ServiceError as error:
        unavailable = error.message
        print(f"Engineering backend unavailable: {unavailable}", flush=True)
    server = None
    try:
        server = LocalServer(("127.0.0.1", args.port), plant=plant, unavailable=unavailable)
        print(f"OpenPWR {args.model}: http://127.0.0.1:{args.port}/{PROFILES[args.model]['page']}", flush=True)
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        if server is not None:
            server.server_close()
        if plant:
            plant.close()


if __name__ == "__main__":
    main()
