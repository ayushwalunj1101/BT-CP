pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

// Obscura zero-knowledge clearing (feature F12).
//
// The solver proves: "this price and these fills are a valid clearing of exactly these sealed orders",
// without revealing any order. The contract checks the proof and settles; no order is ever revealed.
//
// Units are small integers, so the circuit never divides:
//   amount, fill   lots of 0.001 TKN              (< 2^40)
//   limit, price   ticks of 0.01 mUSD per TKN     (< 2^32)
//   f lots at p ticks cost exactly f * p * 10^13 wei of mUSD.
//   lockBase, lockQuote: wei the contract locked for the slot's trader at commit (< 2^128).
//
// Public fill encoding: a buy fill as is, a sell fill shifted left by 64 bits. An unfilled order is 0,
// so the proof does not reveal which side an unfilled order was on.

template Slot() {
    // public, supplied by the contract
    signal input epoch;
    signal input price;
    signal input commitment;
    signal input trader;
    signal input lockBase;
    signal input lockQuote;
    // public, chosen by the solver
    signal input included;   // 1 if the solver opens this slot's order
    signal input fillEnc;
    // private: the sealed order and its fill
    signal input isBuy;
    signal input limit;
    signal input amount;
    signal input salt;
    signal input fill;

    signal output buyFill;
    signal output sellFill;

    // Ranges. Every comparison below relies on these bounds.
    isBuy * (isBuy - 1) === 0;
    included * (included - 1) === 0;
    component limitBits = Num2Bits(32);
    limitBits.in <== limit;
    component amountBits = Num2Bits(40);
    amountBits.in <== amount;
    component fillBits = Num2Bits(40);
    fillBits.in <== fill;
    component lockBaseBits = Num2Bits(128);
    lockBaseBits.in <== lockBase;
    component lockQuoteBits = Num2Bits(128);
    lockQuoteBits.in <== lockQuote;

    // 1. An included order is exactly the one the trader sealed in this slot, for this batch.
    component hash = Poseidon(6);
    hash.inputs[0] <== trader;
    hash.inputs[1] <== epoch;
    hash.inputs[2] <== isBuy;
    hash.inputs[3] <== limit;
    hash.inputs[4] <== amount;
    hash.inputs[5] <== salt;
    (hash.out - commitment) * included === 0;

    // 2. The order counts only if the locked funds cover it in full at its limit
    //    (a buy's worst-case cost in mUSD, a sell's TKN). Unfunded orders cannot block a batch.
    signal notional <== amount * limit;
    component buyFunded = LessEqThan(128);
    buyFunded.in[0] <== notional * 10000000000000;
    buyFunded.in[1] <== lockQuote;
    component sellFunded = LessEqThan(128);
    sellFunded.in[0] <== amount * 1000000000000000;
    sellFunded.in[1] <== lockBase;
    signal funded <== sellFunded.out + isBuy * (buyFunded.out - sellFunded.out);
    signal active <== included * funded;

    // 3. Orders that do not count never trade.
    fill * (1 - active) === 0;

    // 4. The public fill is this order's fill, encoded by side.
    fillEnc === fill * (isBuy + (1 - isBuy) * 18446744073709551616);

    // 5. Never more than ordered.
    component notTooMuch = LessEqThan(40);
    notTooMuch.in[0] <== fill;
    notTooMuch.in[1] <== amount;
    notTooMuch.out === 1;

    // 6. Price rules: the same as the v1 contract's Clearing.check.
    component below = LessThan(32);   // limit < price
    below.in[0] <== limit;
    below.in[1] <== price;
    component above = LessThan(32);   // limit > price
    above.in[0] <== price;
    above.in[1] <== limit;
    component noFill = IsZero();
    noFill.in <== fill;
    signal traded <== 1 - noFill.out;
    signal activeBuy <== active * isBuy;
    signal activeSell <== active - activeBuy;

    // A buyer never trades above their limit, a seller never below.
    signal tradedBuy <== traded * activeBuy;
    tradedBuy * below.out === 0;
    signal tradedSell <== traded * activeSell;
    tradedSell * above.out === 0;

    // An order that crosses the price strictly must fill completely: leaving it out is censorship.
    signal crossingBuy <== activeBuy * above.out;
    crossingBuy * (amount - fill) === 0;
    signal crossingSell <== activeSell * below.out;
    crossingSell * (amount - fill) === 0;

    buyFill <== fill * isBuy;
    sellFill <== fill - buyFill;
}

template Clearing(N) {
    signal input epoch;
    signal input price;
    signal input commitment[N];
    signal input trader[N];
    signal input lockBase[N];
    signal input lockQuote[N];
    signal input included[N];
    signal input fillEnc[N];

    signal input isBuy[N];
    signal input limit[N];
    signal input amount[N];
    signal input salt[N];
    signal input fill[N];

    component priceBits = Num2Bits(32);
    priceBits.in <== price;

    component slot[N];
    var bought = 0;
    var sold = 0;
    for (var i = 0; i < N; i++) {
        slot[i] = Slot();
        slot[i].epoch <== epoch;
        slot[i].price <== price;
        slot[i].commitment <== commitment[i];
        slot[i].trader <== trader[i];
        slot[i].lockBase <== lockBase[i];
        slot[i].lockQuote <== lockQuote[i];
        slot[i].included <== included[i];
        slot[i].fillEnc <== fillEnc[i];
        slot[i].isBuy <== isBuy[i];
        slot[i].limit <== limit[i];
        slot[i].amount <== amount[i];
        slot[i].salt <== salt[i];
        slot[i].fill <== fill[i];
        bought += slot[i].buyFill;
        sold += slot[i].sellFill;
    }

    // 7. TKN bought equals TKN sold.
    bought === sold;
}

component main {public [epoch, price, commitment, trader, lockBase, lockQuote, included, fillEnc]} = Clearing(16);
