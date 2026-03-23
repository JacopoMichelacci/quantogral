from datetime import datetime
import pandas as pd
import numpy as np

from .market_event_base import MarketEvent


class QuoteEvent(MarketEvent):
    def __init__(
        self,
        ts: datetime | pd.Timestamp | np.datetime64,
        symbol: str,
        bid_: float,
        ask_: float,
        bid_size_: float | None = None,
        ask_size_: float | None = None,
    ):
        super().__init__(ts=ts, symbol=symbol)
        self.bid_ = bid_
        self.ask_ = ask_
        self.bid_size_ = bid_size_
        self.ask_size_ = ask_size_

    
    def _set_event_type(self) -> str:
        return "quote"
    

    def __repr__(self) -> str:
        return (
            f"QuoteEvent(ts_={self.ts_!r}, symbol_={self.symbol_!r}, "
            f"bid_={self.bid_}, ask_={self.ask_}, "
            f"bid_size_={self.bid_size_}, ask_size_={self.ask_size_}, "
            f"event_type_={self.event_type_!r})"
        )