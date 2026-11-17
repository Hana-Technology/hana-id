// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HanaDelegateExecutor} from "../../src/HanaDelegateExecutor.sol";

/// Shared set-up: an implementation, accounts with real EIP-7702 delegations to it, and an EIP-712 encoder written
/// out here independently of the contract (and checked against Foundry's own typed-data hasher in the tests).
abstract contract Base is Test {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)");
    bytes32 internal constant CALL_TYPEHASH = keccak256("Call(address to,uint256 value,bytes data)");
    bytes32 internal constant EXECUTE_TYPEHASH = keccak256(
        "Execute(Call[] calls,uint256 nonce,uint256 deadline,address relayer,uint256 minGas)Call(address to,uint256 value,bytes data)"
    );
    /// secp256k1 group order.
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    HanaDelegateExecutor internal impl;
    address internal alice;
    uint256 internal aliceKey;
    address internal bob;
    uint256 internal bobKey;
    address internal relayer;
    uint256 internal deadline;

    function setUp() public virtual {
        impl = new HanaDelegateExecutor();
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        relayer = makeAddr("relayer");
        vm.warp(1_800_000_000);
        deadline = block.timestamp + 600;
        delegate(aliceKey, address(impl));
        delegate(bobKey, address(impl));
    }

    /// Signs an EIP-7702 authorization for `implementation` with `key` and has it applied by a transaction (a plain
    /// call from this test, which Foundry sends as a type-4 transaction carrying the authorization).
    function delegate(uint256 key, address implementation) internal {
        vm.signAndAttachDelegation(implementation, key);
        (bool ok,) = vm.addr(key).call("");
        require(ok, "delegation call failed");
        assertEq(vm.addr(key).code, abi.encodePacked(hex"ef0100", implementation), "delegation designator");
    }

    function exec(address account) internal pure returns (HanaDelegateExecutor) {
        return HanaDelegateExecutor(payable(account));
    }

    function one(address to, uint256 value, bytes memory data)
        internal
        pure
        returns (HanaDelegateExecutor.Call[] memory c)
    {
        c = new HanaDelegateExecutor.Call[](1);
        c[0] = HanaDelegateExecutor.Call(to, value, data);
    }

    function two(HanaDelegateExecutor.Call memory a, HanaDelegateExecutor.Call memory b)
        internal
        pure
        returns (HanaDelegateExecutor.Call[] memory c)
    {
        c = new HanaDelegateExecutor.Call[](2);
        c[0] = a;
        c[1] = b;
    }

    function domainSeparator(uint256 chainId, address account, address implementation) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("HanaDelegateExecutor"),
                keccak256("1"),
                chainId,
                account,
                bytes32(uint256(uint160(implementation)))
            )
        );
    }

    function callsHash(HanaDelegateExecutor.Call[] memory calls) internal pure returns (bytes32) {
        bytes memory packed;
        for (uint256 i = 0; i < calls.length; i++) {
            packed = bytes.concat(
                packed, keccak256(abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data)))
            );
        }
        return keccak256(packed);
    }

    function digestFor(
        uint256 chainId,
        address account,
        address implementation,
        HanaDelegateExecutor.Call[] memory calls,
        uint256 nonce,
        uint256 deadline_,
        address relayer_,
        uint256 minGas
    ) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(EXECUTE_TYPEHASH, callsHash(calls), nonce, deadline_, relayer_, minGas)
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(chainId, account, implementation), structHash));
    }

    /// The digest for `account` delegated to `impl` on this chain.
    function digestFor(
        address account,
        HanaDelegateExecutor.Call[] memory calls,
        uint256 nonce,
        uint256 deadline_,
        address relayer_,
        uint256 minGas
    ) internal view returns (bytes32) {
        return digestFor(block.chainid, account, address(impl), calls, nonce, deadline_, relayer_, minGas);
    }

    function sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Signs the batch for `account` with `key`, everything else default (this chain, `impl`, `relayer`, `deadline`).
    function signed(
        uint256 key,
        address account,
        HanaDelegateExecutor.Call[] memory calls,
        uint256 nonce,
        uint256 minGas
    ) internal view returns (bytes memory) {
        return sign(key, digestFor(account, calls, nonce, deadline, relayer, minGas));
    }

    /// Submits as the relayer.
    function submit(
        address account,
        HanaDelegateExecutor.Call[] memory calls,
        uint256 nonce,
        uint256 minGas,
        bytes memory sig
    ) internal {
        vm.prank(relayer);
        exec(account).execute(calls, nonce, deadline, relayer, minGas, sig);
    }
}
