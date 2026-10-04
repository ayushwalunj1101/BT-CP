// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SpikeVerifier} from "./SpikeVerifier.sol";

/// @title Spike B, on-chain half
/// @notice A proof made off-chain by snarkjs (circuits/spikes/spike-b.mjs) must verify in Solidity,
///         and any change to the proof or to the public commitment must be rejected.
contract ZkSpikeTest is Test {
    SpikeVerifier internal verifier;

    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;
    uint256[1] internal publicSignals;

    function setUp() public {
        verifier = new SpikeVerifier();

        string memory json = vm.readFile("test/fixtures/spike-proof.json");
        uint256[] memory pa = vm.parseJsonUintArray(json, ".a");
        uint256[] memory pb0 = vm.parseJsonUintArray(json, ".b[0]");
        uint256[] memory pb1 = vm.parseJsonUintArray(json, ".b[1]");
        uint256[] memory pc = vm.parseJsonUintArray(json, ".c");
        uint256[] memory pub = vm.parseJsonUintArray(json, ".publicSignals");

        a = [pa[0], pa[1]];
        b = [[pb0[0], pb0[1]], [pb1[0], pb1[1]]];
        c = [pc[0], pc[1]];
        publicSignals = [pub[0]];
    }

    function test_ValidProofVerifies() public view {
        assertTrue(verifier.verifyProof(a, b, c, publicSignals));
    }

    function test_RejectsDifferentCommitment() public view {
        uint256[1] memory wrong = [publicSignals[0] + 1];
        assertFalse(verifier.verifyProof(a, b, c, wrong));
    }

    function test_RejectsTamperedProof() public view {
        uint256[2] memory tampered = [a[0], a[1] + 1];
        assertFalse(verifier.verifyProof(tampered, b, c, publicSignals));
    }

    function test_VerificationGas() public {
        uint256 gasBefore = gasleft();
        verifier.verifyProof(a, b, c, publicSignals);
        uint256 used = gasBefore - gasleft();
        emit log_named_uint("verifyProof gas (1 public input)", used);
        // A Groth16 check is a handful of elliptic-curve operations; it should stay well under 300k gas.
        assertLt(used, 300_000);
    }
}
