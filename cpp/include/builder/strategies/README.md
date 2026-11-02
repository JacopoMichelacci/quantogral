# Writing a Quantogral strategy

This guide describes the strategy interface used by the local C++ backtester. A strategy is a C++ header that owns its trading logic and parameters. Quantogral discovers the header, creates controls from its config fields, compiles it, and makes it available in Simple Backtesting. You do not write UI code or add a registration entry.

## Add a strategy header

Put the header under the configured Builder strategies folder. The default is:

```text
cpp/include/builder/strategies/
```

User strategies normally belong in `custom/`; built-in strategies supplied with Quantogral belong in `built-in/`. A strategy header must follow the conventions below for automatic discovery and config generation.

## Minimal strategy shape

```cpp
#pragma once

#include <vector>

#include "builder/strategies/strategy_base.hpp"
#include "core/market_events.hpp"
#include "core/order_events.hpp"

struct ExampleConfig {
    double entry_level = 100.0;
};

class ExampleStrategy : public Strategy<FeedEvent> {
public:
    using Config = ExampleConfig;

    ExampleStrategy(const Config& config, StrategyConfig base_config = {})
        : Strategy<FeedEvent>("Example", base_config), params(config) {}

    void on_data(const FeedEvent& event,
                 const StrategyContext& ctx,
                 std::vector<OrderEvent>& out) override {
        if (!bconfig.active || event.role != FeedRole::MAIN) return;

        const auto* bar = event.get_if<OHLCVEvent>();
        if (!bar || bar->close <= params.entry_level || ctx.opos > 0.0) return;

        OrderEvent order;
        order.signal = SIGNAL::BLONG;
        order.type = ORDER_TYPE::MARKET;
        order.qty = 1.0;
        // Leave symbol empty to target the Main feed that triggered this call.
        out.push_back(order);
    }

private:
    Config params;
};
```

The key requirements are:

1. Derive from `Strategy<FeedEvent>`.
2. Declare `using Config = YourConfig;` inside the class.
3. Implement the exact `on_data` signature shown above.
4. Provide a constructor that accepts `(const Config&, StrategyConfig)` (the second argument can have a default).
5. Give every UI-supported config field a default value.

The auto-discovery code currently reads conventional C++ declarations rather than parsing all of C++. Keep config fields in simple `type name = default;` form. Supported fields are booleans, numbers, strings, enums, and nested config structs initialized with `{}`. Nested structs become groups in the UI. `SizingConfig sizing = {};` is recognized as the sizing group, with fields shown according to sizing mode. See [`built-in/ma_cross.hpp`](built-in/ma_cross.hpp) for a complete example.

The strategy header's filename supplies its catalog ID and display name. Give each strategy header a unique filename. The class and config struct names should also be unique across strategy headers.

## What the base class provides

`Strategy<Tin>` is the common interface used by the runner. Here, `Tin` is `FeedEvent`, which lets the strategy inspect different concrete event types while the runner stores and calls strategies through one common base type.

- **Constructor:** stores the strategy name and `StrategyConfig`, and assigns an instance ID and tag. The generated adapter constructs the strategy from its config and base config.
- **`on_data(...)`:** the virtual callback implemented by the derived strategy. In the current backtester, it runs on each subscribed Main-feed event, in timestamp order. Sub-feed events do not trigger callbacks.
- **`get_name()`, `get_id()`, `get_tag()`:** identify the constructed strategy instance. The tag includes the instance ID.
- **`get_config()`:** returns the base `StrategyConfig` as a const reference.
- **`resolve_ts(...)`:** a legacy helper for strategies whose input type directly exposes a supported timestamp field. The current `FeedEvent` wrapper does not expose one directly, and the runner already normalizes loaded event timestamps, so FeedEvent strategies should not call this helper.

`StrategyConfig` is the common per-instance behavior config, separate from the strategy's own `Config`. It currently includes `active`, `long_active`, `short_active`, `stacking`, `ts_unit`, and `date_format`. Use `bconfig` in the derived class to check those values. Strategy-specific choices, such as MA lengths, belong in the derived config.

## The callback input: `FeedEvent`

`FeedEvent` is a lightweight wrapper around one concrete `MarketEvent`. It carries:

- `feed_id`: numeric ID of the feed that produced this event.
- `main_feed_id`: numeric ID of the Main feed this event belongs to. For a Main event, it is the same as `feed_id`.
- `role`: `MAIN` (`0`), `SUB1` (`1`), `SUB2` (`2`), or `SUB3` (`3`). The explicit values make each Sub role map to its queue slot.
- `data`: a reference to the concrete event, such as `OHLCVEvent` or `QuoteEvent`.

Use `get_if<T>()` to check the concrete event type. It returns a pointer when the type matches and `nullptr` otherwise:

```cpp
if (const auto* bar = event.get_if<OHLCVEvent>()) {
    // Read bar->open, bar->high, bar->low, bar->close, and bar->volume.
}

if (const auto* quote = event.get_if<QuoteEvent>()) {
    // Read quote->bid, quote->ask, and quote sizes.
}
```

The data loader currently creates OHLCV and Quote events from supported CSV/Parquet files. The `FeedEvent` interface can carry other `MarketEvent` subclasses, but another event format needs a reader that creates that event type. An event type also needs an execution/valuation policy before the backtester can trade or mark a portfolio from it; strategies can still inspect informational events that are not tradable.

## Main and Sub feeds

The Main feed is the strategy's callback clock and the asset it can trade. The runner calls `on_data()` when a new event arrives on a subscribed Main feed. Sub1/Sub2/Sub3 feeds are associated with one Main feed and do not call `on_data()` themselves.

In Simple Backtesting, drag a data file directly onto **+ Subfeed** on a Main feed's row, or click it to open the attach panel and select an existing feed. Quantogral assigns the next available role in order: Sub1, then Sub2, then Sub3. Dropping a file already used in the bucket creates a separate feed instance, so the same file can be used as both Main and Sub data. Subfeeds appear as role-and-filename rows within their Main feed block. Removing a Subfeed removes only that row and compacts the remaining roles; removing its Main also removes all of its Subfeeds. Each Main feed can have one feed in each Sub slot.

Sub events are queued per strategy, per Main feed, and per Sub role. On a Main callback, ask the context for a role's queued events:

```cpp
const auto sub1_events = ctx.get_subfeed(ctx.main_feed_id, FeedRole::SUB1);
for (const FeedEvent& sub_event : sub1_events) {
    if (const auto* quote = sub_event.get_if<QuoteEvent>()) {
        // Use this Sub1 quote alongside the current Main event.
    }
}
```

The queue includes Sub events timestamped at or before the Main event that triggered the callback. After `on_data()` returns, the backtester clears those queues. The returned `std::span` and each `FeedEvent` are non-owning views; copy the concrete values you need into strategy-owned storage if they must survive the callback. Sub events arriving after a Main feed's final event are not delivered. Users are responsible for choosing Sub data with a frequency appropriate for its Main feed.

`StrategyContext` also provides:

- `feed_id`: the configured string ID of the Main feed that triggered this callback. It is a `std::string_view` valid for the callback; do not retain the view.
- `main_feed_id`: the numeric ID used to associate this callback with its Sub queues.
- `opos`: this strategy's current net position on the Main feed.
- `equity`: the account equity available to the sizing helpers.
- `oposlog`: the strategy's current open lots for the Main feed.
- `fixed_fractional_price_qty(price, fraction)` and `fixed_fractional_sl_qty(risk, fraction)`: helpers that calculate quantity using equity and the Main feed's currency conversion rate.

## Returning orders

Create `OrderEvent` values and append them to `out`. The runner processes them after `on_data()` returns. Leave `symbol` empty to target the Main feed that triggered the callback, or set it to a subscribed Main feed's configured ID. Orders cannot target Sub feeds.

`SIGNAL::BLONG` and `SIGNAL::BSHORT` express target-direction entries or flips. `SIGNAL::SELL` and `SIGNAL::COVER` close long and short exposure respectively. Long-only and short-only backtest modes restrict execution; strategies should still use their own direction rules and base settings.

Example order:

```cpp
OrderEvent order;
order.signal = SIGNAL::BLONG;
order.type = ORDER_TYPE::MARKET;
order.qty = 1.0;
out.push_back(order);
```

The backtester owns fill timing and portfolio accounting. With OHLCV data, market orders fill at the next bar's open. With Quote data, buys use the ask and sells use the bid; configured fill latency applies to quote feeds.

## From header to UI

When a supported header is saved, Quantogral scans for a class derived from `Strategy<FeedEvent>`, reads its `Config` fields and defaults, and generates a local constructor adapter under `.quantogral/build/`. The adapter builds the config from the UI values and invokes the constructor. Compilation does not edit strategy headers. After successful compilation, the strategy appears in the project explorer and can be dragged into a Simple Backtesting bucket.

If discovery fails, check the required class inheritance, `Config` alias, config defaults, supported field types, and constructor shape above. Keep UI metadata out of the strategy: it is generated from the C++ config.
