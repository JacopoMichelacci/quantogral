#pragma once

#include <algorithm>
#include <cmath>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include "builder/strategies/strategy_base.hpp"
#include "core/order_events.hpp"

struct BacktestResults {
    std::vector<double> equity_curve;
    std::vector<OrderEvent> hlog;
};

struct BacktestConfig {
    double initial_capital = 100'000.0;
    double cost_bps = 3.0;
    std::string currency = "USD";
};

template <typename Tin>
class Backtester {
public:
    explicit Backtester(BacktestConfig config = {}) : config_(std::move(config)) {}

    BacktestResults run(Strategy<Tin>& strategy, std::span<const Tin> input) {
        BacktestResults results;
        results.equity_curve.reserve(input.size());

        double cash = config_.initial_capital;
        double position = 0.0;
        std::vector<OrderEvent> open_lots;
        std::vector<OrderEvent> pending;
        std::vector<OrderEvent> strategy_orders;
        OrderIdGenerator id_generator;

        for (const auto& bar : input) {
            execute_orders(pending, bar.open, bar.ts, cash, position, open_lots, results.hlog, id_generator, strategy);
            pending.clear();
            execute_stop_losses(open_lots, bar.high, bar.low, bar.ts, cash, position, results.hlog, id_generator, strategy);

            strategy_orders.clear();
            StrategyContext context{.opos = position, .equity = cash + position * bar.close, .oposlog = open_lots};
            strategy.on_data(bar, context, strategy_orders);
            pending = strategy_orders;
            results.equity_curve.push_back(cash + position * bar.close);
        }

        return results;
    }

private:
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
        const double fee = price * order.qty * config_.cost_bps / 10'000.0;
        cash -= price * order.qty + fee;
        position += order.qty;
        normalize_position(position);
        order.status = ORDER_STATUS::FILLED;
        order.price = price;
    }

    void fill_sell(OrderEvent& order, double price, double& cash, double& position) const {
        const double fee = price * order.qty * config_.cost_bps / 10'000.0;
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

    void execute_stop_losses(std::vector<OrderEvent>& lots, double high, double low, long long timestamp,
                             double& cash, double& position, std::vector<OrderEvent>& history,
                             OrderIdGenerator& id_generator, Strategy<Tin>& strategy) const {
        for (auto it = lots.begin(); it != lots.end();) {
            if (!has_stop_loss(*it)) {
                ++it;
                continue;
            }
            const double stop = stop_price(*it);
            const bool hit = it->signal == SIGNAL::LONG ? low <= stop : high >= stop;
            if (!hit) {
                ++it;
                continue;
            }

            OrderEvent exit_order = *it;
            exit_order.ts = timestamp;
            exit_order.price = stop;
            exit_order.strategy_id = strategy.get_id();
            exit_order.id = id_generator.next();
            exit_order.pid = it->id;
            exit_order.reason = "stop loss";
            if (it->signal == SIGNAL::LONG) {
                exit_order.signal = SIGNAL::SELL;
                fill_sell(exit_order, stop, cash, position);
            } else {
                exit_order.signal = SIGNAL::COVER;
                fill_buy(exit_order, stop, cash, position);
            }
            history.push_back(std::move(exit_order));
            it = lots.erase(it);
        }
    }

    void execute_orders(std::vector<OrderEvent>& orders, double price, long long timestamp,
                        double& cash, double& position, std::vector<OrderEvent>& lots,
                        std::vector<OrderEvent>& history, OrderIdGenerator& id_generator,
                        Strategy<Tin>& strategy) const {
        const auto& settings = strategy.get_config();
        for (auto& order : orders) {
            if (order.signal == SIGNAL::FLAT) continue;
            order.price = price;
            order.ts = timestamp;
            order.strategy_id = strategy.get_id();
            order.id = id_generator.next();
            order.pid = -1;
            if (!settings.active) {
                reject(order, "strategy not active");
                history.push_back(order);
                continue;
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
