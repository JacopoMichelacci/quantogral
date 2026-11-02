#pragma once

#include <memory>
#include <cmath>
#include <cctype>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "builder/strategies/strategy_base.hpp"

// Build-generated adapters register OHLCV strategies here. Strategy headers
// only need a normal Config type and a constructor following the shared shape.
namespace quantogral {
using StrategyValues = std::unordered_map<std::string, std::string>;

struct StrategyDefinition {
    std::string id;
    std::unique_ptr<Strategy<OHLCVEvent>> (*create)(const StrategyValues&);
};

inline std::vector<StrategyDefinition>& strategy_registry() {
    static std::vector<StrategyDefinition> definitions;
    return definitions;
}

inline void register_strategy(StrategyDefinition definition) {
    auto& definitions = strategy_registry();
    for (const auto& existing : definitions) {
        if (existing.id == definition.id) {
            throw std::logic_error("Duplicate Quantogral strategy ID: " + definition.id);
        }
    }
    definitions.push_back(std::move(definition));
}

inline std::string value_or(const StrategyValues& values, std::string_view key, std::string fallback) {
    const auto found = values.find(std::string(key));
    return found == values.end() ? std::move(fallback) : found->second;
}

inline double parse_number_value(const StrategyValues& values, std::string_view key, std::string fallback) {
    const auto text = value_or(values, key, std::move(fallback));
    try {
        std::size_t consumed = 0;
        const double value = std::stod(text, &consumed);
        while (consumed < text.size() && std::isspace(static_cast<unsigned char>(text[consumed]))) ++consumed;
        if (consumed != text.size() || !std::isfinite(value)) throw std::invalid_argument("invalid numeric value");
        return value;
    } catch (const std::exception&) {
        throw std::invalid_argument("Strategy setting '" + std::string(key) + "' must be a finite number; got '" + text + "'.");
    }
}

inline long long parse_integer_value(const StrategyValues& values, std::string_view key, std::string fallback) {
    const auto text = value_or(values, key, std::move(fallback));
    try {
        std::size_t consumed = 0;
        const auto value = std::stoll(text, &consumed);
        while (consumed < text.size() && std::isspace(static_cast<unsigned char>(text[consumed]))) ++consumed;
        if (consumed != text.size()) throw std::invalid_argument("invalid integer value");
        return value;
    } catch (const std::exception&) {
        throw std::invalid_argument("Strategy setting '" + std::string(key) + "' must be an integer; got '" + text + "'.");
    }
}

inline bool parse_bool_value(const StrategyValues& values, std::string_view key, bool fallback) {
    const auto value = value_or(values, key, fallback ? "true" : "false");
    if (value == "true" || value == "1") return true;
    if (value == "false" || value == "0") return false;
    throw std::invalid_argument("Expected true or false for " + std::string(key) + ".");
}

inline StrategyConfig make_base_config(const StrategyValues& values) {
    StrategyConfig config;
    config.active = parse_bool_value(values, "active", true);
    config.long_active = parse_bool_value(values, "long_active", true);
    config.short_active = parse_bool_value(values, "short_active", true);
    config.stacking = parse_bool_value(values, "stacking", true);
    const auto ts_unit = value_or(values, "ts_unit", "MILLISECONDS");
    if (ts_unit == "SECONDS") config.ts_unit = TS_UNIT::SECONDS;
    else if (ts_unit == "MILLISECONDS") config.ts_unit = TS_UNIT::MILLISECONDS;
    else if (ts_unit == "MICROSECONDS") config.ts_unit = TS_UNIT::MICROSECONDS;
    else if (ts_unit == "NANOSECONDS") config.ts_unit = TS_UNIT::NANOSECONDS;
    else throw std::invalid_argument("Unsupported timestamp unit.");
    const auto date_format = value_or(values, "date_format", "DDMMYYYY");
    if (date_format == "DDMMYYYY") config.date_format = DATE_FORMAT::DDMMYYYY;
    else if (date_format == "MMDDYYYY") config.date_format = DATE_FORMAT::MMDDYYYY;
    else throw std::invalid_argument("Unsupported date format.");
    return config;
}
} // namespace quantogral
