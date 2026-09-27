#pragma once

#include <cstddef>
#include <optional>
#include <stdexcept>
#include <vector>

#include "builder/indicators/indicator_base.hpp"

template <typename Tin, typename Tout>
class SMA : public Indicator<SMA<Tin, Tout>, Tin, Tout> {
public:
    explicit SMA(int len_, int max_buffer_size_ = -1)
        : Indicator<SMA<Tin, Tout>, Tin, Tout>(max_buffer_size_), len(len_) {
        if (len_ < 1) throw std::invalid_argument("SMA len must be > 0");
        history.reserve(len);
    }

    std::optional<Tout> compute(const Tin& input) {
        if (history.size() < len) {
            history.push_back(input);
            sum += input;
        } else {
            sum -= history[idx];
            history[idx] = input;
            sum += input;
        }

        ++idx;
        if (idx == len) idx = 0;
        if (history.size() != len) return std::nullopt;
        return static_cast<Tout>(sum / history.size());
    }

    std::size_t get_len() const { return len; }

    void set_len(std::size_t len_) {
        if (len_ == 0) throw std::invalid_argument("SMA len must be > 0");
        len = len_;
        history.clear();
        history.reserve(len);
        this->reset_buffer();
        idx = 0;
        sum = 0.0;
    }

private:
    std::size_t len;
    std::vector<Tin> history;
    std::size_t idx = 0;
    double sum = 0.0;
};
