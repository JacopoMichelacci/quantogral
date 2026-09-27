#pragma once

#include <cstdint>
#include <exception>
#include <iostream>
#include <ostream>
#include <string>
#include <vector>

#include "utils/time.hpp"

enum class MKT_EVENT_TYPE : std::uint8_t {
    OHLCV,
    QUOTE,
    NONE
};

struct MarketEvent {
    long long ts = 0;
    MKT_EVENT_TYPE type = MKT_EVENT_TYPE::NONE;

    virtual ~MarketEvent() = default;
};
std::ostream& operator<<(std::ostream& os, MKT_EVENT_TYPE type);

struct OHLCVEvent : public MarketEvent {
    OHLCVEvent() { type = MKT_EVENT_TYPE::OHLCV; }
    double open = 0.0;
    double high = 0.0;
    double low = 0.0;
    double close = 0.0;
    double volume = 0.0;

    static OHLCVEvent from_csv_row(const std::vector<std::string>& row) {
        OHLCVEvent event;
        if (row.size() < 6) {
            std::cerr << "OHLCVEvent::from_csv_row: expected 6 columns, got " << row.size() << "\n";
            return event;
        }

        try {
            event.ts = to_epoch_ms(row[0]);
        } catch (const std::exception& error) {
            std::cerr << "OHLCVEvent::from_csv_row: invalid timestamp \"" << row[0]
                      << "\": " << error.what() << "\n";
        }

        auto parse_double = [&row](std::size_t index, const char* field) {
            try {
                return std::stod(row[index]);
            } catch (const std::exception& error) {
                std::cerr << "OHLCVEvent::from_csv_row: invalid " << field << " \"" << row[index]
                          << "\": " << error.what() << "\n";
                return 0.0;
            }
        };

        event.open = parse_double(1, "open");
        event.high = parse_double(2, "high");
        event.low = parse_double(3, "low");
        event.close = parse_double(4, "close");
        event.volume = parse_double(5, "volume");
        return event;
    }
};
std::ostream& operator<<(std::ostream& os, const OHLCVEvent& event);

struct QuoteEvent : public MarketEvent {
    QuoteEvent() { type = MKT_EVENT_TYPE::QUOTE; }
    double bid = 0.0;
    double ask = 0.0;
    double bidsize = 0.0;
    double asksize = 0.0;
};
std::ostream& operator<<(std::ostream& os, const QuoteEvent& event);
