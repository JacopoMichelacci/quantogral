# Quantogral

Quantogral is a source-available, self-hosted quantitative trading workstation for building, testing, evaluating, and eventually deploying trading strategies written in Python and C++.

The goal is to provide a clean, extensible, local-first research environment where users can develop ideas, run reproducible backtests, analyze results in a polished web dashboard, and later connect strategies to paper or live trading infrastructure.

## Currently Available

- A locally hosted React/Vite dashboard development server, started from the repository root with `./start.sh`.
- A Home-only, collapsible project explorer with a **Builder** folder and `strategies` and `indicators` subfolders.
- A first-run Builder setup screen that defaults the Python strategy root to `./builder/strategies` and remembers a chosen path in the browser.
- A default Builder directory structure:

  ```text
  builder/
  ├── strategies/
  │   ├── built-in/  # Strategies shipped and maintained by Quantogral
  │   └── custom/    # User-owned strategies; Quantogral never changes these
  └── indicators/
      ├── built-in/  # Indicators shipped and maintained by Quantogral
      └── custom/    # User-owned indicators; Quantogral never changes these
  ```
- A local `data/` directory for downloaded and imported market data. Its internal folder structure and naming are intentionally user-defined; its contents are ignored by Git by default.
- A Python source package under `src/quantogral/`, with foundational quantitative-research dependencies and an initial Yahoo Finance OHLCV provider integration.

Quantogral is in very early development. Strategy management, backtesting, result analysis, paper trading, and broker connections are not implemented yet.

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

## Intended Workflow

1. Create or add a strategy in Python or C++.
2. Import or connect historical market data.
3. Configure and run a reproducible backtest.
4. Inspect trades, performance metrics, equity curves, logs, and risk statistics in the local dashboard.
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
- **Separate source from data:** Quantogral code lives under `src/`; downloaded and imported local datasets live under `data/` and are not committed to Git.
- **Code-first:** Strategies remain normal Python or C++ code rather than being trapped in a no-code interface.
- **Dashboard as workflow layer:** The web UI orchestrates and explains the workflow; it is not only a static results viewer.
- **Clear separation of concerns:** Backtests run as on-demand jobs, while paper/live execution runs in a durable service that survives browser closes and reconciles state with the broker.
- **Research before execution:** The first releases prioritize a delightful and trustworthy backtesting experience over broad broker or data-provider abstractions.
- **Respect user code:** Built-in content is maintained by Quantogral; content in `custom/` is user-owned and is never modified by Quantogral updates.
- **Safety by design:** Live-trading functionality is introduced deliberately, with operational controls built in rather than added later.

## License

This project is source-available, not open-source.

You may view, run, and modify the software for personal, educational, and evaluation purposes only. Commercial use, redistribution, resale, rebranding, or incorporation into commercial products or services is prohibited without explicit written permission.

See the [LICENSE](./LICENSE) file for full terms.
