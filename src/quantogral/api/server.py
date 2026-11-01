"""Minimal local API for persistent Quantogral workspace settings."""

from __future__ import annotations

import json
import os
import re
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

STRATEGY_ROOT = CPP_ROOT / "include" / "builder" / "strategies"
GENERATED_REGISTRY = BUILD_DIR / "quantogral_strategy_registry.generated.hpp"


def discover_strategy_headers() -> dict[str, Path]:
    """Find conventional OHLCV strategy classes and derive their configs from C++ fields."""
    found: dict[str, Path] = {}
    strategy_class = re.compile(r"class\s+([A-Za-z_]\w*)\s*:\s*public\s+Strategy\s*<\s*OHLCVEvent\s*>")
    if not STRATEGY_ROOT.is_dir():
        return found
    for header in sorted(STRATEGY_ROOT.rglob("*.hpp")):
        if header.is_symlink() or "strategy_base.hpp" == header.name or "strategy_registry.hpp" == header.name:
            continue
        try:
            source = header.read_text(encoding="utf-8")
        except OSError:
            continue
        match = strategy_class.search(source)
        if not match:
            continue
        identifier = re.sub(r"[^a-zA-Z0-9_]+", "_", header.stem).strip("_").lower()
        if identifier in found:
            raise RuntimeError(f"Duplicate strategy ID '{identifier}' in {header} and {found[identifier]}.")
        found[identifier] = header
    return found


def eligible_strategy_headers() -> dict[str, Path]:
    """Return complete strategies; an in-progress or unsupported header won't break the app."""
    eligible = {}
    for identifier, header in discover_strategy_headers().items():
        source = header.read_text(encoding="utf-8")
        match = re.search(r"class\s+([A-Za-z_]\w*)\s*:\s*public\s+Strategy\s*<\s*OHLCVEvent\s*>", source)
        try:
            _strategy_config_fields(source, match.group(1), header)
        except (RuntimeError, ValueError):
            continue
        eligible[identifier] = header
    return eligible


def _matching_brace(source: str, opening: int) -> int:
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return index
    raise RuntimeError("Unclosed C++ brace while reading strategy configuration.")


def _strategy_config_fields(source: str, class_name: str, header: Path) -> list[dict[str, Any]]:
    class_match = re.search(rf"class\s+{re.escape(class_name)}\s*:\s*public\s+Strategy\s*<\s*OHLCVEvent\s*>", source)
    if not class_match:
        raise RuntimeError(f"{header.name}: could not locate the strategy class body.")
    class_start = source.find("{", class_match.start())
    class_body = source[class_start + 1:_matching_brace(source, class_start)]
    alias = re.search(r"\busing\s+Config\s*=\s*([A-Za-z_]\w*)\s*;", class_body)
    if not alias:
        raise RuntimeError(f"{header.name}: strategy must expose `using Config = YourConfigType;`.")
    config_type = alias.group(1)
    config_start_match = re.search(rf"\bstruct\s+{re.escape(config_type)}\s*\{{", source)
    if not config_start_match:
        raise RuntimeError(f"{header.name}: could not find the config struct `{config_type}`.")
    config_start = source.find("{", config_start_match.start())
    config_body = source[config_start + 1:_matching_brace(source, config_start)]
    enum_types: dict[str, list[str]] = {}
    for enum_match in re.finditer(r"enum\s+class\s+([A-Za-z_]\w*)[^\{]*\{([^}]*)\}", "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in (CPP_ROOT / "include").rglob("*.hpp"))):
        enum_types[enum_match.group(1)] = [part.strip().split("=")[0].strip() for part in enum_match.group(2).split(",") if part.strip()]
    fields: list[dict[str, Any]] = []
    cpp_type_pattern = r"(?:unsigned\s+int|long\s+double|long\s+long|unsigned|short|int|long|float|double|bool|size_t|std::size_t|std::string|[A-Za-z_]\w*(?:::\w+)*)"
    field_pattern = re.compile(rf"^\s*({cpp_type_pattern})\s+([A-Za-z_]\w*)\s*=\s*(.+?)\s*$", re.S)
    declarations = re.split(r";", re.sub(r"/\*.*?\*/|//[^\n]*", "", config_body, flags=re.S))
    for declaration in declarations:
        if not declaration.strip() or declaration.lstrip().startswith("static_assert"):
            continue
        field = field_pattern.match(declaration)
        if not field:
            raise RuntimeError(f"{header.name}: config fields need a simple type, name, and default initializer: {declaration.strip()}")
        cpp_type, key, default_expr = field.groups()
        default_expr = default_expr.strip()
        enum_name = cpp_type.split("::")[-1]
        if enum_name in enum_types:
            options = enum_types[enum_name]
            default = default_expr.split("::")[-1]
            if default not in options:
                raise RuntimeError(f"{header.name}: `{key}` has an enum default not found in {enum_name}.")
            field_type = "select"
        elif cpp_type == "bool":
            if default_expr.lower() not in {"true", "false"}:
                raise RuntimeError(f"{header.name}: `{key}` boolean defaults must be `true` or `false`.")
            options, field_type, default = None, "boolean", default_expr.lower() == "true"
        elif cpp_type in {"std::string", "string"}:
            options, field_type = None, "text"
            try:
                default = json.loads(default_expr)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"{header.name}: `{key}` string defaults must use a quoted literal.") from error
        elif cpp_type in {"float", "double", "long double"}:
            options, field_type = None, "number"
            default = float(default_expr.rstrip("fFlL"))
        elif cpp_type in {"short", "int", "long", "long long", "std::int8_t", "std::int16_t", "std::int32_t", "std::int64_t", "std::uint8_t", "std::uint16_t", "std::uint32_t", "std::uint64_t", "unsigned", "unsigned int", "size_t", "std::size_t"}:
            options, field_type = None, "number"
            default = int(default_expr.rstrip("uUlL"), 0)
        else:
            raise RuntimeError(f"{header.name}: automatic settings support bool, numeric, string, and enum fields; `{key}` uses `{cpp_type}`.")
        item: dict[str, Any] = {"key": key, "type": field_type, "default": default, "_cppType": cpp_type}
        if options is not None:
            item["options"] = options
        fields.append(item)
    return fields


def write_generated_registry(headers: list[Path]) -> None:
    BUILD_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    all_headers = "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in (CPP_ROOT / "include").rglob("*.hpp"))
    enums: dict[str, list[str]] = {}
    for match in re.finditer(r"enum\s+class\s+([A-Za-z_]\w*)[^\{]*\{([^}]*)\}", all_headers):
        enums[match.group(1)] = [part.strip().split("=")[0].strip() for part in match.group(2).split(",") if part.strip()]
    output = ["#pragma once", "#include <memory>", "#include <string>", "#include <stdexcept>", "#include \"builder/strategies/strategy_registry.hpp\""]
    for header in headers:
        output.append(f'#include "{header.relative_to(CPP_ROOT / "include").as_posix()}"')
    for identifier, header in ((re.sub(r"[^a-zA-Z0-9_]+", "_", path.stem).strip("_").lower(), path) for path in headers):
        source = header.read_text(encoding="utf-8")
        class_match = re.search(r"class\s+([A-Za-z_]\w*)\s*:\s*public\s+Strategy\s*<\s*OHLCVEvent\s*>", source)
        class_name = class_match.group(1)
        fields = _strategy_config_fields(source, class_name, header)
        config_alias = re.search(r"\busing\s+Config\s*=\s*([A-Za-z_]\w*)\s*;", source[source.find("{", class_match.start()):_matching_brace(source, source.find("{", class_match.start()))])
        config_type = config_alias.group(1)
        safe_id = re.sub(r"\W", "_", identifier)
        factory = [f"inline std::unique_ptr<Strategy<OHLCVEvent>> qg_create_{safe_id}(const quantogral::StrategyValues& values) {{", f"    {config_type} config{{}};"]
        for item in fields:
            key = item["key"]
            cpp_type = item.get("_cppType", "")
            if item["type"] == "boolean":
                factory.append(f'    config.{key} = quantogral::parse_bool_value(values, "{key}", {"true" if item["default"] else "false"});')
            elif item["type"] == "number":
                parse_fn = "std::stod" if any(t in cpp_type for t in ("float", "double")) else "std::stoll"
                factory.append(f'    config.{key} = static_cast<decltype(config.{key})>({parse_fn}(quantogral::value_or(values, "{key}", "{item["default"]}")));')
            elif item["type"] == "text":
                factory.append(f'    config.{key} = quantogral::value_or(values, "{key}", {json.dumps(item["default"])});')
            else:
                enum_type = cpp_type
                factory.append(f'    const auto qg_{key} = quantogral::value_or(values, "{key}", "{item["default"]}");')
                for option_index, option in enumerate(enums[enum_type.split("::")[-1]]):
                    branch = "if" if option_index == 0 else "else if"
                    factory.append(f'    {branch} (qg_{key} == "{option}") config.{key} = {enum_type}::{option};')
                factory.append(f'    else throw std::invalid_argument("Unsupported value for {key}: " + qg_{key});')
        factory.extend([f'    return std::make_unique<{class_name}>(config, quantogral::make_base_config(values));', "}"])
        output.extend(factory)
        output.append(f'namespace {{ const bool qg_registered_{safe_id} = [] {{ quantogral::register_strategy({{"{identifier}", &qg_create_{safe_id}}}); return true; }}(); }}')
    GENERATED_REGISTRY.write_text("\n".join(output) + "\n", encoding="utf-8")


def strategy_catalog_from_headers() -> list[dict[str, Any]]:
    catalog = []
    base_fields = [
        {"key": "active", "type": "boolean", "default": True},
        {"key": "long_active", "type": "boolean", "default": True},
        {"key": "short_active", "type": "boolean", "default": True},
        {"key": "stacking", "type": "boolean", "default": True},
        {"key": "ts_unit", "type": "select", "default": "MILLISECONDS", "options": ["SECONDS", "MILLISECONDS", "MICROSECONDS", "NANOSECONDS"]},
        {"key": "date_format", "type": "select", "default": "DDMMYYYY", "options": ["DDMMYYYY", "MMDDYYYY"]},
    ]
    for identifier, header in eligible_strategy_headers().items():
        source = header.read_text(encoding="utf-8")
        class_match = re.search(r"class\s+([A-Za-z_]\w*)\s*:\s*public\s+Strategy\s*<\s*OHLCVEvent\s*>", source)
        fields = _strategy_config_fields(source, class_match.group(1), header)
        catalog.append({
            "id": identifier,
            "name": " ".join(word.capitalize() for word in identifier.split("_")),
            "file": header.relative_to(STRATEGY_ROOT.parent).as_posix(),
            "input": "OHLCV",
            "baseConfig": base_fields,
            "parameters": [{key: value for key, value in field.items() if not key.startswith("_")} for field in fields],
        })
    return catalog


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
    sources += list(STRATEGY_ROOT.rglob("*.hpp")) if STRATEGY_ROOT.is_dir() else []
    sources.extend((GENERATED_REGISTRY, Path(__file__)))
    return GENERATED_REGISTRY.is_file() and all(RUNNER_BINARY.stat().st_mtime_ns >= source.stat().st_mtime_ns for source in sources)


def compile_runner(selected_ids: list[str]) -> dict[str, Any]:
    available = eligible_strategy_headers()
    supported_ids = set(available)
    if not selected_ids or len(set(selected_ids)) != len(selected_ids) or any(strategy_id not in supported_ids for strategy_id in selected_ids):
        raise ValueError("Select at least one discovered C++ strategy.")

    compiler = shlex.split(os.environ.get("CXX", "c++"))
    if not compiler or shutil.which(compiler[0]) is None:
        raise RuntimeError("A C++20 compiler was not found. Install one or set the CXX environment variable.")

    BUILD_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    with BUILD_LOCK:
        write_generated_registry([available[strategy_id] for strategy_id in selected_ids])
        with tempfile.NamedTemporaryFile(dir=BUILD_DIR, prefix="quantogral-backtest-", delete=False) as temporary_file:
            temporary_binary = Path(temporary_file.name)
        command = compiler + [
            "-std=c++20", "-O2", f"-I{CPP_ROOT / 'include'}", f"-I{BUILD_DIR}",
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
    return strategy_catalog_from_headers()


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
    backtest = payload.get("backtestConfig", {})
    def value(source: dict[str, Any], key: str, default: Any) -> Any:
        return source.get(key, default) if isinstance(source, dict) else default

    buckets = payload.get("buckets")
    if buckets is None and payload.get("strategyId"):
        # Keep older local clients working while they refresh to the bucket UI.
        buckets = [{
            "id": "bucket-1",
            "feeds": [{"id": "feed-1", "path": payload.get("dataPath")}],
            "strategies": [{
                "instanceId": "strategy-1", "strategyId": payload.get("strategyId"), "feedIds": ["feed-1"],
                "baseConfig": payload.get("baseConfig", {}), "parameters": payload.get("parameters", {}),
            }],
        }]
    if not isinstance(buckets, list) or not buckets:
        raise ValueError("Add at least one complete bucket with a strategy and data feed.")
    initial_capital = float(value(backtest, "initial_capital", 100000))
    cost_bps = float(value(backtest, "cost_bps", 0))
    allocation_mode = value(backtest, "capital_allocation", "SHARED")
    if allocation_mode not in {"SHARED", "EQUAL_PER_STRATEGY"}:
        raise ValueError("Capital allocation must be SHARED or EQUAL_PER_STRATEGY.")
    strategy_catalog = {item["id"]: item for item in strategy_catalog_from_headers()}

    arguments = [str(RUNNER_BINARY), "--run-plan", str(initial_capital), str(cost_bps), allocation_mode, "0", str(len(buckets))]
    temp_dirs: list[Any] = []
    prepared_buckets: list[dict[str, Any]] = []
    instance_ids: set[str] = set()
    bucket_ids: set[str] = set()
    try:
        for bucket_index, raw_bucket in enumerate(buckets):
            if not isinstance(raw_bucket, dict):
                raise ValueError("Every backtest bucket must be an object.")
            bucket_id = raw_bucket.get("id")
            feeds = raw_bucket.get("feeds")
            strategies = raw_bucket.get("strategies")
            if not isinstance(bucket_id, str) or not bucket_id.strip():
                raise ValueError("Every backtest bucket needs an ID.")
            if bucket_id in bucket_ids:
                raise ValueError("Bucket IDs must be unique across the backtest plan.")
            bucket_ids.add(bucket_id)
            if not isinstance(feeds, list) or not feeds or not isinstance(strategies, list) or not strategies:
                raise ValueError(f"Bucket {bucket_id} needs at least one feed and one strategy.")
            arguments.extend([bucket_id, str(len(feeds))])
            prepared_feeds = []
            feed_ids: set[str] = set()
            for feed_index, feed in enumerate(feeds):
                if not isinstance(feed, dict):
                    raise ValueError(f"Bucket {bucket_id} has an invalid data feed.")
                feed_id = feed.get("id")
                if not isinstance(feed_id, str) or not feed_id.strip() or feed_id in feed_ids:
                    raise ValueError(f"Bucket {bucket_id} data feed IDs must be non-empty and unique.")
                feed_ids.add(feed_id)
                data_path = resolve_data_file(feed.get("path"))
                runner_data_path = data_path
                if data_path.suffix.lower() in {".parquet", ".pq"}:
                    temp_dir = tempfile.TemporaryDirectory(prefix="quantogral-parquet-", dir=BUILD_DIR)
                    temp_dirs.append(temp_dir)
                    runner_data_path = Path(temp_dir.name) / f"feed-{feed_index}.csv"
                    prepare_parquet_csv(data_path, runner_data_path)
                ts_unit = feed.get("tsUnit", "MILLISECONDS")
                date_format = feed.get("dateFormat", "DDMMYYYY")
                if ts_unit not in {"SECONDS", "MILLISECONDS", "MICROSECONDS", "NANOSECONDS"}:
                    raise ValueError(f"Feed {feed_id} has an unsupported timestamp unit.")
                if date_format not in {"DDMMYYYY", "MMDDYYYY"}:
                    raise ValueError(f"Feed {feed_id} has an unsupported date format.")
                arguments.extend([feed_id, str(runner_data_path), ts_unit, date_format])
                prepared_feeds.append({"id": feed_id, "path": str(data_path), "name": data_path.name, "tsUnit": ts_unit, "dateFormat": date_format})

            arguments.append(str(len(strategies)))
            prepared_strategies = []
            for strategy in strategies:
                if not isinstance(strategy, dict):
                    raise ValueError(f"Bucket {bucket_id} contains an invalid strategy instance.")
                instance_id = strategy.get("instanceId")
                strategy_id = strategy.get("strategyId")
                connected_feeds = strategy.get("feedIds")
                if not isinstance(instance_id, str) or not instance_id.strip() or instance_id in instance_ids:
                    raise ValueError("Strategy instance IDs must be non-empty and unique across the plan.")
                instance_ids.add(instance_id)
                if not isinstance(strategy_id, str) or not strategy_id.strip():
                    raise ValueError(f"Strategy instance {instance_id} has no strategy type.")
                if not isinstance(connected_feeds, list) or not connected_feeds or any(not isinstance(feed_id, str) or feed_id not in feed_ids for feed_id in connected_feeds):
                    raise ValueError(f"Strategy instance {instance_id} must connect to at least one feed in its bucket.")
                base = strategy.get("baseConfig", {})
                params = strategy.get("parameters", {})
                values = {**(base if isinstance(base, dict) else {}), **(params if isinstance(params, dict) else {})}
                arguments.extend([instance_id, strategy_id, str(len(connected_feeds)), *connected_feeds, str(len(values))])
                for key, item in values.items():
                    if not isinstance(key, str) or not key or "=" in key:
                        raise ValueError(f"Strategy instance {instance_id} has an invalid config field name.")
                    if isinstance(item, bool):
                        item = str(item).lower()
                    arguments.append(f"{key}={item}")
                strategy_meta = strategy_catalog.get(strategy_id)
                if strategy_meta is None:
                    raise ValueError(f"Strategy {strategy_id} is not a supported OHLCV strategy.")
                prepared_strategies.append({"instanceId": instance_id, "strategyId": strategy_id, "name": strategy_meta["name"]})
            prepared_buckets.append({"id": bucket_id, "feeds": prepared_feeds, "strategies": prepared_strategies})

        try:
            result = subprocess.run(arguments, capture_output=True, text=True, timeout=300, check=False)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("The C++ backtest exceeded the 5-minute time limit.") from error
        if result.returncode != 0:
            raise RuntimeError((result.stderr or "C++ backtest failed.").strip()[-4000:])
        output = json.loads(result.stdout)
    finally:
        for temp_dir in temp_dirs:
            temp_dir.cleanup()

    output_buckets = output.get("buckets", [])
    for bucket_index, bucket in enumerate(output_buckets):
        bucket["feeds"] = prepared_buckets[bucket_index]["feeds"]
        strategy_metadata = {item["instanceId"]: item for item in prepared_buckets[bucket_index]["strategies"]}
        for strategy in bucket.get("strategies", []):
            metadata = strategy_metadata[strategy["instanceId"]]
            strategy["strategyId"] = metadata["strategyId"]
            strategy["name"] = metadata["name"]
        equity = bucket.get("equityCurve", [])
        peak = initial_capital
        max_drawdown = 0.0
        for point in equity:
            peak = max(peak, point)
            if peak > 0:
                max_drawdown = min(max_drawdown, point / peak - 1.0)
        bucket["metrics"] = {
            "initialEquity": initial_capital,
            "finalEquity": equity[-1] if equity else initial_capital,
            "returnPct": (((equity[-1] if equity else initial_capital) / initial_capital) - 1.0) * 100.0 if initial_capital else 0.0,
            "maxDrawdownPct": max_drawdown * 100.0,
            "orders": sum(len(strategy.get("orders", [])) for strategy in bucket.get("strategies", [])),
        }
    output["inputRows"] = int(output.get("inputRows", 0))
    output["buckets"] = output_buckets
    initial_total = initial_capital * len(output_buckets)
    aggregate_values: dict[int, list[tuple[int, float]]] = {}
    orders = []
    for bucket_index, bucket in enumerate(output_buckets):
        for timestamp, equity in zip(bucket.get("equityTimestamps", []), bucket.get("equityCurve", [])):
            aggregate_values.setdefault(timestamp, []).append((bucket_index, equity))
        for strategy in bucket.get("strategies", []):
            for order in strategy.get("orders", []):
                orders.append({**order, "bucketId": bucket["id"], "instanceId": strategy["instanceId"], "strategyId": strategy["strategyId"], "strategyName": strategy["name"]})
    current_equities = [initial_capital] * len(output_buckets)
    aggregate_curve = []
    aggregate_timestamps = []
    for timestamp in sorted(aggregate_values):
        for bucket_index, equity in aggregate_values[timestamp]:
            current_equities[bucket_index] = equity
        aggregate_timestamps.append(timestamp)
        aggregate_curve.append(sum(current_equities))
    orders.sort(key=lambda order: (order["timestamp"], order["bucketId"], order["instanceId"], order["id"]))
    peak = initial_total
    max_drawdown = 0.0
    for point in aggregate_curve:
        peak = max(peak, point)
        if peak > 0:
            max_drawdown = min(max_drawdown, point / peak - 1.0)
    final_total = aggregate_curve[-1] if aggregate_curve else initial_total
    output["equityCurve"] = aggregate_curve
    output["equityTimestamps"] = aggregate_timestamps
    output["orders"] = orders
    output["metrics"] = {
        "initialEquity": initial_total,
        "finalEquity": final_total,
        "returnPct": ((final_total / initial_total) - 1.0) * 100.0 if initial_total else 0.0,
        "maxDrawdownPct": max_drawdown * 100.0,
        "orders": len(orders),
    }
    return output
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
                file_format=payload.get("format") or "parquet",
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
            try:
                self.send_json({"strategies": get_strategy_catalog()})
            except (RuntimeError, ValueError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if self.path == "/api/compilation":
            try:
                current = runner_is_current()
                self.send_json({
                    "compiled": RUNNER_BINARY.is_file(),
                    "current": current,
                    "strategies": get_strategy_catalog(),
                    "message": "Engine is ready." if current else "Compile discovered strategies to enable backtests.",
                })
            except (RuntimeError, ValueError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
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
                selected = list(eligible_strategy_headers())
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
