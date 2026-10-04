// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Order} from "../../src/libraries/Clearing.sol";

/// @notice A Solidity version of the TypeScript clearing engine (packages/solver/src/clearing.ts), so the
///         fuzzer can submit honest solutions and reach settlement. Among prices that match the same maximum
///         volume it takes the lowest; any of them is a valid answer.
library ReferenceSolver {
    struct Candidate {
        bool feasible;
        uint256 price;
        uint256 volume;
        uint256 buyStrict;
        uint256 sellStrict;
    }

    function solve(Order[] memory orders)
        internal
        pure
        returns (bool found, uint256 price, uint128[] memory fills, uint256 volume)
    {
        fills = new uint128[](orders.length);
        Candidate memory best = _bestPrice(orders);
        if (!best.feasible) return (false, 0, fills, 0);

        for (uint256 i; i < orders.length; ++i) {
            Order memory o = orders[i];
            if ((o.isBuy && o.limitPrice > best.price) || (!o.isBuy && o.limitPrice < best.price)) {
                fills[i] = o.amount;
            }
        }
        _share(orders, fills, best.price, true, best.volume - best.buyStrict);
        _share(orders, fills, best.price, false, best.volume - best.sellStrict);
        return (true, best.price, fills, best.volume);
    }

    function _bestPrice(Order[] memory orders) private pure returns (Candidate memory best) {
        for (uint256 c; c < orders.length; ++c) {
            Candidate memory cand = _evaluate(orders, orders[c].limitPrice);
            if (!cand.feasible) continue;
            if (
                !best.feasible || cand.volume > best.volume
                    || (cand.volume == best.volume && cand.price < best.price)
            ) best = cand;
        }
    }

    function _evaluate(Order[] memory orders, uint256 p) private pure returns (Candidate memory c) {
        (uint256 buyStrict, uint256 buyAt, uint256 sellStrict, uint256 sellAt) = _sides(orders, p);
        uint256 buyTotal = buyStrict + buyAt;
        uint256 sellTotal = sellStrict + sellAt;
        if (buyStrict > sellTotal || sellStrict > buyTotal) return c; // crossers would not fit
        return Candidate(true, p, buyTotal < sellTotal ? buyTotal : sellTotal, buyStrict, sellStrict);
    }

    function _sides(Order[] memory orders, uint256 p)
        private
        pure
        returns (uint256 buyStrict, uint256 buyAt, uint256 sellStrict, uint256 sellAt)
    {
        for (uint256 i; i < orders.length; ++i) {
            Order memory o = orders[i];
            if (o.isBuy) {
                if (o.limitPrice > p) buyStrict += o.amount;
                else if (o.limitPrice == p) buyAt += o.amount;
            } else {
                if (o.limitPrice < p) sellStrict += o.amount;
                else if (o.limitPrice == p) sellAt += o.amount;
            }
        }
    }

    /// @dev Pro-rata among orders exactly at the price, then leftover wei one at a time.
    function _share(Order[] memory orders, uint128[] memory fills, uint256 p, bool isBuy, uint256 remaining)
        private
        pure
    {
        if (remaining == 0) return;
        uint256 total;
        for (uint256 i; i < orders.length; ++i) {
            if (orders[i].isBuy == isBuy && orders[i].limitPrice == p) total += orders[i].amount;
        }
        uint256 given;
        for (uint256 i; i < orders.length; ++i) {
            if (orders[i].isBuy != isBuy || orders[i].limitPrice != p) continue;
            uint256 share = (remaining * orders[i].amount) / total;
            fills[i] = uint128(share);
            given += share;
        }
        for (uint256 i; i < orders.length && given < remaining; ++i) {
            if (orders[i].isBuy != isBuy || orders[i].limitPrice != p) continue;
            if (fills[i] < orders[i].amount) {
                fills[i] += 1;
                given += 1;
            }
        }
    }
}
