"""Offline tests for Yahoo Finance request validation and file writing."""

from __future__ import annotations

import sys
import tempfile
import types
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from quantogral.data.providers.yfinance import download_yahoo_history, search_yahoo_symbols


class FakeFrame:
    empty = False
    index = types.SimpleNamespace(tz=types.SimpleNamespace(zone="America/New_York"))

    def __len__(self) -> int:
        return 3

    def rename_axis(self, name: str) -> FakeFrame:
        if name != "timestamp":
            raise AssertionError(f"Unexpected index name: {name}")
        return self

    def reset_index(self) -> FakeFrame:
        return self

    def to_csv(self, output_file, index: bool) -> None:
        if index:
            raise AssertionError("The timestamp should be a data column, not a second index.")
        output_file.write(b"timestamp,Open,High,Low,Close,Volume\n")

    def to_parquet(self, output_file, index: bool, engine: str) -> None:
        if index or engine != "pyarrow":
            raise AssertionError("Parquet output must use a flat table with PyArrow.")
        output_file.write(b"PAR1-fake-parquet")


class YahooFinanceProviderTests(unittest.TestCase):
    def fake_yfinance(self) -> types.ModuleType:
        module = types.ModuleType("yfinance")
        module.download_calls = []

        def download(ticker, **kwargs):
            module.download_calls.append({"ticker": ticker, **kwargs})
            return FakeFrame()

        class Search:
            def __init__(self, query, **kwargs):
                self.query = query
                self.quotes = [{"symbol": "AAPL", "shortname": "Apple Inc.", "quoteType": "EQUITY", "exchange": "NMS"}]

        module.download = download
        module.Search = Search
        return module

    def test_download_writes_csv_and_treats_end_date_as_inclusive(self) -> None:
        fake_yfinance = self.fake_yfinance()
        today = date.today().isoformat()
        with tempfile.TemporaryDirectory() as temporary, patch.dict(sys.modules, {"yfinance": fake_yfinance}):
            result = download_yahoo_history(
                ticker="aapl", interval="1d", start_date=today, end_date=today,
                file_format="csv", destination=temporary,
            )
            output_path = Path(result["path"])
            self.assertTrue(output_path.is_file())
            self.assertEqual(output_path.name, f"AAPL_1d_{today}_{today}_America_New_York_yfinance.csv")
            self.assertEqual(result["timezone"], "America/New_York")
            self.assertEqual(result["rows"], 3)
            self.assertEqual(fake_yfinance.download_calls[0]["end"], (date.today() + timedelta(days=1)).isoformat())
            self.assertFalse(fake_yfinance.download_calls[0]["auto_adjust"])

    def test_existing_output_is_never_overwritten(self) -> None:
        fake_yfinance = self.fake_yfinance()
        today = date.today().isoformat()
        with tempfile.TemporaryDirectory() as temporary, patch.dict(sys.modules, {"yfinance": fake_yfinance}):
            args = {"ticker": "AAPL", "interval": "1d", "start_date": today, "end_date": today, "file_format": "csv", "destination": temporary}
            result = download_yahoo_history(**args)
            output_path = Path(result["path"])
            original = output_path.read_bytes()
            with self.assertRaises(FileExistsError):
                download_yahoo_history(**args)
            self.assertEqual(output_path.read_bytes(), original)

    def test_confirmed_overwrite_replaces_only_the_named_file(self) -> None:
        fake_yfinance = self.fake_yfinance()
        today = date.today().isoformat()
        filename = f"AAPL_1d_{today}_{today}_America_New_York_yfinance.csv"
        with tempfile.TemporaryDirectory() as temporary, patch.dict(sys.modules, {"yfinance": fake_yfinance}):
            output_path = Path(temporary) / filename
            output_path.write_text("old data", encoding="utf-8")
            result = download_yahoo_history(
                ticker="AAPL", interval="1d", start_date=today, end_date=today,
                file_format="csv", destination=temporary, overwrite_filenames={filename},
            )
            self.assertEqual(Path(result["path"]).read_text(encoding="utf-8"), "timestamp,Open,High,Low,Close,Volume\n")
            self.assertEqual(list(Path(temporary).iterdir()), [output_path])

    def test_intraday_lookback_is_validated(self) -> None:
        today = date.today()
        with self.assertRaisesRegex(ValueError, "recent 1m data"):
            download_yahoo_history(
                ticker="AAPL", interval="1m", start_date=(today - timedelta(days=9)).isoformat(),
                end_date=today.isoformat(), file_format="csv", destination=".",
            )

    def test_symbol_search_returns_provider_symbols(self) -> None:
        fake_yfinance = self.fake_yfinance()
        with patch.dict(sys.modules, {"yfinance": fake_yfinance}):
            results = search_yahoo_symbols("Apple")
        self.assertEqual(results[0], {"symbol": "AAPL", "name": "Apple Inc.", "type": "EQUITY", "exchange": "NMS"})


if __name__ == "__main__":
    unittest.main()
