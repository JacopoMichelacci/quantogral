#pragma once

#include <cstdint>
#include <stdexcept>

enum class PRICE_FIELD : std::uint8_t {
    OPEN,
    HIGH,
    LOW,
    CLOSE,
    VOLUME
};

template <typename Tin>
double get_price_field(const Tin& input, PRICE_FIELD field) {
    switch (field) {
        case PRICE_FIELD::OPEN: return input.open;
        case PRICE_FIELD::HIGH: return input.high;
        case PRICE_FIELD::LOW: return input.low;
        case PRICE_FIELD::CLOSE: return input.close;
        case PRICE_FIELD::VOLUME: return input.volume;
        default: throw std::invalid_argument("unsupported price field");
    }
}
