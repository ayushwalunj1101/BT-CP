pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";

// Spike B: the smallest proof with the same shape as an Obscura sealed order.
// The prover shows "I know an order and a salt whose Poseidon hash is this commitment"
// without revealing the order or the salt. Only the commitment is public.
template SealedOrder() {
    signal input order;       // private
    signal input salt;        // private
    signal output commitment; // public

    component hash = Poseidon(2);
    hash.inputs[0] <== order;
    hash.inputs[1] <== salt;
    commitment <== hash.out;
}

component main = SealedOrder();
