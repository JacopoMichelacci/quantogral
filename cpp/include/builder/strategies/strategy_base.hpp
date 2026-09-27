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


struct StrategyContext {
    double opos = 0.0;
    double equity = 0.0;
    std::vector<OrderEvent> oposlog;
};


enum class SIZING_MODE {
    FIXED,
    FIXED_FRACTIONAL_PRICE,
    FIXED_FRACTIONAL_SL
};


class PositionSizer {
public:
    PositionSizer() = default;

    double fixed_fractional_price(double equity, double price, double equity_pct) const {
        return equity * equity_pct / price;
    }

    double fixed_fractional_sl(double equity, double sl_notional, double equity_pct) const {
        return equity * equity_pct / sl_notional;
    }
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

    PositionSizer sizer;


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
            static_assert(false, "resolve_ts: timestamp field type not supported");
        }
    }
};
