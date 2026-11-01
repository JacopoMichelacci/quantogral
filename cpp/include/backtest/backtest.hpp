#pragma once

#include <algorithm>
#include <cmath>
#include <limits>
#include <queue>
#include <span>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "builder/strategies/strategy_base.hpp"
#include "core/order_events.hpp"

struct BacktestResults {
    std::vector<double> equity_curve;
    std::vector<long long> equity_timestamps;
    std::vector<OrderEvent> hlog;
};

template <typename Tin>
struct BacktestFeed {
    std::string id;
    std::span<const Tin> events;
};

template <typename Tin>
struct BacktestStrategyBinding {
    std::string instance_id;
    Strategy<Tin>* strategy = nullptr;
    std::vector<std::string> feed_ids;
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

struct BacktestBucketResults {
    std::string bucket_id;
    // The combined account curve. In equal-sleeve mode this is the sum of sleeve equity.
    std::vector<double> equity_curve;
    std::vector<long long> equity_timestamps;
    std::vector<StrategyBacktestResult> strategies;
};

struct BacktestRunResults {
    std::vector<BacktestBucketResults> buckets;
};

// Event policies let the same portfolio/order engine consume bars or quotes.
// Additional market-event types can specialize this contract without duplicating
// the bucket scheduler or accounting implementation.
template <typename TEvent>
struct BacktestEventTraits;

template <>
struct BacktestEventTraits<OHLCVEvent> {
    static constexpr bool supports_fill_latency = false;
    static long long timestamp(const OHLCVEvent& event) { return event.ts; }
    static bool valid(const OHLCVEvent& event) {
        return std::isfinite(event.open) && std::isfinite(event.high) && std::isfinite(event.low) &&
               std::isfinite(event.close) && std::isfinite(event.volume) && event.volume >= 0.0 &&
               event.high >= event.low && event.open >= event.low && event.open <= event.high &&
               event.close >= event.low && event.close <= event.high;
    }
    static double buy_price(const OHLCVEvent& event) { return event.open; }
    static double sell_price(const OHLCVEvent& event) { return event.open; }
    static double mark_price(const OHLCVEvent& event, double) { return event.close; }
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
    static constexpr bool supports_fill_latency = true;
    static long long timestamp(const QuoteEvent& event) { return event.ts; }
    static bool valid(const QuoteEvent& event) {
        return std::isfinite(event.bid) && std::isfinite(event.ask) &&
               std::isfinite(event.bidsize) && std::isfinite(event.asksize) &&
               event.ask >= event.bid && event.bidsize >= 0.0 && event.asksize >= 0.0;
    }
    static double buy_price(const QuoteEvent& event) { return event.ask; }
    static double sell_price(const QuoteEvent& event) { return event.bid; }
    static double mark_price(const QuoteEvent& event, double position) {
        if (position > 0.0) return event.bid;
        if (position < 0.0) return event.ask;
        return (event.bid + event.ask) / 2.0;
    }
    static bool stop_hit(const QuoteEvent& event, SIGNAL side, double stop) {
        return side == SIGNAL::LONG ? event.bid <= stop : event.ask >= stop;
    }
    static double stop_fill_price(const QuoteEvent& event, SIGNAL side, double) {
        return side == SIGNAL::LONG ? event.bid : event.ask;
    }
};

enum class CAPITAL_ALLOCATION_MODE {
    SHARED,
    EQUAL_PER_STRATEGY,
};

struct BacktestConfig {
    double initial_capital = 100'000.0;
    double cost_bps = 3.0;
    std::string currency = "USD";
    CAPITAL_ALLOCATION_MODE capital_allocation = CAPITAL_ALLOCATION_MODE::SHARED;
    double fill_latency_seconds = 0.0;
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
            .strategies = {{instance_id, &strategy, {feed_id}}},
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
        const auto eligible_timestamp = [fill_latency_ms](long long submitted_at) {
            const auto delay = BacktestEventTraits<Tin>::supports_fill_latency ? fill_latency_ms : 0LL;
            if (delay > 0 && submitted_at > std::numeric_limits<long long>::max() - delay) {
                throw std::overflow_error("Fill latency exceeds the supported timestamp range.");
            }
            return submitted_at + delay;
        };
        if (bucket.feeds.empty() || bucket.strategies.empty()) {
            throw std::invalid_argument("A backtest bucket needs at least one feed and one strategy.");
        }

        std::unordered_map<std::string, std::size_t> feed_indices;
        for (std::size_t i = 0; i < bucket.feeds.size(); ++i) {
            const auto& feed = bucket.feeds[i];
            if (feed.id.empty() || !feed_indices.emplace(feed.id, i).second) {
                throw std::invalid_argument("Feed IDs in a bucket must be non-empty and unique.");
            }
            for (std::size_t j = 0; j < feed.events.size(); ++j) {
                if (!BacktestEventTraits<Tin>::valid(feed.events[j])) {
                    throw std::invalid_argument("Feed '" + feed.id + "' contains invalid market data at event " + std::to_string(j + 1) + ".");
                }
                if (j > 0 && BacktestEventTraits<Tin>::timestamp(feed.events[j]) < BacktestEventTraits<Tin>::timestamp(feed.events[j - 1])) {
                    throw std::invalid_argument("Feed '" + feed.id + "' must be sorted by timestamp.");
                }
            }
        }

        struct StrategyState {
            double cash = 0.0;
            std::unordered_map<std::string, double> positions;
            std::unordered_map<std::string, double> marks;
            std::unordered_map<std::string, std::vector<OrderEvent>> open_lots;
            std::unordered_map<std::string, std::vector<PendingOrder>> pending;
            std::unordered_set<long long> pending_stop_lots;
            std::vector<OrderEvent> orders;
            OrderIdGenerator id_generator;
            BacktestResults results;
        };
        std::vector<StrategyState> states(bucket.strategies.size());
        double shared_cash = config_.capital_allocation == CAPITAL_ALLOCATION_MODE::SHARED
            ? config_.initial_capital
            : 0.0;
        std::unordered_set<std::string> instance_ids;
        std::unordered_set<const Strategy<Tin>*> strategy_pointers;
        std::vector<std::vector<std::size_t>> subscribers(bucket.feeds.size());
        std::vector<std::unordered_set<std::size_t>> subscribed_feeds(bucket.strategies.size());
        std::vector<std::vector<std::size_t>> subscription_order(bucket.strategies.size());

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
            for (const auto& feed_id : binding.feed_ids) {
                const auto feed = feed_indices.find(feed_id);
                if (feed == feed_indices.end()) {
                    throw std::invalid_argument("Strategy '" + binding.instance_id + "' references unknown feed '" + feed_id + "'.");
                }
                if (subscribed_feeds[strategy_index].insert(feed->second).second) {
                    subscribers[feed->second].push_back(strategy_index);
                    subscription_order[strategy_index].push_back(feed->second);
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
            for (const auto& cursor : batch) latest_events[cursor.feed_index] = &bucket.feeds[cursor.feed_index].events[cursor.event_index];
            for (const auto& cursor : batch) {
                const auto& feed = bucket.feeds[cursor.feed_index];
                const auto& event = feed.events[cursor.event_index];
                for (const auto strategy_index : subscribers[cursor.feed_index]) {
                    auto& state = states[strategy_index];
                    auto& position = state.positions[feed.id];
                    auto& lots = state.open_lots[feed.id];
                    auto& history = state.results.hlog;
                    auto& waiting = state.pending[feed.id];
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
                    execute_orders(ready_orders, event, timestamp,
                                   cash, position, lots, history, state.id_generator, *bucket.strategies[strategy_index].strategy);
                    for (const auto stop_lot_id : ready_stop_lots) state.pending_stop_lots.erase(stop_lot_id);
                    execute_stop_losses(lots, event, timestamp, eligible_timestamp(timestamp), fill_latency_ms,
                                        waiting, state.pending_stop_lots, cash, position, history,
                                        state.id_generator, *bucket.strategies[strategy_index].strategy);
                    state.marks[feed.id] = BacktestEventTraits<Tin>::mark_price(event, position);
                }
            }

            for (const auto& cursor : batch) {
                const auto& feed = bucket.feeds[cursor.feed_index];
                const auto& event = feed.events[cursor.event_index];
                for (const auto strategy_index : subscribers[cursor.feed_index]) {
                    const auto& binding = bucket.strategies[strategy_index];
                    auto& state = states[strategy_index];
                    std::vector<StrategyContext::FeedView> feed_views;
                    feed_views.reserve(subscription_order[strategy_index].size());
                    double equity = config_.capital_allocation == CAPITAL_ALLOCATION_MODE::SHARED
                        ? portfolio_equity()
                        : sleeve_equity(strategy_index);
                    for (const auto subscribed_feed_index : subscription_order[strategy_index]) {
                        const auto& subscribed_feed = bucket.feeds[subscribed_feed_index];
                        const auto position_it = state.positions.find(subscribed_feed.id);
                        const double position = position_it == state.positions.end() ? 0.0 : position_it->second;
                        feed_views.push_back({subscribed_feed.id, latest_events[subscribed_feed_index], position});
                    }
                    const auto current_lots = state.open_lots.find(feed.id);
                    StrategyContext context{
                        .opos = state.positions[feed.id],
                        .equity = equity,
                        .oposlog = current_lots == state.open_lots.end() ? std::vector<OrderEvent>{} : current_lots->second,
                        .feed_id = feed.id,
                        .feeds = feed_views,
                    };
                    state.orders.clear();
                    binding.strategy->on_data(event, context, state.orders);
                    for (auto& order : state.orders) {
                        if (order.signal == SIGNAL::FLAT) continue;
                        if (order.symbol.empty()) order.symbol = feed.id;
                        const auto target_feed = feed_indices.find(order.symbol);
                        if (target_feed == feed_indices.end() || !subscribed_feeds[strategy_index].contains(target_feed->second)) {
                            order.ts = timestamp;
                            order.strategy_id = binding.strategy->get_id();
                            order.id = state.id_generator.next();
                            reject(order, "order targets a feed not connected to this strategy");
                            state.results.hlog.push_back(order);
                            continue;
                        }
                        order.ts = timestamp;
                        order.strategy_id = binding.strategy->get_id();
                        state.pending[order.symbol].push_back({std::move(order), eligible_timestamp(timestamp), -1});
                    }
                }
            }

            const double total_equity = portfolio_equity();
            bucket_results.equity_timestamps.push_back(timestamp);
            bucket_results.equity_curve.push_back(total_equity);
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
            // With shared capital, the meaningful equity curve belongs to the
            // bucket account; individual strategy entries retain their order logs.
            bucket_results.strategies.push_back({bucket.strategies[i].instance_id, bucket.strategies[i].strategy->get_id(), std::move(states[i].results)});
        }
        return bucket_results;
    }

    BacktestRunResults run(const BacktestPlan<Tin>& plan) {
        if (plan.buckets.empty()) throw std::invalid_argument("A backtest plan needs at least one bucket.");
        BacktestRunResults output;
        output.buckets.reserve(plan.buckets.size());
        std::unordered_set<std::string> bucket_ids;
        for (const auto& bucket : plan.buckets) {
            if (bucket.id.empty() || !bucket_ids.insert(bucket.id).second) {
                throw std::invalid_argument("Bucket IDs in a backtest plan must be non-empty and unique.");
            }
            // Buckets are independent strategy sleeves, so each gets its own
            // chronological feed merge; their execution order cannot affect one another.
            output.buckets.push_back(run(bucket));
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

    void fill_buy(OrderEvent& order, double price, double& cash, double& position) const {
        const double fee = std::abs(price * order.qty) * config_.cost_bps / 10'000.0;
        cash -= price * order.qty + fee;
        position += order.qty;
        normalize_position(position);
        order.status = ORDER_STATUS::FILLED;
        order.price = price;
    }

    void fill_sell(OrderEvent& order, double price, double& cash, double& position) const {
        const double fee = std::abs(price * order.qty) * config_.cost_bps / 10'000.0;
        cash += price * order.qty - fee;
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

    void execute_stop_losses(std::vector<OrderEvent>& lots, const Tin& event, long long timestamp,
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

            if constexpr (BacktestEventTraits<Tin>::supports_fill_latency) {
                if (fill_latency_ms > 0) {
                    exit_order.signal = it->signal == SIGNAL::LONG ? SIGNAL::SELL : SIGNAL::COVER;
                    pending.push_back({std::move(exit_order), eligible_at, it->id});
                    pending_stop_lots.insert(it->id);
                    ++it;
                    continue;
                }
            }

            const double execution_price = BacktestEventTraits<Tin>::stop_fill_price(event, it->signal, stop);
            exit_order.price = execution_price;
            exit_order.strategy_id = strategy.get_id();
            exit_order.id = id_generator.next();
            if (it->signal == SIGNAL::LONG) {
                exit_order.signal = SIGNAL::SELL;
                fill_sell(exit_order, execution_price, cash, position);
            } else {
                exit_order.signal = SIGNAL::COVER;
                fill_buy(exit_order, execution_price, cash, position);
            }
            history.push_back(std::move(exit_order));
            it = lots.erase(it);
        }
    }

    void execute_orders(std::vector<OrderEvent>& orders, const Tin& event, long long timestamp,
                        double& cash, double& position, std::vector<OrderEvent>& lots,
                        std::vector<OrderEvent>& history, OrderIdGenerator& id_generator,
                        Strategy<Tin>& strategy) const {
        const auto& settings = strategy.get_config();
        for (auto& order : orders) {
            if (order.signal == SIGNAL::FLAT) continue;
            const bool is_buy = order.signal == SIGNAL::LONG || order.signal == SIGNAL::BBUY || order.signal == SIGNAL::COVER;
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
                const double fee = std::abs(price * order.qty) * config_.cost_bps / 10'000.0;
                if (price * order.qty + fee > cash) {
                    reject(order, "insufficient shared or allocated cash");
                    history.push_back(order);
                    continue;
                }
            }

            switch (order.signal) {
                case SIGNAL::LONG:
                    if (!settings.long_active || position < 0.0 || (!settings.stacking && position > 0.0)) {
                        reject(order, "long order not allowed"); history.push_back(order); break;
                    }
                    fill_buy(order, price, cash, position);
                    add_open_lot(lots, order, SIGNAL::LONG, order.qty);
                    history.push_back(order);
                    break;
                case SIGNAL::SHORT:
                    if (!settings.short_active || position > 0.0 || (!settings.stacking && position < 0.0)) {
                        reject(order, "short order not allowed"); history.push_back(order); break;
                    }
                    fill_sell(order, price, cash, position);
                    add_open_lot(lots, order, SIGNAL::SHORT, order.qty);
                    history.push_back(order);
                    break;
                case SIGNAL::SELL:
                    if (position <= 0.0 || order.qty > position) {
                        reject(order, "sell exceeds open long position"); history.push_back(order); break;
                    }
                    fill_sell(order, price, cash, position);
                    close_open_lots(lots, SIGNAL::LONG, order, history, id_generator);
                    break;
                case SIGNAL::COVER:
                    if (position >= 0.0 || order.qty > -position) {
                        reject(order, "cover exceeds open short position"); history.push_back(order); break;
                    }
                    fill_buy(order, price, cash, position);
                    close_open_lots(lots, SIGNAL::SHORT, order, history, id_generator);
                    break;
                case SIGNAL::BBUY: {
                    if ((!settings.long_active && (position >= 0.0 || order.qty > -position)) ||
                        (!settings.stacking && position > 0.0)) {
                        reject(order, "buy order not allowed"); history.push_back(order); break;
                    }
                    const double previous_position = position;
                    fill_buy(order, price, cash, position);
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
                case SIGNAL::BSELL: {
                    if ((!settings.short_active && (position <= 0.0 || order.qty > position)) ||
                        (!settings.stacking && position < 0.0)) {
                        reject(order, "sell order not allowed"); history.push_back(order); break;
                    }
                    const double previous_position = position;
                    fill_sell(order, price, cash, position);
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
