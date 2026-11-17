// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {SimpleAMM} from "../src/amm/SimpleAMM.sol";
import {ObscuraBase} from "../src/ObscuraBase.sol";
import {ObscuraAuction} from "../src/ObscuraAuction.sol";
import {InvariantBounty} from "../src/InvariantBounty.sol";

/// @title DeploySepolia
/// @notice Deploys every contract to Sepolia (or any public testnet) with the deployer's key from the environment,
///         seeds the AMM pool, the fee pool and the bounty vault with freshly minted test tokens, and writes the
///         addresses to deployments/<chainId>.json. Visitors get their own test tokens from the website's
///         "Get test tokens" button, because anyone can mint them.
/// @dev Run through `npm run deploy:sepolia`, which loads .env and adds Etherscan verification. Never commit the key.
///      Bonds are small, so a faucet-funded wallet can afford them.
contract DeploySepolia is Script {
    uint256 internal constant POOL_TKN = 100_000e18;
    uint256 internal constant POOL_MUSD = 10_000_000e18;
    uint256 internal constant FEE_POOL_MUSD = 100_000e18;
    uint256 internal constant BOUNTY_MUSD = 10_000e18;
    uint256 internal constant CLAIM_DELAY = 2;

    struct Deployed {
        MockERC20 tkn;
        MockERC20 musd;
        SimpleAMM amm;
        ObscuraAuction auction;
        InvariantBounty bounty;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory outFile = vm.envOr(
            "DEPLOYMENTS_FILE", string.concat("../deployments/", vm.toString(block.chainid), ".json")
        );

        vm.startBroadcast(deployerKey);
        Deployed memory d;
        d.tkn = new MockERC20("Obscura Test Token", "TKN");
        d.musd = new MockERC20("Mock USD", "mUSD");
        d.amm = new SimpleAMM(d.tkn, d.musd);
        d.auction = new ObscuraAuction(d.tkn, d.musd, _testnetConfig());
        d.bounty = new InvariantBounty(d.auction, d.musd, CLAIM_DELAY);
        _seed(d, vm.addr(deployerKey));
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "tkn", address(d.tkn));
        vm.serializeAddress(obj, "musd", address(d.musd));
        vm.serializeAddress(obj, "amm", address(d.amm));
        vm.serializeAddress(obj, "auction", address(d.auction));
        string memory json = vm.serializeAddress(obj, "bounty", address(d.bounty));
        vm.writeJson(json, outFile);
    }

    function _seed(Deployed memory d, address deployer) internal {
        d.tkn.mint(deployer, POOL_TKN);
        d.musd.mint(deployer, POOL_MUSD + FEE_POOL_MUSD + BOUNTY_MUSD);
        d.tkn.approve(address(d.amm), POOL_TKN);
        d.musd.approve(address(d.amm), POOL_MUSD);
        d.amm.addLiquidity(POOL_TKN, POOL_MUSD);
        d.musd.approve(address(d.bounty), BOUNTY_MUSD);
        d.bounty.fund(BOUNTY_MUSD);
        d.musd.approve(address(d.auction), FEE_POOL_MUSD);
        d.auction.fundFeePool(FEE_POOL_MUSD);
    }

    /// @dev Same windows as locally (commit 5 blocks, reveal 3, solve 3), about 2 minutes per batch at 12 s blocks.
    ///      Bonds sized for faucet ETH.
    function _testnetConfig() internal pure returns (ObscuraBase.Config memory) {
        return ObscuraBase.Config({
            commitBlocks: 5,
            revealBlocks: 3,
            solveBlocks: 3,
            revealBond: 0.0005 ether,
            solverBond: 0.01 ether,
            solverReward: 10e18,
            maxOrders: 64,
            maxSolutions: 4
        });
    }
}
