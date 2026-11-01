#pragma once

#include <cstddef>
#include <vector>
#include <optional>
#include <stdexcept>
#include <utility>
#include <type_traits>
#include <string_view>
#include <iostream>
#include <cmath>
#include <string>
#include <string_view>

#include "core/market_events.hpp"

namespace quantogral::detail {
using IndicatorTraceCallback = void (*)(const void*, std::string_view, double, void*);
inline thread_local IndicatorTraceCallback active_indicator_trace_callback = nullptr;
inline thread_local void* active_indicator_trace_context = nullptr;

class IndicatorTraceScope {
public:
    IndicatorTraceScope(IndicatorTraceCallback callback, void* context)
        : previous_callback_(active_indicator_trace_callback), previous_context_(active_indicator_trace_context) {
        active_indicator_trace_callback = callback;
        active_indicator_trace_context = context;
    }
    ~IndicatorTraceScope() {
        active_indicator_trace_callback = previous_callback_;
        active_indicator_trace_context = previous_context_;
    }
    IndicatorTraceScope(const IndicatorTraceScope&) = delete;
    IndicatorTraceScope& operator=(const IndicatorTraceScope&) = delete;

private:
    IndicatorTraceCallback previous_callback_;
    void* previous_context_;
};

inline void record_indicator_value(const void* source, std::string_view name, double value) {
    if (active_indicator_trace_callback) {
        active_indicator_trace_callback(source, name, value, active_indicator_trace_context);
    }
}
} // namespace quantogral::detail



template <typename Derived, typename Tin, typename Tout>
class Indicator {
public:
    ~Indicator() = default;

    // returns new indicator value
    std::optional<Tout> update(const Tin& input) {
        auto value = derived().compute(input);
        record_trace(value);
        return value;
    }

    // computes new ind value and updates buffer
    void update_buffer(const Tin& input) {
        auto value = derived().compute(input);
        record_trace(value);

        // if no max size push always not limit
        if (max_buffer_size < 0) {
            buffer.emplace_back(std::move(value));
        }
        // if buffer not full push normally
        else if (buffer.size() < static_cast<std::size_t>(max_buffer_size)) {
            buffer.emplace_back(std::move(value));
        }
        // when buffer full then impl circular buffer
        else {
            buffer[next_buffer_idx] = std::move(value);

            ++next_buffer_idx;
            if (next_buffer_idx == static_cast<std::size_t>(max_buffer_size)) { next_buffer_idx = 0; }
        }
    }

    // handle buffer operations
    // index --- works wiht negative indexing
    std::optional<Tout> operator[](int i) const {
        if (buffer.empty()) { return std::nullopt; }
        int buffsize = static_cast<int>(buffer.size());

        int logical_idx = i;
        if (logical_idx < 0) { logical_idx += buffsize; }

        if (logical_idx < 0 || logical_idx >= buffsize) { return std::nullopt; }

        return buffer[physical_idx(static_cast<std::size_t>(logical_idx))];
    }

    // get size
    int size() const { return static_cast<int>(buffer.size()); }

    // view buffer in time idx order
    std::vector<std::optional<Tout>> view_buffer() const {
        std::vector<std::optional<Tout>> view;
        view.reserve(buffer.size());

        for (std::size_t i = 0; i < buffer.size(); ++i) {
            view.emplace_back(buffer[physical_idx(i)]);
        }

        return view;
    }


protected:
    // storage of past indicator values in time idx order  ( 0 -> first; .size() -1 -> last )
    std::vector<std::optional<Tout>> buffer;

    void reset_buffer() {
        buffer.clear();
        next_buffer_idx = 0;
    }

    // constructor
    Indicator(int max_buffer_size_ = -1, std::size_t default_buffer_size_ = 64)
        : max_buffer_size(max_buffer_size_) {
        // check the compute function in Derived is valid
        static_assert(
            std::is_same_v<decltype(std::declval<Derived&>().compute(std::declval<const Tin&>())),
            std::optional<Tout>>,
            "Derived must implement: std::optional<Tout> compute(const Tin&)"
        );
        if (max_buffer_size_ == 0 || max_buffer_size_ < -1) {
            throw std::invalid_argument("max buffer size in indicator must be > 0 || default");
        }

        if (max_buffer_size_ < 0) {
            buffer.reserve(default_buffer_size_);
        }
        else {
            buffer.reserve(max_buffer_size_);
        }
    }

private:
    int max_buffer_size = 0;
    std::size_t next_buffer_idx = 0;

    std::string trace_name() const {
        std::string label = "Indicator";
        if constexpr (requires { Derived::trace_type_name; }) {
            label = std::string(Derived::trace_type_name);
        }
        if constexpr (requires(const Derived& value) { value.get_len(); }) {
            label += " (" + std::to_string(derived().get_len()) + ")";
        }
        return label;
    }

    void record_trace(const std::optional<Tout>& value) const {
        if constexpr (std::is_arithmetic_v<Tout>) {
            if (value && std::isfinite(static_cast<double>(*value))) {
                const auto label = trace_name();
                quantogral::detail::record_indicator_value(this, label, static_cast<double>(*value));
            }
        }
    }

    // finds the actual idx in the vector if a max size was triggered (contiguous storage not in order anymore)
    std::size_t physical_idx(std::size_t logical_idx) const {
        if (max_buffer_size < 0 || buffer.size() < static_cast<std::size_t>(max_buffer_size)) {
            return logical_idx;
        }

        // modulo prevents out of idx error as it wraps aroun
        return (next_buffer_idx + logical_idx) % buffer.size();
    }

    // CRTP
    Derived& derived() {
        return static_cast<Derived&>(*this);
    }
    const Derived& derived() const {
        return static_cast<const Derived&>(*this);
    }
};
