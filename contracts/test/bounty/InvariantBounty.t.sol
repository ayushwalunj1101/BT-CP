// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {ObscuraBase} from "../../src/ObscuraBase.sol";
import {ObscuraAuction} from "../../src/ObscuraAuction.sol";
import {InvariantBounty} from "../../src/InvariantBounty.sol";
import {Order} from "../../src/libraries/Clearing.sol";

// ==================================================================== planted bugs
// Each contract below is ObscuraAuction with one deliberate, realistic bug. They exist only in tests,
// to show that each kind of bug breaks a rule, and that breaking a rule pays out the vault.

/// I1 bug: a withdrawal path that forgets to update the ledger. Tokens leave; the ledger still owes them.
contract LeakyAuction is ObscuraAuction {
    constructor(IERC20 b, IERC20 q, Config memory c) ObscuraAuction(b, q, c) {}

    function withdrawWithoutBookkeeping(address token, uint256 amount) external {
        IERC20(token).transfer(msg.sender, amount);
    }
}

/// I2 bug: buyers are charged their own limit price instead of the batch price.
contract LimitPriceAuction is ObscuraAuction {
    constructor(IERC20 b, IERC20 q, Config memory c) ObscuraAuction(b, q, c) {}

    function _settleOrder(Order memory o, uint256 fill, uint256 price) internal override returns (uint256) {
        return super._settleOrder(o, fill, o.isBuy ? o.limitPrice : price);
    }
}

/// I3 bug: sellers are paid half the batch price, far below their own limit.
contract ShortchangeAuction is ObscuraAuction {
    constructor(IERC20 b, IERC20 q, Config memory c) ObscuraAuction(b, q, c) {}

    function _settleOrder(Order memory o, uint256 fill, uint256 price) internal override returns (uint256) {
        return super._settleOrder(o, fill, o.isBuy ? price : price / 2);
    }
}

/// I4 bug: the winning solver pays itself twice the declared reward.
contract GreedySolverAuction is ObscuraAuction {
    constructor(IERC20 b, IERC20 q, Config memory c) ObscuraAuction(b, q, c) {}

    function _rewardFor(uint256 volume) internal view override returns (uint256) {
        uint256 doubled = super._rewardFor(volume) * 2;
        return doubled < feePool ? doubled : feePool;
    }
}

// ==================================================================== tests

contract InvariantBountyTest is Test {
    uint256 internal constant VAULT = 10_000e18;
    uint256 internal constant CLAIM_DELAY = 2;
    uint256 internal constant REVEAL_BOND = 0.01 ether;
    uint256 internal constant SOLVER_BOND = 1 ether;

    enum Kind {
        Correct,
        Leaky,
        LimitPrice,
        Shortchange,
        GreedySolver
    }

    MockERC20 internal tkn;
    MockERC20 internal musd;
    ObscuraAuction internal auction;
    InvariantBounty internal bounty;

    address internal alice = makeAddr("alice"); // buys 10 TKN at up to 105
    address internal carol = makeAddr("carol"); // sells 10 TKN at no less than 95
    address internal solver = makeAddr("solver");
    address internal researcher = makeAddr("researcher"); // finds the bug and claims
    address internal copycat = makeAddr("copycat"); // a bot that copies pending transactions

    function setUp() public {
        tkn = new MockERC20("Obscura Test Token", "TKN");
        musd = new MockERC20("Mock USD", "mUSD");
    }

    // ---------------------------------------------------------------- helpers

    function _deploy(Kind kind) internal {
        ObscuraBase.Config memory c = ObscuraBase.Config(5, 3, 3, REVEAL_BOND, SOLVER_BOND, 10e18, 64, 4);
        if (kind == Kind.Correct) auction = new ObscuraAuction(tkn, musd, c);
        else if (kind == Kind.Leaky) auction = new LeakyAuction(tkn, musd, c);
        else if (kind == Kind.LimitPrice) auction = new LimitPriceAuction(tkn, musd, c);
        else if (kind == Kind.Shortchange) auction = new ShortchangeAuction(tkn, musd, c);
        else auction = new GreedySolverAuction(tkn, musd, c);

        bounty = new InvariantBounty(auction, musd, CLAIM_DELAY);
        musd.mint(address(this), VAULT + 1_000e18);
        musd.approve(address(bounty), VAULT);
        bounty.fund(VAULT);
        musd.approve(address(auction), 1_000e18);
        auction.fundFeePool(1_000e18);

        _fund(alice);
        _fund(carol);
        vm.deal(solver, 10 ether);
    }

    function _fund(address who) internal {
        tkn.mint(who, 1_000e18);
        musd.mint(who, 100_000e18);
        vm.deal(who, 1 ether);
        vm.startPrank(who);
        tkn.approve(address(auction), type(uint256).max);
        musd.approve(address(auction), type(uint256).max);
        auction.deposit(address(tkn), 1_000e18);
        auction.deposit(address(musd), 100_000e18);
        vm.stopPrank();
    }

    /// One ordinary batch in epoch 0: Alice buys 10 TKN from Carol, cleared at 100 mUSD.
    function _runBatch() internal {
        uint256 start = auction.epochStartBlock(0);
        vm.roll(start);
        bytes32 hA = auction.commitmentHash(alice, 0, true, 105e18, 10e18, "a");
        bytes32 hC = auction.commitmentHash(carol, 0, false, 95e18, 10e18, "c");
        vm.prank(alice);
        auction.commit{value: REVEAL_BOND}(0, hA);
        vm.prank(carol);
        auction.commit{value: REVEAL_BOND}(0, hC);

        vm.roll(start + 5);
        vm.prank(alice);
        auction.reveal(0, 0, true, 105e18, 10e18, "a");
        vm.prank(carol);
        auction.reveal(0, 1, false, 95e18, 10e18, "c");

        vm.roll(start + 8);
        uint128[] memory fills = new uint128[](2);
        (fills[0], fills[1]) = (10e18, 10e18);
        vm.prank(solver);
        auction.submitSolution{value: SOLVER_BOND}(0, 100e18, fills);

        vm.roll(start + 11);
        auction.settle(0);
    }

    /// The researcher commits a sealed claim, waits out the delay, then claims.
    function _claim(address who, uint8 invariantId) internal returns (uint256 received) {
        bytes32 salt = keccak256(abi.encode(who, invariantId));
        vm.prank(who);
        bounty.commitClaim(bounty.claimHash(who, invariantId, 0, salt));
        vm.roll(block.number + CLAIM_DELAY);
        uint256 before = musd.balanceOf(who);
        vm.prank(who);
        bounty.claim(invariantId, 0, salt);
        received = musd.balanceOf(who) - before;
    }

    function _assertPaidOut(uint8 invariantId) internal {
        assertTrue(bounty.isViolated(invariantId, 0), "the planted bug breaks the rule");
        uint256 received = _claim(researcher, invariantId);
        assertEq(received, VAULT, "the whole vault goes to the researcher");
        assertEq(bounty.vaultBalance(), 0);
        assertTrue(bounty.paid());
        emit log_named_decimal_uint("vault paid automatically to the researcher (mUSD)", received, 18);
    }

    // ---------------------------------------------------------------- the real contract holds every rule

    function test_CorrectAuction_EveryRuleHoldsAndNothingPays() public {
        _deploy(Kind.Correct);
        _runBatch();
        for (uint8 id = 1; id <= 4; ++id) {
            assertFalse(bounty.isViolated(id, 0));
            bytes32 salt = bytes32(uint256(id));
            vm.prank(researcher);
            bounty.commitClaim(bounty.claimHash(researcher, id, 0, salt));
            vm.roll(block.number + CLAIM_DELAY);
            vm.prank(researcher);
            vm.expectRevert(abi.encodeWithSelector(InvariantBounty.NoViolation.selector, id, 0));
            bounty.claim(id, 0, salt);
        }
        assertEq(bounty.vaultBalance(), VAULT);
    }

    /// Sending tokens or ETH straight to the contract makes it hold more than it owes, not less.
    function test_DonationDoesNotLookLikeABug() public {
        _deploy(Kind.Correct);
        _runBatch();
        tkn.mint(address(auction), 5e18);
        musd.mint(address(auction), 5e18);
        vm.deal(address(auction), address(auction).balance + 1 ether);
        assertTrue(auction.checkI1());
        assertFalse(bounty.isViolated(1, 0));
    }

    // ---------------------------------------------------------------- planted bugs pay out

    function test_PlantedBug_I1_LeakPaysOut() public {
        _deploy(Kind.Leaky);
        _runBatch();
        LeakyAuction(address(auction)).withdrawWithoutBookkeeping(address(tkn), 1e18);
        assertFalse(auction.checkI1());
        _assertPaidOut(1);
    }

    function test_PlantedBug_I2_NonUniformPricePaysOut() public {
        _deploy(Kind.LimitPrice);
        _runBatch(); // Alice is charged 105, her limit, while the batch price is 100
        assertFalse(auction.checkI2(0));
        assertTrue(auction.checkI3(0)); // she still paid no more than her limit, so I3 holds
        _assertPaidOut(2);
    }

    function test_PlantedBug_I3_ShortchangedSellerPaysOut() public {
        _deploy(Kind.Shortchange);
        _runBatch(); // Carol receives 50 per TKN, below her limit of 95
        assertFalse(auction.checkI3(0));
        _assertPaidOut(3);
    }

    function test_PlantedBug_I4_GreedySolverPaysOut() public {
        _deploy(Kind.GreedySolver);
        _runBatch(); // the solver takes 20 mUSD against a declared reward of 10
        assertFalse(auction.checkI4(0));
        _assertPaidOut(4);
    }

    // ---------------------------------------------------------------- attack A6: stealing a claim

    /// A bot sees the researcher's claim in the mempool and copies it. The claim hash includes the claimant's
    /// address, so the copy matches no commitment, and copying the commitment itself does not help either.
    function test_CopiedClaimGetsNothing() public {
        _deploy(Kind.Leaky);
        _runBatch();
        LeakyAuction(address(auction)).withdrawWithoutBookkeeping(address(tkn), 1e18);

        bytes32 salt = "researcher's secret";
        bytes32 researcherHash = bounty.claimHash(researcher, 1, 0, salt);
        vm.prank(researcher);
        bounty.commitClaim(researcherHash);
        vm.prank(copycat);
        bounty.commitClaim(researcherHash); // copying the commitment: harmless
        vm.roll(block.number + CLAIM_DELAY);

        vm.prank(copycat);
        vm.expectRevert(InvariantBounty.NoCommitment.selector);
        bounty.claim(1, 0, salt); // copying the claim: no commitment matches the copycat's address

        vm.prank(researcher);
        bounty.claim(1, 0, salt);
        assertEq(musd.balanceOf(researcher), VAULT);
        assertEq(musd.balanceOf(copycat), 0);
    }

    // ---------------------------------------------------------------- claim rules

    function test_Claim_NeedsACommitmentAndTheDelay() public {
        _deploy(Kind.Leaky);
        _runBatch();
        LeakyAuction(address(auction)).withdrawWithoutBookkeeping(address(tkn), 1e18);

        vm.prank(researcher);
        vm.expectRevert(InvariantBounty.NoCommitment.selector);
        bounty.claim(1, 0, "salt");

        vm.prank(researcher);
        bounty.commitClaim(bounty.claimHash(researcher, 1, 0, "salt"));
        vm.prank(researcher);
        vm.expectRevert(abi.encodeWithSelector(InvariantBounty.TooEarly.selector, block.number + CLAIM_DELAY));
        bounty.claim(1, 0, "salt");
    }

    function test_Claim_PaysOnlyOnce() public {
        _deploy(Kind.Leaky);
        _runBatch();
        LeakyAuction(address(auction)).withdrawWithoutBookkeeping(address(tkn), 1e18);
        _claim(researcher, 1);

        vm.prank(copycat);
        vm.expectRevert(InvariantBounty.AlreadyPaid.selector);
        bounty.commitClaim(bytes32(0));
        vm.prank(researcher);
        vm.expectRevert(InvariantBounty.AlreadyPaid.selector);
        bounty.claim(1, 0, keccak256(abi.encode(researcher, uint8(1))));
    }

    function test_RejectsUnknownRuleZeroFundingAndZeroDelay() public {
        _deploy(Kind.Correct);
        vm.expectRevert(abi.encodeWithSelector(InvariantBounty.UnknownInvariant.selector, 5));
        bounty.isViolated(5, 0);
        vm.expectRevert(InvariantBounty.ZeroAmount.selector);
        bounty.fund(0);
        vm.expectRevert(InvariantBounty.InvalidDelay.selector);
        new InvariantBounty(auction, musd, 0);
    }
}
