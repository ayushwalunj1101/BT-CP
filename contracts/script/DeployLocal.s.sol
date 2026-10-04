// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {SimpleAMM} from "../src/amm/SimpleAMM.sol";

/// @title DeployLocal
/// @notice Deploys the Stage 1 contracts to a local Anvil chain, seeds the pool, funds the test accounts
///         and approves the AMM for them, then writes the addresses to a deployments JSON file.
/// @dev Uses Anvil's public development mnemonic only, never a real key.
///      Output file: $DEPLOYMENTS_FILE, default ../deployments/31337.json.
///      Run: forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeployLocal is Script {
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

    /// @dev Pool seeded at 100 mUSD per TKN.
    uint256 internal constant POOL_TKN = 100_000e18;
    uint256 internal constant POOL_MUSD = 10_000_000e18;

    /// @dev Every non-deployer account gets enough of both tokens to trade in either direction.
    uint256 internal constant ACCOUNT_TKN = 50_000e18;
    uint256 internal constant ACCOUNT_MUSD = 5_000_000e18;
    uint32 internal constant FUNDED_ACCOUNTS = 9; // accounts 1 to 9

    function run() external {
        uint256 deployerKey = vm.deriveKey(ANVIL_MNEMONIC, 0);
        address deployer = vm.addr(deployerKey);
        string memory outFile = vm.envOr("DEPLOYMENTS_FILE", string("../deployments/31337.json"));

        vm.startBroadcast(deployerKey);
        MockERC20 tkn = new MockERC20("Obscura Test Token", "TKN");
        MockERC20 musd = new MockERC20("Mock USD", "mUSD");
        SimpleAMM amm = new SimpleAMM(tkn, musd);

        tkn.mint(deployer, POOL_TKN);
        musd.mint(deployer, POOL_MUSD);
        tkn.approve(address(amm), POOL_TKN);
        musd.approve(address(amm), POOL_MUSD);
        amm.addLiquidity(POOL_TKN, POOL_MUSD);

        for (uint32 i = 1; i <= FUNDED_ACCOUNTS; i++) {
            address account = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, i));
            tkn.mint(account, ACCOUNT_TKN);
            musd.mint(account, ACCOUNT_MUSD);
        }
        vm.stopBroadcast();

        // Each account approves the AMM once, so demos and the harness can trade immediately.
        for (uint32 i = 1; i <= FUNDED_ACCOUNTS; i++) {
            vm.startBroadcast(vm.deriveKey(ANVIL_MNEMONIC, i));
            tkn.approve(address(amm), type(uint256).max);
            musd.approve(address(amm), type(uint256).max);
            vm.stopBroadcast();
        }

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "tkn", address(tkn));
        vm.serializeAddress(obj, "musd", address(musd));
        string memory json = vm.serializeAddress(obj, "amm", address(amm));
        vm.writeJson(json, outFile);
    }
}
