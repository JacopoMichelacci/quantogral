# Quantogral

Quantogral is a source-available, self-hosted quantitative trading workstation for building, testing, evaluating, and eventually deploying C++ trading strategies and indicators. Python is used for research analysis, reports, and supporting tools.

The goal is to provide a clean, extensible, local-first research environment where users can develop ideas, run reproducible backtests, analyze results in a polished web dashboard, and later connect strategies to paper or live trading infrastructure.

## Currently Available

- A locally hosted React/Vite dashboard development server, started from the repository root with `./start.sh`. Run `uv sync` once first to create/update the local Python environment and install provider support.
- A clean Home launch screen with Backtesting, Code Workspace, and Data Download tiles. Data Download opens a provider chooser with Yahoo Finance; its form searches and selects multiple provider symbols, downloads one file per symbol in Parquet by default (CSV is also available), and lets users set the interval, inclusive date range, and destination folder (typed path or selected from the data sidebar). It reports per-instrument download progress. The filename pattern is editable, defaults to `{name}_{ts}_{startdate}_{enddate}_{tz}_{provider}.{extension}` (`ts` is the selected interval, `tz` the detected exchange timezone); filename collisions prompt for overwrite confirmation, and confirmed replacements are atomic. The collapsible project explorer appears on Code Workspace, Simple Backtesting, Data Download, Yahoo Finance, and the parked GridSearch screen; supported C++ strategy headers and local market-data files can be dragged from it into a backtest.
- A **More** screen in the main navigation. Settings opens a General page with a Light/Dark appearance choice saved in the local browser; Profile remains marked “In progress.” More also credits Jacopo Michelacci and links to his LinkedIn profile.
- Home offers Backtesting and Code Workspace entry points. Backtesting offers Simple Backtesting and GridSearch. GridSearch remains a placeholder and is parked while the first single-run workflow is built.
- Backtest settings are available in an expandable inline panel at the top of the Backtesting, Simple Backtesting, and GridSearch pages. Total starting capital (default 100,000), transaction cost (default 0 bps), capital allocation, fill latency (default 0 seconds), trade direction mode, portfolio currency (default USD), and the Ignore currency option persist in `.quantogral/config.json`. Choose Long and short, Long only, Short only, or Compare all three. Compare all runs three isolated scenarios. Fill latency is for quote/tick event backtests; the current dashboard accepts OHLCV data and fills at the next bar open.
- Simple Backtesting lets users create feed buckets, then drag multiple strategies and CSV/Parquet feeds from the project explorer into each bucket. Each strategy instance can subscribe to one or more feeds in its bucket, and its row expands to show feed connections, base settings, and strategy-specific settings. The runner merges events across all buckets in timestamp order and shares one starting-capital pool across every strategy. The equal-per-strategy option divides that same total capital across all strategy instances, regardless of bucket. Feed rows include timestamp-unit and date-order settings. Results show the single portfolio’s equity and performance, with orders tagged by their bucket and strategy instance; each bucket also shows its attributed profit contribution (% of total starting capital), contribution Sharpe, and completed trades per year. These are attribution metrics within the shared portfolio, not standalone bucket accounts. When a bucket contains assets whose currency differs from the portfolio currency, the user can add matching FX history to that bucket and set its base/quote pair there. FX history is never fetched automatically. **Reset backtest** clears the current buckets, strategies, feeds, and results while preserving saved run settings.
- Backtest reports appear below bucket results in General Report, Performance, Trades, and Order Log tabs. The equity and dollar/percent drawdown plots use every recorded point; with OHLCV data, points are valued at each bar close and include unrealized P&L. The aligned plots show six UTC dates as `DD/MM/YY` on the bottom axis. Hovering shows the nearest observation's equity, profit in currency and percent, and drawdown. Performance metrics include Sharpe, Sortino, CAGR, Calmar, profit factor, profit notional and percent, maximum drawdown in dollars and percent, win ratio, average win/loss ratio, average profit per completed trade, closed-trade count, and trades per year. Sharpe and Sortino use annualized daily UTC returns with √252; the win/loss ratio is average winning trade divided by the absolute average losing trade. Profit notional includes open mark-to-market P&L.
- The Builder settings control offers Builder-path configuration and Manage Compilation. Compile All runs from the compilation panel; Compile Selected switches the project explorer into strategy-selection mode with Cancel and Compile actions, plus a live list of selected strategies in the main pane. Compiled artifacts are kept under the ignored `.quantogral/build/` directory.
- Back and Home arrows connect Home, Backtesting, Simple Backtesting, GridSearch, and Code Workspace pages.
- A Builder workspace that defaults its root to `./cpp/include/builder`, with `strategies/` and `indicators/` beneath it. Hover over **Builder** in the project explorer and select its settings control to change the path or manage compilation.
- Code Workspace opens supported C/C++ and text files plus CSV and Parquet data files from the left explorer. Text/CSV files use a local editor; Parquet rows are presented as editable JSON while preserving the existing columns and data types. CSV files have a table preview and a text-editor mode for exact edits (the preview shows all rows up to 200, or the first and last 100 rows for larger files). The editor shows line numbers, keeps long text rows on one horizontally scrollable line, and lightly stripes data rows. Ctrl+S (or ⌘S on Mac) saves. Save writes changes atomically; leaving or switching files with unsaved edits prompts to Save, Don’t Save, or Cancel. Files over 8 MB and Parquet files over 5,000 rows are not opened in the editor.
- The project explorer remembers its expanded/collapsed state, width, Builder expansion, and expanded folders in the local browser. Its expanded width is adjustable from 220 to 420 pixels. Folder/file settings actions can create folders (`foldername/`) or empty files (`filename.ext`) at that level, rename existing items without overwriting, preview code/text/CSV/Parquet in a read-only popup, and delete individual files after explicit confirmation; folders cannot be deleted from the explorer. Large Parquet previews show the first and last 500 rows without loading the whole table into the UI. Changes are restricted to the configured Builder root or project `data/` folder. The root-level `data/` folder shows the project's local files and subfolders. **Collapse all** restores the default tree view: Builder expanded, strategy and indicator folders collapsed, and `data/` collapsed.
- Data file settings store an editable timezone and asset currency in `.quantogral/dataset-settings.json`, without editing the market-data file. A file’s role comes from where it is used: normal feed rows treat it as asset data, while the bucket’s FX-history section treats it as conversion data and lets the user choose its base/quote pair. Explicit timestamp offsets are honored; timezone-less values use the saved IANA timezone. Strategy presets are stored per strategy in `.quantogral/strategy-presets.json`; the last saved preset is applied to newly added instances and can be selected from each instance’s settings control. When a preset schema changes, values with matching field names and types are preserved, new or changed fields use current defaults, and removed fields are dropped.
- A local Python API that saves the selected Builder path and Simple Backtesting settings in `.quantogral/config.json`; data settings and strategy presets stay on the user's machine and are ignored by Git. Include the `.quantogral/` settings files in a manual workspace backup to carry them to another machine.
- An initial C++ strategy/indicator slice: shared market, order, price-field, and timestamp headers; header-only SMA and standard-deviation indicators; and an OHLCV moving-average-cross strategy. A compiled C++ runner and initial backtest engine are under `cpp/`.
- The C++ backtest core and dashboard/API runner support feed buckets: each bucket groups timestamp-sorted OHLCV feeds and dispatches events to its subscribed strategies, while one global timeline and cash pool spans all buckets. Strategies can subscribe to multiple feeds. Capital is shared across all strategy instances by default; the UI can instead split total capital evenly among all strategies. Long-only and short-only modes restrict order execution globally while retaining each strategy's own direction settings; Long and short leaves each strategy's decisions as configured. The API normalizes CSV and Parquet timestamps to UTC using each dataset’s timezone settings, compresses user-provided FX history to daily observations when available or monthly observations for sparser files, and aligns rates backward to asset events. It rejects FX files that do not cover the asset date range or contain gaps longer than five days for daily data or 45 days for monthly data. Cash flows, fees, position marks, and report currency use the selected portfolio currency; strategy OHLC prices remain in their native currency. FX conversion rates live in backtest feed metadata, outside OHLCVEvent and OrderEvent; strategies receive ordinary native-currency market prices and can request fractional sizing through the helpers on StrategyContext. Ignore currency treats every feed as the portfolio currency. OHLCV fills remain next-bar-open; quote/tick fill latency is implemented in the C++ core but quote/tick feeds are not yet available in the dashboard.
- A default Builder directory structure:

  ```text
  cpp/include/builder/
  ├── strategies/
  │   ├── strategy_base.hpp  # Shared interface for built-in and custom strategies
  │   ├── built-in/
  │   │   └── ma_cross.hpp
  │   └── custom/    # User-owned strategies; Quantogral never changes these
  └── indicators/
      ├── indicator_base.hpp  # Shared interface for built-in and custom indicators
      ├── built-in/
      │   ├── moving_average.hpp
      │   └── standard_deviation.hpp
      └── custom/    # User-owned indicators; Quantogral never changes these
  ```
- Shared non-Builder C++ dependencies live under `cpp/include/core/` and `cpp/include/utils/`; compiled core definitions live under `cpp/src/core/`.
- A local `data/` directory for downloaded and imported market data. Its internal folder structure and naming are intentionally user-defined; its contents are ignored by Git by default.
- A Python source package under `src/quantogral/`, with foundational quantitative-research dependencies and a Yahoo Finance OHLCV downloader using yfinance. Yahoo symbol search returns provider results; actual availability and intraday history windows depend on Yahoo Finance.
- Initial C++ strategy and indicator base headers, two built-in indicator templates, and one OHLCV built-in strategy have been brought into the project. The remaining thesis code stays archived separately until it is integrated deliberately.

Quantogral is in very early development. Simple Backtesting now exposes the C++ bucket plan for OHLCV strategies and CSV/Parquet feeds. Flexible data discovery, result analysis, paper trading, and broker connections remain to be built.

### Adding a backtestable C++ strategy

OHLCV strategy headers under `cpp/include/builder/strategies/` are discovered automatically. The build step reads the class and its ordinary C++ `Config` fields, then generates the UI controls and constructor adapter under `.quantogral/build/`. Strategy authors do not write UI schemas, factories, registration macros, or Python catalog entries. Once compiled, the strategy appears in the Builder tree and can be dragged into Simple Backtesting.

The small C++ convention is: derive one class from `Strategy<OHLCVEvent>`, expose its parameter type as `using Config = YourConfigType;`, give every supported config field a default value, and provide a constructor `(const Config&, StrategyConfig)`. The constructor can use the header filename as its strategy name through the existing base-class name fallback. Config fields can use `bool`, numeric, `std::string`, and enums declared in project headers; an empty config is fine for strategies with no strategy-specific settings. The header filename becomes its stable ID and a readable UI name. See `cpp/include/builder/strategies/built-in/ma_cross.hpp` for an example. The current bucket UI and runner support OHLCV strategies, multiple feeds, and multiple strategy instances per bucket.

## Product Vision

A user should be able to clone the repository, start Quantogral locally, and use it as their personal quantitative research and trading workspace.

The product combines a code-first strategy engine with a high-quality local web interface:

```text
Strategy source and configuration
        ↓
Data + backtesting engine
        ↓
Stored run artifacts (trades, metrics, equity curves, logs)
        ↓
Local dashboard for analysis, comparison, and monitoring
        ↓
Paper/live execution service → broker adapter → user's broker account
```

Quantogral is not intended to be a broker, data vendor, or hosted custody platform. Users retain control of their code, data, infrastructure, and broker credentials.

### Local portability

Quantogral does not require a hosted account or cloud sync. To continue working on another machine, a user can archive the entire Quantogral project folder, transfer it, extract it on the other machine, and run `./start.sh`.

The archive should include the hidden `.quantogral/` directory (local workspace configuration), `cpp/include/builder/strategies/custom/` and `cpp/include/builder/indicators/custom/` (user headers), and `data/` (local datasets) when those are needed on the second machine.

## Intended Workflow

1. Create or add a strategy in C++.
2. Import or connect historical market data.
3. Configure and run a reproducible backtest.
4. Analyze trades, performance metrics, equity curves, logs, and risk statistics with Python tools and the local dashboard.
5. Compare runs and iterate through strategy parameters.
6. Move a validated strategy to paper trading.
7. Optionally connect the user's own broker account for live execution, with robust safety controls.

## In Development

The following is the planned development path. Items move to **Currently Available** only once they are implemented and usable.

### 1. Local dashboard foundation

Establish the first locally hosted React dashboard and its visual system. The initial home screen should make a new workspace understandable at a glance, with navigation for Home, Strategies, Backtests, Data, Portfolio, and Settings; realistic example run data; and a clear path to a first backtest.

The visual direction is a calm, professional dark workstation: readable data density, restrained use of color, and no speculative-trading or "crypto casino" aesthetic.

### 2. Research MVP

Build the core research loop: strategy project structure, historical-data import, reproducible backtest execution, run management, and excellent result views for metrics, trades, equity curves, and logs.

### 3. Iteration tools

Add experiment history, run and strategy comparisons, parameter sweeps, and workflows that make research iteration fast and traceable.

### 4. Paper trading

Add a persistent paper-trading runner, simulated account and positions, live-market-data support where available, and operational monitoring from the dashboard.

### 5. Broker integrations and live operations

Connect to user-owned broker accounts through adapters. Live trading must include encrypted local credential storage, order and position reconciliation, risk limits, alerts, audit logs, a kill switch, and recovery after restarts.

## Architectural Principles

- **Local-first:** Quantogral runs on the user's machine or infrastructure; the browser dashboard is served locally.
- **Separate source from data:** Python application code lives under `src/quantogral/`, C++ code under `cpp/`, and downloaded/imported local datasets under `data/` (not committed to Git).
- **C++ strategy engine:** Strategies and indicators are C++ `.hpp` headers. OHLCV strategy headers are discovered recursively, compiled into the local runner, shown in the strategy catalog, and can be dragged into Simple Backtesting buckets with multiple feeds and strategy instances.
- **Python for research analysis:** Python handles analysis, reporting, and supporting research tools around the C++ engine.
- **Keep languages in their lanes:** C++ strategy/indicator headers and Builder folders belong under `cpp/include/builder/`; Python API, data-provider, analysis, and reporting code belongs under `src/quantogral/`.
- **Header-based strategies and indicators:** Strategy and indicator implementations stay in `.hpp` files; they are header-based templates in the current thesis code.
- **Dashboard as workflow layer:** The web UI orchestrates and explains the workflow; it is not only a static results viewer.
- **Clear separation of concerns:** Backtests run as on-demand jobs, while paper/live execution runs in a durable service that survives browser closes and reconciles state with the broker.
- **Research before execution:** The first releases prioritize a delightful and trustworthy backtesting experience over broad broker or data-provider abstractions.
- **Respect user code:** Built-in content is maintained by Quantogral; content in `custom/` is user-owned and is never modified by Quantogral updates.
- **Safety by design:** Live-trading functionality is introduced deliberately, with operational controls built in rather than added later.

## License

This project is source-available, not open-source.

You may view, run, and modify the software for personal, educational, and evaluation purposes only. Commercial use, redistribution, resale, rebranding, or incorporation into commercial products or services is prohibited without explicit written permission.

See the [LICENSE](./LICENSE) file for full terms.
