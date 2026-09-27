#pragma once

#include <cmath>
#include <cstddef>
#include <optional>
#include <stdexcept>
#include <vector>

#include "builder/indicators/indicator_base.hpp"

template <typename Tin, typename Tout>
class STD : public Indicator<STD<Tin, Tout>, Tin, Tout> {
public:
    explicit STD(int len_, int max_buffer_size_ = -1)
        : Indicator<STD<Tin, Tout>, Tin, Tout>(max_buffer_size_), len(len_) {
        if (len_ < 1) throw std::invalid_argument("std len must be > 0");
        history.reserve(len);
    }

    std::optional<Tout> compute(const Tin& input) {
        const double value = static_cast<double>(input);
        const double squared_value = value * value;

        if (history.size() < len) {
            history.push_back(input);
            sum += value;
            squared_sum += squared_value;
        } else {
            const double old_value = static_cast<double>(history[idx]);
            sum -= old_value;
            squared_sum -= old_value * old_value;
            history[idx] = input;
            sum += value;
            squared_sum += squared_value;
        }

        ++idx;
        if (idx == len) idx = 0;
        if (history.size() != len) return std::nullopt;

        const double mean = sum / len;
        double variance = squared_sum / len - mean * mean;
        if (variance < 0.0) variance = 0.0;
        return static_cast<Tout>(std::sqrt(variance));
    }

    std::size_t get_len() const { return len; }

    void set_len(std::size_t len_) {
        if (len_ == 0) throw std::invalid_argument("std len must be > 0");
        len = len_;
        history.clear();
        history.reserve(len);
        this->reset_buffer();
        idx = 0;
        sum = 0.0;
        squared_sum = 0.0;
    }

private:
    std::size_t len;
    std::vector<Tin> history;
    double sum = 0.0;
    double squared_sum = 0.0;
    std::size_t idx = 0;
};
