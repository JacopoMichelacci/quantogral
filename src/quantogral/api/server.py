"""Minimal local API for persistent Quantogral workspace settings."""

from __future__ import annotations

import json
import os
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

DEFAULT_BUILDER_PATH = "./cpp/include/builder"
PROJECT_ROOT = Path(os.environ.get("QUANTOGRAL_ROOT", Path(__file__).resolve().parents[3]))
CONFIG_PATH = PROJECT_ROOT / ".quantogral" / "config.json"


def read_config() -> tuple[dict[str, Any], bool]:
    """Return workspace config and whether a Builder path has been saved."""
    if not CONFIG_PATH.exists():
        return {"builder": {"path": DEFAULT_BUILDER_PATH}}, False
    try:
        with CONFIG_PATH.open(encoding="utf-8") as config_file:
            config = json.load(config_file)
    except (json.JSONDecodeError, OSError):
        return {"builder": {"path": DEFAULT_BUILDER_PATH}}, False

    builder = config.get("builder", {}) if isinstance(config, dict) else {}
    builder_path = builder.get("path") if isinstance(builder, dict) else None
    if not isinstance(builder_path, str) or not builder_path.strip():
        return {"builder": {"path": DEFAULT_BUILDER_PATH}}, False
    return {"builder": {"path": builder_path}}, True


def write_config(builder_path: str) -> None:
    """Persist Builder configuration atomically with owner-only file permissions."""
    CONFIG_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    current_config, _ = read_config()
    current_config["builder"] = {"path": builder_path}
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=CONFIG_PATH.parent, delete=False) as temporary_file:
        json.dump(current_config, temporary_file, indent=2)
        temporary_file.write("\n")
        temporary_path = Path(temporary_file.name)
    temporary_path.chmod(0o600)
    temporary_path.replace(CONFIG_PATH)


def scan_scripts(directory: Path, depth: int = 0) -> list[dict[str, Any]]:
    """Return directory and C++ header entries for the project explorer."""
    if depth > 8:
        return []

    try:
        entries = sorted(directory.iterdir(), key=lambda entry: (not entry.is_dir(), entry.name.casefold()))
    except OSError:
        return []

    nodes: list[dict[str, Any]] = []
    for entry in entries:
        if entry.name.startswith(".") or entry.is_symlink():
            continue
        if entry.is_dir():
            nodes.append({
                "name": entry.name,
                "type": "directory",
                "children": scan_scripts(entry, depth + 1),
            })
        elif entry.suffix.lower() == ".hpp":
            nodes.append({"name": entry.name, "type": "script"})
    return nodes


class ConfigHandler(BaseHTTPRequestHandler):
    """Serve and update local workspace configuration."""

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/builder/tree":
            config, _ = read_config()
            configured_path = Path(config["builder"]["path"]).expanduser()
            builder_path = configured_path if configured_path.is_absolute() else PROJECT_ROOT / configured_path
            self.send_json({
                "children": [
                    {"name": "strategies", "type": "directory", "children": scan_scripts(builder_path / "strategies")},
                    {"name": "indicators", "type": "directory", "children": scan_scripts(builder_path / "indicators")},
                ],
            })
            return

        if self.path != "/api/config":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        config, builder_configured = read_config()
        self.send_json({**config, "builderConfigured": builder_configured})

    def do_PUT(self) -> None:  # noqa: N802
        if self.path != "/api/config/builder":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length))
            builder_path = payload["path"].strip()
        except (AttributeError, json.JSONDecodeError, KeyError, ValueError):
            self.send_json({"error": "path must be a non-empty string."}, HTTPStatus.BAD_REQUEST)
            return
        if not builder_path:
            self.send_json({"error": "path must be a non-empty string."}, HTTPStatus.BAD_REQUEST)
            return
        write_config(builder_path)
        self.send_json({"builder": {"path": builder_path}, "builderConfigured": True})

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        """Keep normal browser requests out of the terminal."""


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 8000), ConfigHandler)
    print("Quantogral API listening at http://127.0.0.1:8000")
    server.serve_forever()


if __name__ == "__main__":
    main()
