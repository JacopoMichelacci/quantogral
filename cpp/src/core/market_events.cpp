#include <iostream>

#include "core/market_events.hpp"

std::ostream& operator<<(std::ostream& os, MKT_EVENT_TYPE type) {
    switch (type) {
        case MKT_EVENT_TYPE::OHLCV: return os << "ohlcv";
        case MKT_EVENT_TYPE::QUOTE: return os << "quote";
        case MKT_EVENT_TYPE::NONE: return os;
    }
    return os;
}

std::ostream& operator<<(std::ostream& os, const OHLCVEvent& event) {
    return os << "| ohlcv_event(type: " << event.type
              << ", open: " << event.open
              << ", high: " << event.high
              << ", low: " << event.low
              << ", close: " << event.close
              << ", volume: " << event.volume << ") |";
}

std::ostream& operator<<(std::ostream& os, const QuoteEvent& event) {
    return os << "| QuoteEvent(type: " << event.type
              << ", bid: " << event.bid
              << ", ask: " << event.ask
              << ", bidsize: " << event.bidsize
              << ", asksize: " << event.asksize << ") |";
}
