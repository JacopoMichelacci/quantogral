from abc import ABC, abstractmethod
from datetime import datetime
import pandas as pd
import numpy as np


class MarketEvent(ABC):
    def __init__(self, 
                 ts: datetime | pd.Timestamp | np.datetime64,
                 symbol: str,
    ):
        self.ts_ = self._normalize_ts(ts)
        self.symbol_ = symbol.strip().lower()
        self.event_type_ = self._set_event_type().strip().lower()
    
    @abstractmethod
    def _set_event_type(self) -> str:
        pass
    
    @abstractmethod
    def __repr__(self) -> str:
        pass

    @staticmethod
    def _normalize_ts(ts: datetime | pd.Timestamp | np.datetime64) -> datetime:
        if isinstance(ts, datetime):
            return ts
        if isinstance(ts, pd.Timestamp):
            return ts.to_pydatetime()
        if isinstance(ts, np.datetime64):
            return pd.Timestamp(ts).to_pydatetime()
        raise TypeError(f"Unsupported timestamp type: {type(ts)}")