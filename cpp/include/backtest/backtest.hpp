#pragma once

#include <algorithm>
#include <cmath>
#include <limits>
#include <queue>
#include <span>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "builder/indicators/indicator_base.hpp"
#include "builder/strategies/strategy_base.hpp"
#include "core/order_events.hpp"

struct BacktestResults {
    std::vector<double> equity_curve;
    std::vector<long long> equity_timestamps;
    // Strategy-attributed P&L, used for per-strategy diagnostics when capital is shared.
    std::vector<double> contribution_curve;
    std::vector<long long> contribution_timestamps;
    std::vector<OrderEvent> hlog;
    struct IndicatorTrace {
        std::string name;
        std::string feed_id;
        std::vector<long long> timestamps;
        std::vector<double> values;
    };
    std::vector<IndicatorTrace> indicators;
};

template <typename Tin>
struct BacktestFeed {
    std::string id;
    std::span<const Tin> events;
    // Backtester-owned conversion rates aligned to events; strategies only receive Tin.
    std::span<const double> account_currency_rates;

    BacktestFeed() = default;
    BacktestFeed(std::string feed_id, std::span<const Tin> market_events,
                 std::span<const double> conversion_rates = {})
        : id(std::move(feed_id)), events(market_events), account_currency_rates(conversion_rates) {}

    double account_currency_rate(std::size_t event_index) const {
        return account_currency_rates.empty() ? 1.0 : account_currency_rates[event_index];
    }
};

template <typename Tin>
struct BacktestStrategyBinding {
    std::string instance_id;
    Strategy<Tin>* strategy = nullptr;
    std::vector<std::string> feed_ids;
    // Optional plan bucket used to attribute P&L while keeping one shared account.
    std::string bucket_id;
};

template <typename Tin>
struct BacktestBucket {
    std::string id;
    std::vector<BacktestFeed<Tin>> feeds;
    std::vector<BacktestStrategyBinding<Tin>> strategies;
};

template <typename Tin>
struct BacktestPlan {
    std::vector<BacktestBucket<Tin>> buckets;
};

struct StrategyBacktestResult {
    std::string instance_id;
    long long strategy_id = -1;
    BacktestResults results;
};

struct BacktestBucketAttribution {
    std::string bucket_id;
    std::vector<double> contribution_curve;
    std::vector<long long> timestamps;
};

struct BacktestBucketResults {
    std::string bucket_id;
    // Populated by direct single-bucket runs. Plan runs expose one global curve below.
    std::vector<double> equity_curve;
    std::vector<long long> equity_timestamps;
    // P&L contribution relative to the bucket's initial allocation.
    std::vector<double> contribution_curve;
    std::vector<long long> contribution_timestamps;
    std::vector<BacktestBucketAttribution> bucket_attributions;
    std::vector<StrategyBacktestResult> strategies;
};

struct BacktestRunResults {
    // One portfolio curve across every strategy and data bucket in the plan.
    std::vector<double> equity_curve;
    std::vector<long long> equity_timestamps;
    std::vector<BacktestBucketResults> buckets;
};

// Event policies let the same portfolio/order engine consume bars or quotes.
// Additional market-event types can specialize this contract without duplicating
// the bucket scheduler or accounting implementation.
template <typename TEvent>
struct BacktestEventTraits;

template <>
struct BacktestEventTraits<OHLCVEvent> {
    static constexpr bool supports_fill_latency(const OHLCVEvent&) { return false; }
    static constexpr bool tradable(const OHLCVEvent&) { return true; }
    static long long timestamp(const OHLCVEvent& event) { return event.ts; }
    static bool valid(const OHLCVEvent& event) {
        return std::isfinite(event.open) && std::isfinite(event.high) && std::isfinite(event.low) &&
               std::isfinite(event.close) && std::isfinite(event.volume) && event.volume >= 0.0 &&
               event.high >= event.low && event.open >= event.low && event.open <= event.high &&
               event.close >= event.low && event.close <= event.high;
    }
    static double buy_price(const OHLCVEvent& event) { return event.open; }
    static double sell_price(const OHLCVEvent& event) { return event.open; }
    static double mark_price(const OHLCVEvent& event, double, double account_currency_rate) { return event.close * account_currency_rate; }
    static bool stop_hit(const OHLCVEvent& event, SIGNAL side, double stop) {
        return side == SIGNAL::LONG ? event.low <= stop : event.high >= stop;
    }
    static double stop_fill_price(const OHLCVEvent& event, SIGNAL side, double stop) {
        if (side == SIGNAL::LONG) return event.open <= stop ? event.open : stop;
        return event.open >= stop ? event.open : stop;
    }
};

template <>
struct BacktestEventTraits<QuoteEvent> {
    static constexpr bool supports_fill_latency(const QuoteEvent&) { return true; }
    static constexpr bool tradable(const QuoteEvent&) { return true; }
    static long long timestamp(const QuoteEvent& event) { return event.ts; }
    static bool valid(const QuoteEvent& event) {
        return std::isfinite(event.bid) && std::isfinite(event.ask) &&
               std::isfinite(event.bidsize) && std::isfinite(event.asksize) &&
               event.ask >= event.bid && event.bidsize >= 0.0 && event.asksize >= 0.0;
    }
    static double buy_price(const QuoteEvent& event) { return event.ask; }
    static double sell_price(const QuoteEvent& event) { return event.bid; }
    static double mark_price(const QuoteEvent& event, double position, double account_currency_rate) {
        if (position > 0.0) return event.bid * account_currency_rate;
        if (position < 0.0) return event.ask * account_currency_rate;
        return (event.bid + event.ask) / 2.0 * account_currency_rate;
    }
    static bool stop_hit(const QuoteEvent& event, SIGNAL side, double stop) {
        return side == SIGNAL::LONG ? event.bid <= stop : event.ask >= stop;
    }
    static double stop_fill_price(const QuoteEvent& event, SIGNAL side, double) {
        return side == SIGNAL::LONG ? event.bid : event.ask;
    }
};

// Runtime policy for heterogeneous event streams. Known market events can
// trade; other MarketEvent-derived types remain available to strategies as
// informational events until they define an execution model.
template <>
struct BacktestEventTraits<FeedEvent> {
    static long long timestamp(const FeedEvent& event) { return event.data.ts; }

    static bool valid(const FeedEvent& event) {
        if (const auto* bar = event.get_if<OHLCVEvent>()) return BacktestEventTraits<OHLCVEvent>::valid(*bar);
        if (const auto* quote = event.get_if<QuoteEvent>()) return BacktestEventTraits<QuoteEvent>::valid(*quote);
        return true;
    }

    static bool supports_fill_latency(const FeedEvent& event) {
        if (const auto* quote = event.get_if<QuoteEvent>()) return BacktestEventTraits<QuoteEvent>::supports_fill_latency(*quote);
        return false;
    }

    static bool tradable(const FeedEvent& event) {
        if (const auto* bar = event.get_if<OHLCVEvent>()) return BacktestEventTraits<OHLCVEvent>::tradable(*bar);
        if (const auto* quote = event.get_if<QuoteEvent>()) return BacktestEventTraits<QuoteEvent>::tradable(*quote);
        return false;
    }

    static double buy_price(const FeedEvent& event) {
        if (const auto* bar = event.get_if<OHLCVEvent>()) return BacktestEventTraits<OHLCVEvent>::buy_price(*bar);
        if (const auto* quote = event.get_if<QuoteEvent>()) return BacktestEventTraits<QuoteEvent>::buy_price(*quote);
        return std::numeric_limits<double>::quiet_NaN();
    }

    static double sell_price(const FeedEvent& event) {
        if (const auto* bar = event.get_if<OHLCVEvent>()) return BacktestEventTraits<OHLCVEvent>::sell_price(*bar);
        if (const auto* quote = event.get_if<QuoteEvent>()) return BacktestEventTraits<QuoteEvent>::sell_price(*quote);
        return std::numeric_limits<double>::quiet_NaN();
    }

    static double mark_price(const FeedEvent& event, double position, double account_currency_rate) {
        if (const auto* bar = event.get_if<OHLCVEvent>()) return BacktestEventTraits<OHLCVEvent>::mark_price(*bar, position, account_currency_rate);
        if (const auto* quote = event.get_if<QuoteEvent>()) return BacktestEventTraits<QuoteEvent>::mark_price(*quote, position, account_currency_rate);
        return std::numeric_limits<double>::quiet_NaN();
    }

    static bool stop_hit(const FeedEvent& event, SIGNAL side, double stop) {
        if (const auto* bar = event.get_if<OHLCVEvent>()) return BacktestEventTraits<OHLCVEvent>::stop_hit(*bar, side, stop);
        if (const auto* quote = event.get_if<QuoteEvent>()) return BacktestEventTraits<QuoteEvent>::stop_hit(*quote, side, stop);
        return false;
    }

    static double stop_fill_price(const FeedEvent& event, SIGNAL side, double stop) {
        if (const auto* bar = event.get_if<OHLCVEvent>()) return BacktestEventTraits<OHLCVEvent>::stop_fill_price(*bar, side, stop);
        if (const auto* quote = event.get_if<QuoteEvent>()) return BacktestEventTraits<QuoteEvent>::stop_fill_price(*quote, side, stop);
        return std::numeric_limits<double>::quiet_NaN();
    }
};

enum class CAPITAL_ALLOCATION_MODE {
    SHARED,
    EQUAL_PER_STRATEGY,
};

enum class BUCKET_CAPITAL_MODE {
    SHARED,
    INDEPENDENT,
};

enum class TRADE_DIRECTION_MODE {
    BOTH,
    LONG_ONLY,
    SHORT_ONLY,
};

struct BacktestConfig {
    double initial_capital = 100'000.0;
    double cost_bps = 3.0;
    std::string currency = "USD";
    CAPITAL_ALLOCATION_MODE capital_allocation = CAPITAL_ALLOCATION_MODE::SHARED;
    BUCKET_CAPITAL_MODE bucket_capital_mode = BUCKET_CAPITAL_MODE::SHARED;
    double fill_latency_seconds = 0.0;
    TRADE_DIRECTION_MODE direction_mode = TRADE_DIRECTION_MODE::BOTH;
};

template <typename Tin>
class Backtester {
public:
    explicit Backtester(BacktestConfig config = {}) : config_(std::move(config)) {}

    BacktestResults run(Strategy<Tin>& strategy, std::span<const Tin> input) {
        const std::string feed_id = "default";
        const std::string instance_id = "strategy-" + std::to_string(strategy.get_id());
        BacktestBucket<Tin> bucket{
            .id = "default",
            .feeds = {{feed_id, input}},
            .strategies = {{instance_id, &strategy, {feed_id}, {}}},
        };
        auto bucket_results = run(bucket);
        return std::move(bucket_results.strategies.front().results);
    }

    BacktestBucketResults run(const BacktestBucket<Tin>& bucket) {
        if (!(config_.initial_capital > 0.0) || !std::isfinite(config_.initial_capital)) {
            throw std::invalid_argument("Initial capital must be a finite positive value.");
        }
        if (config_.cost_bps < 0.0 || !std::isfinite(config_.cost_bps)) {
            throw std::invalid_argument("Transaction cost must be a finite non-negative value.");
        }
        if (config_.fill_latency_seconds < 0.0 || !std::isfinite(config_.fill_latency_seconds) ||
            static_cast<long double>(config_.fill_latency_seconds) * 1'000.0L > std::numeric_limits<long long>::max()) {
            throw std::invalid_argument("Fill latency must be a finite non-negative number of seconds.");
        }
        const auto fill_latency_ms = static_cast<long long>(std::ceil(config_.fill_latency_seconds * 1'000.0));
        const auto eligible_timestamp = [fill_latency_ms](long long submitted_at, const Tin& source_event) {
            const auto delay = BacktestEventTraits<Tin>::supports_fill_latency(source_event) ? fill_latency_ms : 0LL;
            if (delay > 0 && submitted_at > std::numeric_limits<long long>::max() - delay) {
                throw std::overflow_error("Fill latency exceeds the supported timestamp range.");
            }
            return submitted_at + delay;
        };
        if (bucket.feeds.empty() || bucket.strategies.empty()) {
            throw std::invalid_argument("A backtest bucket needs at least one feed and one strategy.");
        }

        std::unordered_map<std::string, std::size_t> feed_indices;
        std::unordered_map<std::uint8_t, std::size_t> numeric_feed_indices;
        std::unordered_map<std::uint8_t, std::string> numeric_feed_names;
        std::vector<std::uint8_t> feed_main_ids(bucket.feeds.size(), 0);
        std::vector<FeedRole> feed_roles(bucket.feeds.size(), FeedRole::MAIN);
        for (std::size_t i = 0; i < bucket.feeds.size(); ++i) {
            const auto& feed = bucket.feeds[i];
            if (feed.id.empty() || !feed_indices.emplace(feed.id, i).second) {
                throw std::invalid_argument("Feed IDs in a bucket must be non-empty and unique.");
            }
            if (!feed.account_currency_rates.empty() && feed.account_currency_rates.size() != feed.events.size()) {
                throw std::invalid_argument("Feed '" + feed.id + "' must have one backtester currency rate per event.");
            }
            for (std::size_t j = 0; j < feed.events.size(); ++j) {
                if (!BacktestEventTraits<Tin>::valid(feed.events[j])) {
                    throw std::invalid_argument("Feed '" + feed.id + "' contains invalid market data at event " + std::to_string(j + 1) + ".");
                }
                if (j > 0 && BacktestEventTraits<Tin>::timestamp(feed.events[j]) < BacktestEventTraits<Tin>::timestamp(feed.events[j - 1])) {
                    throw std::invalid_argument("Feed '" + feed.id + "' must be sorted by timestamp.");
                }
                if (!feed.account_currency_rates.empty() &&
                    (!std::isfinite(feed.account_currency_rates[j]) || feed.account_currency_rates[j] <= 0.0)) {
                    throw std::invalid_argument("Feed '" + feed.id + "' has an invalid backtester currency rate at event " + std::to_string(j + 1) + ".");
                }
                if constexpr (std::is_same_v<Tin, FeedEvent>) {
                    const auto& event = feed.events[j];
                    if (j == 0) {
                        feed_main_ids[i] = event.main_feed_id;
                        feed_roles[i] = event.role;
                        if (event.role != FeedRole::MAIN && event.role != FeedRole::SUB1 &&
                            event.role != FeedRole::SUB2 && event.role != FeedRole::SUB3) {
                            throw std::invalid_argument("Feed '" + feed.id + "' has an unsupported feed role.");
                        }
                        if ((event.role == FeedRole::MAIN && event.main_feed_id != event.feed_id) ||
                            (event.role != FeedRole::MAIN && event.main_feed_id == event.feed_id)) {
                            throw std::invalid_argument("Feed '" + feed.id + "' has an inconsistent Main/Sub relationship.");
                        }
                        if (!numeric_feed_indices.emplace(event.feed_id, i).second) {
                            throw std::invalid_argument("Numeric feed IDs must be unique in a backtest bucket.");
                        }
                        numeric_feed_names.emplace(event.feed_id, feed.id);
                    } else if (event.main_feed_id != feed_main_ids[i] || event.role != feed_roles[i] ||
                               !numeric_feed_indices.contains(event.feed_id) || numeric_feed_indices.at(event.feed_id) != i) {
                        throw std::invalid_argument("All events in feed '" + feed.id + "' must have the same feed ID, role, and Main ID.");
                    }
                }
            }
        }
        if constexpr (std::is_same_v<Tin, FeedEvent>) {
            for (std::size_t i = 0; i < bucket.feeds.size(); ++i) {
                if (bucket.feeds[i].events.empty()) {
                    throw std::invalid_argument("Feed '" + bucket.feeds[i].id + "' has no events.");
                }
                if (feed_roles[i] == FeedRole::MAIN) continue;
                const auto main = numeric_feed_indices.find(feed_main_ids[i]);
                if (main == numeric_feed_indices.end() || feed_roles[main->second] != FeedRole::MAIN) {
                    throw std::invalid_argument("Subfeed '" + bucket.feeds[i].id + "' references an unknown Main feed.");
                }
                for (std::size_t other = i + 1; other < bucket.feeds.size(); ++other) {
                    if (!bucket.feeds[other].events.empty() && feed_roles[other] == feed_roles[i] &&
                        feed_main_ids[other] == feed_main_ids[i]) {
                        throw std::invalid_argument("A Main feed cannot have more than one subfeed in the same slot.");
                    }
                }
            }
        }

        struct StrategyState {
            double cash = 0.0;
            double attribution_cash = 0.0;
            std::unordered_map<std::string, double> positions;
            std::unordered_map<std::string, double> marks;
            std::unordered_map<std::string, std::vector<OrderEvent>> open_lots;
            std::unordered_map<std::string, std::vector<PendingOrder>> pending;
            std::unordered_set<long long> pending_stop_lots;
            std::vector<OrderEvent> orders;
            std::unordered_map<const void*, std::string> indicator_names;
            std::unordered_map<std::string, std::size_t> indicator_name_counts;
            OrderIdGenerator id_generator;
            BacktestResults results;
        };
        std::vector<StrategyState> states(bucket.strategies.size());
        std::vector<double> strategy_initial_capital(bucket.strategies.size(), 0.0);
        double shared_cash = config_.capital_allocation == CAPITAL_ALLOCATION_MODE::SHARED
            ? config_.initial_capital
            : 0.0;
        std::unordered_set<std::string> instance_ids;
        std::unordered_set<const Strategy<Tin>*> strategy_pointers;
        std::vector<std::vector<std::size_t>> subscribers(bucket.feeds.size());
        std::vector<std::unordered_set<std::size_t>> subscribed_feeds(bucket.strategies.size());
        std::vector<std::vector<std::size_t>> subscription_order(bucket.strategies.size());
        std::vector<std::string> attribution_bucket_ids;
        std::unordered_map<std::string, std::size_t> attribution_bucket_indices;
        std::vector<double> attribution_initial_capital;
        const auto subscribe_feed = [&](std::size_t strategy_index, std::size_t feed_index) {
            if (subscribed_feeds[strategy_index].insert(feed_index).second) {
                subscribers[feed_index].push_back(strategy_index);
                subscription_order[strategy_index].push_back(feed_index);
            }
        };

        for (std::size_t strategy_index = 0; strategy_index < bucket.strategies.size(); ++strategy_index) {
            const auto& binding = bucket.strategies[strategy_index];
            if (binding.instance_id.empty() || !instance_ids.insert(binding.instance_id).second || !binding.strategy) {
                throw std::invalid_argument("Strategy instance IDs must be unique, and every binding needs a strategy.");
            }
            if (!strategy_pointers.insert(binding.strategy).second) {
                throw std::invalid_argument("Each bucket entry must own a distinct strategy instance.");
            }
            if (binding.feed_ids.empty()) {
                throw std::invalid_argument("Each strategy must be connected to at least one feed.");
            }
            states[strategy_index].cash = config_.capital_allocation == CAPITAL_ALLOCATION_MODE::EQUAL_PER_STRATEGY
                ? config_.initial_capital / static_cast<double>(bucket.strategies.size())
                : 0.0;
            strategy_initial_capital[strategy_index] = states[strategy_index].cash;
            states[strategy_index].attribution_cash = states[strategy_index].cash;
            const auto attribution_bucket_id = binding.bucket_id.empty() ? bucket.id : binding.bucket_id;
            const auto [attribution_it, inserted] = attribution_bucket_indices.emplace(attribution_bucket_id, attribution_bucket_ids.size());
            if (inserted) {
                attribution_bucket_ids.push_back(attribution_bucket_id);
                attribution_initial_capital.push_back(0.0);
            }
            attribution_initial_capital[attribution_it->second] += states[strategy_index].attribution_cash;
            for (const auto& feed_id : binding.feed_ids) {
                const auto feed = feed_indices.find(feed_id);
                if (feed == feed_indices.end()) {
                    throw std::invalid_argument("Strategy '" + binding.instance_id + "' references unknown feed '" + feed_id + "'.");
                }
                if constexpr (std::is_same_v<Tin, FeedEvent>) {
                    const auto selected_index = feed->second;
                    if (feed_roles[selected_index] == FeedRole::MAIN) {
                        subscribe_feed(strategy_index, selected_index);
                        for (std::size_t candidate = 0; candidate < bucket.feeds.size(); ++candidate) {
                            if (feed_roles[candidate] != FeedRole::MAIN &&
                                feed_main_ids[candidate] == bucket.feeds[selected_index].events.front().feed_id) {
                                subscribe_feed(strategy_index, candidate);
                            }
                        }
                    } else {
                        const auto main_index = numeric_feed_indices.at(feed_main_ids[selected_index]);
                        subscribe_feed(strategy_index, main_index);
                        subscribe_feed(strategy_index, selected_index);
                    }
                } else {
                    subscribe_feed(strategy_index, feed->second);
                }
            }
        }

        const auto sleeve_equity = [&states, &subscription_order, &bucket](std::size_t strategy_index) {
            const auto& state = states[strategy_index];
            double equity = state.cash;
            for (const auto feed_index : subscription_order[strategy_index]) {
                const auto& feed_id = bucket.feeds[feed_index].id;
                const auto position = state.positions.find(feed_id);
                const auto mark = state.marks.find(feed_id);
                if (position != state.positions.end() && mark != state.marks.end()) equity += position->second * mark->second;
            }
            return equity;
        };
        const auto portfolio_equity = [&]() {
            double equity = config_.capital_allocation == CAPITAL_ALLOCATION_MODE::SHARED
                ? shared_cash
                : 0.0;
            for (std::size_t strategy_index = 0; strategy_index < states.size(); ++strategy_index) {
                if (config_.capital_allocation == CAPITAL_ALLOCATION_MODE::EQUAL_PER_STRATEGY) {
                    equity += states[strategy_index].cash;
                }
                for (const auto feed_index : subscription_order[strategy_index]) {
                    const auto& feed_id = bucket.feeds[feed_index].id;
                    const auto position = states[strategy_index].positions.find(feed_id);
                    const auto mark = states[strategy_index].marks.find(feed_id);
                    if (position != states[strategy_index].positions.end() && mark != states[strategy_index].marks.end()) {
                        equity += position->second * mark->second;
                    }
                }
            }
            return equity;
        };
        BacktestBucketResults bucket_results{.bucket_id = bucket.id};
        bucket_results.bucket_attributions.reserve(attribution_bucket_ids.size());
        for (const auto& attribution_bucket_id : attribution_bucket_ids) {
            bucket_results.bucket_attributions.push_back({.bucket_id = attribution_bucket_id});
        }

        struct Cursor { std::size_t feed_index; std::size_t event_index; };
        const auto later_event = [&bucket](const Cursor& lhs, const Cursor& rhs) {
            const auto lhs_ts = BacktestEventTraits<Tin>::timestamp(bucket.feeds[lhs.feed_index].events[lhs.event_index]);
            const auto rhs_ts = BacktestEventTraits<Tin>::timestamp(bucket.feeds[rhs.feed_index].events[rhs.event_index]);
            if (lhs_ts != rhs_ts) return lhs_ts > rhs_ts;
            if (lhs.feed_index != rhs.feed_index) return lhs.feed_index > rhs.feed_index;
            return lhs.event_index > rhs.event_index;
        };
        std::priority_queue<Cursor, std::vector<Cursor>, decltype(later_event)> timeline(later_event);
        for (std::size_t i = 0; i < bucket.feeds.size(); ++i) {
            if (!bucket.feeds[i].events.empty()) timeline.push({i, 0});
        }
        std::vector<const Tin*> latest_events(bucket.feeds.size(), nullptr);
        std::vector<std::size_t> latest_event_indices(bucket.feeds.size(), std::numeric_limits<std::size_t>::max());
        std::vector<std::unordered_map<std::uint8_t, StrategyContext::SubEventQueues>> pending_sub_events(bucket.strategies.size());

        while (!timeline.empty()) {
            const auto timestamp = BacktestEventTraits<Tin>::timestamp(bucket.feeds[timeline.top().feed_index].events[timeline.top().event_index]);
            std::vector<Cursor> batch;
            while (!timeline.empty()) {
                const auto cursor = timeline.top();
                const auto event_ts = BacktestEventTraits<Tin>::timestamp(bucket.feeds[cursor.feed_index].events[cursor.event_index]);
                if (event_ts != timestamp) break;
                timeline.pop();
                batch.push_back(cursor);
                const auto next_index = cursor.event_index + 1;
                if (next_index < bucket.feeds[cursor.feed_index].events.size()) timeline.push({cursor.feed_index, next_index});
            }

            // Treat equal-timestamp updates as simultaneous: every subscriber sees
            // the complete as-of snapshot, independent of feed iteration order.
            for (const auto& cursor : batch) {
                latest_events[cursor.feed_index] = &bucket.feeds[cursor.feed_index].events[cursor.event_index];
                latest_event_indices[cursor.feed_index] = cursor.event_index;
            }
            for (const auto& cursor : batch) {
                const auto& feed = bucket.feeds[cursor.feed_index];
                const auto& event = feed.events[cursor.event_index];
                if constexpr (std::is_same_v<Tin, FeedEvent>) {
                    if (event.role != FeedRole::MAIN || !BacktestEventTraits<Tin>::tradable(event)) continue;
                }
                for (const auto strategy_index : subscribers[cursor.feed_index]) {
                    auto& state = states[strategy_index];
                    auto& position = state.positions[feed.id];
                    auto& lots = state.open_lots[feed.id];
                    auto& history = state.results.hlog;
                    auto& waiting = state.pending[feed.id];
                    const double account_currency_rate = feed.account_currency_rate(cursor.event_index);
                    std::vector<OrderEvent> ready_orders;
                    std::vector<long long> ready_stop_lots;
                    for (auto order = waiting.begin(); order != waiting.end();) {
                        if (order->eligible_at <= timestamp) {
                            ready_orders.push_back(std::move(order->order));
                            if (order->stop_lot_id >= 0) ready_stop_lots.push_back(order->stop_lot_id);
                            order = waiting.erase(order);
                        } else {
                            ++order;
                        }
                    }
                    double& cash = config_.capital_allocation == CAPITAL_ALLOCATION_MODE::SHARED
                        ? shared_cash
                        : state.cash;
                    const double cash_before_execution = cash;
                    execute_orders(ready_orders, event, account_currency_rate, timestamp,
                                   cash, position, lots, history, state.id_generator, *bucket.strategies[strategy_index].strategy);
                    for (const auto stop_lot_id : ready_stop_lots) state.pending_stop_lots.erase(stop_lot_id);
                    execute_stop_losses(lots, event, account_currency_rate, timestamp, eligible_timestamp(timestamp, event), fill_latency_ms,
                                        waiting, state.pending_stop_lots, cash, position, history,
                                        state.id_generator, *bucket.strategies[strategy_index].strategy);
                    state.attribution_cash += cash - cash_before_execution;
                    state.marks[feed.id] = BacktestEventTraits<Tin>::mark_price(event, position, account_currency_rate);
                }
            }

            if constexpr (std::is_same_v<Tin, FeedEvent>) {
                // Sub updates are queued for their owning strategies. They do
                // not invoke on_data themselves; each queue is drained on the
                // next event from its Main feed.
                for (const auto& cursor : batch) {
                    const auto& event = bucket.feeds[cursor.feed_index].events[cursor.event_index];
                    if (event.role == FeedRole::MAIN) continue;
                    for (const auto strategy_index : subscribers[cursor.feed_index]) {
                        const auto role_index = static_cast<std::size_t>(event.role) - static_cast<std::size_t>(FeedRole::SUB1);
                        pending_sub_events[strategy_index][event.main_feed_id][role_index].emplace_back(event);
                    }
                }
            }

            for (const auto& cursor : batch) {
                const auto& feed = bucket.feeds[cursor.feed_index];
                const auto& event = feed.events[cursor.event_index];
                if constexpr (std::is_same_v<Tin, FeedEvent>) {
                    // Main is the strategy's callback clock. Its context
                    // carries all queued Sub updates received through this
                    // timestamp.
                    if (event.role != FeedRole::MAIN) continue;
                }
                for (const auto strategy_index : subscribers[cursor.feed_index]) {
                    const auto& binding = bucket.strategies[strategy_index];
                    auto& state = states[strategy_index];
                    double equity = config_.capital_allocation == CAPITAL_ALLOCATION_MODE::SHARED
                        ? portfolio_equity()
                        : sleeve_equity(strategy_index);
                    std::size_t position_feed_index = cursor.feed_index;
                    if constexpr (std::is_same_v<Tin, FeedEvent>) {
                        position_feed_index = numeric_feed_indices.at(event.main_feed_id);
                    }
                    const auto& position_feed = bucket.feeds[position_feed_index];
                    const auto current_lots = state.open_lots.find(position_feed.id);
                    StrategyContext context;
                    context.opos = state.positions[position_feed.id];
                    context.equity = equity;
                    context.oposlog = current_lots == state.open_lots.end() ? std::vector<OrderEvent>{} : current_lots->second;
                    context.feed_id = feed.id;
                    if constexpr (std::is_same_v<Tin, FeedEvent>) context.main_feed_id = event.main_feed_id;
                    std::size_t currency_rate_event_index = cursor.event_index;
                    if constexpr (std::is_same_v<Tin, FeedEvent>) {
                        currency_rate_event_index = latest_event_indices[position_feed_index];
                    }
                    context.account_currency_per_native_unit_ = currency_rate_event_index == std::numeric_limits<std::size_t>::max()
                        ? 1.0
                        : position_feed.account_currency_rate(currency_rate_event_index);
                    StrategyContext::SubEventQueues* delivered_sub_events = nullptr;
                    if constexpr (std::is_same_v<Tin, FeedEvent>) {
                        auto& queues = pending_sub_events[strategy_index];
                        const auto queued = queues.find(event.feed_id);
                        if (queued != queues.end()) {
                            delivered_sub_events = &queued->second;
                            context.queued_sub_events_ = delivered_sub_events;
                        }
                    }
                    state.orders.clear();
                    struct IndicatorCapture {
                        StrategyState* state;
                        long long timestamp;
                        const std::string* feed_id;
                    } indicator_capture{&state, timestamp, &feed.id};
                    const auto trace_indicator = +[](const void* source, std::string_view raw_name, double value, void* opaque) {
                        auto& capture = *static_cast<IndicatorCapture*>(opaque);
                        auto [name_it, inserted] = capture.state->indicator_names.try_emplace(source);
                        if (inserted) {
                            std::string base_name(raw_name);
                            const auto occurrence = ++capture.state->indicator_name_counts[base_name];
                            name_it->second = occurrence == 1 ? base_name : base_name + " #" + std::to_string(occurrence);
                        }
                        const auto trace_name = name_it->second;
                        auto& traces = capture.state->results.indicators;
                        auto trace = std::find_if(traces.begin(), traces.end(), [&](const auto& item) {
                            return item.name == trace_name && item.feed_id == *capture.feed_id;
                        });
                        if (trace == traces.end()) {
                            traces.push_back({trace_name, *capture.feed_id, {}, {}});
                            trace = std::prev(traces.end());
                        }
                        trace->timestamps.push_back(capture.timestamp);
                        trace->values.push_back(value);
                    };
                    quantogral::detail::IndicatorTraceScope indicator_trace_scope(trace_indicator, &indicator_capture);
                    binding.strategy->on_data(event, context, state.orders);
                    if (delivered_sub_events) {
                        for (auto& queue : *delivered_sub_events) queue.clear();
                    }
                    for (auto& order : state.orders) {
                        if (order.signal == SIGNAL::FLAT) continue;
                        if (order.symbol.empty()) {
                            if constexpr (std::is_same_v<Tin, FeedEvent>) {
                                order.symbol = numeric_feed_names.at(event.main_feed_id);
                            } else {
                                order.symbol = feed.id;
                            }
                        }
                        const auto target_feed = feed_indices.find(order.symbol);
                        if (target_feed == feed_indices.end() || !subscribed_feeds[strategy_index].contains(target_feed->second)) {
                            order.ts = timestamp;
                            order.strategy_id = binding.strategy->get_id();
                            order.id = state.id_generator.next();
                            reject(order, "order targets a feed not connected to this strategy");
                            state.results.hlog.push_back(order);
                            continue;
                        }
                        if constexpr (std::is_same_v<Tin, FeedEvent>) {
                            if (feed_roles[target_feed->second] != FeedRole::MAIN) {
                                order.ts = timestamp;
                                order.strategy_id = binding.strategy->get_id();
                                order.id = state.id_generator.next();
                                reject(order, "orders can only target Main feeds");
                                state.results.hlog.push_back(order);
                                continue;
                            }
                        }
                        order.ts = timestamp;
                        order.strategy_id = binding.strategy->get_id();
                        const Tin* execution_event = &event;
                        if constexpr (std::is_same_v<Tin, FeedEvent>) {
                            const auto* latest_execution_event = latest_events[target_feed->second];
                            execution_event = latest_execution_event
                                ? latest_execution_event
                                : &bucket.feeds[target_feed->second].events.front();
                        }
                        state.pending[order.symbol].push_back({std::move(order), eligible_timestamp(timestamp, *execution_event), -1});
                    }
                }
            }

            const double total_equity = portfolio_equity();
            bucket_results.equity_timestamps.push_back(timestamp);
            bucket_results.equity_curve.push_back(total_equity);
            std::vector<double> bucket_contributions(attribution_bucket_ids.size(), 0.0);
            for (std::size_t strategy_index = 0; strategy_index < bucket.strategies.size(); ++strategy_index) {
                const auto& binding = bucket.strategies[strategy_index];
                const auto& attribution_bucket_id = binding.bucket_id.empty() ? bucket.id : binding.bucket_id;
                const auto attribution_index = attribution_bucket_indices.at(attribution_bucket_id);
                double strategy_contribution = states[strategy_index].attribution_cash;
                for (const auto feed_index : subscription_order[strategy_index]) {
                    const auto& feed_id = bucket.feeds[feed_index].id;
                    const auto position = states[strategy_index].positions.find(feed_id);
                    const auto mark = states[strategy_index].marks.find(feed_id);
                    if (position != states[strategy_index].positions.end() && mark != states[strategy_index].marks.end()) {
                        strategy_contribution += position->second * mark->second;
                    }
                }
                bucket_contributions[attribution_index] += strategy_contribution;
                states[strategy_index].results.contribution_timestamps.push_back(timestamp);
                states[strategy_index].results.contribution_curve.push_back(strategy_contribution - strategy_initial_capital[strategy_index]);
            }
            for (std::size_t i = 0; i < bucket_results.bucket_attributions.size(); ++i) {
                auto& attribution = bucket_results.bucket_attributions[i];
                attribution.timestamps.push_back(timestamp);
                attribution.contribution_curve.push_back(bucket_contributions[i] - attribution_initial_capital[i]);
            }
            if (config_.capital_allocation == CAPITAL_ALLOCATION_MODE::EQUAL_PER_STRATEGY) {
                for (std::size_t strategy_index = 0; strategy_index < bucket.strategies.size(); ++strategy_index) {
                    states[strategy_index].results.equity_timestamps.push_back(timestamp);
                    states[strategy_index].results.equity_curve.push_back(sleeve_equity(strategy_index));
                }
            }
        }

        for (std::size_t strategy_index = 0; strategy_index < states.size(); ++strategy_index) {
            auto& state = states[strategy_index];
            for (const auto feed_index : subscription_order[strategy_index]) {
                const auto& feed_id = bucket.feeds[feed_index].id;
                const auto pending = state.pending.find(feed_id);
                if (pending == state.pending.end()) continue;
                for (auto& pending_order : pending->second) {
                    auto& order = pending_order.order;
                    order.id = state.id_generator.next();
                    order.status = ORDER_STATUS::CANCELED;
                    order.reason = "no eligible later market event was available to execute this order";
                    state.results.hlog.push_back(std::move(order));
                }
            }
        }

        bucket_results.strategies.reserve(bucket.strategies.size());
        for (std::size_t i = 0; i < bucket.strategies.size(); ++i) {
            if (config_.capital_allocation == CAPITAL_ALLOCATION_MODE::SHARED && bucket.strategies.size() == 1) {
                states[i].results.equity_curve = bucket_results.equity_curve;
                states[i].results.equity_timestamps = bucket_results.equity_timestamps;
            }
            // Under shared capital, individual strategy entries retain order logs;
            // the portfolio curve is carried by the bucket/run result.
            bucket_results.strategies.push_back({bucket.strategies[i].instance_id, bucket.strategies[i].strategy->get_id(), std::move(states[i].results)});
        }
        return bucket_results;
    }

    BacktestRunResults run(const BacktestPlan<Tin>& plan) {
        if (plan.buckets.empty()) throw std::invalid_argument("A backtest plan needs at least one bucket.");
        BacktestRunResults output;
        output.buckets.reserve(plan.buckets.size());
        if (config_.bucket_capital_mode == BUCKET_CAPITAL_MODE::INDEPENDENT) {
            std::unordered_set<std::string> independent_bucket_ids;
            std::unordered_set<std::string> independent_feed_ids;
            for (const auto& bucket : plan.buckets) {
                if (bucket.id.empty() || !independent_bucket_ids.insert(bucket.id).second) {
                    throw std::invalid_argument("Bucket IDs in a backtest plan must be non-empty and unique.");
                }
                if (bucket.feeds.empty() || bucket.strategies.empty()) {
                    throw std::invalid_argument("Every backtest bucket needs at least one feed and one strategy.");
                }
                for (const auto& feed : bucket.feeds) {
                    if (feed.id.empty() || !independent_feed_ids.insert(feed.id).second) {
                        throw std::invalid_argument("Feed IDs must be non-empty and unique across all backtest buckets.");
                    }
                }
            }
            const double bucket_initial_capital = config_.initial_capital / static_cast<double>(plan.buckets.size());
            std::vector<std::size_t> curve_indices(plan.buckets.size(), 0);
            std::vector<long long> portfolio_timestamps;
            for (std::size_t i = 0; i < plan.buckets.size(); ++i) {
                auto bucket_config = config_;
                bucket_config.initial_capital = bucket_initial_capital;
                bucket_config.bucket_capital_mode = BUCKET_CAPITAL_MODE::SHARED;
                Backtester<Tin> bucket_backtester(bucket_config);
                auto bucket_result = bucket_backtester.run(plan.buckets[i]);
                bucket_result.contribution_curve.reserve(bucket_result.equity_curve.size());
                for (const auto equity : bucket_result.equity_curve) {
                    bucket_result.contribution_curve.push_back(equity - bucket_initial_capital);
                }
                bucket_result.contribution_timestamps = bucket_result.equity_timestamps;
                portfolio_timestamps.insert(portfolio_timestamps.end(), bucket_result.equity_timestamps.begin(), bucket_result.equity_timestamps.end());
                output.buckets.push_back(std::move(bucket_result));
            }
            std::sort(portfolio_timestamps.begin(), portfolio_timestamps.end());
            portfolio_timestamps.erase(std::unique(portfolio_timestamps.begin(), portfolio_timestamps.end()), portfolio_timestamps.end());
            output.equity_timestamps = portfolio_timestamps;
            output.equity_curve.reserve(portfolio_timestamps.size());
            for (const auto timestamp : portfolio_timestamps) {
                double portfolio_equity = 0.0;
                for (std::size_t bucket_index = 0; bucket_index < output.buckets.size(); ++bucket_index) {
                    const auto& bucket_result = output.buckets[bucket_index];
                    auto& curve_index = curve_indices[bucket_index];
                    while (curve_index < bucket_result.equity_timestamps.size() && bucket_result.equity_timestamps[curve_index] <= timestamp) ++curve_index;
                    portfolio_equity += curve_index == 0 ? bucket_initial_capital : bucket_result.equity_curve[curve_index - 1];
                }
                output.equity_curve.push_back(portfolio_equity);
            }
            return output;
        }
        std::unordered_set<std::string> bucket_ids;
        std::unordered_set<std::string> feed_ids;
        BacktestBucket<Tin> portfolio_bucket{.id = "__portfolio__"};
        for (const auto& bucket : plan.buckets) {
            if (bucket.id.empty() || !bucket_ids.insert(bucket.id).second) {
                throw std::invalid_argument("Bucket IDs in a backtest plan must be non-empty and unique.");
            }
            if (bucket.feeds.empty() || bucket.strategies.empty()) {
                throw std::invalid_argument("Every backtest bucket needs at least one feed and one strategy.");
            }
            for (const auto& feed : bucket.feeds) {
                if (!feed_ids.insert(feed.id).second) {
                    throw std::invalid_argument("Feed IDs must be unique across all backtest buckets.");
                }
                portfolio_bucket.feeds.push_back(feed);
            }
            for (auto binding : bucket.strategies) {
                binding.bucket_id = bucket.id;
                portfolio_bucket.strategies.push_back(std::move(binding));
            }
        }

        // Buckets only organize feed subscriptions. Flatten them into one event
        // schedule so all strategies share one account and starting capital.
        auto portfolio_results = run(portfolio_bucket);
        output.equity_curve = std::move(portfolio_results.equity_curve);
        output.equity_timestamps = std::move(portfolio_results.equity_timestamps);
        auto strategy_result = portfolio_results.strategies.begin();
        for (const auto& bucket : plan.buckets) {
            BacktestBucketResults bucket_result{.bucket_id = bucket.id};
            const auto attribution = std::find_if(portfolio_results.bucket_attributions.begin(), portfolio_results.bucket_attributions.end(),
                [&bucket](const auto& item) { return item.bucket_id == bucket.id; });
            if (attribution != portfolio_results.bucket_attributions.end()) {
                bucket_result.contribution_curve = attribution->contribution_curve;
                bucket_result.contribution_timestamps = attribution->timestamps;
            }
            bucket_result.strategies.reserve(bucket.strategies.size());
            for (std::size_t i = 0; i < bucket.strategies.size(); ++i, ++strategy_result) {
                bucket_result.strategies.push_back(std::move(*strategy_result));
            }
            output.buckets.push_back(std::move(bucket_result));
        }
        return output;
    }

private:
    struct PendingOrder {
        OrderEvent order;
        long long eligible_at = 0;
        long long stop_lot_id = -1;
    };

    BacktestConfig config_;
    static constexpr double quantity_epsilon = 1e-12;

    static void normalize_position(double& position) {
        if (std::abs(position) <= quantity_epsilon) position = 0.0;
    }

    static void reject(OrderEvent& order, const std::string& reason) {
        order.status = ORDER_STATUS::REJECTED;
        order.reason = reason;
    }

    void fill_buy(OrderEvent& order, double price, double currency_rate, double& cash, double& position) const {
        const double base_notional = price * order.qty * currency_rate;
        const double fee = std::abs(base_notional) * config_.cost_bps / 10'000.0;
        cash -= base_notional + fee;
        position += order.qty;
        normalize_position(position);
        order.status = ORDER_STATUS::FILLED;
        order.price = price;
    }

    void fill_sell(OrderEvent& order, double price, double currency_rate, double& cash, double& position) const {
        const double base_notional = price * order.qty * currency_rate;
        const double fee = std::abs(base_notional) * config_.cost_bps / 10'000.0;
        cash += base_notional - fee;
        position -= order.qty;
        normalize_position(position);
        order.status = ORDER_STATUS::FILLED;
        order.price = price;
    }

    void add_open_lot(std::vector<OrderEvent>& lots, const OrderEvent& order, SIGNAL side, double quantity) const {
        if (quantity <= quantity_epsilon) return;
        OrderEvent lot = order;
        lot.signal = side;
        lot.qty = quantity;
        lot.status = ORDER_STATUS::FILLED;
        lot.reason.clear();
        lots.push_back(std::move(lot));
    }

    static void close_open_lots(std::vector<OrderEvent>& lots, SIGNAL side, const OrderEvent& closing_order,
                                std::vector<OrderEvent>& history, OrderIdGenerator& id_generator) {
        double remaining = closing_order.qty;
        for (auto it = lots.begin(); it != lots.end() && remaining > 0.0;) {
            if (it->signal != side) {
                ++it;
                continue;
            }
            const double closed_quantity = std::min(it->qty, remaining);
            OrderEvent exit_part = closing_order;
            exit_part.id = id_generator.next();
            exit_part.pid = it->id;
            exit_part.qty = closed_quantity;
            exit_part.status = ORDER_STATUS::FILLED;
            history.push_back(std::move(exit_part));
            it->qty -= closed_quantity;
            remaining -= closed_quantity;
            if (it->qty <= quantity_epsilon) it = lots.erase(it);
            else ++it;
        }
    }

    static bool has_stop_loss(const OrderEvent& lot) {
        return lot.sl.type == STOP_TYPE::HARD && (lot.sl.slnot > 0.0 || lot.sl.slpct > 0.0);
    }

    static double stop_price(const OrderEvent& lot) {
        const bool has_notional = lot.sl.slnot > 0.0;
        const bool has_percent = lot.sl.slpct > 0.0;
        if (lot.signal == SIGNAL::LONG) {
            const double percent_stop = lot.price * (1.0 - lot.sl.slpct / 100.0);
            const double notional_stop = lot.price - lot.sl.slnot;
            if (has_notional && has_percent) return std::max(percent_stop, notional_stop);
            return has_percent ? percent_stop : notional_stop;
        }
        const double percent_stop = lot.price * (1.0 + lot.sl.slpct / 100.0);
        const double notional_stop = lot.price + lot.sl.slnot;
        if (has_notional && has_percent) return std::min(percent_stop, notional_stop);
        return has_percent ? percent_stop : notional_stop;
    }

    void execute_stop_losses(std::vector<OrderEvent>& lots, const Tin& event, double currency_rate, long long timestamp,
                             long long eligible_at, long long fill_latency_ms,
                             std::vector<PendingOrder>& pending, std::unordered_set<long long>& pending_stop_lots,
                             double& cash, double& position, std::vector<OrderEvent>& history,
                             OrderIdGenerator& id_generator, Strategy<Tin>& strategy) const {
        for (auto it = lots.begin(); it != lots.end();) {
            if (!has_stop_loss(*it) || pending_stop_lots.contains(it->id)) {
                ++it;
                continue;
            }
            const double stop = stop_price(*it);
            const bool hit = BacktestEventTraits<Tin>::stop_hit(event, it->signal, stop);
            if (!hit) {
                ++it;
                continue;
            }

            OrderEvent exit_order = *it;
            exit_order.ts = timestamp;
            exit_order.pid = it->id;
            exit_order.reason = "stop loss";

            if (BacktestEventTraits<Tin>::supports_fill_latency(event) && fill_latency_ms > 0) {
                exit_order.signal = it->signal == SIGNAL::LONG ? SIGNAL::SELL : SIGNAL::COVER;
                pending.push_back({std::move(exit_order), eligible_at, it->id});
                pending_stop_lots.insert(it->id);
                ++it;
                continue;
            }

            const double execution_price = BacktestEventTraits<Tin>::stop_fill_price(event, it->signal, stop);
            exit_order.price = execution_price;
            exit_order.strategy_id = strategy.get_id();
            exit_order.id = id_generator.next();
            if (it->signal == SIGNAL::LONG) {
                exit_order.signal = SIGNAL::SELL;
                fill_sell(exit_order, execution_price, currency_rate, cash, position);
            } else {
                exit_order.signal = SIGNAL::COVER;
                fill_buy(exit_order, execution_price, currency_rate, cash, position);
            }
            history.push_back(std::move(exit_order));
            it = lots.erase(it);
        }
    }

    void execute_orders(std::vector<OrderEvent>& orders, const Tin& event, double currency_rate, long long timestamp,
                        double& cash, double& position, std::vector<OrderEvent>& lots,
                        std::vector<OrderEvent>& history, OrderIdGenerator& id_generator,
                        Strategy<Tin>& strategy) const {
        const auto& settings = strategy.get_config();
        const bool long_allowed = settings.long_active && config_.direction_mode != TRADE_DIRECTION_MODE::SHORT_ONLY;
        const bool short_allowed = settings.short_active && config_.direction_mode != TRADE_DIRECTION_MODE::LONG_ONLY;
        for (auto& order : orders) {
            if (order.signal == SIGNAL::FLAT) continue;
            const bool is_buy = order.signal == SIGNAL::LONG || order.signal == SIGNAL::BLONG || order.signal == SIGNAL::COVER;
            const double price = is_buy ? BacktestEventTraits<Tin>::buy_price(event) : BacktestEventTraits<Tin>::sell_price(event);
            order.price = price;
            order.ts = timestamp;
            order.strategy_id = strategy.get_id();
            order.id = id_generator.next();
            order.pid = -1;
            if (!(order.qty > quantity_epsilon) || !std::isfinite(order.qty) || !std::isfinite(price)) {
                reject(order, "order quantity must be finite and positive, and execution price finite");
                history.push_back(order);
                continue;
            }
            if (!settings.active) {
                reject(order, "strategy not active");
                history.push_back(order);
                continue;
            }
            const bool forced_stop_exit = order.reason == "stop loss";
            if (is_buy && !forced_stop_exit) {
                const double notional = price * order.qty * currency_rate;
                const double fee = std::abs(notional) * config_.cost_bps / 10'000.0;
                if (notional + fee > cash) {
                    reject(order, "insufficient shared or allocated cash");
                    history.push_back(order);
                    continue;
                }
            }

            switch (order.signal) {
                case SIGNAL::LONG:
                    if (!long_allowed || position < 0.0 || (!settings.stacking && position > 0.0)) {
                        reject(order, "long order not allowed"); history.push_back(order); break;
                    }
                    fill_buy(order, price, currency_rate, cash, position);
                    add_open_lot(lots, order, SIGNAL::LONG, order.qty);
                    history.push_back(order);
                    break;
                case SIGNAL::SHORT:
                    if (!short_allowed || position > 0.0 || (!settings.stacking && position < 0.0)) {
                        reject(order, "short order not allowed"); history.push_back(order); break;
                    }
                    fill_sell(order, price, currency_rate, cash, position);
                    add_open_lot(lots, order, SIGNAL::SHORT, order.qty);
                    history.push_back(order);
                    break;
                case SIGNAL::SELL:
                    if (position <= 0.0 || order.qty > position) {
                        reject(order, "sell exceeds open long position"); history.push_back(order); break;
                    }
                    fill_sell(order, price, currency_rate, cash, position);
                    close_open_lots(lots, SIGNAL::LONG, order, history, id_generator);
                    break;
                case SIGNAL::COVER:
                    if (position >= 0.0 || order.qty > -position) {
                        reject(order, "cover exceeds open short position"); history.push_back(order); break;
                    }
                    fill_buy(order, price, currency_rate, cash, position);
                    close_open_lots(lots, SIGNAL::SHORT, order, history, id_generator);
                    break;
                case SIGNAL::BLONG: {
                    if ((!long_allowed && (position >= 0.0 || order.qty > -position)) ||
                        (!settings.stacking && position > 0.0)) {
                        reject(order, "buy order not allowed"); history.push_back(order); break;
                    }
                    const double previous_position = position;
                    fill_buy(order, price, currency_rate, cash, position);
                    if (previous_position < 0.0) {
                        OrderEvent cover = order;
                        cover.signal = SIGNAL::COVER;
                        cover.qty = std::min(order.qty, -previous_position);
                        close_open_lots(lots, SIGNAL::SHORT, cover, history, id_generator);
                    }
                    if (previous_position >= 0.0) {
                        add_open_lot(lots, order, SIGNAL::LONG, order.qty);
                        history.push_back(order);
                    } else if (position > 0.0) {
                        OrderEvent long_part = order;
                        long_part.id = id_generator.next();
                        long_part.qty = position;
                        add_open_lot(lots, long_part, SIGNAL::LONG, long_part.qty);
                        history.push_back(long_part);
                    }
                    break;
                }
                case SIGNAL::BSHORT: {
                    if ((!short_allowed && (position <= 0.0 || order.qty > position)) ||
                        (!settings.stacking && position < 0.0)) {
                        reject(order, "sell order not allowed"); history.push_back(order); break;
                    }
                    const double previous_position = position;
                    fill_sell(order, price, currency_rate, cash, position);
                    if (previous_position > 0.0) {
                        OrderEvent sell = order;
                        sell.signal = SIGNAL::SELL;
                        sell.qty = std::min(order.qty, previous_position);
                        close_open_lots(lots, SIGNAL::LONG, sell, history, id_generator);
                    }
                    if (previous_position <= 0.0) {
                        add_open_lot(lots, order, SIGNAL::SHORT, order.qty);
                        history.push_back(order);
                    } else if (position < 0.0) {
                        OrderEvent short_part = order;
                        short_part.id = id_generator.next();
                        short_part.qty = -position;
                        add_open_lot(lots, short_part, SIGNAL::SHORT, short_part.qty);
                        history.push_back(short_part);
                    }
                    break;
                }
                case SIGNAL::FLAT:
                    break;
            }
        }
    }
};
