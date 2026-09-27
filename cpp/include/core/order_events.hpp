#pragma once

#include <cstdint>
#include <ostream>
#include <string>

enum class SIGNAL : std::int8_t {
    SELL = -2,
    SHORT = -1,
    FLAT = 0,
    LONG = 1,
    COVER = 2,
    BBUY = 9,
    BSELL = -9,
};
std::ostream& operator<<(std::ostream& os, SIGNAL signal);

enum class ORDER_STATUS : std::int8_t {
    PENDING = 0,
    FILLED = 1,
    PFILLED = 2,
    REJECTED = -1,
    CANCELED = -9
};
std::ostream& operator<<(std::ostream& os, ORDER_STATUS status);

enum class ORDER_TYPE : std::int8_t {
    MARKET = 1,
    NONE = 0
};
std::ostream& operator<<(std::ostream& os, ORDER_TYPE type);

enum class STOP_TYPE : std::int8_t {
    NONE = 0,
    HARD = 1,
};
std::ostream& operator<<(std::ostream& os, STOP_TYPE type);

struct StopLoss {
    STOP_TYPE type = STOP_TYPE::NONE;
    double slnot = -1.0;
    double slpct = -1.0;
};

class OrderIdGenerator {
public:
    long long next() { return ++id_; }

private:
    long long id_ = 0;
};

class OrderEvent {
public:
    long long ts = 0;
    SIGNAL signal = SIGNAL::FLAT;
    ORDER_TYPE type = ORDER_TYPE::NONE;
    std::string symbol;
    double qty = 0.0;
    double price = 0.0;
    StopLoss sl = {};
    long long strategy_id = -1;
    long long id = -1;
    long long pid = -1;
    ORDER_STATUS status = ORDER_STATUS::PENDING;
    std::string reason;
};
std::ostream& operator<<(std::ostream& os, const OrderEvent& event);
