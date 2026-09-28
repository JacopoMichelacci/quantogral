"""Minimal local API for persistent Quantogral workspace settings."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tempfile
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, urlparse

from quantogral.data.providers.yfinance import DataAlreadyExistsError, download_yahoo_history, search_yahoo_symbols

DEFAULT_BUILDER_PATH = "./cpp/include/builder"
PROJECT_ROOT = Path(os.environ.get("QUANTOGRAL_ROOT", Path(__file__).resolve().parents[3]))
CONFIG_PATH = PROJECT_ROOT / ".quantogral" / "config.json"
CPP_ROOT = PROJECT_ROOT / "cpp"
RUNNER_SOURCE = CPP_ROOT / "src" / "backtest_runner.cpp"
CORE_SOURCES = [CPP_ROOT / "src" / "core" / "market_events.cpp", CPP_ROOT / "src" / "core" / "order_events.cpp"]
BUILD_DIR = PROJECT_ROOT / ".quantogral" / "build"
RUNNER_BINARY = BUILD_DIR / "quantogral_backtest"
BUILD_LOCK = threading.Lock()
YAHOO_DOWNLOAD_JOBS: dict[str, dict[str, Any]] = {}
YAHOO_DOWNLOAD_JOBS_LOCK = threading.Lock()

STRATEGY_CATALOG = [{
    "id": "ma_cross",
    "name": "Moving Average Cross",
    "file": "ma_cross.hpp",
    "input": "OHLCV",
    "baseConfig": [
        {"key": "active", "label": "Strategy active", "type": "boolean", "default": True},
        {"key": "long_active", "label": "Allow long positions", "type": "boolean", "default": True},
        {"key": "short_active", "label": "Allow short positions", "type": "boolean", "default": True},
        {"key": "stacking", "label": "Allow position stacking", "type": "boolean", "default": True},
        {"key": "ts_unit", "label": "Numeric timestamp unit", "type": "select", "default": "MILLISECONDS", "options": ["SECONDS", "MILLISECONDS", "MICROSECONDS", "NANOSECONDS"]},
        {"key": "date_format", "label": "Ambiguous date format", "type": "select", "default": "DDMMYYYY", "options": ["DDMMYYYY", "MMDDYYYY"]},
    ],
    "parameters": [
        {"key": "fast_len", "label": "Fast period", "type": "number", "default": 10, "min": 1, "step": 1},
        {"key": "slow_len", "label": "Slow period", "type": "number", "default": 30, "min": 2, "step": 1},
        {"key": "fast_price_field", "label": "Fast price field", "type": "select", "default": "CLOSE", "options": ["OPEN", "HIGH", "LOW", "CLOSE", "VOLUME"]},
        {"key": "slow_price_field", "label": "Slow price field", "type": "select", "default": "CLOSE", "options": ["OPEN", "HIGH", "LOW", "CLOSE", "VOLUME"]},
        {"key": "slnot", "label": "Stop-loss amount (0 disables)", "type": "number", "default": -1, "step": 0.01},
        {"key": "slpct", "label": "Stop-loss percent (0 disables)", "type": "number", "default": -1, "step": 0.01},
        {"key": "pos_sizing_mode", "label": "Position sizing", "type": "select", "default": "FIXED", "options": ["FIXED", "FIXED_FRACTIONAL_PRICE"]},
        {"key": "qty", "label": "Fixed quantity", "type": "number", "default": 1, "min": 0.000001, "step": 0.1},
        {"key": "equity_pct", "label": "Equity fraction", "type": "number", "default": 0.05, "min": 0.000001, "max": 1, "step": 0.01},
    ],
}]


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
    """Return directories and files for the Builder project explorer."""
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
        elif entry.is_file():
            nodes.append({"name": entry.name, "type": "script"})
    return nodes


def scan_data(directory: Path, depth: int = 0) -> list[dict[str, Any]]:
    """Return a safe folder/file tree for the project's local data directory."""
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
            nodes.append({"name": entry.name, "type": "directory", "children": scan_data(entry, depth + 1)})
        elif entry.is_file():
            nodes.append({"name": entry.name, "type": "file"})
    return nodes


class WorkspaceItemError(ValueError):
    """An invalid or conflicting local workspace file operation."""

    def __init__(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def workspace_root(scope: Any) -> Path:
    if scope == "builder":
        config, _ = read_config()
        configured = Path(config["builder"]["path"]).expanduser()
        root = configured if configured.is_absolute() else PROJECT_ROOT / configured
    elif scope == "data":
        root = PROJECT_ROOT / "data"
        if root.is_symlink():
            raise WorkspaceItemError("The project data folder cannot be a symbolic link.")
        root.mkdir(parents=True, exist_ok=True)
        if PROJECT_ROOT.resolve() not in root.resolve().parents:
            raise WorkspaceItemError("The project data folder must stay inside the Quantogral project.")
    else:
        raise WorkspaceItemError("Choose either the Builder or data folder.")
    root = root.resolve()
    if not root.is_dir():
        raise WorkspaceItemError("The selected workspace folder does not exist.")
    return root


def safe_workspace_path(root: Path, relative_path: Any, must_exist: bool = True) -> Path:
    if not isinstance(relative_path, str) or "\\" in relative_path:
        raise WorkspaceItemError("The item path is invalid.")
    pure_path = PurePosixPath(relative_path)
    if pure_path.is_absolute() or any(part in {".", ".."} for part in pure_path.parts):
        raise WorkspaceItemError("Items can only be changed inside their current workspace folder.")
    target = root
    for part in pure_path.parts:
        target = target / part
        if target.is_symlink():
            raise WorkspaceItemError("Symbolic links cannot be changed from the project explorer.")
    try:
        resolved = target.resolve(strict=must_exist)
    except OSError as error:
        raise WorkspaceItemError("The selected folder or file could not be found.") from error
    if resolved != root and root not in resolved.parents:
        raise WorkspaceItemError("Items can only be changed inside their current workspace folder.")
    return resolved


WORKSPACE_EDITABLE_TEXT_SUFFIXES = {".hpp", ".h", ".cpp", ".cc", ".cxx", ".c", ".py", ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".ini", ".sh", ".csv"}
WORKSPACE_PARQUET_SUFFIXES = {".parquet", ".pq"}
WORKSPACE_EDITOR_MAX_BYTES = 8 * 1024 * 1024
WORKSPACE_PARQUET_EDITOR_MAX_ROWS = 5000


def workspace_file_target(payload: dict[str, Any]) -> tuple[Path, str]:
    root = workspace_root(payload.get("scope"))
    target = safe_workspace_path(root, payload.get("path"))
    if not target.is_file():
        raise WorkspaceItemError("Choose a file to open.")
    suffix = target.suffix.lower()
    if suffix not in WORKSPACE_EDITABLE_TEXT_SUFFIXES | WORKSPACE_PARQUET_SUFFIXES:
        raise WorkspaceItemError("The editor supports C/C++ source, text, CSV, and Parquet files.", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
    if target.stat().st_size > WORKSPACE_EDITOR_MAX_BYTES:
        raise WorkspaceItemError("This file is larger than the 8 MB editor limit. Open a smaller file or edit it outside Quantogral.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    return target, suffix


def read_workspace_file(payload: dict[str, Any]) -> dict[str, Any]:
    target, suffix = workspace_file_target(payload)
    if suffix in WORKSPACE_PARQUET_SUFFIXES:
        try:
            import polars as pl
        except ImportError as error:
            raise RuntimeError("Parquet editing needs the project's Polars dependency. Run `uv sync` and restart Quantogral.") from error
        try:
            frame = pl.scan_parquet(target).limit(WORKSPACE_PARQUET_EDITOR_MAX_ROWS + 1).collect()
        except Exception as error:
            raise WorkspaceItemError(f"Could not read this Parquet file: {error}") from error
        if frame.height > WORKSPACE_PARQUET_EDITOR_MAX_ROWS:
            raise WorkspaceItemError("The Parquet editor currently supports up to 5,000 rows per file.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        content = json.dumps({"columns": frame.columns, "rows": frame.to_dicts()}, ensure_ascii=False, indent=2, default=str)
        return {"name": target.name, "format": "parquet-json", "content": content, "rows": frame.height, "columns": frame.columns}
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise WorkspaceItemError("This file is not UTF-8 text and cannot be opened in the editor.", HTTPStatus.UNSUPPORTED_MEDIA_TYPE) from error
    return {"name": target.name, "format": "text", "content": content}


def save_workspace_file(payload: dict[str, Any]) -> dict[str, str]:
    target, suffix = workspace_file_target(payload)
    content = payload.get("content")
    if not isinstance(content, str):
        raise WorkspaceItemError("File content must be text.")
    if len(content.encode("utf-8")) > WORKSPACE_EDITOR_MAX_BYTES:
        raise WorkspaceItemError("The edited file exceeds the 8 MB editor limit.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)

    temporary_path: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
        temporary_path = Path(temporary_name)
        if suffix in WORKSPACE_PARQUET_SUFFIXES:
            os.close(descriptor)
            try:
                import polars as pl
            except ImportError as error:
                raise RuntimeError("Parquet editing needs the project's Polars dependency. Run `uv sync` and restart Quantogral.") from error
            try:
                document = json.loads(content)
                columns, rows = document["columns"], document["rows"]
                original = pl.scan_parquet(target).limit(WORKSPACE_PARQUET_EDITOR_MAX_ROWS + 1).collect()
                if original.height > WORKSPACE_PARQUET_EDITOR_MAX_ROWS:
                    raise ValueError("The Parquet file exceeds the 5,000-row editor limit.")
                if columns != original.columns or not isinstance(rows, list) or len(rows) > WORKSPACE_PARQUET_EDITOR_MAX_ROWS:
                    raise ValueError("Keep the existing Parquet columns and use no more than 5,000 rows.")
                if any(not isinstance(row, dict) or set(row) != set(columns) for row in rows):
                    raise ValueError("Each Parquet row must contain exactly the file's existing columns.")
                frame = pl.DataFrame(rows, schema=original.schema, strict=True)
                frame.write_parquet(temporary_path)
            except Exception as error:
                raise WorkspaceItemError(f"Could not save Parquet rows: {error}") from error
        else:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output_file:
                output_file.write(content)
        os.chmod(temporary_path, target.stat().st_mode)
        os.replace(temporary_path, target)
    except WorkspaceItemError:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise
    except Exception as error:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise WorkspaceItemError(f"Could not save {target.name}: {error}", HTTPStatus.INTERNAL_SERVER_ERROR) from error
    return {"name": target.name, "path": str(target)}


def validate_item_name(raw_name: Any, allow_folder_suffix: bool) -> tuple[str, bool]:
    if not isinstance(raw_name, str) or not raw_name.strip():
        raise WorkspaceItemError("Enter a folder name ending in / or a filename with an extension.")
    raw_name = raw_name.strip()
    is_directory = allow_folder_suffix and raw_name.endswith("/")
    name = raw_name[:-1] if is_directory else raw_name
    if not name or name in {".", ".."} or "/" in name or "\\" in name or "\0" in name:
        raise WorkspaceItemError("Enter a single name, not a path.")
    if not is_directory and not Path(name).suffix:
        raise WorkspaceItemError("File names need an extension; folder names must end in /.")
    return name, is_directory


def create_workspace_item(payload: dict[str, Any]) -> dict[str, str]:
    root = workspace_root(payload.get("scope"))
    parent = safe_workspace_path(root, payload.get("directory", ""))
    if not parent.is_dir():
        raise WorkspaceItemError("Choose a folder to create the item in.")
    name, is_directory = validate_item_name(payload.get("name"), allow_folder_suffix=True)
    target = parent / name
    if target.exists() or target.is_symlink():
        raise WorkspaceItemError("An item with that name already exists.", HTTPStatus.CONFLICT)
    try:
        if is_directory:
            target.mkdir()
        else:
            with target.open("x", encoding="utf-8"):
                pass
    except FileExistsError as error:
        raise WorkspaceItemError("An item with that name already exists.", HTTPStatus.CONFLICT) from error
    return {"name": name, "type": "directory" if is_directory else "file"}


def rename_workspace_item(payload: dict[str, Any]) -> dict[str, str]:
    root = workspace_root(payload.get("scope"))
    relative_path = payload.get("path")
    source = safe_workspace_path(root, relative_path)
    if not isinstance(relative_path, str) or not relative_path or source == root or source.is_symlink():
        raise WorkspaceItemError("Choose a folder or file inside the workspace to rename.")
    parent = source.parent
    name, requested_directory = validate_item_name(payload.get("name"), allow_folder_suffix=False)
    is_directory = source.is_dir()
    if requested_directory or (is_directory and Path(name).suffix):
        raise WorkspaceItemError("Use a folder name without / to rename a folder.")
    if not is_directory and not Path(name).suffix:
        raise WorkspaceItemError("File names need an extension.")
    target = parent / name
    if target == source:
        return {"name": name, "type": "directory" if is_directory else "file"}
    if target.exists() or target.is_symlink():
        raise WorkspaceItemError("An item with that name already exists.", HTTPStatus.CONFLICT)
    try:
        source.rename(target)
    except FileExistsError as error:
        raise WorkspaceItemError("An item with that name already exists.", HTTPStatus.CONFLICT) from error
    return {"name": name, "type": "directory" if is_directory else "file"}


def runner_is_current() -> bool:
    if not RUNNER_BINARY.is_file():
        return False
    sources = [path for path in CPP_ROOT.rglob("*") if path.is_file() and path.suffix in {".hpp", ".cpp"}]
    return all(RUNNER_BINARY.stat().st_mtime_ns >= source.stat().st_mtime_ns for source in sources)


def compile_runner(selected_ids: list[str]) -> dict[str, Any]:
    supported_ids = {strategy["id"] for strategy in STRATEGY_CATALOG}
    if not selected_ids or any(strategy_id not in supported_ids for strategy_id in selected_ids):
        raise ValueError("Select at least one supported strategy.")

    compiler = shlex.split(os.environ.get("CXX", "c++"))
    if not compiler or shutil.which(compiler[0]) is None:
        raise RuntimeError("A C++20 compiler was not found. Install one or set the CXX environment variable.")

    BUILD_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    with BUILD_LOCK:
        with tempfile.NamedTemporaryFile(dir=BUILD_DIR, prefix="quantogral-backtest-", delete=False) as temporary_file:
            temporary_binary = Path(temporary_file.name)
        command = compiler + [
            "-std=c++20", "-O2", f"-I{CPP_ROOT / 'include'}",
            str(RUNNER_SOURCE), *(str(source) for source in CORE_SOURCES),
            "-o", str(temporary_binary),
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            temporary_binary.unlink(missing_ok=True)
            raise RuntimeError(f"Could not compile the C++ backtest engine: {error}") from error
        if result.returncode != 0:
            temporary_binary.unlink(missing_ok=True)
            detail = (result.stderr or result.stdout).strip()
            raise RuntimeError(f"C++ compilation failed.\n{detail[-12000:]}")
        temporary_binary.chmod(0o700)
        temporary_binary.replace(RUNNER_BINARY)

    return {"compiled": True, "current": True, "selected": selected_ids, "message": "C++ backtest engine compiled successfully."}


def get_strategy_catalog() -> list[dict[str, Any]]:
    if runner_is_current():
        try:
            result = subprocess.run([str(RUNNER_BINARY), "--catalog"], capture_output=True, text=True, timeout=10, check=True)
            catalog = json.loads(result.stdout).get("strategies", [])
            if catalog:
                return catalog
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            pass
    return STRATEGY_CATALOG


def resolve_data_file(raw_path: Any) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("Enter the path to an OHLCV CSV or Parquet file.")
    path = Path(raw_path.strip()).expanduser()
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    path = path.resolve()
    if path.suffix.lower() not in {".csv", ".parquet", ".pq"} or not path.is_file():
        raise ValueError("Choose an existing .csv, .parquet, or .pq market-data file.")
    return path


def prepare_parquet_csv(source: Path, destination: Path) -> None:
    """Convert a Parquet OHLCV table to the runner's timestamp/OHLCV CSV format."""
    try:
        import polars as pl
    except ImportError as error:
        raise RuntimeError("Parquet support needs the project's Python dependencies. Run `uv sync` and restart Quantogral.") from error

    frame = pl.read_parquet(source)
    if frame.width < 6:
        raise ValueError("Parquet data must contain at least six columns: timestamp, open, high, low, close, and volume.")

    aliases = {
        "timestamp": {"timestamp", "timestamps", "ts", "time", "date", "datetime", "epoch"},
        "open": {"open", "o"},
        "high": {"high", "h"},
        "low": {"low", "l"},
        "close": {"close", "c"},
        "volume": {"volume", "vol", "v"},
    }
    by_normalized_name = {"".join(character for character in name.lower() if character.isalnum()): name for name in frame.columns}
    selected_columns = []
    for canonical, names in aliases.items():
        original = next((by_normalized_name.get(name) for name in names if by_normalized_name.get(name)), None)
        if original is None:
            selected_columns = []
            break
        selected_columns.append(pl.col(original).alias(canonical))

    if selected_columns:
        frame = frame.select(selected_columns)
    else:
        frame = frame.select(frame.columns[:6]).rename(dict(zip(frame.columns[:6], ["timestamp", "open", "high", "low", "close", "volume"])))
    frame.write_csv(destination, include_header=True)


def run_backtest(payload: dict[str, Any]) -> dict[str, Any]:
    if not runner_is_current():
        raise RuntimeError("Compile the strategies from Builder settings before running a backtest.")
    if payload.get("strategyId") != "ma_cross":
        raise ValueError("This build currently supports Moving Average Cross only.")

    data_path = resolve_data_file(payload.get("dataPath"))
    base = payload.get("baseConfig", {})
    params = payload.get("parameters", {})
    backtest = payload.get("backtestConfig", {})
    def value(source: dict[str, Any], key: str, default: Any) -> Any:
        return source.get(key, default) if isinstance(source, dict) else default

    temporary_data = None
    runner_data_path = data_path
    if data_path.suffix.lower() in {".parquet", ".pq"}:
        temporary_data = tempfile.TemporaryDirectory(prefix="quantogral-parquet-", dir=BUILD_DIR)
        runner_data_path = Path(temporary_data.name) / "market_data.csv"
        try:
            prepare_parquet_csv(data_path, runner_data_path)
        except Exception:
            temporary_data.cleanup()
            raise

    arguments = [
        str(RUNNER_BINARY), "--run", str(runner_data_path),
        str(float(value(backtest, "initial_capital", 100000))), str(float(value(backtest, "cost_bps", 0))),
        *(str(bool(value(base, key, default))).lower() for key, default in (
            ("active", True), ("long_active", True), ("short_active", True), ("stacking", True),
        )),
        str(value(base, "ts_unit", "MILLISECONDS")), str(value(base, "date_format", "DDMMYYYY")),
        str(int(value(params, "fast_len", 10))), str(int(value(params, "slow_len", 30))),
        str(value(params, "fast_price_field", "CLOSE")), str(value(params, "slow_price_field", "CLOSE")),
        str(float(value(params, "slnot", -1))), str(float(value(params, "slpct", -1))),
        str(value(params, "pos_sizing_mode", "FIXED")), str(float(value(params, "qty", 1))),
        str(float(value(params, "equity_pct", 0.05))),
    ]
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=300, check=False)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("The C++ backtest exceeded the 5-minute time limit.") from error
    finally:
        if temporary_data is not None:
            temporary_data.cleanup()
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "C++ backtest failed.").strip()[-4000:])

    output = json.loads(result.stdout)
    equity = output.get("equityCurve", [])
    initial = float(value(backtest, "initial_capital", 100000))
    final = equity[-1] if equity else initial
    peak = initial
    max_drawdown = 0.0
    for point in equity:
        peak = max(peak, point)
        if peak > 0:
            max_drawdown = min(max_drawdown, point / peak - 1.0)
    output["metrics"] = {
        "initialEquity": initial,
        "finalEquity": final,
        "returnPct": ((final / initial) - 1.0) * 100.0 if initial else 0.0,
        "maxDrawdownPct": max_drawdown * 100.0,
        "orders": len(output.get("orders", [])),
    }
    return output


def run_yahoo_download_job(
    job_id: str, payload: dict[str, Any], *, overwrite_files: set[str] | None = None, initial_completed: int = 0,
) -> None:
    """Download each selected Yahoo instrument sequentially while publishing job progress."""
    destination = Path(payload["destination"]).expanduser()
    tickers = list(dict.fromkeys(item.strip() for item in payload["tickers"]))
    for offset, ticker in enumerate(tickers):
        index = initial_completed + offset + 1
        with YAHOO_DOWNLOAD_JOBS_LOCK:
            job = YAHOO_DOWNLOAD_JOBS[job_id]
            job["currentTicker"] = ticker
            job["status"] = f"Downloading {ticker} ({index} of {len(tickers)})"
        try:
            result = download_yahoo_history(
                ticker=ticker,
                interval=payload.get("interval"),
                start_date=payload.get("startDate"),
                end_date=payload.get("endDate"),
                file_format=payload.get("format"),
                destination=destination,
                filename_template=payload.get("filenameTemplate"),
                overwrite_filenames=overwrite_files,
            )
            with YAHOO_DOWNLOAD_JOBS_LOCK:
                job = YAHOO_DOWNLOAD_JOBS[job_id]
                job["results"].append(result)
        except DataAlreadyExistsError as error:
            with YAHOO_DOWNLOAD_JOBS_LOCK:
                job = YAHOO_DOWNLOAD_JOBS[job_id]
                job["conflicts"].append({"ticker": ticker, "filename": error.output_filename})
                job["needsConfirmation"] = True
                job["resumeTickers"] = tickers[offset:]
                job["finished"] = True
                job["currentTicker"] = None
                job["status"] = "Data already stored"
            return
        except Exception as error:
            with YAHOO_DOWNLOAD_JOBS_LOCK:
                job = YAHOO_DOWNLOAD_JOBS[job_id]
                job["errors"].append({"ticker": ticker, "error": str(error)})
        with YAHOO_DOWNLOAD_JOBS_LOCK:
            YAHOO_DOWNLOAD_JOBS[job_id]["completed"] = index

    with YAHOO_DOWNLOAD_JOBS_LOCK:
        job = YAHOO_DOWNLOAD_JOBS[job_id]
        job["finished"] = True
        job["currentTicker"] = None
        job["status"] = "Download finished"


class ConfigHandler(BaseHTTPRequestHandler):
    """Serve and update local workspace configuration."""

    def do_GET(self) -> None:  # noqa: N802
        parsed_path = urlparse(self.path)
        if parsed_path.path == "/api/health":
            self.send_json({"status": "ok"})
            return
        yahoo_job_prefix = "/api/data/yahoo/download/"
        if parsed_path.path.startswith(yahoo_job_prefix):
            job_id = parsed_path.path.removeprefix(yahoo_job_prefix)
            with YAHOO_DOWNLOAD_JOBS_LOCK:
                job = YAHOO_DOWNLOAD_JOBS.get(job_id)
                snapshot = ({key: value for key, value in job.items() if not key.startswith("_")}) if job else None
                if snapshot is not None:
                    snapshot["results"] = list(job["results"])
                    snapshot["errors"] = list(job["errors"])
            if snapshot is None:
                self.send_json({"error": "Yahoo Finance download job not found."}, HTTPStatus.NOT_FOUND)
            else:
                self.send_json(snapshot)
            return
        if parsed_path.path == "/api/data/yahoo/search":
            query = parse_qs(parsed_path.query).get("q", [""])[0]
            try:
                self.send_json({"results": search_yahoo_symbols(query)})
            except Exception as error:
                self.send_json({"error": f"Yahoo Finance symbol search failed: {error}"}, HTTPStatus.BAD_GATEWAY)
            return

        if parsed_path.path == "/api/workspace/file":
            query = parse_qs(parsed_path.query)
            try:
                self.send_json(read_workspace_file({"scope": query.get("scope", [""])[0], "path": query.get("path", [""])[0]}))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
            except RuntimeError as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if parsed_path.path == "/api/builder/tree":
            config, _ = read_config()
            configured_path = Path(config["builder"]["path"]).expanduser()
            builder_path = configured_path if configured_path.is_absolute() else PROJECT_ROOT / configured_path
            self.send_json({
                "children": scan_scripts(builder_path),
                "dataChildren": scan_data(PROJECT_ROOT / "data"),
            })
            return

        if self.path == "/api/strategies":
            self.send_json({"strategies": get_strategy_catalog()})
            return

        if self.path == "/api/compilation":
            current = runner_is_current()
            self.send_json({
                "compiled": RUNNER_BINARY.is_file(),
                "current": current,
                "strategies": get_strategy_catalog(),
                "message": "Engine is ready." if current else "Compile registered strategies to enable backtests.",
            })
            return

        if self.path != "/api/config":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        config, builder_configured = read_config()
        self.send_json({**config, "builderConfigured": builder_configured})

    def do_PUT(self) -> None:  # noqa: N802
        if self.path not in {"/api/config/builder", "/api/workspace/items", "/api/workspace/file"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length))
            if not isinstance(payload, dict):
                raise ValueError("Request body must be a JSON object.")
        except (AttributeError, json.JSONDecodeError, ValueError):
            self.send_json({"error": "Request body must be valid JSON."}, HTTPStatus.BAD_REQUEST)
            return

        if self.path == "/api/workspace/items":
            try:
                self.send_json(rename_workspace_item(payload))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
            except OSError as error:
                self.send_json({"error": f"Could not rename item: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if self.path == "/api/workspace/file":
            try:
                self.send_json(save_workspace_file(payload))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
            except RuntimeError as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        try:
            builder_path = payload["path"].strip()
        except (AttributeError, KeyError, TypeError, ValueError):
            self.send_json({"error": "path must be a non-empty string."}, HTTPStatus.BAD_REQUEST)
            return
        if not builder_path:
            self.send_json({"error": "path must be a non-empty string."}, HTTPStatus.BAD_REQUEST)
            return
        write_config(builder_path)
        self.send_json({"builder": {"path": builder_path}, "builderConfigured": True})

    def do_POST(self) -> None:  # noqa: N802
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length))
            if not isinstance(payload, dict):
                raise ValueError("Request body must be a JSON object.")
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Request body must be valid JSON."}, HTTPStatus.BAD_REQUEST)
            return

        if self.path == "/api/workspace/items":
            try:
                self.send_json(create_workspace_item(payload))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
            except OSError as error:
                self.send_json({"error": f"Could not create item: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if self.path == "/api/compilation":
            mode = payload.get("mode")
            if mode == "all":
                selected = [strategy["id"] for strategy in STRATEGY_CATALOG]
            elif mode == "selected":
                selected = payload.get("strategyIds", [])
            else:
                self.send_json({"error": "mode must be 'all' or 'selected'."}, HTTPStatus.BAD_REQUEST)
                return
            if not isinstance(selected, list) or any(not isinstance(item, str) for item in selected):
                self.send_json({"error": "strategyIds must be a list of strategy IDs."}, HTTPStatus.BAD_REQUEST)
                return
            try:
                self.send_json(compile_runner(selected))
            except ValueError as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except RuntimeError as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if self.path == "/api/backtests/run":
            try:
                self.send_json(run_backtest(payload))
            except ValueError as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except RuntimeError as error:
                self.send_json({"error": str(error)}, HTTPStatus.CONFLICT)
            except (OSError, json.JSONDecodeError, TypeError) as error:
                self.send_json({"error": f"Could not run backtest: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        overwrite_prefix = "/api/data/yahoo/download/"
        if self.path.startswith(overwrite_prefix) and self.path.endswith("/overwrite"):
            job_id = self.path[len(overwrite_prefix):-len("/overwrite")]
            with YAHOO_DOWNLOAD_JOBS_LOCK:
                job = YAHOO_DOWNLOAD_JOBS.get(job_id)
                if job is None or not job.get("needsConfirmation"):
                    self.send_json({"error": "There are no existing data files awaiting confirmation."}, HTTPStatus.CONFLICT)
                    return
                resume_payload = {**job["_payload"], "tickers": list(job["resumeTickers"])}
                initial_completed = job["completed"]
                approved_files = {item["filename"] for item in job["conflicts"]}
                job["needsConfirmation"] = False
                job["finished"] = False
                job["conflicts"] = []
                job["status"] = "Overwriting confirmed files…"
            thread = threading.Thread(
                target=run_yahoo_download_job,
                kwargs={"job_id": job_id, "payload": resume_payload, "overwrite_files": approved_files, "initial_completed": initial_completed},
                daemon=True,
            )
            thread.start()
            self.send_json({"jobId": job_id}, HTTPStatus.ACCEPTED)
            return

        if self.path == "/api/data/yahoo/download":
            try:
                tickers = payload.get("tickers")
                if not isinstance(tickers, list) or not tickers or any(not isinstance(item, str) or not item.strip() for item in tickers):
                    raise ValueError("Choose at least one Yahoo Finance instrument.")
                destination_value = payload.get("destination")
                if not isinstance(destination_value, str) or not destination_value.strip():
                    raise ValueError("Choose a destination folder.")
                destination_path = Path(destination_value.strip()).expanduser()
                if not destination_path.is_absolute():
                    destination_path = PROJECT_ROOT / destination_path
                destination_path = destination_path.resolve(strict=True)
                if not destination_path.is_dir():
                    raise ValueError("Choose an existing destination folder.")
                unique_tickers = list(dict.fromkeys(item.strip() for item in tickers))
                job_id = uuid.uuid4().hex
                with YAHOO_DOWNLOAD_JOBS_LOCK:
                    YAHOO_DOWNLOAD_JOBS[job_id] = {
                        "jobId": job_id,
                        "completed": 0,
                        "total": len(unique_tickers),
                        "currentTicker": None,
                        "status": "Starting download…",
                        "finished": False,
                        "results": [],
                        "errors": [],
                        "conflicts": [],
                        "needsConfirmation": False,
                        "_payload": {**payload, "tickers": unique_tickers, "destination": str(destination_path)},
                    }
                thread = threading.Thread(
                    target=run_yahoo_download_job,
                    args=(job_id, {**payload, "tickers": unique_tickers, "destination": str(destination_path)}),
                    daemon=True,
                )
                thread.start()
                self.send_json({"jobId": job_id}, HTTPStatus.ACCEPTED)
            except FileExistsError as error:
                self.send_json({"error": str(error)}, HTTPStatus.CONFLICT)
            except ValueError as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except RuntimeError as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
            except OSError as error:
                self.send_json({"error": f"Could not access the download destination: {error}"}, HTTPStatus.BAD_REQUEST)
            return

        self.send_error(HTTPStatus.NOT_FOUND)

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
