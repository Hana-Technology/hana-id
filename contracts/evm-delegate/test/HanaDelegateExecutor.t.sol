// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {HanaDelegateExecutor} from "../src/HanaDelegateExecutor.sol";
import {CheckIn} from "../src/demo/CheckIn.sol";
import {Base} from "./utils/Base.sol";
import {Errors, Mock1155, Mock721, NaiveCaller, PermitLike, Reenterer, Target, TwoSubmits} from "./utils/Mocks.sol";

contract HanaDelegateExecutorTest is Base {
    Target internal target;
    CheckIn internal checkIn;

    function setUp() public override {
        super.setUp();
        target = new Target();
        checkIn = new CheckIn();
        vm.deal(alice, 10 ether);
    }

    function checkInCall() internal view returns (HanaDelegateExecutor.Call[] memory) {
        return one(address(checkIn), 0, abi.encodeCall(CheckIn.checkIn, ()));
    }

    /// Calldata for Alice's batch, signed by her for `relayer_` with minGas 0.
    function executeData(HanaDelegateExecutor.Call[] memory calls, uint256 nonce, address relayer_)
        internal
        view
        returns (bytes memory)
    {
        bytes memory sig = sign(aliceKey, digestFor(alice, calls, nonce, deadline, relayer_, 0));
        return abi.encodeCall(HanaDelegateExecutor.execute, (calls, nonce, deadline, relayer_, 0, sig));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The happy path, events and storage

    function test_execute_runsTheCallsFromTheAccount() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes32 digest = digestFor(alice, calls, 0, deadline, relayer, 100_000);
        bytes memory sig = sign(aliceKey, digest);

        vm.expectEmit(true, false, false, true, address(checkIn));
        emit CheckIn.CheckedIn(alice, 1);
        vm.expectEmit(true, false, false, true, alice);
        emit HanaDelegateExecutor.Executed(digest, 0, 1);
        submit(alice, calls, 0, 100_000, sig);

        assertEq(checkIn.checkIns(alice), 1, "counted for the account, not the relayer");
        assertEq(checkIn.checkIns(relayer), 0);
        assertEq(exec(alice).nonce(), 1);
        assertEq(exec(bob).nonce(), 0, "nonces are per account");
    }

    function test_execute_runsSeveralCallsInOrder() public {
        HanaDelegateExecutor.Call[] memory calls = two(
            HanaDelegateExecutor.Call(address(target), 0, abi.encodeCall(Target.record, (1))),
            HanaDelegateExecutor.Call(address(target), 0, abi.encodeCall(Target.record, (2)))
        );
        bytes32 digest = digestFor(alice, calls, 0, deadline, relayer, 0);
        vm.expectEmit(true, false, false, true, alice);
        emit HanaDelegateExecutor.Executed(digest, 0, 2);
        submit(alice, calls, 0, 0, sign(aliceKey, digest));
        assertEq(target.calls(), 2);
        assertEq(target.lastArg(), 2, "second call ran last");
    }

    function test_execute_valueWithData_comesFromTheAccount() public {
        HanaDelegateExecutor.Call[] memory calls = one(address(target), 1.5 ether, abi.encodeCall(Target.record, (42)));
        uint256 relayerBefore = relayer.balance;
        submit(alice, calls, 0, 0, signed(aliceKey, alice, calls, 0, 0));
        assertEq(target.lastSender(), alice);
        assertEq(target.lastValue(), 1.5 ether);
        assertEq(target.lastArg(), 42);
        assertEq(alice.balance, 8.5 ether);
        assertEq(address(target).balance, 1.5 ether);
        assertEq(relayer.balance, relayerBefore, "the relayer sends no value");
    }

    function test_execute_plainTransferToAnEoa() public {
        address carol = makeAddr("carol");
        HanaDelegateExecutor.Call[] memory calls = one(carol, 1 ether, "");
        submit(alice, calls, 0, 0, signed(aliceKey, alice, calls, 0, 0));
        assertEq(carol.balance, 1 ether);
    }

    function test_execute_valueAboveTheBalanceFailsAsCallFailed() public {
        HanaDelegateExecutor.Call[] memory calls = one(address(target), 11 ether, abi.encodeCall(Target.record, (1)));
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.expectRevert(Errors.callFailed(0, ""));
        submit(alice, calls, 0, 0, sig);
    }

    function test_execute_isNotPayable() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.deal(relayer, 1 ether);
        vm.prank(relayer);
        (bool ok,) = alice.call{value: 1 wei}(
            abi.encodeCall(HanaDelegateExecutor.execute, (calls, 0, deadline, relayer, 0, sig))
        );
        assertFalse(ok);
        assertEq(exec(alice).nonce(), 0);
    }

    function test_nonceStorage_slotIsTheErc7201Namespace() public {
        bytes32 slot =
            keccak256(abi.encode(uint256(keccak256("hana.storage.DelegateExecutor")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(slot, 0xe526c94a37a61336af23ffe6f077f900033f135d7cb97e988e0cd22f1bf8ed00);

        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.record();
        submit(alice, calls, 0, 0, sig);
        (, bytes32[] memory writes) = vm.accesses(alice);
        assertEq(writes.length, 1, "execute writes one slot of the account: the nonce");
        assertEq(writes[0], slot);
        assertEq(uint256(vm.load(alice, slot)), 1);
    }

    function test_eip712Domain_isErc5267() public view {
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address vc,
            bytes32 salt,
            uint256[] memory ext
        ) = exec(alice).eip712Domain();
        assertEq(fields, hex"1f");
        assertEq(name, "HanaDelegateExecutor");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(vc, alice, "verifyingContract is the account");
        assertEq(salt, bytes32(uint256(uint160(address(impl)))), "salt is the implementation");
        assertEq(ext.length, 0);
    }

    /// The encoder in Base agrees with Foundry's own EIP-712 implementation (alloy), from the JSON typed data.
    function test_digest_matchesFoundrysTypedDataHasher() public view {
        HanaDelegateExecutor.Call[] memory calls = two(
            HanaDelegateExecutor.Call(address(checkIn), 0, abi.encodeCall(CheckIn.checkIn, ())),
            HanaDelegateExecutor.Call(address(target), 7, hex"")
        );
        string memory json = string.concat(
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"},{"name":"salt","type":"bytes32"}],',
            '"Execute":[{"name":"calls","type":"Call[]"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"},',
            '{"name":"relayer","type":"address"},{"name":"minGas","type":"uint256"}],',
            '"Call":[{"name":"to","type":"address"},{"name":"value","type":"uint256"},{"name":"data","type":"bytes"}]},',
            '"primaryType":"Execute","domain":{"name":"HanaDelegateExecutor","version":"1","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(alice),
            '","salt":"',
            vm.toString(bytes32(uint256(uint160(address(impl))))),
            '"},"message":{"calls":[{"to":"',
            vm.toString(address(checkIn)),
            '","value":0,"data":"0x183ff085"},{"to":"',
            vm.toString(address(target)),
            '","value":7,"data":"0x"}],"nonce":5,"deadline":',
            vm.toString(deadline),
            ',"relayer":"',
            vm.toString(relayer),
            '","minGas":100000}}'
        );
        assertEq(abi.encodeCall(CheckIn.checkIn, ()), hex"183ff085");
        assertEq(vm.eip712HashTypedData(json), digestFor(alice, calls, 5, deadline, relayer, 100_000));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Replay, nonce, deadline

    function test_replay_isRefused() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        submit(alice, calls, 0, 0, sig);
        vm.expectRevert(HanaDelegateExecutor.InvalidNonce.selector);
        submit(alice, calls, 0, 0, sig);
        assertEq(checkIn.checkIns(alice), 1);
    }

    function test_futureNonce_isRefused() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(aliceKey, alice, calls, 1, 0);
        vm.expectRevert(HanaDelegateExecutor.InvalidNonce.selector);
        submit(alice, calls, 1, 0, sig);
    }

    function test_deadline_lastSecondIsAccepted_nextIsExpired() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        uint256 snap = vm.snapshotState();

        vm.warp(deadline + 1);
        vm.expectRevert(HanaDelegateExecutor.Expired.selector);
        submit(alice, calls, 0, 0, sig);

        vm.revertToState(snap);
        vm.warp(deadline);
        submit(alice, calls, 0, 0, sig);
        assertEq(exec(alice).nonce(), 1);
    }

    function test_incrementNonce_byTheAccountItself_invalidatesSignedBatches() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.expectEmit(false, false, false, true, alice);
        emit HanaDelegateExecutor.NonceIncremented(1);
        vm.prank(alice, alice); // the account's own transaction to itself
        exec(alice).incrementNonce();
        assertEq(exec(alice).nonce(), 1);
        vm.expectRevert(HanaDelegateExecutor.InvalidNonce.selector);
        submit(alice, calls, 0, 0, sig);
    }

    function test_incrementNonce_byAnyoneElse_isRefused() public {
        vm.expectRevert(HanaDelegateExecutor.OnlyEOA.selector);
        vm.prank(relayer);
        exec(alice).incrementNonce();
        vm.expectRevert(HanaDelegateExecutor.OnlyEOA.selector);
        vm.prank(bob); // another delegated account
        exec(alice).incrementNonce();
        vm.expectRevert(HanaDelegateExecutor.OnlyEOA.selector);
        exec(address(impl)).incrementNonce();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Signatures: bound to the account, chain, implementation, relayer and minGas; strict encoding

    function test_signature_ofAnotherKey_isRefused() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(bobKey, alice, calls, 0, 0);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(alice, calls, 0, 0, sig);
    }

    function test_signature_forAnotherAccount_isRefused() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        // Bob's own valid batch, submitted to Alice's account, and Alice's to Bob's.
        bytes memory bobs = signed(bobKey, bob, calls, 0, 0);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(alice, calls, 0, 0, bobs);
        bytes memory alices = signed(aliceKey, alice, calls, 0, 0);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(bob, calls, 0, 0, alices);
        // Alice's key signing a digest for Bob's account (verifyingContract = bob) does not pass on Bob's either.
        bytes memory crossed = signed(aliceKey, bob, calls, 0, 0);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(bob, calls, 0, 0, crossed);
    }

    function test_signature_forAnotherChain_isRefused() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = sign(aliceKey, digestFor(1, alice, address(impl), calls, 0, deadline, relayer, 0));
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(alice, calls, 0, 0, sig);

        // And a batch signed here does not run once the chain id differs.
        bytes memory here = signed(aliceKey, alice, calls, 0, 0);
        vm.chainId(84532);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(alice, calls, 0, 0, here);
    }

    function test_signature_forAnotherImplementation_isRefusedBySalt() public {
        HanaDelegateExecutor other = new HanaDelegateExecutor();
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory forImpl = signed(aliceKey, alice, calls, 0, 0);
        bytes memory forOther =
            sign(aliceKey, digestFor(block.chainid, alice, address(other), calls, 0, deadline, relayer, 0));

        // Same name and version, different deployment: the salt (implementation address) tells them apart.
        delegate(aliceKey, address(other));
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(alice, calls, 0, 0, forImpl);
        submit(alice, calls, 0, 0, forOther);

        delegate(aliceKey, address(impl));
        bytes memory forOther1 =
            sign(aliceKey, digestFor(block.chainid, alice, address(other), calls, 1, deadline, relayer, 0));
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(alice, calls, 1, 0, forOther1);
        // The nonce lives in the account's storage under one namespace, so it carried over (1, not 0).
        assertEq(exec(alice).nonce(), 1);
    }

    function test_signature_tamperedFields_areRefused() public {
        HanaDelegateExecutor.Call[] memory calls = one(address(target), 1, abi.encodeCall(Target.record, (1)));
        bytes memory sig = signed(aliceKey, alice, calls, 0, 50_000);

        // Another minGas, deadline, value, data or target: all refused.
        vm.startPrank(relayer);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        exec(alice).execute(calls, 0, deadline, relayer, 0, sig);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        exec(alice).execute(calls, 0, deadline + 1, relayer, 50_000, sig);
        calls[0].value = 2;
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        exec(alice).execute(calls, 0, deadline, relayer, 50_000, sig);
        calls[0].value = 1;
        calls[0].data = abi.encodeCall(Target.record, (2));
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        exec(alice).execute(calls, 0, deadline, relayer, 50_000, sig);
        calls[0].data = abi.encodeCall(Target.record, (1));
        calls[0].to = address(checkIn);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        exec(alice).execute(calls, 0, deadline, relayer, 50_000, sig);
        calls[0].to = address(target);
        exec(alice).execute(calls, 0, deadline, relayer, 50_000, sig);
        vm.stopPrank();
        assertEq(target.lastArg(), 1);
    }

    function test_signature_highS_isRefused() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digestFor(alice, calls, 0, deadline, relayer, 0));
        // The malleated twin (N - s, other v) recovers to the same key, but high s is refused.
        bytes memory twin = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(alice, calls, 0, 0, twin);
    }

    function test_signature_compactAndBadLengths_areRefused() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digestFor(alice, calls, 0, deadline, relayer, 0));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        bytes[] memory bad = new bytes[](7);
        bad[0] = abi.encodePacked(r, vs); // ERC-2098 compact (64 bytes)
        bad[1] = "";
        bad[2] = abi.encodePacked(r, s); // 64 bytes, no v
        bad[3] = abi.encodePacked(r, s, v, uint8(0)); // 66 bytes
        bad[4] = abi.encodePacked(r, s, v, r, s, v); // 130 bytes
        bad[5] = abi.encodePacked(r, s, v - 27); // v 0/1
        bad[6] = abi.encodePacked(bytes32(0), bytes32(0), v); // r = s = 0
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
            submit(alice, calls, 0, 0, bad[i]);
        }
        assertEq(exec(alice).nonce(), 0);
    }

    function test_implementationItself_neverExecutes() public {
        // Called directly (no delegation), address(this) is the implementation, which no key controls.
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig =
            sign(aliceKey, digestFor(block.chainid, address(impl), address(impl), calls, 0, deadline, relayer, 0));
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        vm.prank(relayer);
        impl.execute(calls, 0, deadline, relayer, 0, sig);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Relayer and gas

    function test_relayer_onlyTheSignedOneMaySubmit() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.expectRevert(HanaDelegateExecutor.WrongRelayer.selector);
        vm.prank(bob);
        exec(alice).execute(calls, 0, deadline, relayer, 0, sig);
        // Naming another relayer than the signed one fails the signature instead.
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        vm.prank(bob);
        exec(alice).execute(calls, 0, deadline, bob, 0, sig);
    }

    function test_relayer_zeroAddressMatchesNoOne() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = sign(aliceKey, digestFor(alice, calls, 0, deadline, address(0), 0));
        vm.expectRevert(HanaDelegateExecutor.WrongRelayer.selector);
        vm.prank(relayer);
        exec(alice).execute(calls, 0, deadline, address(0), 0, sig);
    }

    function test_relayer_canBeTheAccountItself() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = sign(aliceKey, digestFor(alice, calls, 0, deadline, alice, 0));
        vm.prank(alice, alice);
        exec(alice).execute(calls, 0, deadline, alice, 0, sig);
        assertEq(checkIn.checkIns(alice), 1);
    }

    function test_underGassedSubmission_isRefusedAndKeepsTheNonce() public {
        HanaDelegateExecutor.Call[] memory calls = one(address(target), 0, abi.encodeCall(Target.needsGas, (400_000)));
        bytes memory sig = signed(aliceKey, alice, calls, 0, 450_000);
        vm.prank(relayer);
        vm.expectRevert(HanaDelegateExecutor.InsufficientGas.selector);
        exec(alice).execute{gas: 300_000}(calls, 0, deadline, relayer, 450_000, sig);
        assertEq(exec(alice).nonce(), 0, "nothing consumed: the batch can be submitted again");

        vm.prank(relayer);
        exec(alice).execute{gas: 600_000}(calls, 0, deadline, relayer, 450_000, sig);
        assertEq(target.calls(), 1);
    }

    /// Without the floor, a relayer could pick a gas limit that starves a gas-sensitive call; minGas is signed.
    function test_minGas_isSigned_soTheRelayerCannotLowerIt() public {
        HanaDelegateExecutor.Call[] memory calls = one(address(target), 0, abi.encodeCall(Target.needsGas, (400_000)));
        bytes memory sig = signed(aliceKey, alice, calls, 0, 450_000);
        vm.prank(relayer);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        exec(alice).execute{gas: 300_000}(calls, 0, deadline, relayer, 0, sig);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Call failures: wrapped with their index, the whole batch undone, revert data bounded, no spoofing

    function test_failingCall_revertsTheWholeBatchWithItsIndex() public {
        bytes memory reason = abi.encodeWithSignature("Error(string)", "nope");
        HanaDelegateExecutor.Call[] memory calls = two(
            HanaDelegateExecutor.Call(address(checkIn), 0, abi.encodeCall(CheckIn.checkIn, ())),
            HanaDelegateExecutor.Call(address(target), 0, abi.encodeCall(Target.failWith, (reason)))
        );
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.expectRevert(Errors.callFailed(1, reason));
        submit(alice, calls, 0, 0, sig);
        assertEq(checkIn.checkIns(alice), 0, "the first call is undone too");
        assertEq(exec(alice).nonce(), 0, "and the nonce");
    }

    function test_failingCall_cannotSpoofTheExecutorsErrors() public {
        bytes memory spoof = abi.encodeWithSelector(HanaDelegateExecutor.InvalidNonce.selector);
        HanaDelegateExecutor.Call[] memory calls = one(address(target), 0, abi.encodeCall(Target.failWith, (spoof)));
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.expectRevert(Errors.callFailed(0, spoof));
        submit(alice, calls, 0, 0, sig);
    }

    function test_returnBomb_onSuccess_isNotCopied() public {
        uint256 size = 600_000; // ~0.7M gas of memory for the target; copying it would cost the same again
        HanaDelegateExecutor.Call[] memory calls = one(address(target), 0, abi.encodeCall(Target.bomb, (size)));
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);

        // The contrast: a caller that copies the return data runs out of gas in this budget.
        NaiveCaller naive = new NaiveCaller();
        (bool naiveOk,) = address(naive).call{gas: 1_100_000}(
            abi.encodeCall(NaiveCaller.callAndCopy, (address(target), abi.encodeCall(Target.bomb, (size))))
        );
        assertFalse(naiveOk, "the budget is too small to copy the bomb");

        vm.prank(relayer);
        exec(alice).execute{gas: 1_100_000}(calls, 0, deadline, relayer, 0, sig);
        assertEq(exec(alice).nonce(), 1);
    }

    function test_returnBomb_onFailure_isCutTo1024Bytes() public {
        uint256 size = 600_000;
        HanaDelegateExecutor.Call[] memory calls = one(address(target), 0, abi.encodeCall(Target.revertBomb, (size)));
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.prank(relayer);
        (bool ok, bytes memory ret) = alice.call{gas: 1_100_000}(
            abi.encodeCall(HanaDelegateExecutor.execute, (calls, 0, deadline, relayer, 0, sig))
        );
        assertFalse(ok);
        assertEq(bytes4(ret), HanaDelegateExecutor.CallFailed.selector);
        bytes memory args = new bytes(ret.length - 4);
        for (uint256 i = 0; i < args.length; i++) {
            args[i] = ret[i + 4];
        }
        (uint256 index, bytes memory reason) = abi.decode(args, (uint256, bytes));
        assertEq(index, 0);
        assertEq(reason.length, 1024);
        assertEq(uint8(reason[0]), 0xab);
        assertEq(uint8(reason[1023]), 0xcd);
    }

    function test_emptyBatch_isRefused() public {
        HanaDelegateExecutor.Call[] memory calls = new HanaDelegateExecutor.Call[](0);
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.expectRevert(HanaDelegateExecutor.EmptyBatch.selector);
        submit(alice, calls, 0, 0, sig);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Reentrancy and self-calls

    function test_selfCall_incrementNonce_insideABatch() public {
        HanaDelegateExecutor.Call[] memory calls =
            one(alice, 0, abi.encodeCall(HanaDelegateExecutor.incrementNonce, ()));
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.expectEmit(false, false, false, true, alice);
        emit HanaDelegateExecutor.NonceIncremented(2);
        submit(alice, calls, 0, 0, sig);
        assertEq(exec(alice).nonce(), 2);
    }

    function test_selfCall_valueToItself_isANoOp() public {
        HanaDelegateExecutor.Call[] memory calls = one(alice, 1 ether, "");
        submit(alice, calls, 0, 0, signed(aliceKey, alice, calls, 0, 0));
        assertEq(alice.balance, 10 ether);
    }

    function test_selfCall_execute_isBlockedByTheGuard() public {
        // An inner batch, validly signed for nonce 1 with the account as its relayer, run from inside batch 0.
        HanaDelegateExecutor.Call[] memory inner = checkInCall();
        bytes memory innerSig = sign(aliceKey, digestFor(alice, inner, 1, deadline, alice, 0));
        HanaDelegateExecutor.Call[] memory outer =
            one(alice, 0, abi.encodeCall(HanaDelegateExecutor.execute, (inner, 1, deadline, alice, 0, innerSig)));
        bytes memory sig = signed(aliceKey, alice, outer, 0, 0);
        vm.expectRevert(Errors.callFailed(0, abi.encodeWithSelector(Errors.REENTRANT)));
        submit(alice, outer, 0, 0, sig);
        assertEq(exec(alice).nonce(), 0);
    }

    function test_reentryThroughAnotherContract_isBlocked() public {
        Reenterer r = new Reenterer();
        HanaDelegateExecutor.Call[] memory inner = checkInCall();
        bytes memory innerSig = sign(aliceKey, digestFor(alice, inner, 1, deadline, address(r), 0));
        r.setPayload(abi.encodeCall(HanaDelegateExecutor.execute, (inner, 1, deadline, address(r), 0, innerSig)));
        HanaDelegateExecutor.Call[] memory outer = one(address(r), 0, abi.encodeCall(Reenterer.poke, ()));
        bytes memory sig = signed(aliceKey, alice, outer, 0, 0);
        vm.expectRevert(Errors.callFailed(0, abi.encodeWithSelector(Errors.REENTRANT)));
        submit(alice, outer, 0, 0, sig);
        assertEq(checkIn.checkIns(alice), 0);
    }

    function test_guard_isClearAfterARevertedBatch_inTheSameTransaction() public {
        TwoSubmits twice = new TwoSubmits();
        bytes memory reason = abi.encodeWithSignature("Error(string)", "first fails");
        HanaDelegateExecutor.Call[] memory failing = one(address(target), 0, abi.encodeCall(Target.failWith, (reason)));
        HanaDelegateExecutor.Call[] memory passing = checkInCall();
        bool firstOk =
            twice.run(alice, executeData(failing, 0, address(twice)), executeData(passing, 0, address(twice)));
        assertFalse(firstOk);
        assertEq(checkIn.checkIns(alice), 1);
        assertEq(exec(alice).nonce(), 1);
    }

    function test_guard_isClearAfterASuccessfulBatch_inTheSameTransaction() public {
        TwoSubmits twice = new TwoSubmits();
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bool firstOk = twice.run(alice, executeData(calls, 0, address(twice)), executeData(calls, 1, address(twice)));
        assertTrue(firstOk);
        assertEq(checkIn.checkIns(alice), 2);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Receiving: native token, ERC-721, ERC-1155; what is not accepted

    function test_receive_nativeToken() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool ok,) = alice.call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(alice.balance, 11 ether);
    }

    function test_receive_erc721SafeTransfer_andSendItOnInABatch() public {
        Mock721 nft = new Mock721();
        nft.safeMint(alice, 1);
        assertEq(nft.ownerOf(1), alice);

        HanaDelegateExecutor.Call[] memory calls =
            one(address(nft), 0, abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", alice, bob, 1));
        submit(alice, calls, 0, 0, signed(aliceKey, alice, calls, 0, 0));
        assertEq(nft.ownerOf(1), bob, "bob's delegated account accepts it too");
    }

    function test_receive_erc1155SingleAndBatch() public {
        Mock1155 token = new Mock1155();
        token.mint(alice, 7, 3);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 10;
        amounts[1] = 20;
        token.mintBatch(alice, ids, amounts);
        assertEq(token.balanceOf(alice, 7), 3);
        assertEq(token.balanceOf(alice, 2), 20);
    }

    /// A plain EOA accepts any calldata; the delegated account answers only its own functions. A transfer that
    /// carries data, or an unknown callback, reverts (D845).
    function test_unknownCalldata_reverts() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool ok,) = alice.call{value: 1}(hex"12345678");
        assertFalse(ok);
        (ok,) = alice.call(abi.encodeWithSignature("onERC1363Received(address,address,uint256,bytes)", bob, bob, 1, ""));
        assertFalse(ok);
    }

    function test_supportsInterface() public view {
        assertTrue(exec(alice).supportsInterface(type(IERC165).interfaceId));
        assertTrue(exec(alice).supportsInterface(type(IERC721Receiver).interfaceId));
        assertTrue(exec(alice).supportsInterface(type(IERC1155Receiver).interfaceId));
        assertTrue(exec(alice).supportsInterface(type(IERC1271).interfaceId));
        assertFalse(exec(alice).supportsInterface(0xffffffff));
        assertFalse(exec(alice).supportsInterface(0x00000000));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // ERC-1271: exactly the EOA's ecrecover check, nothing more

    bytes4 internal constant MAGIC = 0x1626ba7e;

    function test_erc1271_acceptsTheAccountsOwnSignature() public view {
        bytes32 h = keccak256("any hash a protocol computed");
        assertEq(exec(alice).isValidSignature(h, sign(aliceKey, h)), MAGIC);
        assertTrue(SignatureChecker.isValidSignatureNow(alice, h, sign(aliceKey, h)));
    }

    function test_erc1271_refusesEverythingElse() public view {
        bytes32 h = keccak256("any hash a protocol computed");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, h);
        bytes4 no = 0xffffffff;
        assertEq(exec(alice).isValidSignature(h, sign(bobKey, h)), no, "another key");
        assertEq(exec(bob).isValidSignature(h, sign(aliceKey, h)), no, "another account");
        assertEq(exec(alice).isValidSignature(keccak256("other"), sign(aliceKey, h)), no, "another hash");
        assertEq(
            exec(alice)
                .isValidSignature(h, abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27))),
            no,
            "high s"
        );
        assertEq(
            exec(alice).isValidSignature(h, abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)))),
            no,
            "compact"
        );
        assertEq(exec(alice).isValidSignature(h, ""), no, "empty");
        assertEq(exec(alice).isValidSignature(h, abi.encodePacked(r, s, v, uint8(0))), no, "66 bytes");
        assertEq(impl.isValidSignature(h, sign(aliceKey, h)), no, "the implementation itself");
    }

    /// An Execute signature is over this contract's own digest (its domain: name, chain, account, implementation);
    /// a protocol checks a signature over its own digest, so the two can never be swapped.
    function test_erc1271_anExecuteSignatureIsUselessToAnotherProtocol() public {
        PermitLike permit = new PermitLike();
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory executeSig = signed(aliceKey, alice, calls, 0, 0);
        vm.expectRevert(bytes("bad signature"));
        permit.permit(alice, relayer, type(uint256).max, executeSig);

        // While the account's own permit signature works through ERC-1271, as it would for a plain EOA,
        // and is useless as an Execute signature.
        bytes memory permitSig = sign(aliceKey, permit.digest(relayer, 5, 0));
        permit.permit(alice, relayer, 5, permitSig);
        assertEq(permit.allowance(alice, relayer), 5);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(alice, calls, 0, 0, permitSig);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Delegation itself

    /// An account without the delegation runs nothing: a call to it succeeds and does nothing, with no Executed event.
    /// The relayer must check the delegation before sending and the Executed event after (D845).
    function test_undelegatedAccount_runsNothing() public {
        address carol;
        uint256 carolKey;
        (carol, carolKey) = makeAddrAndKey("carol");
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = sign(carolKey, digestFor(carol, calls, 0, deadline, relayer, 0));
        vm.recordLogs();
        vm.prank(relayer);
        (bool ok,) = carol.call(abi.encodeCall(HanaDelegateExecutor.execute, (calls, 0, deadline, relayer, 0, sig)));
        assertTrue(ok);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
        assertEq(checkIn.checkIns(carol), 0);
    }

    function test_revokedDelegation_stopsExecution() public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(aliceKey, alice, calls, 0, 0);
        vm.signAndAttachDelegation(address(0), aliceKey);
        (bool ok,) = alice.call("");
        assertTrue(ok);
        assertEq(alice.code.length, 0, "delegation removed");
        vm.prank(relayer);
        (ok,) = alice.call(abi.encodeCall(HanaDelegateExecutor.execute, (calls, 0, deadline, relayer, 0, sig)));
        assertTrue(ok);
        assertEq(checkIn.checkIns(alice), 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Fuzz

    function testFuzz_anyOtherKey_isRefused(uint256 key) public {
        key = bound(key, 1, N - 1);
        vm.assume(key != aliceKey);
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(key, alice, calls, 0, 0);
        vm.expectRevert(HanaDelegateExecutor.InvalidSignature.selector);
        submit(alice, calls, 0, 0, sig);
    }

    function testFuzz_anySignatureBytes_neverRun(bytes memory sig) public {
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        vm.prank(relayer);
        (bool ok,) = alice.call(abi.encodeCall(HanaDelegateExecutor.execute, (calls, 0, deadline, relayer, 0, sig)));
        assertFalse(ok);
        assertEq(exec(alice).nonce(), 0);
    }

    function testFuzz_wrongNonce_isRefused(uint256 nonce) public {
        vm.assume(nonce != 0);
        HanaDelegateExecutor.Call[] memory calls = checkInCall();
        bytes memory sig = signed(aliceKey, alice, calls, nonce, 0);
        vm.expectRevert(HanaDelegateExecutor.InvalidNonce.selector);
        submit(alice, calls, nonce, 0, sig);
    }

    function testFuzz_anyBatch_runsWithTheDigestTheEncoderComputes(
        uint96 value,
        uint256 arg,
        uint256 minGas,
        uint32 ttl
    ) public {
        value = uint96(bound(value, 0, 10 ether));
        minGas = bound(minGas, 0, 1_000_000);
        deadline = block.timestamp + ttl;
        HanaDelegateExecutor.Call[] memory calls = two(
            HanaDelegateExecutor.Call(address(target), value, abi.encodeCall(Target.record, (arg))),
            HanaDelegateExecutor.Call(address(checkIn), 0, abi.encodeCall(CheckIn.checkIn, ()))
        );
        bytes32 digest = digestFor(alice, calls, 0, deadline, relayer, minGas);
        vm.expectEmit(true, false, false, true, alice);
        emit HanaDelegateExecutor.Executed(digest, 0, 2);
        vm.prank(relayer);
        exec(alice).execute{gas: minGas + 300_000}(calls, 0, deadline, relayer, minGas, sign(aliceKey, digest));
        assertEq(target.lastArg(), arg);
        assertEq(target.lastValue(), value);
    }

    function testFuzz_nonceOnlyIncreases(uint8 steps, uint256 seed) public {
        steps = uint8(bound(steps, 1, 24));
        uint256 last = exec(alice).nonce();
        for (uint256 i = 0; i < steps; i++) {
            uint256 action = uint256(keccak256(abi.encode(seed, i))) % 3;
            uint256 n = exec(alice).nonce();
            HanaDelegateExecutor.Call[] memory calls = checkInCall();
            if (action == 0) {
                submit(alice, calls, n, 0, signed(aliceKey, alice, calls, n, 0));
            } else if (action == 1) {
                vm.prank(alice, alice);
                exec(alice).incrementNonce();
            } else if (n > 0) {
                bytes memory old = signed(aliceKey, alice, calls, n - 1, 0);
                vm.prank(relayer);
                (bool ok,) =
                    alice.call(abi.encodeCall(HanaDelegateExecutor.execute, (calls, n - 1, deadline, relayer, 0, old)));
                assertFalse(ok, "an old nonce never runs again");
            }
            uint256 now_ = exec(alice).nonce();
            assertGe(now_, last);
            last = now_;
        }
    }
}
