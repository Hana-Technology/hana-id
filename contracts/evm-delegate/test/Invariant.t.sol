// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HanaDelegateExecutor} from "../src/HanaDelegateExecutor.sol";
import {CheckIn} from "../src/demo/CheckIn.sol";
import {Base} from "./utils/Base.sol";

/// Random sequences of valid batches, replays, stale and future nonces, foreign signatures and self-increments
/// against one delegated account. The fuzzer calls only this handler.
contract NonceHandler is Test {
    HanaDelegateExecutor internal immutable account;
    address internal immutable implementation;
    uint256 internal immutable key;
    uint256 internal immutable otherKey;
    address internal immutable relayer;
    CheckIn internal immutable checkIn;

    /// What the nonce must be: every successful batch and increment adds one, nothing else changes it.
    uint256 public expected;
    uint256 public lastSeen;
    bool public decreased;
    uint256 public runs;
    uint256 public refused;

    constructor(address account_, address implementation_, uint256 key_, uint256 otherKey_, address relayer_) {
        account = HanaDelegateExecutor(payable(account_));
        implementation = implementation_;
        key = key_;
        otherKey = otherKey_;
        relayer = relayer_;
        checkIn = new CheckIn();
    }

    function _calls() internal view returns (HanaDelegateExecutor.Call[] memory c) {
        c = new HanaDelegateExecutor.Call[](1);
        c[0] = HanaDelegateExecutor.Call(address(checkIn), 0, abi.encodeCall(CheckIn.checkIn, ()));
    }

    function _digest(HanaDelegateExecutor.Call[] memory calls, uint256 nonce) internal view returns (bytes32) {
        bytes32 callHash = keccak256(
            abi.encode(
                keccak256("Call(address to,uint256 value,bytes data)"),
                calls[0].to,
                calls[0].value,
                keccak256(calls[0].data)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Execute(Call[] calls,uint256 nonce,uint256 deadline,address relayer,uint256 minGas)Call(address to,uint256 value,bytes data)"
                ),
                keccak256(abi.encodePacked(callHash)),
                nonce,
                block.timestamp,
                relayer,
                uint256(0)
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"
                ),
                keccak256("HanaDelegateExecutor"),
                keccak256("1"),
                block.chainid,
                address(account),
                bytes32(uint256(uint160(implementation)))
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }

    function _submit(uint256 signer, uint256 nonce) internal returns (bool ok) {
        HanaDelegateExecutor.Call[] memory calls = _calls();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signer, _digest(calls, nonce));
        vm.prank(relayer);
        (ok,) = address(account)
            .call(
                abi.encodeCall(
                    HanaDelegateExecutor.execute, (calls, nonce, block.timestamp, relayer, 0, abi.encodePacked(r, s, v))
                )
            );
    }

    function _observe() internal {
        uint256 n = account.nonce();
        if (n < lastSeen) decreased = true;
        lastSeen = n;
    }

    function executeValid() external {
        require(_submit(key, account.nonce()), "a valid batch must run");
        expected++;
        runs++;
        _observe();
    }

    function replayOld(uint256 back) external {
        uint256 n = account.nonce();
        if (n == 0) return;
        require(!_submit(key, n - 1 - bound(back, 0, n - 1)), "a used nonce must not run again");
        refused++;
        _observe();
    }

    function executeFuture(uint256 ahead) external {
        require(!_submit(key, account.nonce() + bound(ahead, 1, type(uint128).max)), "a future nonce must not run");
        refused++;
        _observe();
    }

    function executeForeign() external {
        require(!_submit(otherKey, account.nonce()), "another key must not run");
        refused++;
        _observe();
    }

    function incrementSelf() external {
        vm.prank(address(account), address(account));
        account.incrementNonce();
        expected++;
        _observe();
    }

    function incrementByOther(address caller) external {
        vm.assume(caller != address(account));
        vm.prank(caller);
        (bool ok,) = address(account).call(abi.encodeCall(HanaDelegateExecutor.incrementNonce, ()));
        require(!ok, "only the account may increment");
        _observe();
    }

    function warp(uint32 by) external {
        vm.warp(block.timestamp + by);
    }
}

contract NonceInvariantTest is Base {
    NonceHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new NonceHandler(alice, address(impl), aliceKey, bobKey, relayer);
        targetContract(address(handler));
    }

    function invariant_nonceOnlyIncreases() public view {
        assertFalse(handler.decreased());
        assertGe(exec(alice).nonce(), handler.lastSeen());
    }

    function invariant_nonceCountsExactlyTheAcceptedActions() public view {
        assertEq(exec(alice).nonce(), handler.expected());
    }
}
