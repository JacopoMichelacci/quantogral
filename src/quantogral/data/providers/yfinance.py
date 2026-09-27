"""Yahoo Finance market-data integration."""

import quantolib as ql


def download_ohlcv() -> None:
    """Download OHLCV data through Quantolib's Yahoo Finance provider."""
    ql.pull_ohlcv_yf()


if __name__ == '__main__':
    download_ohlcv()
