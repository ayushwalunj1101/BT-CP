// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The Groth16 verifier snarkjs generates for circuits/clearing/clearing.circom (98 public inputs).
interface IClearingVerifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[98] calldata pubSignals
    ) external view returns (bool);
}
