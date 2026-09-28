# Quantogral

Quantogral is a source-available, self-hosted quantitative trading workstation for building, testing, evaluating, and eventually deploying C++ trading strategies and indicators. Python is used for research analysis, reports, and supporting tools.

The goal is to provide a clean, extensible, local-first research environment where users can develop ideas, run reproducible backtests, analyze results in a polished web dashboard, and later connect strategies to paper or live trading infrastructure.

## Currently Available

- A locally hosted React/Vite dashboard development server, started from the repository root with `./start.sh`.
- A clean Home launch screen with Backtesting, Code Workspace, and Data Download tiles. Data Download opens a provider chooser with a Yahoo Finance tile and a provider page marked “In progress”; the project explorer is available on both pages. The Code Workspace includes a Viewer tile marked “In progress.” The collapsible project explorer appears on Code Workspace, Simple Backtesting, Data Download, Yahoo Finance, and the parked GridSearch screen, with distinct folder and header icons; supported C++ strategy headers can be dragged from it into a backtest.
- A **More** screen in the main navigation. Settings opens a General page with a Light/Dark appearance choice saved in the local browser; Profile remains marked “In progress.” More also credits Jacopo Michelacci and links to his LinkedIn profile.
- Home offers Backtesting and Code Workspace entry points. Backtesting offers Simple Backtesting and GridSearch. GridSearch remains a placeholder and is parked while the first single-run workflow is built.
- Simple Backtesting lets users assemble multiple registered strategies and CSV/Parquet data files from the project explorer. Each strategy appears as a collapsed row that expands to its own base and strategy-specific settings. The current C++ runner still executes one strategy and one file per run; multi-item execution behavior remains to be built. CSV header rows are detected automatically. Its compact gear menu holds starting capital (default 100,000) and transaction cost (default 0 bps); saved values persist in the local browser.
- The Builder settings control offers Builder-path configuration and Manage Compilation. Compile All runs from the compilation panel; Compile Selected switches the project explorer into strategy-selection mode with Cancel and Compile actions, plus a live list of selected strategies in the main pane. Compiled artifacts are kept under the ignored `.quantogral/build/` directory.
- Back and Home arrows connect Home, Backtesting, Simple Backtesting, GridSearch, and Code Workspace pages.
- A Builder workspace that defaults its root to `./cpp/include/builder`, with `strategies/` and `indicators/` beneath it. Hover over **Builder** in the project explorer and select its settings control to change the path or manage compilation.
- The project explorer remembers its expanded/collapsed state, width, Builder expansion, and expanded folders in the local browser. Its expanded width is adjustable from 220 to 420 pixels. Folder/file settings actions can create folders (`foldername/`) or empty files (`filename.ext`) at that level and rename existing items without overwriting; changes are restricted to the configured Builder root or project `data/` folder. The root-level `data/` folder shows the project's local files and subfolders. **Collapse all** restores the default tree view: Builder expanded, strategy and indicator folders collapsed, and `data/` collapsed.
- A local Python API that saves the selected Builder path in `.quantogral/config.json`; this workspace state stays on the user's machine and is ignored by Git.
- An initial C++ strategy/indicator slice: shared market, order, price-field, and timestamp headers; header-only SMA and standard-deviation indicators; and an OHLCV moving-average-cross strategy. A compiled C++ runner and initial backtest engine are under `cpp/`.
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
- A Python source package under `src/quantogral/`, with foundational quantitative-research dependencies and an initial Yahoo Finance OHLCV provider integration.
- Initial C++ strategy and indicator base headers, two built-in indicator templates, and one OHLCV built-in strategy have been brought into the project. The remaining thesis code stays archived separately until it is integrated deliberately.

Quantogral is in very early development. Simple Backtesting is an initial working slice for one registered OHLCV strategy; broader strategy registration/compilation, flexible data discovery, portfolio backtesting, result analysis, paper trading, and broker connections remain to be built.

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
- **C++ strategy engine:** Strategies and indicators are C++ `.hpp` headers. The initial Simple Backtesting runner compiles registered strategies and executes them locally; broader custom-strategy registration and runtime management remain future work.
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
