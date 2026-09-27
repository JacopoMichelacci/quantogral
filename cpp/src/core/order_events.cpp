#include "core/order_events.hpp"

std::ostream& operator<<(std::ostream& os, SIGNAL signal) {
    switch (signal) {
        case SIGNAL::SELL: return os << "sell";
        case SIGNAL::SHORT: return os << "short";
        case SIGNAL::FLAT: return os << "flat";
        case SIGNAL::LONG: return os << "long";
        case SIGNAL::COVER: return os << "cover";
        case SIGNAL::BBUY: return os << "bbuy";
        case SIGNAL::BSELL: return os << "bsell";
    }
    return os;
}

std::ostream& operator<<(std::ostream& os, ORDER_STATUS status) {
    switch (status) {
        case ORDER_STATUS::PENDING: return os << "pending";
        case ORDER_STATUS::FILLED: return os << "filled";
        case ORDER_STATUS::PFILLED: return os << "pfilled";
        case ORDER_STATUS::REJECTED: return os << "rejected";
        case ORDER_STATUS::CANCELED: return os << "canceled";
    }
    return os;
}

std::ostream& operator<<(std::ostream& os, ORDER_TYPE type) {
    switch (type) {
        case ORDER_TYPE::MARKET: return os << "market";
        case ORDER_TYPE::NONE: return os << "none";
    }
    return os;
}

std::ostream& operator<<(std::ostream& os, STOP_TYPE type) {
    switch (type) {
        case STOP_TYPE::NONE: return os << "none";
        case STOP_TYPE::HARD: return os << "hard";
    }
    return os;
}

std::ostream& operator<<(std::ostream& os, const OrderEvent& event) {
    os << "OrderEvent{"
       << "id=" << event.id
       << ", ts=" << event.ts
       << ", symbol=" << event.symbol
       << ", signal=" << event.signal
       << ", qty=" << event.qty
       << ", price=" << event.price
       << ", sl_type=" << event.sl.type
       << ", slnot=" << event.sl.slnot
       << ", slpct=" << event.sl.slpct
       << ", status=" << event.status
       << ", strat_id=" << event.strategy_id;
    if (!event.reason.empty()) os << ", reason=\"" << event.reason << "\"";
    return os << "} | ";
}
