// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {HanaDelegateExecutor} from "../src/HanaDelegateExecutor.sol";
import {CheckIn} from "../src/demo/CheckIn.sol";
import {Base} from "./utils/Base.sol";
import {GasProbe, Swallower} from "./utils/Mocks.sol";

/// The gas floor (minGas) at its exact boundary, a target that swallows an inner out-of-gas, and the gas numbers the
/// relayer budgets with (README "Gas"; `forge test --mc GasTest -vv` prints them).
contract GasTest is Base {
    GasProbe internal probe;
    Swallower internal swallower;
    CheckIn internal checkIn;

    function setUp() public override {
        super.setUp();
        probe = new GasProbe();
        swallower = new Swallower();
        checkIn = new CheckIn();
        coldSet.push(address(probe));
        coldSet.push(address(swallower));
        coldSet.push(address(swallower.burner()));
        coldSet.push(address(checkIn));
        coldSet.push(alice);
    }

    function executeData(address account, HanaDelegateExecutor.Call[] memory calls, uint256 nonce, uint256 minGas)
        internal
        view
        returns (bytes memory)
    {
        bytes memory sig = signed(aliceKey, account, calls, nonce, minGas);
        return abi.encodeCall(HanaDelegateExecutor.execute, (calls, nonce, deadline, relayer, minGas, sig));
    }

    /// The smallest gas limit for the frame that passes the minGas check, minus minGas: what the executor spends
    /// before the check (calldata decoding, hashing, ecrecover, the nonce write).
    function overhead(HanaDelegateExecutor.Call[] memory calls, uint256 nonce) internal returns (uint256) {
        uint256 m = 200_000;
        bytes memory data = executeData(alice, calls, nonce, m);
        return minGasLimit(relayer, alice, data, HanaDelegateExecutor.InsufficientGas.selector, m, m + 100_000) - m;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The floor at its boundary

    function test_minGas_exactBoundary_firstCallGetsTheFloor() public {
        uint256 m = 100_000;
        HanaDelegateExecutor.Call[] memory calls = one(address(probe), 0, abi.encodeCall(GasProbe.probe, ()));
        bytes memory data = executeData(alice, calls, 0, m);
        uint256 limit = minGasLimit(relayer, alice, data, HanaDelegateExecutor.InsufficientGas.selector, m, m + 100_000);

        // One unit less at the check: InsufficientGas, nothing consumed.
        coolAll(alice);
        vm.prank(relayer);
        (bool ok, bytes memory ret) = alice.call{gas: limit - 1}(data);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(HanaDelegateExecutor.InsufficientGas.selector));
        assertEq(exec(alice).nonce(), 0);
        assertEq(probe.seen(), 0);

        // At the boundary: it runs, and the first call receives at least 63/64 of the floor, less the call's own
        // cost (a cold account access, 2 600, and the loop's few hundred). Checking after the nonce write matters:
        // checked before it, the nonce's 22 100 would come out of the floor.
        coolAll(alice);
        vm.prank(relayer);
        (ok,) = alice.call{gas: limit}(data);
        assertTrue(ok, "runs at the boundary");
        assertEq(exec(alice).nonce(), 1);
        uint256 floor = m * 63 / 64 - 4_000;
        assertGe(probe.seen(), floor, "the first call gets the signed floor");
        assertLe(probe.seen(), m, "and the boundary is the floor itself");
        console.log("gas limit at the boundary for minGas 100000:", limit);
        console.log("gas the first call received:", probe.seen());
    }

    /// With an honest minGas (the wallet's rule: ceil(L * 1.15) + 5 000 per call, L the call loop's gas in a
    /// simulation) a target that swallows an inner out-of-gas either has its full effect or the batch reverts,
    /// whatever gas limit the relayer picks: never a partial, degraded success.
    function test_swallowingTarget_honestMinGas_fullEffectOrRevert() public {
        uint256 iterations = 600; // about 60 000 gas inside the burner
        HanaDelegateExecutor.Call[] memory calls =
            one(address(swallower), 0, abi.encodeCall(Swallower.work, (iterations)));

        // L: the loop's gas in a simulation (the call from the account, as execute makes it).
        uint256 snap = vm.snapshotState();
        coolAll(alice);
        vm.prank(alice);
        uint256 g = gasleft();
        swallower.work(iterations);
        uint256 loop = g - gasleft();
        assertTrue(swallower.full());
        vm.revertToState(snap);
        uint256 minGas = (loop * 115 + 99) / 100 + 5_000;

        bytes memory data = executeData(alice, calls, 0, minGas);
        uint256 fulls;
        uint256 reverts;
        for (uint256 limit = minGas - 20_000; limit <= minGas + 80_000; limit += 1_000) {
            snap = vm.snapshotState();
            coolAll(alice);
            vm.prank(relayer);
            (bool ok,) = alice.call{gas: limit}(data);
            if (ok) {
                assertTrue(swallower.full(), "success means the full effect, never a degraded one");
                fulls++;
            } else {
                assertFalse(swallower.full());
                assertEq(exec(alice).nonce(), 0);
                reverts++;
            }
            vm.revertToState(snap);
        }
        assertGt(fulls, 0);
        assertGt(reverts, 0);
        console.log("swallower: loop gas L", loop, "honest minGas", minGas);
    }

    /// The contrast: without a floor (minGas 0) some gas limit gives the degraded success the floor prevents.
    function test_swallowingTarget_noFloor_canBeDegraded() public {
        uint256 iterations = 600;
        HanaDelegateExecutor.Call[] memory calls =
            one(address(swallower), 0, abi.encodeCall(Swallower.work, (iterations)));
        bytes memory data = executeData(alice, calls, 0, 0);
        bool degradedSeen;
        for (uint256 limit = 40_000; limit <= 140_000 && !degradedSeen; limit += 1_000) {
            uint256 snap = vm.snapshotState();
            coolAll(alice);
            vm.prank(relayer);
            (bool ok,) = alice.call{gas: limit}(data);
            degradedSeen = ok && !swallower.full();
            vm.revertToState(snap);
        }
        assertTrue(degradedSeen, "a relayer could have degraded it");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Numbers for the relayer's budget (README "Gas"); the bounds catch a change, the logs give the exact values

    function test_gas_numbers() public {
        HanaDelegateExecutor.Call[] memory oneCall = one(address(checkIn), 0, abi.encodeCall(CheckIn.checkIn, ()));
        HanaDelegateExecutor.Call[] memory four = new HanaDelegateExecutor.Call[](4);
        for (uint256 i = 0; i < 4; i++) {
            four[i] = oneCall[0];
        }

        uint256 coldOne = overhead(oneCall, 0);
        uint256 coldFour = overhead(four, 0);
        // A first batch moves the nonce off zero; later ones change a non-zero slot.
        bytes memory first = executeData(alice, oneCall, 0, 0);
        uint256 execFirst = minGasLimit(relayer, alice, first, bytes4(0), 5_000, 300_000);
        vm.prank(relayer);
        (bool ok,) = alice.call(first);
        assertTrue(ok);
        uint256 warmOne = overhead(oneCall, 1);
        uint256 execLater = minGasLimit(relayer, alice, executeData(alice, oneCall, 1, 0), bytes4(0), 5_000, 300_000);

        // CheckIn alone, called from the account: the first check-in, then a later one.
        address dave = makeAddr("dave");
        bytes memory ci = abi.encodeCall(CheckIn.checkIn, ());
        uint256 checkInFirst = minGasLimit(dave, address(checkIn), ci, bytes4(0), 1_000, 100_000);
        vm.prank(dave);
        checkIn.checkIn();
        uint256 checkInLater = minGasLimit(dave, address(checkIn), ci, bytes4(0), 1_000, 100_000);

        console.log("pre-loop overhead, 1 call, nonce 0 -> 1 (cold, zero slot):", coldOne);
        console.log("pre-loop overhead, 4 calls, nonce 0 -> 1:", coldFour);
        console.log("pre-loop overhead, 1 call, nonce 1 -> 2 (non-zero slot):", warmOne);
        console.log("execute with one checkIn, minimum frame gas, first batch and first check-in:", execFirst);
        console.log("execute with one checkIn, minimum frame gas, later batch and later check-in:", execLater);
        console.log("checkIn alone, minimum frame gas, first check-in:", checkInFirst);
        console.log("checkIn alone, minimum frame gas, later check-in:", checkInLater);

        assertApproxEqAbs(coldOne, 29_300, 1_500, "cold overhead");
        assertApproxEqAbs(warmOne, 9_800, 1_500, "warm overhead");
        assertGt(coldFour, coldOne);
        assertLt(coldFour - coldOne, 6_000, "decoding and hashing three more calls");
        assertApproxEqAbs(checkInFirst, 24_400, 1_500, "first check-in");
        assertApproxEqAbs(checkInLater, 4_700, 1_500, "later check-in");
        assertApproxEqAbs(execFirst, 59_000, 3_000, "a first sponsored check-in");
        assertApproxEqAbs(execLater, 16_600, 2_000, "a later sponsored check-in");
    }
}
