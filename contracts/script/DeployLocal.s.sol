// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {SimpleAMM} from "../src/amm/SimpleAMM.sol";
import {ObscuraBase} from "../src/ObscuraBase.sol";
import {ObscuraAuction} from "../src/ObscuraAuction.sol";
import {ObscuraAuctionZK} from "../src/ObscuraAuctionZK.sol";
import {InvariantBounty} from "../src/InvariantBounty.sol";
import {ClearingVerifier} from "../src/zk/ClearingVerifier.sol";
import {IClearingVerifier} from "../src/interfaces/IClearingVerifier.sol";

/// @title DeployLocal
/// @notice Deploys everything to a local Anvil chain: the tokens, the "normal exchange" (SimpleAMM), the v1
///         Obscura auction with its bounty vault, and the zero-knowledge auction with its verifier. Seeds the AMM
///         pool, both fee pools and the vault, funds the test accounts, approves every venue for them, deposits
///         into both auctions for the victim and the simulated traders, and writes the addresses to a JSON file.
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

    /// @dev Accounts 1 to 16 get enough of both tokens to trade in either direction on every venue.
    ///      Roles: 1 victim, 2 bot, 3 solver, 4-9 traders on the v1 auction, 10 ZK solver, 11-16 ZK traders.
    ///      Anvil only gives ETH to accounts 0 to 9, so the deployer sends some to 10 to 16.
    uint256 internal constant ACCOUNT_TKN = 100_000e18;
    uint256 internal constant ACCOUNT_MUSD = 10_000_000e18;
    uint32 internal constant FUNDED_ACCOUNTS = 16;
    uint256 internal constant EXTRA_ACCOUNT_ETH = 100 ether;
    /// @dev The victim and each simulated trader start with this much inside the auction they trade on.
    uint256 internal constant OBSCURA_TKN = 25_000e18;
    uint256 internal constant OBSCURA_MUSD = 2_500_000e18;

    struct Deployed {
        MockERC20 tkn;
        MockERC20 musd;
        SimpleAMM amm;
        ObscuraAuction auction;
        InvariantBounty bounty;
        ClearingVerifier verifier;
        ObscuraAuctionZK zkAuction;
    }

    function run() external {
        uint256 deployerKey = vm.deriveKey(ANVIL_MNEMONIC, 0);
        string memory outFile = vm.envOr("DEPLOYMENTS_FILE", string("../deployments/31337.json"));

        vm.startBroadcast(deployerKey);
        Deployed memory d = _deployContracts();
        _seed(d, vm.addr(deployerKey));
        vm.stopBroadcast();

        _onboardAccounts(d);
        _writeDeployment(d, outFile);
    }

    function _deployContracts() internal returns (Deployed memory d) {
        d.tkn = new MockERC20("Obscura Test Token", "TKN");
        d.musd = new MockERC20("Mock USD", "mUSD");
        d.amm = new SimpleAMM(d.tkn, d.musd);
        d.auction = new ObscuraAuction(d.tkn, d.musd, _localConfig(64, 4));
        d.bounty = new InvariantBounty(d.auction, d.musd, CLAIM_DELAY);
        d.verifier = new ClearingVerifier();
        d.zkAuction =
            new ObscuraAuctionZK(d.tkn, d.musd, _localConfig(16, 1), IClearingVerifier(address(d.verifier)));
    }

    function _seed(Deployed memory d, address deployer) internal {
        d.tkn.mint(deployer, POOL_TKN);
        d.musd.mint(deployer, POOL_MUSD + 2 * FEE_POOL_MUSD + BOUNTY_MUSD);
        d.tkn.approve(address(d.amm), POOL_TKN);
        d.musd.approve(address(d.amm), POOL_MUSD);
        d.amm.addLiquidity(POOL_TKN, POOL_MUSD);
        d.musd.approve(address(d.bounty), BOUNTY_MUSD);
        d.bounty.fund(BOUNTY_MUSD);
        d.musd.approve(address(d.auction), FEE_POOL_MUSD);
        d.auction.fundFeePool(FEE_POOL_MUSD);
        d.musd.approve(address(d.zkAuction), FEE_POOL_MUSD);
        d.zkAuction.fundFeePool(FEE_POOL_MUSD);

        for (uint32 i = 1; i <= FUNDED_ACCOUNTS; i++) {
            address account = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, i));
            d.tkn.mint(account, ACCOUNT_TKN);
            d.musd.mint(account, ACCOUNT_MUSD);
            if (i >= 10) payable(account).transfer(EXTRA_ACCOUNT_ETH);
        }
    }

    /// @dev Each account approves every venue once, so demos and the harness can trade immediately.
    function _onboardAccounts(Deployed memory d) internal {
        for (uint32 i = 1; i <= FUNDED_ACCOUNTS; i++) {
            vm.startBroadcast(vm.deriveKey(ANVIL_MNEMONIC, i));
            d.tkn.approve(address(d.amm), type(uint256).max);
            d.musd.approve(address(d.amm), type(uint256).max);
            d.tkn.approve(address(d.auction), type(uint256).max);
            d.musd.approve(address(d.auction), type(uint256).max);
            d.tkn.approve(address(d.zkAuction), type(uint256).max);
            d.musd.approve(address(d.zkAuction), type(uint256).max);
            if (i == 1 || (i >= 4 && i <= 9)) {
                d.auction.deposit(address(d.tkn), OBSCURA_TKN);
                d.auction.deposit(address(d.musd), OBSCURA_MUSD);
            }
            if (i == 1 || i >= 11) {
                d.zkAuction.deposit(address(d.tkn), OBSCURA_TKN);
                d.zkAuction.deposit(address(d.musd), OBSCURA_MUSD);
            }
            vm.stopBroadcast();
        }
    }

    function _writeDeployment(Deployed memory d, string memory outFile) internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "tkn", address(d.tkn));
        vm.serializeAddress(obj, "musd", address(d.musd));
        vm.serializeAddress(obj, "amm", address(d.amm));
        vm.serializeAddress(obj, "auction", address(d.auction));
        vm.serializeAddress(obj, "bounty", address(d.bounty));
        vm.serializeAddress(obj, "verifier", address(d.verifier));
        string memory json = vm.serializeAddress(obj, "zkAuction", address(d.zkAuction));
        vm.writeJson(json, outFile);
    }

    /// @dev Short windows for a local chain: commit 5 blocks, reveal 3, solve 3.
    function _localConfig(uint256 maxOrders, uint256 maxSolutions)
        internal
        pure
        returns (ObscuraBase.Config memory)
    {
        return ObscuraBase.Config({
            commitBlocks: 5,
            revealBlocks: 3,
            solveBlocks: 3,
            revealBond: 0.01 ether,
            solverBond: 1 ether,
            solverReward: 10e18,
            maxOrders: maxOrders,
            maxSolutions: maxSolutions
        });
    }
}
