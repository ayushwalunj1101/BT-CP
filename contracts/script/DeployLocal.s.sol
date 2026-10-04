// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {SimpleAMM} from "../src/amm/SimpleAMM.sol";
import {ObscuraBase} from "../src/ObscuraBase.sol";
import {ObscuraAuction} from "../src/ObscuraAuction.sol";
import {InvariantBounty} from "../src/InvariantBounty.sol";

/// @title DeployLocal
/// @notice Deploys everything to a local Anvil chain: the tokens, the "normal exchange" (SimpleAMM),
///         Obscura and its bounty vault. Seeds the AMM pool, Obscura's fee pool and the vault, funds the test
///         accounts, approves both venues
///         for them, deposits into Obscura for the victim and the simulated traders, and writes the addresses
///         to a deployments JSON file.
/// @dev Uses Anvil's public development mnemonic only, never a real key.
///      Output file: $DEPLOYMENTS_FILE, default ../deployments/31337.json.
///      Run: forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeployLocal is Script {
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

    /// @dev AMM pool seeded at 100 mUSD per TKN.
    uint256 internal constant POOL_TKN = 100_000e18;
    uint256 internal constant POOL_MUSD = 10_000_000e18;
    uint256 internal constant FEE_POOL_MUSD = 100_000e18;
    /// @dev Test funds in the bounty vault, and the blocks between committing and making a claim.
    uint256 internal constant BOUNTY_MUSD = 10_000e18;
    uint256 internal constant CLAIM_DELAY = 2;

    /// @dev Accounts 1 to 9 get enough of both tokens to trade in either direction on either venue.
    uint256 internal constant ACCOUNT_TKN = 100_000e18;
    uint256 internal constant ACCOUNT_MUSD = 10_000_000e18;
    uint32 internal constant FUNDED_ACCOUNTS = 9;
    /// @dev Account 1 (victim) and 4 to 9 (simulated traders) start with half their tokens inside Obscura.
    uint256 internal constant OBSCURA_TKN = 25_000e18;
    uint256 internal constant OBSCURA_MUSD = 2_500_000e18;

    function run() external {
        uint256 deployerKey = vm.deriveKey(ANVIL_MNEMONIC, 0);
        address deployer = vm.addr(deployerKey);
        string memory outFile = vm.envOr("DEPLOYMENTS_FILE", string("../deployments/31337.json"));

        vm.startBroadcast(deployerKey);
        MockERC20 tkn = new MockERC20("Obscura Test Token", "TKN");
        MockERC20 musd = new MockERC20("Mock USD", "mUSD");
        SimpleAMM amm = new SimpleAMM(tkn, musd);
        ObscuraAuction auction = new ObscuraAuction(tkn, musd, _localConfig());
        InvariantBounty bounty = new InvariantBounty(auction, musd, CLAIM_DELAY);

        tkn.mint(deployer, POOL_TKN);
        musd.mint(deployer, POOL_MUSD + FEE_POOL_MUSD + BOUNTY_MUSD);
        musd.approve(address(bounty), BOUNTY_MUSD);
        bounty.fund(BOUNTY_MUSD);
        tkn.approve(address(amm), POOL_TKN);
        musd.approve(address(amm), POOL_MUSD);
        amm.addLiquidity(POOL_TKN, POOL_MUSD);
        musd.approve(address(auction), FEE_POOL_MUSD);
        auction.fundFeePool(FEE_POOL_MUSD);

        for (uint32 i = 1; i <= FUNDED_ACCOUNTS; i++) {
            address account = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, i));
            tkn.mint(account, ACCOUNT_TKN);
            musd.mint(account, ACCOUNT_MUSD);
        }
        vm.stopBroadcast();

        // Each account approves both venues once, so demos and the harness can trade immediately.
        for (uint32 i = 1; i <= FUNDED_ACCOUNTS; i++) {
            vm.startBroadcast(vm.deriveKey(ANVIL_MNEMONIC, i));
            tkn.approve(address(amm), type(uint256).max);
            musd.approve(address(amm), type(uint256).max);
            tkn.approve(address(auction), type(uint256).max);
            musd.approve(address(auction), type(uint256).max);
            if (i == 1 || i >= 4) {
                auction.deposit(address(tkn), OBSCURA_TKN);
                auction.deposit(address(musd), OBSCURA_MUSD);
            }
            vm.stopBroadcast();
        }

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "tkn", address(tkn));
        vm.serializeAddress(obj, "musd", address(musd));
        vm.serializeAddress(obj, "amm", address(amm));
        vm.serializeAddress(obj, "auction", address(auction));
        string memory json = vm.serializeAddress(obj, "bounty", address(bounty));
        vm.writeJson(json, outFile);
    }

    /// @dev Short windows for a local chain: commit 5 blocks, reveal 3, solve 3.
    function _localConfig() internal pure returns (ObscuraBase.Config memory) {
        return ObscuraBase.Config({
            commitBlocks: 5,
            revealBlocks: 3,
            solveBlocks: 3,
            revealBond: 0.01 ether,
            solverBond: 1 ether,
            solverReward: 10e18,
            maxOrders: 64,
            maxSolutions: 4
        });
    }
}
