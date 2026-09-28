"""Yahoo Finance symbol search and historical OHLCV downloads."""

from __future__ import annotations

import re
import os
import tempfile
from datetime import date, timedelta
from pathlib import Path
from typing import Any

YAHOO_INTERVALS = (
    "1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h",
    "1d", "5d", "1wk", "1mo", "3mo",
)
YAHOO_FORMATS = {"csv", "parquet"}
INTRADAY_MAX_DAYS = {"1m": 8, "2m": 60, "5m": 60, "15m": 60, "30m": 60, "90m": 60, "60m": 730, "1h": 730}


class DataAlreadyExistsError(FileExistsError):
    """A data file exists and needs explicit user confirmation before replacement."""

    def __init__(self, filename: str):
        self.output_filename = filename
        super().__init__(f"{filename} already exists in the selected folder.")


def _yfinance():
    try:
        import yfinance as yf
    except ImportError as error:
        raise RuntimeError("Yahoo Finance downloads need yfinance. Run `uv sync` and restart Quantogral.") from error
    return yf


def search_yahoo_symbols(query: str) -> list[dict[str, str]]:
    query = query.strip()
    if len(query) < 2:
        return []
    yf = _yfinance()
    search = yf.Search(query, max_results=8, news_count=0, lists_count=0, include_cb=False, timeout=15)
    results = []
    for quote in search.quotes or []:
        symbol = str(quote.get("symbol") or "").strip()
        if not symbol:
            continue
        results.append({
            "symbol": symbol,
            "name": str(quote.get("shortname") or quote.get("longname") or symbol),
            "type": str(quote.get("quoteType") or "Instrument"),
            "exchange": str(quote.get("exchange") or quote.get("exchDisp") or ""),
        })
    return results


def download_yahoo_history(
    *, ticker: str, interval: str, start_date: str, end_date: str, file_format: str,
    destination: str | Path, filename_template: str | None = None, overwrite_filenames: set[str] | None = None,
) -> dict[str, Any]:
    """Download one Yahoo symbol and write its OHLCV rows without overwriting files."""
    if not isinstance(ticker, str):
        raise ValueError("Enter a valid Yahoo Finance ticker symbol.")
    ticker = ticker.strip().upper()
    if not ticker or len(ticker) > 32 or not re.fullmatch(r"[A-Z0-9.^=_-]+", ticker):
        raise ValueError("Enter a valid Yahoo Finance ticker symbol.")
    if not isinstance(interval, str) or interval not in YAHOO_INTERVALS:
        raise ValueError("Choose one of Yahoo Finance's supported data intervals.")
    if not isinstance(file_format, str):
        raise ValueError("Choose CSV or Parquet format.")
    file_format = file_format.lower()
    if file_format not in YAHOO_FORMATS:
        raise ValueError("Choose CSV or Parquet format.")
    try:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
    except (TypeError, ValueError) as error:
        raise ValueError("Enter valid start and end dates.") from error
    today = date.today()
    if start > end:
        raise ValueError("Start date must be on or before end date.")
    if end > today:
        raise ValueError("End date cannot be in the future.")
    max_days = INTRADAY_MAX_DAYS.get(interval)
    if max_days is not None and start < today - timedelta(days=max_days):
        raise ValueError(f"Yahoo Finance only provides recent {interval} data (approximately the last {max_days} days). Choose a later start date or a daily interval.")

    directory = Path(destination).expanduser().resolve(strict=True)
    if not directory.is_dir():
        raise ValueError("Choose an existing destination folder.")

    yf = _yfinance()
    try:
        frame = yf.download(
            ticker,
            start=start.isoformat(),
            end=(end + timedelta(days=1)).isoformat(),
            interval=interval,
            actions=False,
            auto_adjust=False,
            progress=False,
            threads=False,
            ignore_tz=False,
            multi_level_index=False,
            timeout=30,
        )
    except Exception as error:
        raise RuntimeError(f"Yahoo Finance could not download {ticker}: {error}") from error
    if frame is None or frame.empty:
        raise ValueError(f"Yahoo Finance returned no rows for {ticker} in that date range and interval.")

    filename_symbol = re.sub(r"[^A-Z0-9_-]+", "_", ticker).strip("_") or "instrument"
    provider_timezone = getattr(getattr(getattr(frame, "index", None), "tz", None), "zone", None)
    if provider_timezone is None:
        timezone_value = getattr(getattr(frame, "index", None), "tz", None)
        provider_timezone = str(timezone_value) if timezone_value else "unknown"
    timezone_slug = re.sub(r"[^A-Za-z0-9_-]+", "_", provider_timezone).strip("_") or "unknown"
    filename_template = filename_template or "{name}_{ts}_{startdate}_{enddate}_{tz}_{provider}.{extension}"
    if not isinstance(filename_template, str) or not filename_template.strip():
        raise ValueError("Enter a filename pattern.")
    values = {
        "name": filename_symbol,
        "symbol": filename_symbol,
        "interval": interval,
        "ts": interval,
        "start": start.strftime("%Y-%m-%d"),
        "startdate": start.strftime("%Y-%m-%d"),
        "end": end.strftime("%Y-%m-%d"),
        "enddate": end.strftime("%Y-%m-%d"),
        "provider": "yfinance",
        "tz": timezone_slug,
        "timezone": timezone_slug,
        "extension": file_format,
    }
    try:
        filename = filename_template.format_map(values)
    except (KeyError, ValueError) as error:
        raise ValueError(f"Filename pattern has an unknown or malformed field: {error}.") from error
    if filename in {"", ".", ".."} or Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise ValueError("Filename pattern must produce a filename, not a path.")
    if Path(filename).suffix.lower() != f".{file_format}":
        raise ValueError(f"Filename must end in .{file_format} to match the selected file format.")
    output_path = directory / filename
    overwrite = overwrite_filenames is not None and filename in overwrite_filenames
    rows = len(frame)
    temporary_path = None
    created_new_file = False
    try:
        if overwrite:
            descriptor, temporary_name = tempfile.mkstemp(prefix=f".{filename}.", suffix=".tmp", dir=directory)
            temporary_path = Path(temporary_name)
            output_file = os.fdopen(descriptor, "wb")
        else:
            output_file = output_path.open("xb")
            created_new_file = True
        with output_file:
            data = frame.rename_axis("timestamp").reset_index()
            if file_format == "csv":
                data.to_csv(output_file, index=False)
            else:
                data.to_parquet(output_file, index=False, engine="pyarrow")
        if temporary_path is not None:
            os.replace(temporary_path, output_path)
            overwrite_filenames.discard(filename)
    except FileExistsError as error:
        raise DataAlreadyExistsError(filename) from error
    except Exception as error:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        elif created_new_file:
            output_path.unlink(missing_ok=True)
        if file_format == "parquet" and "pyarrow" in str(error).lower():
            raise RuntimeError("Parquet output needs PyArrow. Run `uv sync` and restart Quantogral.") from error
        raise RuntimeError(f"Could not save the downloaded data: {error}") from error

    return {"ticker": ticker, "rows": rows, "filename": filename, "path": str(output_path), "format": file_format, "timezone": provider_timezone}
