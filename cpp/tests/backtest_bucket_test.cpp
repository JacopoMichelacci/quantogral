#include <cassert>
#include <cmath>
#include <string>
#include <tuple>
#include <vector>

#include "backtest/backtest.hpp"

namespace {

OHLCVEvent bar(long long timestamp, double open, double high, double low, double close) {
    OHLCVEvent event;
    event.ts = timestamp;
    event.open = open;
    event.high = high;
    event.low = low;
    event.close = close;
    return event;
}

class RecordingStrategy final : public Strategy<OHLCVEvent> {
public:
    RecordingStrategy() : Strategy("recording") {}

    void on_data(const OHLCVEvent& input, const StrategyContext& context,
                 std::vector<OrderEvent>&) override {
        calls.emplace_back(std::string(context.feed_id), input.ts);
    }

    std::vector<std::pair<std::string, long long>> calls;
};

class BuyOnceStrategy final : public Strategy<OHLCVEvent> {
public:
    explicit BuyOnceStrategy(double quantity) : Strategy("buy once"), quantity_(quantity) {}

    void on_data(const OHLCVEvent&, const StrategyContext&,
                 std::vector<OrderEvent>& orders) override {
        if (!sent_) {
            sent_ = true;
            orders.push_back({.signal = SIGNAL::LONG, .type = ORDER_TYPE::MARKET, .qty = quantity_});
        }
    }

private:
    double quantity_;
    bool sent_ = false;
};

class EquityCaptureBuyStrategy final : public Strategy<OHLCVEvent> {
public:
    explicit EquityCaptureBuyStrategy(double quantity) : Strategy("equity capture"), quantity_(quantity) {}

    void on_data(const OHLCVEvent&, const StrategyContext& context,
                 std::vector<OrderEvent>& orders) override {
        equities.push_back(context.equity);
        if (sent_) return;
        sent_ = true;
        orders.push_back({.signal = SIGNAL::LONG, .type = ORDER_TYPE::MARKET, .qty = quantity_});
    }

    std::vector<double> equities;

private:
    double quantity_;
    bool sent_ = false;
};

class QuoteBuyStrategy final : public Strategy<QuoteEvent> {
public:
    QuoteBuyStrategy() : Strategy("quote buy") {}

    void on_data(const QuoteEvent&, const StrategyContext&, std::vector<OrderEvent>& orders) override {
        if (sent_) return;
        sent_ = true;
        orders.push_back({.signal = SIGNAL::LONG, .type = ORDER_TYPE::MARKET, .qty = 1.0});
    }

private:
    bool sent_ = false;
};

class QuoteStopStrategy final : public Strategy<QuoteEvent> {
public:
    QuoteStopStrategy() : Strategy("quote stop") {}
    void on_data(const QuoteEvent&, const StrategyContext&, std::vector<OrderEvent>& orders) override {
        if (sent_) return;
        sent_ = true;
        orders.push_back({.signal = SIGNAL::LONG, .type = ORDER_TYPE::MARKET, .qty = 1.0,
                          .sl = StopLoss{.type = STOP_TYPE::HARD, .slnot = 0.5}});
    }
private:
    bool sent_ = false;
};

class StopBuyStrategy final : public Strategy<OHLCVEvent> {
public:
    StopBuyStrategy() : Strategy("stop buy") {}
    void on_data(const OHLCVEvent&, const StrategyContext&, std::vector<OrderEvent>& orders) override {
        if (sent_) return;
        sent_ = true;
        orders.push_back({.signal = SIGNAL::LONG, .type = ORDER_TYPE::MARKET, .qty = 1.0,
                          .sl = StopLoss{.type = STOP_TYPE::HARD, .slnot = 1.0}});
    }
private:
    bool sent_ = false;
};

class RouteToBStrategy final : public Strategy<OHLCVEvent> {
public:
    RouteToBStrategy() : Strategy("route to B") {}
    void on_data(const OHLCVEvent&, const StrategyContext& context, std::vector<OrderEvent>& orders) override {
        if (sent_ || context.feed_id != "A") return;
        sent_ = true;
        orders.push_back({.signal = SIGNAL::LONG, .type = ORDER_TYPE::MARKET, .symbol = "B", .qty = 1.0});
    }
private:
    bool sent_ = false;
};

void test_time_order_and_multi_feed_subscriptions() {
    const std::vector<OHLCVEvent> a{bar(10, 10, 11, 9, 10), bar(30, 12, 13, 11, 12)};
    const std::vector<OHLCVEvent> b{bar(20, 20, 21, 19, 20), bar(30, 22, 23, 21, 22)};
    RecordingStrategy a_only;
    RecordingStrategy pair;
    BacktestBucket<OHLCVEvent> bucket{
        .id = "shared-market-data",
        .feeds = {{"A", a}, {"B", b}},
        .strategies = {{"a-only", &a_only, {"A"}, {}}, {"pair", &pair, {"A", "B"}, {}}},
    };

    const auto result = Backtester<OHLCVEvent>({.initial_capital = 1'000.0, .cost_bps = 0.0}).run(bucket);

    assert(result.strategies.size() == 2);
    assert(a_only.calls.size() == 2);
    assert(pair.calls.size() == 4);
    assert((pair.calls[0] == std::pair<std::string, long long>{"A", 10}));
    assert((pair.calls[1] == std::pair<std::string, long long>{"B", 20}));
    assert((pair.calls[2] == std::pair<std::string, long long>{"A", 30}));
    assert((pair.calls[3] == std::pair<std::string, long long>{"B", 30}));
    assert(result.equity_timestamps == std::vector<long long>({10, 20, 30}));
}

void test_shared_capital_by_default() {
    const std::vector<OHLCVEvent> a{bar(10, 10, 10, 10, 10), bar(20, 12, 14, 11, 14)};
    BuyOnceStrategy one(1.0);
    BuyOnceStrategy two(2.0);
    BacktestBucket<OHLCVEvent> bucket{
        .id = "A-only",
        .feeds = {{"A", a}},
        .strategies = {{"one", &one, {"A"}, {}}, {"two", &two, {"A"}, {}}},
    };

    const auto result = Backtester<OHLCVEvent>({.initial_capital = 1'000.0, .cost_bps = 0.0}).run(bucket);
    const auto& one_result = result.strategies[0].results;
    const auto& two_result = result.strategies[1].results;
    assert(one_result.hlog.size() == 1 && two_result.hlog.size() == 1);
    assert(one_result.hlog.front().status == ORDER_STATUS::FILLED);
    assert(two_result.hlog.front().status == ORDER_STATUS::FILLED);
    assert(one_result.hlog.front().symbol == "A");
    assert(one_result.equity_curve.empty() && two_result.equity_curve.empty());
    assert(std::abs(result.equity_curve.back() - 1'006.0) < 1e-9);
}

void test_equal_capital_sleeves() {
    const std::vector<OHLCVEvent> a{bar(10, 10, 10, 10, 10), bar(20, 12, 14, 11, 14)};
    BuyOnceStrategy one(1.0);
    BuyOnceStrategy two(2.0);
    BacktestBucket<OHLCVEvent> bucket{
        .id = "A-only",
        .feeds = {{"A", a}},
        .strategies = {{"one", &one, {"A"}, {}}, {"two", &two, {"A"}, {}}},
    };

    const auto result = Backtester<OHLCVEvent>({
        .initial_capital = 1'000.0,
        .cost_bps = 0.0,
        .capital_allocation = CAPITAL_ALLOCATION_MODE::EQUAL_PER_STRATEGY,
    }).run(bucket);
    const auto& one_result = result.strategies[0].results;
    const auto& two_result = result.strategies[1].results;
    assert(std::abs(one_result.equity_curve.back() - 502.0) < 1e-9);
    assert(std::abs(two_result.equity_curve.back() - 504.0) < 1e-9);
    assert(std::abs(result.equity_curve.back() - 1'006.0) < 1e-9);
}

void test_plan_shares_capital_and_timeline_across_buckets() {
    const std::vector<OHLCVEvent> a{bar(10, 10, 10, 10, 10), bar(20, 10, 12, 10, 12)};
    const std::vector<OHLCVEvent> b{bar(10, 10, 10, 10, 10), bar(20, 10, 10, 8, 8)};
    BuyOnceStrategy first(60.0);
    EquityCaptureBuyStrategy second(40.0);
    BacktestPlan<OHLCVEvent> plan{
        .buckets = {
            {.id = "bucket-a", .feeds = {{"A", a}}, .strategies = {{"strategy-a", &first, {"A"}, {}}}},
            {.id = "bucket-b", .feeds = {{"B", b}}, .strategies = {{"strategy-b", &second, {"B"}, {}}}},
        },
    };

    const auto result = Backtester<OHLCVEvent>({.initial_capital = 1'000.0, .cost_bps = 0.0}).run(plan);
    assert(result.buckets.size() == 2);
    assert(result.buckets[0].strategies[0].results.hlog.size() == 1);
    assert(result.buckets[1].strategies[0].results.hlog.size() == 1);
    assert(result.buckets[0].strategies[0].results.hlog[0].status == ORDER_STATUS::FILLED);
    assert(result.buckets[1].strategies[0].results.hlog[0].status == ORDER_STATUS::FILLED);
    assert(result.equity_timestamps == std::vector<long long>({10, 20}));
    assert(std::abs(result.equity_curve.back() - 1'040.0) < 1e-9);
    assert(std::abs(result.buckets[0].contribution_curve.back() - 120.0) < 1e-9);
    assert(std::abs(result.buckets[1].contribution_curve.back() + 80.0) < 1e-9);
    assert(std::abs(result.buckets[0].contribution_curve.back() + result.buckets[1].contribution_curve.back()
                    - (result.equity_curve.back() - 1'000.0)) < 1e-9);
    assert(!second.equities.empty());
    assert(std::abs(second.equities.back() - 1'040.0) < 1e-9);
}

void test_equal_capital_is_split_across_all_buckets() {
    const std::vector<OHLCVEvent> a{bar(10, 10, 10, 10, 10), bar(20, 10, 10, 10, 10)};
    const std::vector<OHLCVEvent> b{bar(10, 10, 10, 10, 10), bar(20, 10, 10, 10, 10)};
    BuyOnceStrategy first(60.0);
    BuyOnceStrategy second(60.0);
    BacktestPlan<OHLCVEvent> plan{
        .buckets = {
            {.id = "bucket-a", .feeds = {{"A", a}}, .strategies = {{"strategy-a", &first, {"A"}, {}}}},
            {.id = "bucket-b", .feeds = {{"B", b}}, .strategies = {{"strategy-b", &second, {"B"}, {}}}},
        },
    };
    const auto result = Backtester<OHLCVEvent>({
        .initial_capital = 1'000.0,
        .cost_bps = 0.0,
        .capital_allocation = CAPITAL_ALLOCATION_MODE::EQUAL_PER_STRATEGY,
    }).run(plan);
    assert(result.buckets[0].strategies[0].results.hlog[0].status == ORDER_STATUS::REJECTED);
    assert(result.buckets[1].strategies[0].results.hlog[0].status == ORDER_STATUS::REJECTED);
    assert(std::abs(result.equity_curve.back() - 1'000.0) < 1e-9);
}

void test_currency_conversion_applies_to_cash_and_mark_to_market() {
    auto entry = bar(10, 10, 10, 10, 10);
    auto mark = bar(20, 10, 12, 10, 12);
    const std::vector<OHLCVEvent> bars{entry, mark};
    const std::vector<double> account_currency_rates{1.2, 1.3};
    BuyOnceStrategy strategy(1.0);
    const BacktestBucket<OHLCVEvent> bucket{
        .id = "fx-test",
        .feeds = {{"default", bars, account_currency_rates}},
        .strategies = {{"buy-once", &strategy, {"default"}, {}}},
    };
    const auto result = Backtester<OHLCVEvent>({.initial_capital = 100.0, .cost_bps = 0.0}).run(bucket);
    const auto& orders = result.strategies.front().results.hlog;
    assert(orders.size() == 1);
    assert(orders[0].status == ORDER_STATUS::FILLED);
    assert(std::abs(orders[0].price - 10.0) < 1e-9);
    assert(std::abs(result.equity_curve.back() - 102.6) < 1e-9);
}

void test_multi_feed_order_executes_on_its_target_feed() {
    const std::vector<OHLCVEvent> a{bar(10, 10, 10, 10, 10)};
    const std::vector<OHLCVEvent> b{bar(20, 20, 20, 20, 20), bar(30, 21, 21, 21, 21)};
    RouteToBStrategy strategy;
    BacktestBucket<OHLCVEvent> bucket{
        .id = "cross-feed",
        .feeds = {{"A", a}, {"B", b}},
        .strategies = {{"cross-feed-instance", &strategy, {"A", "B"}, {}}},
    };
    const auto result = Backtester<OHLCVEvent>({.initial_capital = 1'000.0, .cost_bps = 0.0}).run(bucket);
    const auto& orders = result.strategies.front().results.hlog;
    assert(orders.size() == 1);
    assert(orders.front().status == ORDER_STATUS::FILLED);
    assert(orders.front().symbol == "B");
    assert(orders.front().ts == 20);
    assert(std::abs(orders.front().price - 20.0) < 1e-9);
}

void test_quote_execution_uses_bid_ask() {
    QuoteEvent first;
    first.ts = 10;
    first.bid = 9.9;
    first.ask = 10.1;
    first.bidsize = first.asksize = 100.0;
    QuoteEvent second;
    second.ts = 20;
    second.bid = 11.9;
    second.ask = 12.1;
    second.bidsize = second.asksize = 100.0;
    const std::vector<QuoteEvent> quotes{first, second};
    QuoteBuyStrategy strategy;
    BacktestBucket<QuoteEvent> bucket{
        .id = "quote-feed",
        .feeds = {{"A", quotes}},
        .strategies = {{"quote-instance", &strategy, {"A"}, {}}},
    };

    const auto result = Backtester<QuoteEvent>({.initial_capital = 1'000.0, .cost_bps = 0.0}).run(bucket);
    const auto& strategy_result = result.strategies.front().results;
    assert(strategy_result.hlog.size() == 1);
    assert(std::abs(strategy_result.hlog.front().price - 12.1) < 1e-9);
    assert(std::abs(strategy_result.equity_curve.back() - 999.8) < 1e-9);
}

void test_quote_latency_delays_entry_and_stop_fills() {
    std::vector<QuoteEvent> quotes(5);
    const std::vector<std::pair<long long, std::pair<double, double>>> updates{
        {1'000, {9.9, 10.1}}, {2'000, {11.9, 12.1}}, {3'000, {9.4, 9.6}},
        {3'500, {8.9, 9.1}}, {4'000, {8.7, 8.9}},
    };
    for (std::size_t i = 0; i < updates.size(); ++i) {
        quotes[i].ts = updates[i].first;
        quotes[i].bid = updates[i].second.first;
        quotes[i].ask = updates[i].second.second;
        quotes[i].bidsize = quotes[i].asksize = 100.0;
    }
    QuoteStopStrategy strategy;
    const auto result = Backtester<QuoteEvent>({
        .initial_capital = 1'000.0,
        .cost_bps = 0.0,
        .fill_latency_seconds = 1.0,
    }).run(strategy, quotes);
    assert(result.hlog.size() == 2);
    assert(result.hlog[0].ts == 2'000);
    assert(std::abs(result.hlog[0].price - 12.1) < 1e-9);
    assert(result.hlog[1].reason == "stop loss");
    assert(result.hlog[1].ts == 4'000);
    assert(std::abs(result.hlog[1].price - 8.7) < 1e-9);
}

void test_latency_setting_does_not_change_ohlcv_next_open_fills() {
    const std::vector<OHLCVEvent> bars{bar(10, 10, 10, 10, 10), bar(20, 11, 12, 10, 11)};
    StopBuyStrategy strategy;
    const auto result = Backtester<OHLCVEvent>({
        .initial_capital = 1'000.0,
        .cost_bps = 0.0,
        .fill_latency_seconds = 100.0,
    }).run(strategy, bars);
    assert(!result.hlog.empty());
    assert(result.hlog.front().status == ORDER_STATUS::FILLED);
    assert(result.hlog.front().ts == 20);
    assert(std::abs(result.hlog.front().price - 11.0) < 1e-9);
}

void test_gap_stop_and_end_of_data_cancellation() {
    const std::vector<OHLCVEvent> bars{
        bar(10, 10, 10, 10, 10),
        bar(20, 10, 11, 9.5, 10.5),
        bar(30, 8, 8.5, 7.5, 8),
    };
    StopBuyStrategy strategy;
    const auto result = Backtester<OHLCVEvent>({.initial_capital = 1'000.0, .cost_bps = 0.0})
        .run(strategy, bars);
    assert(result.hlog.size() == 2);
    assert(result.hlog[0].status == ORDER_STATUS::FILLED);
    assert(result.hlog[1].reason == "stop loss");
    assert(std::abs(result.hlog[1].price - 8.0) < 1e-9);

    const std::vector<OHLCVEvent> one_bar{bar(10, 10, 10, 10, 10)};
    StopBuyStrategy final_signal;
    const auto canceled = Backtester<OHLCVEvent>({.initial_capital = 1'000.0, .cost_bps = 0.0})
        .run(final_signal, one_bar);
    assert(canceled.hlog.size() == 1);
    assert(canceled.hlog.front().status == ORDER_STATUS::CANCELED);
}

void test_invalid_order_is_rejected_without_changing_equity() {
    const std::vector<OHLCVEvent> bars{bar(10, 10, 10, 10, 10), bar(20, 10, 10, 10, 10)};
    BuyOnceStrategy invalid_quantity(-1.0);
    const auto result = Backtester<OHLCVEvent>({.initial_capital = 1'000.0, .cost_bps = 0.0})
        .run(invalid_quantity, bars);
    assert(result.hlog.size() == 1);
    assert(result.hlog.front().status == ORDER_STATUS::REJECTED);
    assert(result.hlog.front().id > 0);
    assert(std::abs(result.equity_curve.back() - 1'000.0) < 1e-9);
}

} // namespace

int main() {
    test_time_order_and_multi_feed_subscriptions();
    test_shared_capital_by_default();
    test_equal_capital_sleeves();
    test_plan_shares_capital_and_timeline_across_buckets();
    test_equal_capital_is_split_across_all_buckets();
    test_currency_conversion_applies_to_cash_and_mark_to_market();
    test_multi_feed_order_executes_on_its_target_feed();
    test_quote_execution_uses_bid_ask();
    test_quote_latency_delays_entry_and_stop_fills();
    test_latency_setting_does_not_change_ohlcv_next_open_fills();
    test_gap_stop_and_end_of_data_cancellation();
    test_invalid_order_is_rejected_without_changing_equity();
}
