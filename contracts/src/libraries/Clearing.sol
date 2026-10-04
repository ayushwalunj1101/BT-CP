// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice A revealed order. Prices are mUSD per TKN scaled by 1e18; amounts are TKN with 18 decimals.
struct Order {
    address trader;
    bool isBuy;
    uint128 limitPrice;
    uint128 amount;
}

/// @notice One executed fill, recorded at settlement.
struct Fill {
    address trader;
    bool isBuy;
    uint32 orderId; // index of the order in its batch, so a check can compare the fill with the order
    uint256 baseAmount; // TKN bought or sold
    uint256 quoteAmount; // mUSD paid by a buyer, or received by a seller
}

/// @title Clearing
/// @notice The rules a batch solution must obey, checked in one pass over the orders.
///         Finding the clearing price is the solver's job; checking it is this cheap loop.
library Clearing {
    uint256 internal constant PRICE_SCALE = 1e18;

    /// @notice Is filling `orders` by `fills` at one `price` a valid clearing of the batch?
    /// @return ok     true if every rule holds
    /// @return volume matched TKN volume (the sum of buy fills), zero when not ok
    function check(Order[] memory orders, uint256 price, uint128[] memory fills)
        internal
        pure
        returns (bool ok, uint256 volume)
    {
        if (price == 0 || price > type(uint128).max || fills.length != orders.length) return (false, 0);
        uint256 sellVolume = 0;
        for (uint256 i; i < orders.length; ++i) {
            Order memory o = orders[i];
            uint256 fill = fills[i];
            if (fill > o.amount) return (false, 0); // filled more than ordered
            if (o.isBuy) {
                if (fill > 0 && o.limitPrice < price) return (false, 0); // buyer pays above their limit
                if (o.limitPrice > price && fill < o.amount) return (false, 0); // crossing buy left out
                volume += fill;
            } else {
                if (fill > 0 && o.limitPrice > price) return (false, 0); // seller sells below their limit
                if (o.limitPrice < price && fill < o.amount) return (false, 0); // crossing sell left out
                sellVolume += fill;
            }
        }
        if (volume != sellVolume) return (false, 0); // TKN bought must equal TKN sold
        return (true, volume);
    }

    /// @notice mUSD for `baseAmount` TKN at `price`, rounded up. What a buyer pays or locks.
    function quoteUp(uint256 baseAmount, uint256 price) internal pure returns (uint256) {
        return Math.mulDiv(baseAmount, price, PRICE_SCALE, Math.Rounding.Ceil);
    }

    /// @notice mUSD for `baseAmount` TKN at `price`, rounded down. What a seller receives.
    function quoteDown(uint256 baseAmount, uint256 price) internal pure returns (uint256) {
        return Math.mulDiv(baseAmount, price, PRICE_SCALE);
    }
}
