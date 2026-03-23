from datetime import datetime
import pandas as pd
import numpy as np

from .market_event_base import MarketEvent


class OHLCVEvent(MarketEvent):
    def __init__(
        self,
        ts: datetime | pd.Timestamp | np.datetime64,
        symbol: str,
        open_: float,
        high_: float,
        low_: float,
        close_: float,
        volume_: float,
    ):
        super().__init__(ts=ts, symbol=symbol)
        self.open_ = open_
        self.high_ = high_
        self.low_ = low_
        self.close_ = close_
        self.volume_ = volume_

    def _set_event_type(self) -> str:
        return "ohlcv"

    def __repr__(self) -> str:
        return (f"OHLCVEvent(ts_={self.ts_!r}, symbol_={self.symbol_!r}," 
                f"open_={self.open_}, high_={self.high_}, " 
                f"low_={self.low_}, close_={self.close_}," 
                f"volume_={self.volume_}, event_type_={self.event_type_!r})")