#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "backtest/backtest.hpp"
#include "quantogral_strategy_registry.generated.hpp"
#include "core/market_events.hpp"
#include "utils/time.hpp"

namespace {

std::string json_escape(const std::string& value) {
    std::ostringstream escaped;
    for (const unsigned char ch : value) {
        switch (ch) {
            case '"': escaped << "\\\""; break;
            case '\\': escaped << "\\\\"; break;
            case '\b': escaped << "\\b"; break;
            case '\f': escaped << "\\f"; break;
            case '\n': escaped << "\\n"; break;
            case '\r': escaped << "\\r"; break;
            case '\t': escaped << "\\t"; break;
            default:
                if (ch < 0x20) escaped << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(ch);
                else escaped << ch;
        }
    }
    return escaped.str();
}

std::vector<std::string> split_csv_row(const std::string& line) {
    std::vector<std::string> cells;
    std::string cell;
    bool quoted = false;
    for (std::size_t i = 0; i < line.size(); ++i) {
        const char ch = line[i];
        if (ch == '"') {
            if (quoted && i + 1 < line.size() && line[i + 1] == '"') {
                cell.push_back('"');
                ++i;
            } else {
                quoted = !quoted;
            }
        } else if (ch == ',' && !quoted) {
            cells.push_back(std::move(cell));
            cell.clear();
        } else {
            cell.push_back(ch);
        }
    }
    cells.push_back(std::move(cell));
    return cells;
}

long long parse_timestamp(const std::string& value, TS_UNIT unit, DATE_FORMAT format) {
    char* end = nullptr;
    const long long numeric_value = std::strtoll(value.c_str(), &end, 10);
    if (end != value.c_str() && *end == '\0') return to_epoch_ms(numeric_value, unit);
    return to_epoch_ms(value, format);
}

std::string normalized(std::string value) {
    value.erase(std::remove_if(value.begin(), value.end(), [](unsigned char ch) { return !std::isalnum(ch); }), value.end());
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return value;
}

struct OhlcvColumns {
    std::size_t timestamp = 0;
    std::size_t open = 1;
    std::size_t high = 2;
    std::size_t low = 3;
    std::size_t close = 4;
    std::size_t volume = 5;
};

struct LoadedOhlcvFeed {
    std::vector<OHLCVEvent> events;
    std::vector<double> account_currency_rates;
};

std::optional<OhlcvColumns> detect_ohlcv_header(const std::vector<std::string>& cells) {
    OhlcvColumns columns;
    bool has_timestamp = false, has_open = false, has_high = false;
    bool has_low = false, has_close = false, has_volume = false;
    for (std::size_t i = 0; i < cells.size(); ++i) {
        const auto name = normalized(cells[i]);
        if (name == "timestamp" || name == "time" || name == "date" || name == "datetime" || name == "ts" || name == "epoch") {
            columns.timestamp = i; has_timestamp = true;
        } else if (name == "open" || name == "o") { columns.open = i; has_open = true; }
        else if (name == "high" || name == "h") { columns.high = i; has_high = true; }
        else if (name == "low" || name == "l") { columns.low = i; has_low = true; }
        else if (name == "close" || name == "c") { columns.close = i; has_close = true; }
        else if (name == "volume" || name == "vol" || name == "v") { columns.volume = i; has_volume = true; }
    }
    if (has_timestamp && has_open && has_high && has_low && has_close && has_volume) return columns;
    return std::nullopt;
}

OHLCVEvent parse_ohlcv_row(const std::vector<std::string>& cells, const OhlcvColumns& columns, TS_UNIT unit, DATE_FORMAT format, double& account_currency_rate) {
    const auto largest_column = std::max({columns.timestamp, columns.open, columns.high, columns.low, columns.close, columns.volume});
    if (cells.size() <= largest_column) throw std::runtime_error("Each market-data row must contain timestamp, open, high, low, close, and volume values.");
    OHLCVEvent bar;
    bar.ts = parse_timestamp(cells[columns.timestamp], unit, format);
    const auto number = [&cells](std::size_t column, const char* name) {
        try {
            std::size_t consumed = 0;
            const double value = std::stod(cells[column], &consumed);
            while (consumed < cells[column].size() && std::isspace(static_cast<unsigned char>(cells[column][consumed]))) ++consumed;
            if (consumed != cells[column].size()) throw std::invalid_argument("trailing characters");
            return value;
        } catch (const std::exception&) {
            throw std::runtime_error("column '" + std::string(name) + "' is not numeric (value '" + cells[column] + "').");
        }
    };
    bar.open = number(columns.open, "open");
    bar.high = number(columns.high, "high");
    bar.low = number(columns.low, "low");
    bar.close = number(columns.close, "close");
    bar.volume = number(columns.volume, "volume");
    account_currency_rate = cells.size() > 6 && !cells[6].empty() ? number(6, "conversion_rate") : 1.0;
    if (!std::isfinite(bar.open) || !std::isfinite(bar.high) || !std::isfinite(bar.low) ||
        !std::isfinite(bar.close) || !std::isfinite(bar.volume) ||
        !std::isfinite(account_currency_rate) || account_currency_rate <= 0.0) {
        throw std::runtime_error("Market data contains a non-finite OHLCV value or invalid backtester conversion rate.");
    }
    return bar;
}

LoadedOhlcvFeed load_ohlcv_csv(const std::string& path, TS_UNIT unit, DATE_FORMAT format) {
    std::ifstream input(path);
    if (!input) throw std::runtime_error("Could not open the selected market-data file.");

    std::vector<std::string> rows;
    std::string line;
    while (std::getline(input, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (!line.empty()) rows.push_back(std::move(line));
    }
    if (rows.empty()) throw std::runtime_error("The selected market-data file is empty.");

    const auto header = detect_ohlcv_header(split_csv_row(rows.front()));
    const std::size_t first_row = header ? 1 : 0;
    const OhlcvColumns columns = header.value_or(OhlcvColumns{});
    LoadedOhlcvFeed feed;
    for (std::size_t i = first_row; i < rows.size(); ++i) {
        try {
            double rate = 1.0;
            feed.events.push_back(parse_ohlcv_row(split_csv_row(rows[i]), columns, unit, format, rate));
            feed.account_currency_rates.push_back(rate);
        } catch (const std::exception& error) {
            throw std::runtime_error("Could not read market-data row " + std::to_string(i + 1) + ": " + error.what());
        }
    }
    if (feed.events.empty()) throw std::runtime_error("The selected market-data file contains no OHLCV rows.");
    return feed;
}

const char* signal_name(SIGNAL signal) {
    switch (signal) {
        case SIGNAL::SELL: return "SELL";
        case SIGNAL::SHORT: return "SHORT";
        case SIGNAL::FLAT: return "FLAT";
        case SIGNAL::LONG: return "LONG";
        case SIGNAL::COVER: return "COVER";
        case SIGNAL::BLONG: return "BLONG";
        case SIGNAL::BSHORT: return "BSHORT";
    }
    return "UNKNOWN";
}

const char* status_name(ORDER_STATUS status) {
    switch (status) {
        case ORDER_STATUS::PENDING: return "PENDING";
        case ORDER_STATUS::FILLED: return "FILLED";
        case ORDER_STATUS::PFILLED: return "PARTIALLY_FILLED";
        case ORDER_STATUS::REJECTED: return "REJECTED";
        case ORDER_STATUS::CANCELED: return "CANCELED";
    }
    return "UNKNOWN";
}

const char* stop_type_name(STOP_TYPE type) {
    switch (type) {
        case STOP_TYPE::NONE: return "NONE";
        case STOP_TYPE::HARD: return "HARD";
    }
    return "UNKNOWN";
}

TS_UNIT parse_ts_unit(const std::string& value) {
    if (value == "SECONDS") return TS_UNIT::SECONDS;
    if (value == "MILLISECONDS") return TS_UNIT::MILLISECONDS;
    if (value == "MICROSECONDS") return TS_UNIT::MICROSECONDS;
    if (value == "NANOSECONDS") return TS_UNIT::NANOSECONDS;
    throw std::invalid_argument("Unsupported timestamp unit for data feed.");
}

DATE_FORMAT parse_date_format(const std::string& value) {
    if (value == "DDMMYYYY") return DATE_FORMAT::DDMMYYYY;
    if (value == "MMDDYYYY") return DATE_FORMAT::MMDDYYYY;
    throw std::invalid_argument("Unsupported date format for data feed.");
}

TRADE_DIRECTION_MODE parse_direction_mode(const std::string& value) {
    if (value == "BOTH") return TRADE_DIRECTION_MODE::BOTH;
    if (value == "LONG_ONLY") return TRADE_DIRECTION_MODE::LONG_ONLY;
    if (value == "SHORT_ONLY") return TRADE_DIRECTION_MODE::SHORT_ONLY;
    throw std::invalid_argument("Unsupported trade direction mode.");
}

void print_equity_curve(const std::vector<double>& curve) {
    std::cout << '[';
    for (std::size_t i = 0; i < curve.size(); ++i) {
        if (i) std::cout << ',';
        std::cout << curve[i];
    }
    std::cout << ']';
}

using CurrencyRateLookup = std::unordered_map<std::string, std::unordered_map<long long, double>>;

void print_orders(const std::vector<OrderEvent>& orders, const CurrencyRateLookup& rates) {
    std::cout << '[';
    for (std::size_t i = 0; i < orders.size(); ++i) {
        const auto& order = orders[i];
        if (i) std::cout << ',';
        const auto feed_rates = rates.find(order.symbol);
        double account_currency_rate = 1.0;
        if (feed_rates != rates.end()) {
            const auto rate = feed_rates->second.find(order.ts);
            if (rate != feed_rates->second.end()) account_currency_rate = rate->second;
        }
        std::cout << "{\"id\":" << order.id
                  << ",\"parentId\":" << order.pid
                  << ",\"timestamp\":" << order.ts
                  << ",\"feedId\":\"" << json_escape(order.symbol) << "\""
                  << ",\"signal\":\"" << signal_name(order.signal) << "\""
                  << ",\"quantity\":" << order.qty
                  << ",\"price\":" << order.price
                  << ",\"currencyRate\":" << account_currency_rate
                  << ",\"stopType\":\"" << stop_type_name(order.sl.type) << "\""
                  << ",\"stopNotional\":" << order.sl.slnot
                  << ",\"stopPercent\":" << order.sl.slpct
                  << ",\"status\":\"" << status_name(order.status) << "\""
                  << ",\"reason\":\"" << json_escape(order.reason) << "\"}";
    }
    std::cout << ']';
}

void print_results(const BacktestRunResults& results, std::size_t input_rows, const CurrencyRateLookup& rates) {
    std::cout << std::setprecision(15) << "{\"inputRows\":" << input_rows << ",\"equityCurve\":";
    print_equity_curve(results.equity_curve);
    std::cout << ",\"equityTimestamps\":[";
    for (std::size_t i = 0; i < results.equity_timestamps.size(); ++i) {
        if (i) std::cout << ',';
        std::cout << results.equity_timestamps[i];
    }
    std::cout << "],\"buckets\":[";
    for (std::size_t bucket_index = 0; bucket_index < results.buckets.size(); ++bucket_index) {
        const auto& bucket = results.buckets[bucket_index];
        if (bucket_index) std::cout << ',';
        std::cout << "{\"id\":\"" << json_escape(bucket.bucket_id) << "\",\"equityCurve\":";
        print_equity_curve(bucket.equity_curve);
        std::cout << ",\"equityTimestamps\":[";
        for (std::size_t i = 0; i < bucket.equity_timestamps.size(); ++i) {
            if (i) std::cout << ',';
            std::cout << bucket.equity_timestamps[i];
        }
        std::cout << "],\"contributionCurve\":";
        print_equity_curve(bucket.contribution_curve);
        std::cout << ",\"contributionTimestamps\":[";
        for (std::size_t i = 0; i < bucket.contribution_timestamps.size(); ++i) {
            if (i) std::cout << ',';
            std::cout << bucket.contribution_timestamps[i];
        }
        std::cout << "],\"strategies\":[";
        for (std::size_t strategy_index = 0; strategy_index < bucket.strategies.size(); ++strategy_index) {
            const auto& strategy = bucket.strategies[strategy_index];
            if (strategy_index) std::cout << ',';
            std::cout << "{\"instanceId\":\"" << json_escape(strategy.instance_id)
                      << "\",\"engineId\":" << strategy.strategy_id << ",\"equityCurve\":";
            print_equity_curve(strategy.results.equity_curve);
            std::cout << ",\"orders\":";
            print_orders(strategy.results.hlog, rates);
            std::cout << ",\"indicators\":[";
            for (std::size_t indicator_index = 0; indicator_index < strategy.results.indicators.size(); ++indicator_index) {
                const auto& indicator = strategy.results.indicators[indicator_index];
                if (indicator_index) std::cout << ',';
                std::cout << "{\"name\":\"" << json_escape(indicator.name)
                          << "\",\"feedId\":\"" << json_escape(indicator.feed_id)
                          << "\",\"points\":[";
                const auto point_count = std::min(indicator.timestamps.size(), indicator.values.size());
                for (std::size_t point_index = 0; point_index < point_count; ++point_index) {
                    if (point_index) std::cout << ',';
                    std::cout << "{\"timestamp\":" << indicator.timestamps[point_index]
                              << ",\"value\":" << indicator.values[point_index] << '}';
                }
                std::cout << "]}";
            }
            std::cout << ']';
            std::cout << '}';
        }
        std::cout << "]}";
    }
    std::cout << "]}\n";
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc < 8 || std::string(argv[1]) != "--run-plan") {
            throw std::invalid_argument("Invalid runner arguments.");
        }
        int argument_index = 2;
        const double initial_capital = std::stod(argv[argument_index++]);
        const double cost_bps = std::stod(argv[argument_index++]);
        const std::string allocation_mode = argv[argument_index++];
        // Accept the earlier runner argument layout as well, so an already
        // running local API process can continue to launch this newer binary.
        std::string bucket_capital_mode = "SHARED";
        if (std::string(argv[argument_index]) == "SHARED" || std::string(argv[argument_index]) == "INDEPENDENT") {
            bucket_capital_mode = argv[argument_index++];
        }
        const double fill_latency_seconds = std::stod(argv[argument_index++]);
        const auto direction_mode = parse_direction_mode(argv[argument_index++]);
        const auto bucket_count = static_cast<std::size_t>(std::stoull(argv[argument_index++]));
        if (bucket_count == 0) throw std::invalid_argument("A backtest plan needs at least one bucket.");

        BacktestConfig config{.initial_capital = initial_capital, .cost_bps = cost_bps};
        if (allocation_mode == "SHARED") config.capital_allocation = CAPITAL_ALLOCATION_MODE::SHARED;
        else if (allocation_mode == "EQUAL_PER_STRATEGY") config.capital_allocation = CAPITAL_ALLOCATION_MODE::EQUAL_PER_STRATEGY;
        else throw std::invalid_argument("Unsupported capital allocation mode.");
        if (bucket_capital_mode == "SHARED") config.bucket_capital_mode = BUCKET_CAPITAL_MODE::SHARED;
        else if (bucket_capital_mode == "INDEPENDENT") config.bucket_capital_mode = BUCKET_CAPITAL_MODE::INDEPENDENT;
        else throw std::invalid_argument("Unsupported bucket capital mode.");
        config.fill_latency_seconds = fill_latency_seconds;
        config.direction_mode = direction_mode;

        const auto require_arguments = [&](std::size_t count) {
            if (count > static_cast<std::size_t>(argc - argument_index)) {
                throw std::invalid_argument("Backtest plan ended before all bucket configuration was read.");
            }
        };
        const auto& registry = quantogral::strategy_registry();
        BacktestPlan<OHLCVEvent> plan;
        plan.buckets.reserve(bucket_count);
        std::vector<std::vector<LoadedOhlcvFeed>> all_feed_data;
        all_feed_data.reserve(bucket_count);
        std::vector<std::unique_ptr<Strategy<OHLCVEvent>>> owned_strategies;
        CurrencyRateLookup currency_rates;
        std::size_t total_input_rows = 0;
        for (std::size_t bucket_index = 0; bucket_index < bucket_count; ++bucket_index) {
            require_arguments(2);
            BacktestBucket<OHLCVEvent> bucket;
            bucket.id = argv[argument_index++];
            const auto feed_count = static_cast<std::size_t>(std::stoull(argv[argument_index++]));
            if (bucket.id.empty() || feed_count == 0) throw std::invalid_argument("Every configured bucket needs an ID and at least one feed.");
            require_arguments(feed_count * 4 + 1);
            std::vector<LoadedOhlcvFeed> feed_data;
            feed_data.reserve(feed_count);
            bucket.feeds.reserve(feed_count);
            for (std::size_t feed_index = 0; feed_index < feed_count; ++feed_index) {
                const std::string feed_id = argv[argument_index++];
                const std::string data_path = argv[argument_index++];
                const auto ts_unit = parse_ts_unit(argv[argument_index++]);
                const auto date_format = parse_date_format(argv[argument_index++]);
                feed_data.push_back(load_ohlcv_csv(data_path, ts_unit, date_format));
                auto& loaded_feed = feed_data.back();
                total_input_rows += loaded_feed.events.size();
                for (std::size_t event_index = 0; event_index < loaded_feed.events.size(); ++event_index) {
                    currency_rates[feed_id][loaded_feed.events[event_index].ts] = loaded_feed.account_currency_rates[event_index];
                }
                bucket.feeds.push_back({
                    feed_id,
                    std::span<const OHLCVEvent>(loaded_feed.events),
                    std::span<const double>(loaded_feed.account_currency_rates),
                });
            }

            const auto strategy_count = static_cast<std::size_t>(std::stoull(argv[argument_index++]));
            if (strategy_count == 0) throw std::invalid_argument("Every configured bucket needs at least one strategy.");
            bucket.strategies.reserve(strategy_count);
            for (std::size_t strategy_index = 0; strategy_index < strategy_count; ++strategy_index) {
                require_arguments(4);
                const std::string instance_id = argv[argument_index++];
                const std::string strategy_id = argv[argument_index++];
                const auto connected_feed_count = static_cast<std::size_t>(std::stoull(argv[argument_index++]));
                require_arguments(connected_feed_count + 1);
                std::vector<std::string> feed_ids;
                feed_ids.reserve(connected_feed_count);
                for (std::size_t i = 0; i < connected_feed_count; ++i) feed_ids.emplace_back(argv[argument_index++]);
                const auto value_count = static_cast<std::size_t>(std::stoull(argv[argument_index++]));
                require_arguments(value_count);
                quantogral::StrategyValues values;
                for (std::size_t i = 0; i < value_count; ++i) {
                    const std::string setting = argv[argument_index++];
                    const auto separator = setting.find('=');
                    if (separator == std::string::npos || separator == 0) throw std::invalid_argument("Strategy settings must use key=value form.");
                    values[setting.substr(0, separator)] = setting.substr(separator + 1);
                }
                const auto definition = std::find_if(registry.begin(), registry.end(), [&](const auto& item) { return item.id == strategy_id; });
                if (definition == registry.end()) throw std::invalid_argument("Strategy is not included in this compiled runner: " + strategy_id);
                owned_strategies.push_back(definition->create(values));
                bucket.strategies.push_back({instance_id, owned_strategies.back().get(), std::move(feed_ids), {}});
            }
            all_feed_data.push_back(std::move(feed_data));
            plan.buckets.push_back(std::move(bucket));
        }
        if (argument_index != argc) throw std::invalid_argument("Unexpected extra backtest runner arguments.");
        Backtester<OHLCVEvent> backtester(config);
        print_results(backtester.run(plan), total_input_rows, currency_rates);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 2;
    }
}
