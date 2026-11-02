"""Minimal local API for persistent Quantogral workspace settings."""

from __future__ import annotations

import csv
import json
import math
import os
import re
import shlex
import shutil
import statistics
import subprocess
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from quantogral.data.providers.yfinance import DataAlreadyExistsError, download_yahoo_history, search_yahoo_symbols

DEFAULT_BUILDER_PATH = "./cpp/include/builder"
DEFAULT_SIMPLE_BACKTEST_SETTINGS = {
    "initial_capital": 100000,
    "cost_bps": 0,
    "fill_latency_seconds": 0,
    "capital_allocation": "SHARED",
    "bucket_capital_mode": "SHARED",
    "run_mode": "BOTH",
    "base_currency": "USD",
    "ignore_currency": False,
}
DEFAULT_GRID_SEARCH_SETTINGS: dict[str, Any] = {}
PROJECT_ROOT = Path(os.environ.get("QUANTOGRAL_ROOT", Path(__file__).resolve().parents[3]))
CONFIG_PATH = PROJECT_ROOT / ".quantogral" / "config.json"
DATASET_SETTINGS_PATH = PROJECT_ROOT / ".quantogral" / "dataset-settings.json"
STRATEGY_PRESETS_PATH = PROJECT_ROOT / ".quantogral" / "strategy-presets.json"
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
    """Find FeedEvent strategy classes and derive their configs from C++ fields."""
    found: dict[str, Path] = {}
    strategy_class = re.compile(r"class\s+([A-Za-z_]\w*)\s*:\s*public\s+Strategy\s*<\s*FeedEvent\s*>")
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
        match = re.search(r"class\s+([A-Za-z_]\w*)\s*:\s*public\s+Strategy\s*<\s*FeedEvent\s*>", source)
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
    class_match = re.search(rf"class\s+{re.escape(class_name)}\s*:\s*public\s+Strategy\s*<\s*FeedEvent\s*>", source)
    if not class_match:
        raise RuntimeError(f"{header.name}: could not locate the strategy class body.")
    class_start = source.find("{", class_match.start())
    class_body = source[class_start + 1:_matching_brace(source, class_start)]
    alias = re.search(r"\busing\s+Config\s*=\s*([A-Za-z_]\w*)\s*;", class_body)
    if not alias:
        raise RuntimeError(f"{header.name}: strategy must expose `using Config = YourConfigType;`.")
    config_type = alias.group(1)
    all_headers = "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in (CPP_ROOT / "include").rglob("*.hpp"))
    config_source = source + "\n" + all_headers
    config_start_match = re.search(rf"\bstruct\s+{re.escape(config_type)}\s*{{", config_source)
    if not config_start_match:
        raise RuntimeError(f"{header.name}: could not find the config struct `{config_type}`.")
    config_start = config_source.find("{", config_start_match.start())
    config_body = config_source[config_start + 1:_matching_brace(config_source, config_start)]
    enum_types: dict[str, list[str]] = {}
    for enum_match in re.finditer(r"enum\s+class\s+([A-Za-z_]\w*)[^\{]*\{([^}]*)\}", all_headers):
        enum_types[enum_match.group(1)] = [part.strip().split("=")[0].strip() for part in enum_match.group(2).split(",") if part.strip()]
    struct_bodies: dict[str, str] = {}
    for struct_match in re.finditer(r"\bstruct\s+([A-Za-z_]\w*)\s*\{", all_headers):
        struct_start = all_headers.find("{", struct_match.start())
        struct_bodies[struct_match.group(1)] = all_headers[struct_start + 1:_matching_brace(all_headers, struct_start)]
    cpp_type_pattern = r"(?:unsigned\s+int|long\s+double|long\s+long|unsigned|short|int|long|float|double|bool|size_t|std::size_t|std::string|[A-Za-z_]\w*(?:::\w*)*)"
    field_pattern = re.compile(rf"^\s*({cpp_type_pattern})\s+([A-Za-z_]\w*)\s*=\s*(.+?)\s*$", re.S)
    fields: list[dict[str, Any]] = []

    def parse_fields(body: str, key_prefix: str = "", cpp_prefix: str = "", group: str | None = None, struct_name: str | None = None) -> None:
        declarations = re.split(r";", re.sub(r"/\*.*?\*/|//[^\n]*", "", body, flags=re.S))
        for declaration in declarations:
            declaration = declaration.strip()
            if not declaration or declaration.startswith("static_assert"):
                continue
            nested = re.match(r"^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*=\s*\{\s*\}$", declaration)
            if nested and nested.group(1) in struct_bodies:
                nested_type, nested_key = nested.groups()
                nested_group = group or re.sub(r"Config$", "", re.sub(r"(?<!^)([A-Z])", r" \1", nested_type)).strip()
                nested_key_path = f"{key_prefix}.{nested_key}" if key_prefix else nested_key
                nested_cpp_path = f"{cpp_prefix}.{nested_key}" if cpp_prefix else nested_key
                parse_fields(struct_bodies[nested_type], nested_key_path, nested_cpp_path, nested_group, nested_type)
                continue
            field = field_pattern.match(declaration)
            if not field:
                raise RuntimeError(f"{header.name}: config fields need simple fields or default-initialized nested config structs: {declaration}")
            cpp_type, key, default_expr = field.groups()
            default_expr = default_expr.strip()
            full_key = f"{key_prefix}.{key}" if key_prefix else key
            cpp_path = f"{cpp_prefix}.{key}" if cpp_prefix else key
            enum_name = cpp_type.split("::")[-1]
            if enum_name in enum_types:
                options = enum_types[enum_name]
                default = default_expr.split("::")[-1]
                if default not in options:
                    raise RuntimeError(f"{header.name}: `{full_key}` has an enum default not found in {enum_name}.")
                field_type = "select"
            elif cpp_type == "bool":
                if default_expr.lower() not in {"true", "false"}:
                    raise RuntimeError(f"{header.name}: `{full_key}` boolean defaults must be `true` or `false`.")
                options, field_type, default = None, "boolean", default_expr.lower() == "true"
            elif cpp_type in {"std::string", "string"}:
                options, field_type = None, "text"
                try:
                    default = json.loads(default_expr)
                except json.JSONDecodeError as error:
                    raise RuntimeError(f"{header.name}: `{full_key}` string defaults must use a quoted literal.") from error
            elif cpp_type in {"float", "double", "long double"}:
                options, field_type = None, "number"
                default = float(default_expr.rstrip("fFlL"))
            elif cpp_type in {"short", "int", "long", "long long", "std::int8_t", "std::int16_t", "std::int32_t", "std::uint8_t", "std::uint16_t", "std::uint32_t", "std::uint64_t", "unsigned", "unsigned int", "size_t", "std::size_t"}:
                options, field_type = None, "number"
                default = int(default_expr.rstrip("uUlL"), 0)
            else:
                raise RuntimeError(f"{header.name}: automatic settings support bool, numeric, string, enum, and nested config fields; `{full_key}` uses `{cpp_type}.")
            item: dict[str, Any] = {"key": full_key, "type": field_type, "default": default, "_cppType": cpp_type, "_cppPath": cpp_path}
            if group:
                item["group"] = group
                item["label"] = key
            if options is not None:
                item["options"] = options
            if struct_name == "SizingConfig" and key == "qty":
                item["visibleWhen"] = {"key": f"{key_prefix}.mode", "values": ["FIXED"]}
            elif struct_name == "SizingConfig" and key == "equity_pct":
                item["visibleWhen"] = {"key": f"{key_prefix}.mode", "values": ["FIXED_FRACTIONAL_PRICE", "FIXED_FRACTIONAL_SL"]}
            fields.append(item)

    parse_fields(config_body)
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
        class_match = re.search(r"class\s+([A-Za-z_]\w*)\s*:\s*public\s+Strategy\s*<\s*FeedEvent\s*>", source)
        class_name = class_match.group(1)
        fields = _strategy_config_fields(source, class_name, header)
        config_alias = re.search(r"\busing\s+Config\s*=\s*([A-Za-z_]\w*)\s*;", source[source.find("{", class_match.start()):_matching_brace(source, source.find("{", class_match.start()))])
        config_type = config_alias.group(1)
        safe_id = re.sub(r"\W", "_", identifier)
        factory = [f"inline std::unique_ptr<Strategy<FeedEvent>> qg_create_{safe_id}(const quantogral::StrategyValues& values) {{", f"    {config_type} config{{}};"]
        for item in fields:
            key = item["key"]
            cpp_path = item.get("_cppPath", key)
            safe_key = re.sub(r"\W", "_", key)
            cpp_type = item.get("_cppType", "")
            if item["type"] == "boolean":
                factory.append(f'    config.{cpp_path} = quantogral::parse_bool_value(values, "{key}", {"true" if item["default"] else "false"});')
            elif item["type"] == "number":
                parse_fn = "parse_number_value" if any(t in cpp_type for t in ("float", "double")) else "parse_integer_value"
                factory.append(f'    config.{cpp_path} = static_cast<decltype(config.{cpp_path})>(quantogral::{parse_fn}(values, "{key}", "{item["default"]}"));')
            elif item["type"] == "text":
                factory.append(f'    config.{cpp_path} = quantogral::value_or(values, "{key}", {json.dumps(item["default"])});')
            else:
                enum_type = cpp_type
                factory.append(f'    const auto qg_{safe_key} = quantogral::value_or(values, "{key}", "{item["default"]}");')
                for option_index, option in enumerate(enums[enum_type.split("::")[-1]]):
                    branch = "if" if option_index == 0 else "else if"
                    factory.append(f'    {branch} (qg_{safe_key} == "{option}") config.{cpp_path} = {enum_type}::{option};')
                factory.append(f'    else throw std::invalid_argument("Unsupported value for {key}: " + qg_{safe_key});')
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
        class_match = re.search(r"class\s+([A-Za-z_]\w*)\s*:\s*public\s+Strategy\s*<\s*FeedEvent\s*>", source)
        fields = _strategy_config_fields(source, class_match.group(1), header)
        catalog.append({
            "id": identifier,
            "name": " ".join(word.capitalize() for word in identifier.split("_")),
            "file": header.relative_to(STRATEGY_ROOT.parent).as_posix(),
            "input": "Multi-event",
            "baseConfig": base_fields,
            "parameters": [{key: value for key, value in field.items() if not key.startswith("_")} for field in fields],
        })
    return catalog


def read_config() -> tuple[dict[str, Any], bool]:
    """Return local workspace plus settings isolated by backtesting method."""
    raw_config: dict[str, Any] = {}
    try:
        with CONFIG_PATH.open(encoding="utf-8") as config_file:
            loaded_config = json.load(config_file)
            if isinstance(loaded_config, dict):
                raw_config = loaded_config
    except (json.JSONDecodeError, OSError):
        pass

    builder = raw_config.get("builder", {})
    saved_builder_path = builder.get("path") if isinstance(builder, dict) else None
    configured = isinstance(saved_builder_path, str) and bool(saved_builder_path.strip())
    builder_path = saved_builder_path
    if not configured:
        builder_path = DEFAULT_BUILDER_PATH

    saved_simple = raw_config.get("simple_backtest", raw_config.get("backtest", {}))
    saved_simple = saved_simple if isinstance(saved_simple, dict) else {}
    simple_backtest = dict(DEFAULT_SIMPLE_BACKTEST_SETTINGS)
    for key in ("initial_capital", "cost_bps", "fill_latency_seconds"):
        candidate = saved_simple.get(key)
        if isinstance(candidate, (int, float)) and not isinstance(candidate, bool) and math.isfinite(candidate):
            simple_backtest[key] = candidate
    if simple_backtest["initial_capital"] <= 0 or simple_backtest["cost_bps"] < 0 or simple_backtest["fill_latency_seconds"] < 0:
        simple_backtest = dict(DEFAULT_SIMPLE_BACKTEST_SETTINGS)
    if saved_simple.get("capital_allocation") in {"SHARED", "EQUAL_PER_STRATEGY"}:
        simple_backtest["capital_allocation"] = saved_simple["capital_allocation"]
    if saved_simple.get("bucket_capital_mode") in {"SHARED", "INDEPENDENT"}:
        simple_backtest["bucket_capital_mode"] = saved_simple["bucket_capital_mode"]
    if saved_simple.get("run_mode") in {"BOTH", "LONG_ONLY", "SHORT_ONLY", "COMPARE_ALL"}:
        simple_backtest["run_mode"] = saved_simple["run_mode"]
    base_currency = saved_simple.get("base_currency")
    if isinstance(base_currency, str) and re.fullmatch(r"[A-Z]{3}", base_currency):
        simple_backtest["base_currency"] = base_currency
    if isinstance(saved_simple.get("ignore_currency"), bool):
        simple_backtest["ignore_currency"] = saved_simple["ignore_currency"]
    saved_grid_search = raw_config.get("grid_search", {})
    grid_search = saved_grid_search if isinstance(saved_grid_search, dict) else dict(DEFAULT_GRID_SEARCH_SETTINGS)
    return {"builder": {"path": builder_path}, "simple_backtest": simple_backtest, "grid_search": grid_search}, configured


def read_local_json(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as source:
            value = json.load(source)
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_local_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as output:
        json.dump(value, output, indent=2)
        output.write("\n")
        temporary_path = Path(output.name)
    temporary_path.chmod(0o600)
    temporary_path.replace(path)


def infer_embedded_timezone(path: Path) -> str | None:
    """Recognize explicit UTC markers; non-UTC offsets are still honored by the timestamp parser."""
    try:
        if path.suffix.lower() in {".parquet", ".pq"}:
            import polars as pl
            frame = pl.read_parquet(path, n_rows=1)
            candidates = [name for name in frame.columns if "".join(ch for ch in name.lower() if ch.isalnum()) in {"timestamp", "timestamps", "ts", "time", "date", "datetime", "epoch"}]
            value = str(frame[candidates[0]][0]) if candidates and frame.height else ""
        else:
            with path.open("r", encoding="utf-8-sig") as source:
                first = source.readline()
                second = source.readline()
            value = second.split(",", 1)[0].strip().strip('"') if first and any(token in first.lower() for token in ("timestamp", "date", "datetime", "time")) else first.split(",", 1)[0].strip().strip('"')
        if re.search(r"(?:Z|\+00:?00)$", value, flags=re.IGNORECASE):
            return "UTC"
    except Exception:
        return None
    return None


def dataset_settings(path: str) -> dict[str, Any]:
    saved = read_local_json(DATASET_SETTINGS_PATH).get(path)
    if isinstance(saved, dict):
        return {"path": path, "timezone": saved.get("timezone", "UTC"),
                "currency": saved.get("currency") or "USD",
                "fxBaseCurrency": saved.get("fxBaseCurrency", saved.get("baseCurrency", "")),
                "fxQuoteCurrency": saved.get("fxQuoteCurrency", saved.get("quoteCurrency", "")),
                "timezoneSource": "user", "currencySource": "user"}
    inferred_timezone = infer_embedded_timezone(PROJECT_ROOT / "data" / path)
    timezone = inferred_timezone or "UTC"
    return {"path": path, "timezone": timezone, "currency": "USD", "fxBaseCurrency": "", "fxQuoteCurrency": "",
            "timezoneSource": "embedded" if inferred_timezone else "default", "currencySource": "default"}


def save_dataset_settings(payload: dict[str, Any]) -> dict[str, Any]:
    relative_path = payload.get("path")
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise WorkspaceItemError("Choose a data file to configure.")
    target = safe_workspace_path(PROJECT_ROOT / "data", relative_path)
    if not target.is_file() or target.suffix.lower() not in {".csv", ".parquet", ".pq"}:
        raise WorkspaceItemError("Dataset settings are available for CSV and Parquet files.")
    timezone_name = payload.get("timezone", "UTC")
    currency = payload.get("currency", "USD")
    fx_base_currency = payload.get("fxBaseCurrency", payload.get("baseCurrency", ""))
    fx_quote_currency = payload.get("fxQuoteCurrency", payload.get("quoteCurrency", ""))
    if not isinstance(timezone_name, str) or not timezone_name.strip():
        raise WorkspaceItemError("Enter the dataset timezone.")
    try:
        ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise WorkspaceItemError("Enter a valid IANA timezone, such as America/New_York.") from error
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
        raise WorkspaceItemError("Choose a three-letter asset currency code, such as USD.")
    pair_codes_valid = all(code == "" or isinstance(code, str) and re.fullmatch(r"[A-Z]{3}", code) for code in (fx_base_currency, fx_quote_currency))
    if not pair_codes_valid or fx_base_currency and fx_quote_currency and fx_base_currency == fx_quote_currency:
        raise WorkspaceItemError("FX history needs two different three-letter currency codes.")
    settings = {"timezone": timezone_name, "currency": currency,
                "fxBaseCurrency": fx_base_currency, "fxQuoteCurrency": fx_quote_currency}
    all_settings = read_local_json(DATASET_SETTINGS_PATH)
    all_settings[relative_path] = settings
    write_local_json(DATASET_SETTINGS_PATH, all_settings)
    return {"path": relative_path, **settings, "timezoneSource": "user", "currencySource": "user"}


def get_strategy_presets(strategy_id: str) -> dict[str, Any]:
    if strategy_id not in eligible_strategy_headers():
        raise WorkspaceItemError("The selected strategy is not currently discovered.", HTTPStatus.NOT_FOUND)
    saved = read_local_json(STRATEGY_PRESETS_PATH).get(strategy_id, {})
    if not isinstance(saved, dict):
        saved = {}
    return {"strategyId": strategy_id, "presets": saved.get("presets", []), "lastPresetId": saved.get("lastPresetId")}


def save_strategy_presets(payload: dict[str, Any]) -> dict[str, Any]:
    strategy_id = payload.get("strategyId")
    if not isinstance(strategy_id, str) or strategy_id not in eligible_strategy_headers():
        raise WorkspaceItemError("The selected strategy is not currently discovered.", HTTPStatus.NOT_FOUND)
    presets = payload.get("presets")
    last_preset_id = payload.get("lastPresetId")
    if not isinstance(presets, list):
        raise WorkspaceItemError("Presets must be provided as a list.")
    normalized = []
    seen_ids = set()
    for preset in presets:
        if not isinstance(preset, dict):
            raise WorkspaceItemError("Each preset must be an object.")
        preset_id, name = preset.get("id"), preset.get("name")
        config, fields = preset.get("config"), preset.get("fields")
        if not isinstance(preset_id, str) or not preset_id or preset_id in seen_ids or not isinstance(name, str) or not name.strip():
            raise WorkspaceItemError("Each preset needs a unique ID and a non-empty name.")
        if len(name) > 80 or not isinstance(config, dict) or not isinstance(fields, dict):
            raise WorkspaceItemError("Preset names are limited to 80 characters and need valid config and field definitions.")
        seen_ids.add(preset_id)
        normalized.append({"id": preset_id, "name": name.strip(), "config": config, "fields": fields})
    if last_preset_id is not None and last_preset_id not in seen_ids:
        raise WorkspaceItemError("The selected last preset is not in this preset list.")
    all_presets = read_local_json(STRATEGY_PRESETS_PATH)
    all_presets[strategy_id] = {"presets": normalized, "lastPresetId": last_preset_id}
    write_local_json(STRATEGY_PRESETS_PATH, all_presets)
    return {"strategyId": strategy_id, "presets": normalized, "lastPresetId": last_preset_id}


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


def write_backtest_config(settings: dict[str, Any], mode: str = "simple") -> None:
    """Persist settings in the selected backtesting mode's own config namespace."""
    config, _ = read_config()
    config["simple_backtest" if mode == "simple" else "grid_search"] = settings
    CONFIG_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=CONFIG_PATH.parent, delete=False) as temporary_file:
        json.dump(config, temporary_file, indent=2)
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
WORKSPACE_PARQUET_PREVIEW_EDGE_ROWS = 500


def workspace_file_target(payload: dict[str, Any], *, allow_large_parquet_preview: bool = False) -> tuple[Path, str]:
    root = workspace_root(payload.get("scope"))
    target = safe_workspace_path(root, payload.get("path"))
    if not target.is_file():
        raise WorkspaceItemError("Choose a file to open.")
    suffix = target.suffix.lower()
    if suffix not in WORKSPACE_EDITABLE_TEXT_SUFFIXES | WORKSPACE_PARQUET_SUFFIXES:
        raise WorkspaceItemError("The editor supports C/C++ source, text, CSV, and Parquet files.", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
    if target.stat().st_size > WORKSPACE_EDITOR_MAX_BYTES and not (allow_large_parquet_preview and suffix in WORKSPACE_PARQUET_SUFFIXES):
        raise WorkspaceItemError("This file is larger than the 8 MB editor limit. Open a smaller file or edit it outside Quantogral.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    return target, suffix


def read_workspace_file(payload: dict[str, Any], *, preview: bool = False) -> dict[str, Any]:
    target, suffix = workspace_file_target(payload, allow_large_parquet_preview=preview)
    if suffix in WORKSPACE_PARQUET_SUFFIXES:
        try:
            import polars as pl
        except ImportError as error:
            raise RuntimeError("Parquet editing needs the project's Polars dependency. Run `uv sync` and restart Quantogral.") from error
        try:
            parquet_scan = pl.scan_parquet(target)
            if preview:
                total_rows = int(parquet_scan.select(pl.len()).collect().item())
                if total_rows > WORKSPACE_PARQUET_PREVIEW_EDGE_ROWS * 2:
                    frame = pl.concat([
                        parquet_scan.head(WORKSPACE_PARQUET_PREVIEW_EDGE_ROWS).collect(),
                        parquet_scan.tail(WORKSPACE_PARQUET_PREVIEW_EDGE_ROWS).collect(),
                    ])
                else:
                    frame = parquet_scan.head(WORKSPACE_PARQUET_PREVIEW_EDGE_ROWS * 2).collect()
            else:
                frame = parquet_scan.limit(WORKSPACE_PARQUET_EDITOR_MAX_ROWS + 1).collect()
        except Exception as error:
            raise WorkspaceItemError(f"Could not read this Parquet file: {error}") from error
        if not preview and frame.height > WORKSPACE_PARQUET_EDITOR_MAX_ROWS:
            raise WorkspaceItemError("The Parquet editor currently supports up to 5,000 rows per file.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        content = json.dumps({"columns": frame.columns, "rows": frame.to_dicts()}, ensure_ascii=False, indent=2, default=str)
        return {
            "name": target.name, "format": "parquet-json", "content": content,
            "rows": total_rows if preview else frame.height, "columns": frame.columns,
            "omittedRows": max(0, total_rows - frame.height) if preview else 0,
        }
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
    if payload.get("scope") == "data":
        saved_settings = read_local_json(DATASET_SETTINGS_PATH)
        prefix = relative_path.rstrip("/")
        updates = {}
        for old_path, settings in saved_settings.items():
            if old_path == prefix or (is_directory and old_path.startswith(prefix + "/")):
                updates[name + old_path[len(prefix):]] = settings
        if updates:
            for old_path in list(saved_settings):
                if old_path == prefix or (is_directory and old_path.startswith(prefix + "/")):
                    del saved_settings[old_path]
            saved_settings.update(updates)
            write_local_json(DATASET_SETTINGS_PATH, saved_settings)
    return {"name": name, "type": "directory" if is_directory else "file"}


def delete_workspace_file(payload: dict[str, Any]) -> dict[str, str]:
    """Delete one file from a Builder or data workspace; folders are never removed here."""
    root = workspace_root(payload.get("scope"))
    relative_path = payload.get("path")
    target = safe_workspace_path(root, relative_path)
    if not isinstance(relative_path, str) or not relative_path or target == root or not target.is_file():
        raise WorkspaceItemError("Choose a file inside the workspace to delete.")
    try:
        target.unlink()
    except OSError as error:
        raise WorkspaceItemError(f"Could not delete {target.name}: {error}", HTTPStatus.INTERNAL_SERVER_ERROR) from error
    if payload.get("scope") == "data":
        saved_settings = read_local_json(DATASET_SETTINGS_PATH)
        if relative_path in saved_settings:
            del saved_settings[relative_path]
            write_local_json(DATASET_SETTINGS_PATH, saved_settings)
    return {"name": target.name, "type": "file"}


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


def _read_ohlcv_frame(source: Path):
    try:
        import polars as pl
    except ImportError as error:
        raise RuntimeError("Timezone-aware backtests need Polars. Run `uv sync` and restart Quantogral.") from error
    is_parquet = source.suffix.lower() in {".parquet", ".pq"}
    frame = pl.read_parquet(source) if is_parquet else pl.read_csv(source, infer_schema_length=10000, try_parse_dates=True)
    aliases = {
        "timestamp": {"timestamp", "timestamps", "ts", "time", "date", "datetime", "epoch"},
        "open": {"open", "o"}, "high": {"high", "h"}, "low": {"low", "l"},
        "close": {"close", "c"}, "volume": {"volume", "vol", "v"},
    }
    by_normalized_name = {"".join(character for character in name.lower() if character.isalnum()): name for name in frame.columns}
    selected = []
    for canonical, candidates in aliases.items():
        original = next((by_normalized_name.get(candidate) for candidate in candidates if by_normalized_name.get(candidate)), None)
        if original is None:
            selected = []
            break
        selected.append(original)
    if not selected:
        normalized_columns = {"".join(character for character in name.lower() if character.isalnum()) for name in frame.columns}
        if {"bid", "ask"}.issubset(normalized_columns):
            raise ValueError("This file contains quote data, not OHLCV bars.")
        if normalized_columns.intersection({"headline", "title", "news", "text", "message"}):
            raise ValueError("This file contains news data, not OHLCV bars.")
        if not is_parquet:
            frame = pl.read_csv(source, has_header=False, infer_schema_length=10000, try_parse_dates=True)
        if frame.width < 6:
            raise ValueError("Market data must contain timestamp, open, high, low, close, and volume columns.")
        selected = frame.columns[:6]
    return frame.select(selected).rename(dict(zip(selected, ["timestamp", "open", "high", "low", "close", "volume"])))


def _read_quote_frame(source: Path):
    try:
        import polars as pl
    except ImportError as error:
        raise RuntimeError("Reading quote data needs Polars. Run `uv sync` and restart Quantogral.") from error
    is_parquet = source.suffix.lower() in {".parquet", ".pq"}
    frame = pl.read_parquet(source) if is_parquet else pl.read_csv(source, infer_schema_length=10000, try_parse_dates=True)
    normalized = {"".join(character for character in name.lower() if character.isalnum()): name for name in frame.columns}
    timestamp = next((normalized.get(name) for name in ("timestamp", "timestamps", "ts", "time", "date", "datetime", "epoch") if normalized.get(name)), None)
    bid = next((normalized.get(name) for name in ("bid", "bestbid") if normalized.get(name)), None)
    ask = next((normalized.get(name) for name in ("ask", "bestask", "offer") if normalized.get(name)), None)
    bid_size = next((normalized.get(name) for name in ("bidsize", "bidqty", "bidquantity") if normalized.get(name)), None)
    ask_size = next((normalized.get(name) for name in ("asksize", "askqty", "askquantity") if normalized.get(name)), None)
    if timestamp is None or bid is None or ask is None:
        normalized_columns = set(normalized)
        if normalized_columns.intersection({"headline", "title", "news", "text", "message"}):
            raise ValueError("This file contains news data, not quote data.")
        if is_parquet:
            raise ValueError("Quote data must contain timestamp, bid, and ask columns.")
        frame = pl.read_csv(source, has_header=False, infer_schema_length=10000, try_parse_dates=True)
        if frame.width < 3:
            raise ValueError("Quote data must contain timestamp, bid, and ask columns.")
        timestamp, bid, ask = frame.columns[:3]
        bid_size = frame.columns[3] if frame.width > 3 else None
        ask_size = frame.columns[4] if frame.width > 4 else None
    selected = [pl.col(timestamp).alias("timestamp"), pl.col(bid).alias("bid"), pl.col(ask).alias("ask")]
    selected.append(pl.col(bid_size).alias("bidsize") if bid_size else pl.lit(0.0).alias("bidsize"))
    selected.append(pl.col(ask_size).alias("asksize") if ask_size else pl.lit(0.0).alias("asksize"))
    return frame.select(selected)


def _read_market_frame(source: Path):
    try:
        return _read_ohlcv_frame(source), "OHLCV"
    except ValueError:
        return _read_quote_frame(source), "QUOTE"


def _read_fx_rate_frame(source: Path):
    try:
        import polars as pl
    except ImportError as error:
        raise RuntimeError("Timezone-aware backtests need Polars. Run `uv sync` and restart Quantogral.") from error
    is_parquet = source.suffix.lower() in {".parquet", ".pq"}
    frame = pl.read_parquet(source) if is_parquet else pl.read_csv(source, infer_schema_length=10000, try_parse_dates=True)
    by_normalized_name = {"".join(ch for ch in name.lower() if ch.isalnum()): name for name in frame.columns}
    timestamp = next((by_normalized_name.get(name) for name in ("timestamp", "timestamps", "ts", "time", "date", "datetime", "epoch") if by_normalized_name.get(name)), None)
    rate = next((by_normalized_name.get(name) for name in ("close", "rate", "fxrate", "value", "price", "c") if by_normalized_name.get(name)), None)
    if timestamp is None or rate is None:
        if not is_parquet:
            frame = pl.read_csv(source, has_header=False, infer_schema_length=10000, try_parse_dates=True)
        if frame.width < 2:
            raise ValueError("FX history needs timestamp and close/rate columns.")
        timestamp, rate = frame.columns[:2]
    return frame.select([pl.col(timestamp).alias("timestamp"), pl.col(rate).alias("rate")])


def _market_timestamp_ms(value: Any, timezone_name: str, ts_unit: str, date_format: str) -> int:
    if value is None:
        raise ValueError("A market-data timestamp is empty.")
    text = str(value).strip()
    if re.fullmatch(r"[-+]?\d+(?:\.\d+)?", text):
        number = int(float(text))
        factors = {"SECONDS": 1000, "MILLISECONDS": 1, "MICROSECONDS": 0.001, "NANOSECONDS": 0.000001}
        return int(number * factors[ts_unit])
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        normalized = text.replace("/", "-")
        formats = ["%d-%m-%Y", "%d-%m-%Y %H:%M:%S", "%m-%d-%Y", "%m-%d-%Y %H:%M:%S"]
        if date_format == "MMDDYYYY":
            formats = ["%m-%d-%Y", "%m-%d-%Y %H:%M:%S", "%d-%m-%Y", "%d-%m-%Y %H:%M:%S"]
        parsed = None
        for timestamp_format in formats:
            try:
                parsed = datetime.strptime(normalized, timestamp_format)
                break
            except ValueError:
                continue
        if parsed is None:
            raise ValueError(f"Could not parse timestamp {text!r} using {date_format}.")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(timezone_name))
    return int(parsed.timestamp() * 1000)


def _compress_fx_rates(rows: list[tuple[int, float]], first_asset_timestamp: int) -> tuple[list[tuple[int, float]], str, int]:
    """Keep one causally timestamped FX close per UTC day or month, depending on source cadence."""
    rows.sort(key=lambda item: item[0])
    unique_rows = []
    for timestamp, rate in rows:
        if unique_rows and unique_rows[-1][0] == timestamp:
            unique_rows[-1] = (timestamp, rate)
        else:
            unique_rows.append((timestamp, rate))
    if not unique_rows:
        raise ValueError("FX history contains no usable rows.")
    gaps = [(right[0] - left[0]) / 86_400_000.0 for left, right in zip(unique_rows, unique_rows[1:])]
    median_gap_days = statistics.median(gaps) if gaps else 1.0
    resolution = "daily" if median_gap_days <= 4.0 else "monthly"
    max_age_ms = (5 if resolution == "daily" else 45) * 86_400_000
    compressed: dict[Any, tuple[int, float]] = {}
    for row in unique_rows:
        timestamp = row[0]
        moment = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc)
        key = moment.date() if resolution == "daily" else (moment.year, moment.month)
        compressed[key] = row
    # Preserve the latest observation available at the first asset event,
    # even if a later close from the same day/month is selected by downsampling.
    prior_to_start = next((row for row in reversed(unique_rows) if row[0] <= first_asset_timestamp), None)
    if prior_to_start is not None:
        period = datetime.fromtimestamp(prior_to_start[0] / 1000, tz=timezone.utc)
        key = period.date() if resolution == "daily" else (period.year, period.month)
        if compressed[key][0] > first_asset_timestamp:
            compressed[("start-boundary", prior_to_start[0])] = prior_to_start
    return sorted(compressed.values(), key=lambda item: item[0]), resolution, max_age_ms


def prepare_market_feed_csv(
    source: Path, destination: Path, *, timezone_name: str, ts_unit: str, date_format: str,
    fx_source: Path | None = None, fx_settings: dict[str, Any] | None = None,
    asset_currency: str = "USD", base_currency: str = "USD",
    fx_cache: dict[tuple[str, str, str, str, str], tuple[list[tuple[int, float]], str, int]] | None = None,
) -> str:
    """Normalize market-event rows and append an as-of FX multiplier where applicable."""
    if ts_unit not in {"SECONDS", "MILLISECONDS", "MICROSECONDS", "NANOSECONDS"}:
        raise ValueError("Choose a supported numeric timestamp unit.")
    if date_format not in {"DDMMYYYY", "MMDDYYYY"}:
        raise ValueError("Choose a supported date order.")
    assets, event_kind = _read_market_frame(source)
    asset_rows = assets.rows()
    parsed_assets = []
    for row_number, row in enumerate(asset_rows, 1):
        try:
            parsed_assets.append((_market_timestamp_ms(row[0], timezone_name, ts_unit, date_format), row[1:]))
        except Exception as error:
            raise ValueError(f"Could not parse timestamp in {source.name}, row {row_number}: {error}") from error
    parsed_assets.sort(key=lambda item: item[0])

    fx_rows: list[tuple[int, float]] = []
    fx_max_age_ms = 0
    invert_rate = False
    if fx_source is not None and fx_settings is not None:
        pair_base = fx_settings.get("baseCurrency")
        pair_quote = fx_settings.get("quoteCurrency")
        if pair_base == asset_currency and pair_quote == base_currency:
            invert_rate = False
        elif pair_base == base_currency and pair_quote == asset_currency:
            invert_rate = True
        else:
            raise ValueError(f"FX file {fx_source.name} must contain {asset_currency}/{base_currency} or {base_currency}/{asset_currency} history.")
        first_asset_timestamp = parsed_assets[0][0] if parsed_assets else 0
        cache_key = (str(fx_source.resolve()), fx_settings.get("timezone", "UTC"), fx_settings.get("tsUnit", "MILLISECONDS"), fx_settings.get("dateFormat", "DDMMYYYY"), str(first_asset_timestamp))
        cached = fx_cache.get(cache_key) if fx_cache is not None else None
        if cached is None:
            fx_frame = _read_fx_rate_frame(fx_source)
            raw_fx_rows = []
            for row_number, row in enumerate(fx_frame.rows(), 1):
                try:
                    timestamp = _market_timestamp_ms(row[0], fx_settings.get("timezone", "UTC"), fx_settings.get("tsUnit", "MILLISECONDS"), fx_settings.get("dateFormat", "DDMMYYYY"))
                    rate = float(row[1])
                except Exception as error:
                    raise ValueError(f"Could not read FX history {fx_source.name}, row {row_number}: {error}") from error
                if not math.isfinite(rate) or rate <= 0:
                    raise ValueError(f"FX file {fx_source.name}, row {row_number} has an invalid close rate.")
                raw_fx_rows.append((timestamp, rate))
            cached = _compress_fx_rates(raw_fx_rows, first_asset_timestamp)
            if fx_cache is not None:
                fx_cache[cache_key] = cached
        fx_rows, resolution, fx_max_age_ms = cached
        if parsed_assets and fx_rows[0][0] > parsed_assets[0][0]:
            raise ValueError(f"FX history in {fx_source.name} starts after {source.name}; it does not cover the asset data start. Add earlier FX history.")
        if parsed_assets and fx_rows[-1][0] < parsed_assets[-1][0]:
            raise ValueError(f"FX history in {fx_source.name} ends before {source.name}; it does not cover the asset data end. Add later FX history.")

    converted_rows = []
    fx_index = 0
    current_fx_rate = 1.0
    for timestamp, values in parsed_assets:
        if fx_rows:
            while fx_index < len(fx_rows) and fx_rows[fx_index][0] <= timestamp:
                current_fx_rate = fx_rows[fx_index][1]
                fx_index += 1
            if fx_index == 0:
                raise ValueError(f"FX history in {fx_source.name} starts after {source.name}; earlier conversion rates are missing.")
            if timestamp - fx_rows[fx_index - 1][0] > fx_max_age_ms:
                allowed_gap_days = fx_max_age_ms // 86_400_000
                raise ValueError(f"FX history in {fx_source.name} has a gap larger than the {allowed_gap_days}-day tolerance for {resolution} rates while covering {source.name} at {datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat()}.")
            current_rate = 1.0 / current_fx_rate if invert_rate else current_fx_rate
        else:
            current_rate = 1.0
        converted_rows.append((timestamp, *values, current_rate))

    with destination.open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output)
        if event_kind == "OHLCV":
            columns = ["timestamp", "open", "high", "low", "close", "volume"]
        elif event_kind == "QUOTE":
            columns = ["timestamp", "bid", "ask", "bidsize", "asksize"]
        else:
            columns = ["timestamp", "bid", "ask", "bidsize", "asksize"]
        writer.writerow([*columns, "currency_to_base"])
        writer.writerows(converted_rows)
    return event_kind


def read_trade_chart(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a small, scrollable OHLC window for a trade in a local data file."""
    relative_path = payload.get("path")
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("The trade has no linked data file.")
    source = safe_workspace_path(PROJECT_ROOT / "data", relative_path)
    if not source.is_file() or source.suffix.lower() not in {".csv", ".parquet", ".pq"}:
        raise ValueError("The linked market-data file could not be found.")
    timezone_name = payload.get("timezone", "UTC")
    ts_unit = payload.get("tsUnit", "MILLISECONDS")
    date_format = payload.get("dateFormat", "DDMMYYYY")
    if ts_unit not in {"SECONDS", "MILLISECONDS", "MICROSECONDS", "NANOSECONDS"} or date_format not in {"DDMMYYYY", "MMDDYYYY"}:
        raise ValueError("The linked data file has unsupported timestamp settings.")
    try:
        frame, event_kind = _read_market_frame(source)
        rows = frame.rows()
        points = []
        for row_number, row in enumerate(rows, 1):
            try:
                timestamp = _market_timestamp_ms(row[0], timezone_name, ts_unit, date_format)
                if event_kind == "QUOTE":
                    mid = (float(row[1]) + float(row[2])) / 2.0
                    ohlc = [mid, mid, mid, mid]
                else:
                    ohlc = [float(value) for value in row[1:5]]
            except (TypeError, ValueError, IndexError) as error:
                raise ValueError(f"Could not read chart data at row {row_number}: {error}") from error
            if all(math.isfinite(value) for value in ohlc):
                points.append({"timestamp": timestamp, "open": ohlc[0], "high": ohlc[1], "low": ohlc[2], "close": ohlc[3]})
    except ImportError as error:
        raise RuntimeError(str(error)) from error
    points.sort(key=lambda point: point["timestamp"])
    if not points:
        raise ValueError("The linked market-data file has no usable OHLC rows.")
    return {"points": points, "totalPoints": len(points)}


def read_benchmark_series(payload: dict[str, Any]) -> dict[str, Any]:
    """Read a local CSV/Parquet price series for report-only benchmark regressions."""
    relative_path = payload.get("path")
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("Choose a reference dataset.")
    source = safe_workspace_path(PROJECT_ROOT / "data", relative_path)
    if not source.is_file() or source.suffix.lower() not in {".csv", ".parquet", ".pq"}:
        raise ValueError("Choose an existing CSV or Parquet reference dataset.")
    timezone_name = dataset_settings(source.relative_to(PROJECT_ROOT / "data").as_posix())["timezone"]
    ts_unit = payload.get("tsUnit", "MILLISECONDS")
    date_format = payload.get("dateFormat", "DDMMYYYY")
    if ts_unit not in {"SECONDS", "MILLISECONDS", "MICROSECONDS", "NANOSECONDS"} or date_format not in {"DDMMYYYY", "MMDDYYYY"}:
        raise ValueError("Choose valid timestamp settings for the reference dataset.")
    try:
        import polars as pl
    except ImportError as error:
        raise RuntimeError("Reading reference data needs Polars. Run `uv sync` and restart Quantogral.") from error
    try:
        market_frame = None
        event_kind = None
        try:
            market_frame, event_kind = _read_market_frame(source)
        except ValueError:
            pass
        if event_kind == "QUOTE":
            timestamp_column, price_column = "timestamp", "mid"
            rows = market_frame.select([
                pl.col("timestamp").alias("timestamp"),
                ((pl.col("bid") + pl.col("ask")) / 2.0).alias("price"),
            ]).rows()
        else:
            parquet = source.suffix.lower() in {".parquet", ".pq"}
            frame = pl.read_parquet(source) if parquet else pl.read_csv(source, infer_schema_length=10000, try_parse_dates=True)
            normalized = {"".join(character for character in column.lower() if character.isalnum()): column for column in frame.columns}
            timestamp_column = next((normalized.get(name) for name in ("timestamp", "timestamps", "datetime", "date", "time", "ts", "epoch") if normalized.get(name)), None)
            price_column = next((normalized.get(name) for name in ("adjclose", "adjustedclose", "close", "price", "value", "nav") if normalized.get(name)), None)
            if timestamp_column is None or price_column is None:
                if not parquet:
                    frame = pl.read_csv(source, has_header=False, infer_schema_length=10000, try_parse_dates=True)
                if frame.width < 2:
                    raise ValueError("Reference data needs a timestamp column and a price column such as Adj Close or Close.")
                timestamp_column, price_column = frame.columns[:2]
            rows = frame.select([pl.col(timestamp_column).alias("timestamp"), pl.col(price_column).alias("price")]).rows()
    except ValueError:
        raise
    except Exception as error:
        raise ValueError(f"Could not read reference dataset {source.name}: {error}") from error
    points = []
    for row_number, (raw_timestamp, raw_price) in enumerate(rows, 1):
        try:
            timestamp = _market_timestamp_ms(raw_timestamp, timezone_name, ts_unit, date_format)
            price = float(raw_price)
            if not math.isfinite(price) or price <= 0:
                raise ValueError("price must be a finite value greater than zero")
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError(f"Invalid reference data at row {row_number}: {error}") from error
        points.append({"timestamp": timestamp, "price": price})
    points.sort(key=lambda point: point["timestamp"])
    if len(points) < 2:
        raise ValueError("Reference data needs at least two valid price observations.")
    metadata = dataset_settings(source.relative_to(PROJECT_ROOT / "data").as_posix())
    median_gap_ms = statistics.median(right["timestamp"] - left["timestamp"] for left, right in zip(points, points[1:]))
    return {"path": relative_path, "priceColumn": price_column, "currency": metadata["currency"], "timezone": timezone_name, "medianGapMs": median_gap_ms, "points": points}


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
    fill_latency_seconds = float(value(backtest, "fill_latency_seconds", 0))
    base_currency = value(backtest, "base_currency", "USD")
    ignore_currency = value(backtest, "ignore_currency", False)
    if not math.isfinite(initial_capital) or initial_capital <= 0:
        raise ValueError("Starting capital must be a finite number greater than zero.")
    if not math.isfinite(cost_bps) or cost_bps < 0:
        raise ValueError("Transaction cost must be a finite non-negative number of basis points.")
    if not math.isfinite(fill_latency_seconds) or fill_latency_seconds < 0:
        raise ValueError("Fill latency must be a finite non-negative number of seconds.")
    if not isinstance(base_currency, str) or not re.fullmatch(r"[A-Z]{3}", base_currency):
        raise ValueError("Set a three-letter portfolio currency in Backtest Settings.")
    if not isinstance(ignore_currency, bool):
        raise ValueError("Ignore currency must be enabled or disabled in Backtest Settings.")
    allocation_mode = value(backtest, "capital_allocation", "SHARED")
    if allocation_mode not in {"SHARED", "EQUAL_PER_STRATEGY"}:
        raise ValueError("Capital allocation must be SHARED or EQUAL_PER_STRATEGY.")
    bucket_capital_mode = value(backtest, "bucket_capital_mode", "SHARED")
    if bucket_capital_mode not in {"SHARED", "INDEPENDENT"}:
        raise ValueError("Bucket capital mode must be SHARED or INDEPENDENT.")
    run_mode = value(backtest, "run_mode", "BOTH")
    if run_mode not in {"BOTH", "LONG_ONLY", "SHORT_ONLY", "COMPARE_ALL"}:
        raise ValueError("Choose Long and short, Long only, Short only, or Compare all.")
    strategy_catalog = {item["id"]: item for item in strategy_catalog_from_headers()}

    arguments = [str(RUNNER_BINARY), "--run-plan", str(initial_capital), str(cost_bps), allocation_mode, bucket_capital_mode, str(fill_latency_seconds), "BOTH", str(len(buckets))]
    temp_dirs: list[Any] = []
    prepared_buckets: list[dict[str, Any]] = []
    fx_rate_cache: dict[tuple[str, str, str, str, str], tuple[list[tuple[int, float]], str, int]] = {}
    instance_ids: set[str] = set()
    bucket_ids: set[str] = set()
    next_numeric_feed_id = 1
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
            feed_protocol: dict[str, dict[str, Any]] = {}
            for feed in feeds:
                if not isinstance(feed, dict):
                    raise ValueError(f"Bucket {bucket_id} has an invalid data feed.")
                feed_id = feed.get("id")
                if not isinstance(feed_id, str) or not feed_id.strip() or feed_id in feed_protocol:
                    raise ValueError(f"Bucket {bucket_id} data feed IDs must be non-empty and unique.")
                role = feed.get("role", "MAIN")
                if role not in {"MAIN", "SUB1", "SUB2", "SUB3"}:
                    raise ValueError(f"Feed {feed_id} has an unsupported role.")
                if next_numeric_feed_id > 255:
                    raise ValueError("This backtest has more feeds than the current 8-bit FeedId can represent.")
                feed_protocol[feed_id] = {
                    "numericId": next_numeric_feed_id,
                    "role": role,
                    "mainFeedId": feed_id if role == "MAIN" else feed.get("mainFeedId"),
                }
                next_numeric_feed_id += 1
            role_by_id = {feed_id: metadata["role"] for feed_id, metadata in feed_protocol.items()}
            roles_by_main: set[tuple[str, str]] = set()
            for feed_id, metadata in feed_protocol.items():
                role = metadata["role"]
                main_feed_id = metadata["mainFeedId"]
                if role == "MAIN":
                    continue
                if not isinstance(main_feed_id, str) or role_by_id.get(main_feed_id) != "MAIN":
                    raise ValueError(f"Subfeed {feed_id} must reference a Main feed in bucket {bucket_id}.")
                role_key = (main_feed_id, role)
                if role_key in roles_by_main:
                    raise ValueError(f"Main feed {main_feed_id} has more than one {role}.")
                roles_by_main.add(role_key)
            raw_fx_feeds = [] if ignore_currency else raw_bucket.get("fxFeeds", [])
            if not isinstance(raw_fx_feeds, list):
                raise ValueError(f"Bucket {bucket_id} has invalid FX history settings.")
            available_fx = []
            for fx_feed in raw_fx_feeds:
                if not isinstance(fx_feed, dict):
                    raise ValueError(f"Bucket {bucket_id} has an invalid FX history file.")
                fx_path = resolve_data_file(fx_feed.get("path"))
                fx_relative = fx_path.relative_to(PROJECT_ROOT / "data").as_posix()
                fx_metadata = dataset_settings(fx_relative)
                available_fx.append({"path": fx_path, "settings": {**fx_metadata, "tsUnit": fx_feed.get("tsUnit", "MILLISECONDS"), "dateFormat": fx_feed.get("dateFormat", "DDMMYYYY")}})
            arguments.extend([bucket_id, str(len(feeds))])
            prepared_feeds = []
            feed_ids: set[str] = set(feed_protocol)
            for feed_index, feed in enumerate(feeds):
                feed_id = feed.get("id")
                protocol = feed_protocol[feed_id]
                role = protocol["role"]
                main_feed_id = protocol["mainFeedId"]
                main_numeric_id = feed_protocol[main_feed_id]["numericId"]
                data_path = resolve_data_file(feed.get("path"))
                ts_unit = feed.get("tsUnit", "MILLISECONDS")
                date_format = feed.get("dateFormat", "DDMMYYYY")
                if ts_unit not in {"SECONDS", "MILLISECONDS", "MICROSECONDS", "NANOSECONDS"}:
                    raise ValueError(f"Feed {feed_id} has an unsupported timestamp unit.")
                if date_format not in {"DDMMYYYY", "MMDDYYYY"}:
                    raise ValueError(f"Feed {feed_id} has an unsupported date format.")
                relative_path = data_path.relative_to(PROJECT_ROOT / "data").as_posix()
                metadata = dataset_settings(relative_path)
                asset_currency = metadata["currency"]
                selected_fx = None
                if role == "MAIN" and not ignore_currency and asset_currency != base_currency:
                    selected_fx = next((item for item in available_fx if {item["settings"].get("fxBaseCurrency"), item["settings"].get("fxQuoteCurrency")} == {asset_currency, base_currency}), None)
                    if selected_fx is None:
                        raise ValueError(f"Bucket {bucket_id} needs user-provided FX history for {asset_currency}/{base_currency}. Add a matching FX file to this bucket.")
                temp_dir = tempfile.TemporaryDirectory(prefix="quantogral-market-feed-", dir=BUILD_DIR)
                temp_dirs.append(temp_dir)
                runner_data_path = Path(temp_dir.name) / f"feed-{feed_index}.csv"
                event_kind = prepare_market_feed_csv(
                    data_path, runner_data_path,
                    timezone_name=metadata["timezone"], ts_unit=ts_unit, date_format=date_format,
                    fx_source=selected_fx["path"] if selected_fx else None,
                    fx_settings={**selected_fx["settings"], "baseCurrency": selected_fx["settings"].get("fxBaseCurrency"), "quoteCurrency": selected_fx["settings"].get("fxQuoteCurrency")} if selected_fx else None,
                    asset_currency=asset_currency if role == "MAIN" and not ignore_currency else base_currency,
                    base_currency=base_currency,
                    fx_cache=fx_rate_cache,
                )
                arguments.extend([feed_id, str(protocol["numericId"]), str(main_numeric_id), role, str(runner_data_path), "MILLISECONDS", "DDMMYYYY"])
                prepared_feeds.append({"id": feed_id, "role": role, "mainFeedId": main_feed_id, "eventType": event_kind, "path": relative_path, "name": data_path.name, "tsUnit": ts_unit, "dateFormat": date_format, "currency": asset_currency, "timezone": metadata["timezone"]})

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
                strategy_meta = strategy_catalog.get(strategy_id)
                if strategy_meta is None:
                    raise ValueError(f"Strategy {strategy_id} does not use the FeedEvent strategy interface.")
                fields = {field["key"]: field for field in [*strategy_meta["baseConfig"], *strategy_meta["parameters"]]}
                active_values = {}
                for key, item in values.items():
                    field = fields.get(key)
                    visibility = field.get("visibleWhen") if field else None
                    if visibility and values.get(visibility["key"]) not in visibility["values"]:
                        # Hidden conditional parameters fall back to their C++ defaults.
                        # Do not parse stale or blank values for an inactive sizing mode.
                        continue
                    if field and field["type"] == "number":
                        try:
                            number = float(item)
                        except (TypeError, ValueError):
                            raise ValueError(f"Strategy {strategy_meta['name']} setting '{key}' must be a number.") from None
                        if not math.isfinite(number):
                            raise ValueError(f"Strategy {strategy_meta['name']} setting '{key}' must be a finite number.")
                    active_values[key] = item
                arguments.extend([instance_id, strategy_id, str(len(connected_feeds)), *connected_feeds, str(len(active_values))])
                for key, item in active_values.items():
                    if not isinstance(key, str) or not key or "=" in key:
                        raise ValueError(f"Strategy instance {instance_id} has an invalid config field name.")
                    if isinstance(item, bool):
                        item = str(item).lower()
                    arguments.append(f"{key}={item}")
                prepared_strategies.append({"instanceId": instance_id, "strategyId": strategy_id, "name": strategy_meta["name"], "feedIds": connected_feeds})
            prepared_buckets.append({"id": bucket_id, "feeds": prepared_feeds, "strategies": prepared_strategies})

        scenario_specs = {
            "BOTH": [("both", "Long and short", "BOTH")],
            "LONG_ONLY": [("long_only", "Long only", "LONG_ONLY")],
            "SHORT_ONLY": [("short_only", "Short only", "SHORT_ONLY")],
            "COMPARE_ALL": [
                ("both", "Long and short", "BOTH"),
                ("long_only", "Long only", "LONG_ONLY"),
                ("short_only", "Short only", "SHORT_ONLY"),
            ],
        }[run_mode]
        raw_scenarios = []
        for scenario_id, scenario_label, direction_mode in scenario_specs:
            scenario_arguments = arguments.copy()
            # argv[6] is fill_latency_seconds; argv[7] is trade direction.
            # Replacing index 6 made the C++ runner call stod("BOTH"), which
            # surfaced to the UI as `stod: no conversion` on every run.
            scenario_arguments[7] = direction_mode
            try:
                result = subprocess.run(scenario_arguments, capture_output=True, text=True, timeout=300, check=False)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError(f"The {scenario_label.lower()} backtest exceeded the 5-minute time limit.") from error
            if result.returncode != 0:
                raise RuntimeError((result.stderr or "C++ backtest failed.").strip()[-4000:])
            raw_scenarios.append((scenario_id, scenario_label, json.loads(result.stdout)))
    finally:
        for temp_dir in temp_dirs:
            temp_dir.cleanup()

    def process_scenario(output: dict[str, Any]) -> dict[str, Any]:
        output_buckets = output.get("buckets", [])
        orders = []
        instrument_by_feed = {
            feed["id"]: Path(feed["name"]).stem.split("_", 1)[0]
            for bucket in prepared_buckets
            for feed in bucket["feeds"]
        }
        for bucket_index, bucket in enumerate(output_buckets):
            bucket["feeds"] = prepared_buckets[bucket_index]["feeds"]
            strategy_metadata = {item["instanceId"]: item for item in prepared_buckets[bucket_index]["strategies"]}
            for strategy in bucket.get("strategies", []):
                metadata = strategy_metadata[strategy["instanceId"]]
                strategy["strategyId"] = metadata["strategyId"]
                strategy["name"] = metadata["name"]
                strategy["feedIds"] = metadata["feedIds"]
                strategy["strategyTag"] = f'{metadata["name"]}#{strategy.get("engineId", strategy["instanceId"])}'
                for indicator in strategy.get("indicators", []):
                    indicator["instanceId"] = strategy["instanceId"]
                    indicator["strategyName"] = metadata["name"]
                    indicator["strategyTag"] = strategy["strategyTag"]
                for order in strategy.get("orders", []):
                    orders.append({**order, "bucketId": bucket["id"], "instanceId": strategy["instanceId"], "strategyId": strategy["strategyId"], "strategyName": strategy["name"], "strategyTag": strategy["strategyTag"]})
            bucket["metrics"] = {"orders": sum(len(strategy.get("orders", [])) for strategy in bucket.get("strategies", []))}
        output["inputRows"] = int(output.get("inputRows", 0))
        output["bucketCapitalMode"] = bucket_capital_mode
        output["buckets"] = output_buckets
        orders.sort(key=lambda order: (order["timestamp"], order["bucketId"], order["instanceId"], order["id"]))
        output["orders"] = orders
        entries: dict[tuple[str, str, int], dict[str, Any]] = {}
        closed_trades = []
        for order in orders:
            if order.get("status") != "FILLED":
                continue
            parent_id = int(order.get("parentId", -1))
            order_key = (order["bucketId"], order["instanceId"], parent_id)
            signal = order.get("signal")
            if parent_id < 0 and signal in {"LONG", "SHORT", "BLONG", "BSHORT", "BUY", "SELL"}:
                side = "LONG" if signal in {"LONG", "BLONG", "BUY"} else "SHORT"
                entries[(order["bucketId"], order["instanceId"], int(order["id"]))] = {**order, "side": side}
                continue
            entry = entries.get(order_key)
            if entry is None or (entry["side"] == "LONG" and signal != "SELL") or (entry["side"] == "SHORT" and signal != "COVER"):
                continue
            quantity = float(order["quantity"])
            entry_price = float(entry["price"])
            exit_price = float(order["price"])
            entry_rate = float(entry.get("currencyRate", 1.0))
            exit_rate = float(order.get("currencyRate", 1.0))
            gross_profit = (exit_price * exit_rate - entry_price * entry_rate) * quantity if entry["side"] == "LONG" else (entry_price * entry_rate - exit_price * exit_rate) * quantity
            fees = (abs(entry_price * entry_rate * quantity) + abs(exit_price * exit_rate * quantity)) * cost_bps / 10_000.0
            net_profit = gross_profit - fees
            stop_distances = []
            if entry.get("stopType") == "HARD":
                stop_notional = float(entry.get("stopNotional", -1))
                stop_percent = float(entry.get("stopPercent", -1))
                if stop_notional > 0:
                    stop_distances.append(stop_notional)
                if stop_percent > 0:
                    stop_distances.append(entry_price * stop_percent / 100.0)
            risk_amount = min(stop_distances) * quantity * entry_rate if stop_distances else 0.0
            closed_trades.append({
                "bucketId": order["bucketId"], "instanceId": order["instanceId"],
                "strategyName": order["strategyName"], "strategyTag": order["strategyTag"], "feedId": order.get("feedId", ""),
                "instrument": instrument_by_feed.get(order.get("feedId", ""), ""),
                "side": entry["side"], "entryTimestamp": entry["timestamp"], "exitTimestamp": order["timestamp"],
                "quantity": quantity, "entryPrice": entry_price, "exitPrice": exit_price,
                "profit": net_profit, "riskReward": net_profit / risk_amount if risk_amount > 0 else None,
            })
        equity_timestamps = output.get("equityTimestamps", [])
        equity_curve = output.get("equityCurve", [])
        starting_equity = initial_capital
        final_equity = equity_curve[-1] if equity_curve else starting_equity
        peak = starting_equity
        max_drawdown_dollars = 0.0
        max_drawdown_pct = 0.0
        for point in equity_curve:
            peak = max(peak, point)
            drawdown_dollars = peak - point
            drawdown_pct = drawdown_dollars / peak if peak > 0 else 0.0
            max_drawdown_dollars = max(max_drawdown_dollars, drawdown_dollars)
            max_drawdown_pct = max(max_drawdown_pct, drawdown_pct)
        daily_equity: dict[Any, float] = {}
        for timestamp, equity in zip(equity_timestamps, equity_curve):
            day = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).date()
            daily_equity[day] = equity
        daily_returns = []
        previous_equity = starting_equity
        for day in sorted(daily_equity):
            current_equity = daily_equity[day]
            if previous_equity > 0:
                daily_returns.append(current_equity / previous_equity - 1.0)
            previous_equity = current_equity
        sharpe = None
        if len(daily_returns) > 1:
            volatility = statistics.stdev(daily_returns)
            if volatility > 0:
                sharpe = statistics.mean(daily_returns) / volatility * math.sqrt(252.0)
        elapsed_years = ((max(equity_timestamps) - min(equity_timestamps)) / 86_400_000.0 / 365.25) if len(equity_timestamps) > 1 else 0.0
        for bucket in output_buckets:
            if bucket_capital_mode == "INDEPENDENT":
                bucket_curve = bucket.get("equityCurve", [])
                bucket_timestamps = bucket.get("equityTimestamps", [])
                bucket_initial = initial_capital / max(1, len(output_buckets))
                bucket_final = bucket_curve[-1] if bucket_curve else bucket_initial
                bucket_peak = bucket_initial
                bucket_max_dd = 0.0
                bucket_max_dd_pct = 0.0
                daily_bucket_equity: dict[Any, float] = {}
                for timestamp, equity in zip(bucket_timestamps, bucket_curve):
                    bucket_peak = max(bucket_peak, equity)
                    bucket_max_dd = max(bucket_max_dd, bucket_peak - equity)
                    if bucket_peak > 0:
                        bucket_max_dd_pct = max(bucket_max_dd_pct, (bucket_peak - equity) / bucket_peak)
                    day = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).date()
                    daily_bucket_equity[day] = equity
                bucket_returns = []
                previous_bucket_equity = bucket_initial
                for day in sorted(daily_bucket_equity):
                    current_equity = daily_bucket_equity[day]
                    if previous_bucket_equity > 0:
                        bucket_returns.append(current_equity / previous_bucket_equity - 1.0)
                    previous_bucket_equity = current_equity
                bucket_sharpe = None
                if len(bucket_returns) > 1:
                    bucket_volatility = statistics.stdev(bucket_returns)
                    if bucket_volatility > 0:
                        bucket_sharpe = statistics.mean(bucket_returns) / bucket_volatility * math.sqrt(252.0)
                bucket_years = ((max(bucket_timestamps) - min(bucket_timestamps)) / 86_400_000.0 / 365.25) if len(bucket_timestamps) > 1 else 0.0
                bucket_trade_count = sum(1 for trade in closed_trades if trade["bucketId"] == bucket["id"])
                bucket_profit = bucket_final - bucket_initial
                bucket["metrics"].update({
                    "initialEquity": bucket_initial, "finalEquity": bucket_final,
                    "profitNotional": bucket_profit,
                    "profitPct": (bucket_profit / bucket_initial * 100.0) if bucket_initial else 0.0,
                    "maxDrawdownDollars": bucket_max_dd,
                    "maxDrawdownPct": bucket_max_dd_pct * 100.0,
                    "sharpe": bucket_sharpe,
                    "profitContributionPct": bucket_profit / initial_capital * 100.0 if initial_capital else 0.0,
                    "tradesPerYear": bucket_trade_count / bucket_years if bucket_years > 0 else None,
                })
                continue
            contribution_curve = bucket.get("contributionCurve", [])
            contribution_timestamps = bucket.get("contributionTimestamps", [])
            bucket_profit = contribution_curve[-1] if contribution_curve else 0.0
            daily_contributions: dict[Any, float] = {}
            for timestamp, contribution in zip(contribution_timestamps, contribution_curve):
                day = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).date()
                daily_contributions[day] = contribution
            daily_contribution_returns = []
            previous_contribution = 0.0
            for day in sorted(daily_contributions):
                current_contribution = daily_contributions[day]
                if initial_capital > 0:
                    daily_contribution_returns.append((current_contribution - previous_contribution) / initial_capital)
                previous_contribution = current_contribution
            bucket_sharpe = None
            if len(daily_contribution_returns) > 1:
                contribution_volatility = statistics.stdev(daily_contribution_returns)
                if contribution_volatility > 0:
                    bucket_sharpe = statistics.mean(daily_contribution_returns) / contribution_volatility * math.sqrt(252.0)
            bucket_trade_count = sum(1 for trade in closed_trades if trade["bucketId"] == bucket["id"])
            bucket["metrics"].update({
                "profitContributionPct": bucket_profit / initial_capital * 100.0 if initial_capital else 0.0,
                "contributionSharpe": bucket_sharpe,
                "tradesPerYear": bucket_trade_count / elapsed_years if elapsed_years > 0 else None,
            })
        total_return = final_equity / starting_equity - 1.0 if starting_equity > 0 else None
        annual_log_return = math.log1p(total_return) / elapsed_years if elapsed_years > 0 and total_return is not None and total_return > -1.0 else None
        cagr = math.expm1(annual_log_return) * 100.0 if annual_log_return is not None and annual_log_return < 709.0 else None
        downside_deviation = math.sqrt(sum(min(value, 0.0) ** 2 for value in daily_returns) / len(daily_returns)) if daily_returns else 0.0
        sortino = statistics.mean(daily_returns) / downside_deviation * math.sqrt(252.0) if downside_deviation > 0 else None
        winning_trades = sum(1 for trade in closed_trades if trade["profit"] > 0)
        losing_trades = sum(1 for trade in closed_trades if trade["profit"] < 0)
        gross_wins = sum(trade["profit"] for trade in closed_trades if trade["profit"] > 0)
        gross_losses = abs(sum(trade["profit"] for trade in closed_trades if trade["profit"] < 0))
        average_win = gross_wins / winning_trades if winning_trades else None
        average_loss = gross_losses / losing_trades if losing_trades else None
        output["metrics"] = {
            "initialEquity": starting_equity, "finalEquity": final_equity,
            "currency": base_currency,
            "maxDrawdownDollars": max_drawdown_dollars, "maxDrawdownPct": max_drawdown_pct * 100.0,
            "profitNotional": final_equity - starting_equity,
            "profitPct": ((final_equity / starting_equity) - 1.0) * 100.0 if starting_equity else 0.0,
            "returnPct": ((final_equity / starting_equity) - 1.0) * 100.0 if starting_equity else 0.0,
            "sharpe": sharpe,
            "cagrPct": cagr,
            "sortino": sortino,
            "sortinoInfinite": bool(daily_returns and downside_deviation == 0 and statistics.mean(daily_returns) > 0),
            "calmar": (cagr / 100.0) / max_drawdown_pct if cagr is not None and max_drawdown_pct > 0 else None,
            "profitFactor": gross_wins / gross_losses if gross_losses > 0 else None,
            "profitFactorInfinite": bool(gross_wins > 0 and gross_losses == 0),
            "winRatio": winning_trades / len(closed_trades) * 100.0 if closed_trades else None,
            "winLossRatio": average_win / average_loss if average_win is not None and average_loss is not None and average_loss > 0 else None,
            "winLossRatioInfinite": bool(winning_trades > 0 and losing_trades == 0),
            "averageProfitPerTrade": sum(trade["profit"] for trade in closed_trades) / len(closed_trades) if closed_trades else None,
            "tradeCount": len(closed_trades),
            "tradesPerYear": len(closed_trades) / elapsed_years if elapsed_years > 0 else None,
            "orders": len(orders),
        }
        output["trades"] = closed_trades
        return output

    scenarios = []
    for scenario_id, scenario_label, raw_output in raw_scenarios:
        processed = process_scenario(raw_output)
        processed["scenarioId"] = scenario_id
        processed["scenarioLabel"] = scenario_label
        scenarios.append(processed)
    if run_mode == "COMPARE_ALL":
        return {"runMode": run_mode, "inputRows": scenarios[0]["inputRows"], "scenarios": scenarios}
    return scenarios[0]
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
                self.send_json(read_workspace_file(
                    {"scope": query.get("scope", [""])[0], "path": query.get("path", [""])[0]},
                    preview=query.get("preview", [""])[0] == "1",
                ))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
            except RuntimeError as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if parsed_path.path == "/api/data/settings":
            relative_path = parse_qs(parsed_path.query).get("path", [""])[0]
            if not relative_path:
                self.send_json({"error": "Choose a data file."}, HTTPStatus.BAD_REQUEST)
                return
            try:
                target = safe_workspace_path(PROJECT_ROOT / "data", relative_path)
                if not target.is_file():
                    raise WorkspaceItemError("Choose a data file.")
                self.send_json(dataset_settings(relative_path))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
            return

        if parsed_path.path == "/api/backtests/trade-chart":
            query = parse_qs(parsed_path.query)
            payload = {key: values[0] for key, values in query.items() if values}
            try:
                self.send_json(read_trade_chart(payload))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
            except ValueError as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except RuntimeError as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if parsed_path.path == "/api/backtests/reference-series":
            query = parse_qs(parsed_path.query)
            payload = {key: values[0] for key, values in query.items() if values}
            try:
                self.send_json(read_benchmark_series(payload))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
            except ValueError as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except RuntimeError as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if parsed_path.path == "/api/strategies/presets":
            strategy_id = parse_qs(parsed_path.query).get("strategyId", [""])[0]
            try:
                self.send_json(get_strategy_presets(strategy_id))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
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
        simple_backtest_configured = False
        grid_search_configured = False
        try:
            with CONFIG_PATH.open(encoding="utf-8") as config_file:
                stored_config = json.load(config_file)
            if isinstance(stored_config, dict):
                simple_backtest_configured = isinstance(stored_config.get("simple_backtest"), dict) or isinstance(stored_config.get("backtest"), dict)
                grid_search_configured = isinstance(stored_config.get("grid_search"), dict)
        except (json.JSONDecodeError, OSError):
            pass
        self.send_json({**config, "builderConfigured": builder_configured, "simpleBacktestConfigured": simple_backtest_configured, "gridSearchConfigured": grid_search_configured})

    def do_PUT(self) -> None:  # noqa: N802
        if self.path not in {"/api/config/builder", "/api/config/backtest", "/api/workspace/items", "/api/workspace/file", "/api/data/settings", "/api/strategies/presets"}:
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

        if self.path == "/api/data/settings":
            try:
                self.send_json(save_dataset_settings(payload))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
            return

        if self.path == "/api/strategies/presets":
            try:
                self.send_json(save_strategy_presets(payload))
            except WorkspaceItemError as error:
                self.send_json({"error": str(error)}, error.status)
            return

        if self.path == "/api/config/backtest":
            mode = payload.get("mode", "simple")
            if mode == "gridsearch":
                settings = payload.get("settings", {})
                if not isinstance(settings, dict):
                    self.send_json({"error": "GridSearch settings must be an object."}, HTTPStatus.BAD_REQUEST)
                    return
                write_backtest_config(settings, mode="gridsearch")
                self.send_json({"grid_search": settings})
                return
            if mode != "simple":
                self.send_json({"error": "Choose simple or gridsearch settings."}, HTTPStatus.BAD_REQUEST)
                return
            settings = {}
            try:
                for key in ("initial_capital", "cost_bps", "fill_latency_seconds"):
                    value = payload[key]
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                        raise ValueError(f"{key} must be a finite number.")
                    settings[key] = value
                if settings["initial_capital"] <= 0 or settings["cost_bps"] < 0 or settings["fill_latency_seconds"] < 0:
                    raise ValueError("Capital must be positive; costs and latency cannot be negative.")
                settings["capital_allocation"] = payload["capital_allocation"]
                if settings["capital_allocation"] not in {"SHARED", "EQUAL_PER_STRATEGY"}:
                    raise ValueError("Choose a valid capital allocation mode.")
                settings["bucket_capital_mode"] = payload["bucket_capital_mode"]
                if settings["bucket_capital_mode"] not in {"SHARED", "INDEPENDENT"}:
                    raise ValueError("Choose a valid bucket capital mode.")
                settings["run_mode"] = payload["run_mode"]
                if settings["run_mode"] not in {"BOTH", "LONG_ONLY", "SHORT_ONLY", "COMPARE_ALL"}:
                    raise ValueError("Choose a valid trade direction mode.")
                settings["base_currency"] = payload["base_currency"]
                if not isinstance(settings["base_currency"], str) or not re.fullmatch(r"[A-Z]{3}", settings["base_currency"]):
                    raise ValueError("Base currency must be a three-letter currency code, such as USD.")
                settings["ignore_currency"] = payload["ignore_currency"]
                if not isinstance(settings["ignore_currency"], bool):
                    raise ValueError("Ignore currency must be enabled or disabled.")
            except (KeyError, TypeError, ValueError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            write_backtest_config(settings, mode="simple")
            self.send_json({"simple_backtest": settings})
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

    def do_DELETE(self) -> None:  # noqa: N802
        if self.path != "/api/workspace/items":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length))
            if not isinstance(payload, dict):
                raise ValueError("Request body must be a JSON object.")
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Request body must be valid JSON."}, HTTPStatus.BAD_REQUEST)
            return
        try:
            self.send_json(delete_workspace_file(payload))
        except WorkspaceItemError as error:
            self.send_json({"error": str(error)}, error.status)

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # The browser may cancel a large preview/reference request when the
            # user changes views or selects another dataset. The disconnected
            # client is normal; it should not produce a server traceback.
            return

    def log_message(self, format: str, *args: Any) -> None:
        """Keep normal browser requests out of the terminal."""


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 8000), ConfigHandler)
    print("Quantogral API listening at http://127.0.0.1:8000")
    server.serve_forever()


if __name__ == "__main__":
    main()
