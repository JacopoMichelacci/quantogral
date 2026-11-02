#pragma once

#include <vector>
#include <span>
#include <array>
#include <string>
#include <string_view>
#include <utility>
#include <optional>
#include <iostream>
#include <type_traits>

#include <atomic>

#include "core/market_events.hpp"
#include "core/order_events.hpp"
#include "utils/time.hpp"


namespace detail {
    inline std::string resolve_name(const std::string& name, const std::string& file_path) {
        if (!name.empty()) {
            return name; 
        }

        const auto slash = file_path.find_last_of("/\\");
        const auto file  = (slash == std::string::npos) ? file_path : file_path.substr(slash + 1);
        const auto dot   = file.find_last_of('.');
        return (dot == std::string::npos) ? file : file.substr(0, dot);
    }
}


struct StrategyConfig {
    bool active = true;             // allows trades
    bool long_active = true;        // allows longs
    bool short_active = true;       // allows shorts
    bool stacking = true;           // allows stacking orders in the same direction

    TS_UNIT     ts_unit     = TS_UNIT::MILLISECONDS;
    DATE_FORMAT date_format = DATE_FORMAT::DDMMYYYY;
};


template <typename Tin>
class Backtester;

struct StrategyContext {
    using SubEventQueues = std::array<std::vector<FeedEvent>, 3>;

    double opos = 0.0;
    double equity = 0.0;
    std::vector<OrderEvent> oposlog;
    std::string_view feed_id;
    std::uint8_t main_feed_id = 0;

    // Returns this Main callback's queued events for the requested Sub role.
    // The span is valid only until on_data returns.
    std::span<const FeedEvent> get_subfeed(std::uint8_t parent_main_id, FeedRole role) const {
        if (parent_main_id != main_feed_id || role == FeedRole::MAIN || !queued_sub_events_) return {};
        const auto role_index = static_cast<std::size_t>(role) - static_cast<std::size_t>(FeedRole::SUB1);
        if (role_index >= queued_sub_events_->size()) return {};
        return (*queued_sub_events_)[role_index];
    }

    double fixed_fractional_price_qty(double native_price, double equity_fraction) const {
        return equity * equity_fraction / (native_price * account_currency_per_native_unit_);
    }

    double fixed_fractional_sl_qty(double native_risk_per_unit, double equity_fraction) const {
        return equity * equity_fraction / (native_risk_per_unit * account_currency_per_native_unit_);
    }

private:
    double account_currency_per_native_unit_ = 1.0;
    const SubEventQueues* queued_sub_events_ = nullptr;
    template <typename Tin>
    friend class Backtester;
};


enum class SIZING_MODE {
    FIXED,
    FIXED_FRACTIONAL_PRICE,
    FIXED_FRACTIONAL_SL
};

struct SizingConfig {
    SIZING_MODE mode = SIZING_MODE::FIXED;
    double qty = 1.0;
    double equity_pct = 0.05;
};


struct SharedStrategyBase {
protected:
    inline static std::atomic<long long> id_state = 0;
};
template <typename Tin>
class Strategy : public SharedStrategyBase {
public:
    Strategy(std::string name_, StrategyConfig bconfig_ = {}) 
        : name(std::move(name_)), 
        id(++id_state), 
        tag(name + "#" + std::to_string(id)),
        bconfig(std::move(bconfig_)) {

        if (name.empty()) {
            std::cerr << "Strategy with id: " << id << " was neglected a meaningful name.\n";
        }
    }

    virtual ~Strategy() = default;

    // works for: Live and Backtest -- generates a vector of OrderEvents
    virtual void on_data(const Tin& input, const StrategyContext& ctx, std::vector<OrderEvent>& out) = 0;


    // getters
    std::string_view get_name() const { return name; }
    long long get_id() const { return id; }
    std::string_view get_tag() const { return tag; }

    const StrategyConfig& get_config() const { return bconfig; }


protected:
    std::string name;
    long long id;
    std::string tag;

    // base config
    StrategyConfig bconfig;

    // resolves the right timestamp type at compile time
    long long resolve_ts(const Tin& input) {
        auto ts = get_timestamp(input);

        if constexpr (std::is_same_v<decltype(ts), std::string>) {
            return to_epoch_ms(ts, bconfig.date_format);
        }
        else if constexpr (std::is_integral_v<decltype(ts)>) {
            return to_epoch_ms(ts, bconfig.ts_unit);
        }
        else {
            static_assert(!std::is_same_v<Tin, Tin>, "resolve_ts: timestamp field type not supported");
        }
    }
};
