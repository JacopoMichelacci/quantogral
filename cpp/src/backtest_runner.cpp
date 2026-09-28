#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "backtest/backtest.hpp"
#include "builder/strategies/built-in/ma_cross.hpp"
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

bool is_header_row(const std::vector<std::string>& cells) {
    if (cells.size() < 6) return false;
    const auto timestamp = normalized(cells[0]);
    return (timestamp == "timestamp" || timestamp == "time" || timestamp == "date" || timestamp == "datetime" || timestamp == "ts" || timestamp == "epoch") &&
        normalized(cells[1]) == "open" && normalized(cells[2]) == "high" && normalized(cells[3]) == "low" &&
        normalized(cells[4]) == "close" && normalized(cells[5]) == "volume";
}

OHLCVEvent parse_ohlcv_row(const std::vector<std::string>& cells, TS_UNIT unit, DATE_FORMAT format) {
    if (cells.size() < 6) throw std::runtime_error("Each market-data row needs timestamp, open, high, low, close, and volume columns in that order.");
    OHLCVEvent bar;
    bar.ts = parse_timestamp(cells[0], unit, format);
    bar.open = std::stod(cells[1]);
    bar.high = std::stod(cells[2]);
    bar.low = std::stod(cells[3]);
    bar.close = std::stod(cells[4]);
    bar.volume = std::stod(cells[5]);
    if (!std::isfinite(bar.open) || !std::isfinite(bar.high) || !std::isfinite(bar.low) ||
        !std::isfinite(bar.close) || !std::isfinite(bar.volume)) {
        throw std::runtime_error("Market data contains a non-finite OHLCV value.");
    }
    return bar;
}

std::vector<OHLCVEvent> load_ohlcv_csv(const std::string& path, TS_UNIT unit, DATE_FORMAT format) {
    std::ifstream input(path);
    if (!input) throw std::runtime_error("Could not open the selected market-data file.");

    std::vector<std::string> rows;
    std::string line;
    while (std::getline(input, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (!line.empty()) rows.push_back(std::move(line));
    }
    if (rows.empty()) throw std::runtime_error("The selected market-data file is empty.");

    std::size_t first_row = 0;
    if (is_header_row(split_csv_row(rows.front()))) first_row = 1;
    std::vector<OHLCVEvent> bars;
    for (std::size_t i = first_row; i < rows.size(); ++i) {
        try {
            bars.push_back(parse_ohlcv_row(split_csv_row(rows[i]), unit, format));
        } catch (const std::exception& error) {
            throw std::runtime_error("Could not read market-data row " + std::to_string(i + 1) + ": " + error.what());
        }
    }
    if (bars.empty()) throw std::runtime_error("The selected market-data file contains no OHLCV rows.");
    return bars;
}

bool parse_bool(const char* value) {
    const std::string text(value);
    if (text == "true" || text == "1") return true;
    if (text == "false" || text == "0") return false;
    throw std::invalid_argument("Expected true or false.");
}

TS_UNIT parse_ts_unit(const std::string& value) {
    if (value == "SECONDS") return TS_UNIT::SECONDS;
    if (value == "MILLISECONDS") return TS_UNIT::MILLISECONDS;
    if (value == "MICROSECONDS") return TS_UNIT::MICROSECONDS;
    if (value == "NANOSECONDS") return TS_UNIT::NANOSECONDS;
    throw std::invalid_argument("Unsupported timestamp unit.");
}

DATE_FORMAT parse_date_format(const std::string& value) {
    if (value == "DDMMYYYY") return DATE_FORMAT::DDMMYYYY;
    if (value == "MMDDYYYY") return DATE_FORMAT::MMDDYYYY;
    throw std::invalid_argument("Unsupported date format.");
}

PRICE_FIELD parse_price_field(const std::string& value) {
    if (value == "OPEN") return PRICE_FIELD::OPEN;
    if (value == "HIGH") return PRICE_FIELD::HIGH;
    if (value == "LOW") return PRICE_FIELD::LOW;
    if (value == "CLOSE") return PRICE_FIELD::CLOSE;
    if (value == "VOLUME") return PRICE_FIELD::VOLUME;
    throw std::invalid_argument("Unsupported price field.");
}

SIZING_MODE parse_sizing_mode(const std::string& value) {
    if (value == "FIXED") return SIZING_MODE::FIXED;
    if (value == "FIXED_FRACTIONAL_PRICE") return SIZING_MODE::FIXED_FRACTIONAL_PRICE;
    throw std::invalid_argument("Unsupported position-sizing mode for MA Cross.");
}

const char* signal_name(SIGNAL signal) {
    switch (signal) {
        case SIGNAL::SELL: return "SELL";
        case SIGNAL::SHORT: return "SHORT";
        case SIGNAL::FLAT: return "FLAT";
        case SIGNAL::LONG: return "LONG";
        case SIGNAL::COVER: return "COVER";
        case SIGNAL::BBUY: return "BUY";
        case SIGNAL::BSELL: return "SELL";
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

void print_catalog() {
    std::cout << R"JSON({"strategies":[{"id":"ma_cross","name":"Moving Average Cross","file":"ma_cross.hpp","input":"OHLCV","baseConfig":[{"key":"active","label":"Strategy active","type":"boolean","default":true},{"key":"long_active","label":"Allow long positions","type":"boolean","default":true},{"key":"short_active","label":"Allow short positions","type":"boolean","default":true},{"key":"stacking","label":"Allow position stacking","type":"boolean","default":true},{"key":"ts_unit","label":"Numeric timestamp unit","type":"select","default":"MILLISECONDS","options":["SECONDS","MILLISECONDS","MICROSECONDS","NANOSECONDS"]},{"key":"date_format","label":"Ambiguous date format","type":"select","default":"DDMMYYYY","options":["DDMMYYYY","MMDDYYYY"]}],"parameters":[{"key":"fast_len","label":"Fast period","type":"number","default":10,"min":1,"step":1},{"key":"slow_len","label":"Slow period","type":"number","default":30,"min":2,"step":1},{"key":"fast_price_field","label":"Fast price field","type":"select","default":"CLOSE","options":["OPEN","HIGH","LOW","CLOSE","VOLUME"]},{"key":"slow_price_field","label":"Slow price field","type":"select","default":"CLOSE","options":["OPEN","HIGH","LOW","CLOSE","VOLUME"]},{"key":"slnot","label":"Stop-loss amount (0 disables)","type":"number","default":-1,"step":0.01},{"key":"slpct","label":"Stop-loss percent (0 disables)","type":"number","default":-1,"step":0.01},{"key":"pos_sizing_mode","label":"Position sizing","type":"select","default":"FIXED","options":["FIXED","FIXED_FRACTIONAL_PRICE"]},{"key":"qty","label":"Fixed quantity","type":"number","default":1,"min":0.000001,"step":0.1},{"key":"equity_pct","label":"Equity fraction","type":"number","default":0.05,"min":0.000001,"max":1,"step":0.01}]}]})JSON" << '\n';
}

void print_results(const BacktestResults& results, std::size_t input_rows) {
    std::cout << std::setprecision(15) << "{\"inputRows\":" << input_rows << ",\"equityCurve\":[";
    for (std::size_t i = 0; i < results.equity_curve.size(); ++i) {
        if (i) std::cout << ',';
        std::cout << results.equity_curve[i];
    }
    std::cout << "],\"orders\":[";
    for (std::size_t i = 0; i < results.hlog.size(); ++i) {
        const auto& order = results.hlog[i];
        if (i) std::cout << ',';
        std::cout << "{\"id\":" << order.id
                  << ",\"timestamp\":" << order.ts
                  << ",\"signal\":\"" << signal_name(order.signal) << "\""
                  << ",\"quantity\":" << order.qty
                  << ",\"price\":" << order.price
                  << ",\"status\":\"" << status_name(order.status) << "\""
                  << ",\"reason\":\"" << json_escape(order.reason) << "\"}";
    }
    std::cout << "]}\n";
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc == 2 && std::string(argv[1]) == "--catalog") {
            print_catalog();
            return 0;
        }
        if (argc != 20 || std::string(argv[1]) != "--run") {
            throw std::invalid_argument("Invalid runner arguments.");
        }

        const double initial_capital = std::stod(argv[3]);
        const double cost_bps = std::stod(argv[4]);
        StrategyConfig base_config;
        base_config.active = parse_bool(argv[5]);
        base_config.long_active = parse_bool(argv[6]);
        base_config.short_active = parse_bool(argv[7]);
        base_config.stacking = parse_bool(argv[8]);
        base_config.ts_unit = parse_ts_unit(argv[9]);
        base_config.date_format = parse_date_format(argv[10]);

        MACConfig strategy_config;
        strategy_config.fast_len = static_cast<std::int16_t>(std::stoi(argv[11]));
        strategy_config.slow_len = static_cast<std::int16_t>(std::stoi(argv[12]));
        strategy_config.fast_price_field = parse_price_field(argv[13]);
        strategy_config.slow_price_field = parse_price_field(argv[14]);
        strategy_config.slnot = std::stod(argv[15]);
        strategy_config.slpct = std::stod(argv[16]);
        strategy_config.pos_sizing_mode = parse_sizing_mode(argv[17]);
        strategy_config.qty = std::stod(argv[18]);
        strategy_config.equity_pct = std::stod(argv[19]);

        const auto bars = load_ohlcv_csv(argv[2], base_config.ts_unit, base_config.date_format);
        MAC strategy("ma_cross", strategy_config, base_config);
        Backtester<OHLCVEvent> backtester(BacktestConfig{.initial_capital = initial_capital, .cost_bps = cost_bps});
        const auto results = backtester.run(strategy, bars);
        print_results(results, bars.size());
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 2;
    }
}
