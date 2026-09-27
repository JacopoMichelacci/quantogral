#pragma once

#include <algorithm>
#include <cctype>
#include <concepts>
#include <cstdint>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

enum class DATE_FORMAT { DDMMYYYY, MMDDYYYY };

inline long long to_epoch_ms(const std::string& timestamp, DATE_FORMAT format = DATE_FORMAT::DDMMYYYY) {
    int milliseconds = 0;
    std::string normalized = timestamp;
    std::replace(normalized.begin(), normalized.end(), '/', '-');
    std::replace(normalized.begin(), normalized.end(), 'T', ' ');

    const auto dot = normalized.find('.');
    if (dot != std::string::npos) {
        std::string fraction = normalized.substr(dot + 1);
        fraction.resize(3, '0');
        milliseconds = std::stoi(fraction);
        normalized = normalized.substr(0, dot);
    }

    const bool has_time = normalized.size() > 10;
    const bool year_first = normalized.size() >= 5 &&
        std::isdigit(static_cast<unsigned char>(normalized[0])) &&
        std::isdigit(static_cast<unsigned char>(normalized[1])) &&
        std::isdigit(static_cast<unsigned char>(normalized[2])) &&
        std::isdigit(static_cast<unsigned char>(normalized[3])) && normalized[4] == '-';

    std::istringstream stream(std::move(normalized));
    std::tm parsed = {};
    if (year_first) {
        stream >> std::get_time(&parsed, has_time ? "%Y-%m-%d %H:%M:%S" : "%Y-%m-%d");
    } else if (format == DATE_FORMAT::DDMMYYYY) {
        stream >> std::get_time(&parsed, has_time ? "%d-%m-%Y %H:%M:%S" : "%d-%m-%Y");
    } else {
        stream >> std::get_time(&parsed, has_time ? "%m-%d-%Y %H:%M:%S" : "%m-%d-%Y");
    }

    if (stream.fail()) {
        throw std::invalid_argument("unrecognized timestamp format: " + timestamp);
    }
    return static_cast<long long>(std::mktime(&parsed)) * 1000 + milliseconds;
}

enum class TS_UNIT : std::int8_t { SECONDS, MILLISECONDS, MICROSECONDS, NANOSECONDS };

template <std::integral T>
inline long long to_epoch_ms(T timestamp, TS_UNIT unit = TS_UNIT::MILLISECONDS) {
    switch (unit) {
        case TS_UNIT::SECONDS: return static_cast<long long>(timestamp) * 1000;
        case TS_UNIT::MILLISECONDS: return static_cast<long long>(timestamp);
        case TS_UNIT::MICROSECONDS: return static_cast<long long>(timestamp) / 1000;
        case TS_UNIT::NANOSECONDS: return static_cast<long long>(timestamp) / 1'000'000;
        default: throw std::invalid_argument("unknown timestamp unit");
    }
}

template <typename T>
concept HasTimestamp = requires(T value) { value.ts; } ||
                       requires(T value) { value.timestamp; } ||
                       requires(T value) { value.time; } ||
                       requires(T value) { value.date; } ||
                       requires(T value) { value.datetime; } ||
                       requires(T value) { value.epoch; };

template <HasTimestamp T>
auto get_timestamp(const T& value) {
    if constexpr (requires { value.ts; }) return value.ts;
    else if constexpr (requires { value.timestamp; }) return value.timestamp;
    else if constexpr (requires { value.time; }) return value.time;
    else if constexpr (requires { value.date; }) return value.date;
    else if constexpr (requires { value.datetime; }) return value.datetime;
    else return value.epoch;
}
