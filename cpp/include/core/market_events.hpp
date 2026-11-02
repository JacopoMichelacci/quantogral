#pragma once

#include <cstdint>
#include <ostream>
#include <string>

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

enum class FeedRole : std::uint8_t {
    MAIN = 0,
    SUB1 = 1,
    SUB2 = 2,
    SUB3 = 3
};

// Non-owning view of one event delivered from a feed. The referenced event
// must outlive this view (for example, the duration of a strategy callback).
struct FeedEvent {
    std::uint8_t feed_id;
    // For a Main event this equals feed_id; for a Sub it identifies its parent Main.
    std::uint8_t main_feed_id;
    FeedRole role;
    const MarketEvent& data;

    FeedEvent(std::uint8_t id, std::uint8_t main_id, FeedRole feed_role,
              const MarketEvent& event)
        : feed_id(id), main_feed_id(main_id), role(feed_role), data(event) {}

    // Returns this event as TEvent, or nullptr when its concrete type differs.
    template <typename TEvent>
    const TEvent* get_if() const noexcept {
        return dynamic_cast<const TEvent*>(&data);
    }
};

std::ostream& operator<<(std::ostream& os, MKT_EVENT_TYPE type);

struct OHLCVEvent : public MarketEvent {
    OHLCVEvent() { type = MKT_EVENT_TYPE::OHLCV; }
    double open = 0.0;
    double high = 0.0;
    double low = 0.0;
    double close = 0.0;
    double volume = 0.0;
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
