"""Tests for the local source/data file editor API helpers."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import polars as pl

from quantogral.api.server import PROJECT_ROOT, read_workspace_file, save_workspace_file


class WorkspaceEditorTests(unittest.TestCase):
    def test_text_file_can_be_opened_and_saved(self) -> None:
        with tempfile.TemporaryDirectory(dir=PROJECT_ROOT) as temporary:
            root = Path(temporary)
            target = root / "strategy.hpp"
            target.write_text("int value = 1;\n", encoding="utf-8")
            with patch("quantogral.api.server.workspace_root", return_value=root):
                opened = read_workspace_file({"scope": "builder", "path": "strategy.hpp"})
                self.assertEqual(opened["content"], "int value = 1;\n")
                save_workspace_file({"scope": "builder", "path": "strategy.hpp", "content": "int value = 2;\n"})
            self.assertEqual(target.read_text(encoding="utf-8"), "int value = 2;\n")

    def test_parquet_rows_can_be_edited_and_round_trip(self) -> None:
        with tempfile.TemporaryDirectory(dir=PROJECT_ROOT) as temporary:
            root = Path(temporary)
            target = root / "prices.parquet"
            pl.DataFrame({"timestamp": [1, 2], "close": [10.5, 12.0]}).write_parquet(target)
            with patch("quantogral.api.server.workspace_root", return_value=root):
                opened = read_workspace_file({"scope": "data", "path": "prices.parquet"})
                document = json.loads(opened["content"])
                document["rows"][0]["close"] = 11.25
                save_workspace_file({"scope": "data", "path": "prices.parquet", "content": json.dumps(document)})
            result = pl.read_parquet(target)
            self.assertEqual(result["close"].to_list(), [11.25, 12.0])


if __name__ == "__main__":
    unittest.main()
