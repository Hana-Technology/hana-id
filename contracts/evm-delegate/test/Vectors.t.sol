// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {HanaDelegateExecutor} from "../src/HanaDelegateExecutor.sol";
import {CheckIn} from "../src/demo/CheckIn.sol";
import {Base} from "./utils/Base.sol";

/// test/vectors/execute-v1.json: a byte-for-byte copy of the TypeScript signer's vector
/// (packages/core/test/vectors/evm-sponsor-v1.json, generated there with viem; the core file is the source). The
/// contract's type strings, domain and selector are the vector's; this test's encoder agrees with every case's hashes,
/// signature and calldata; and each case's calldata runs from the vector's relayer against the real contract.
contract VectorsTest is Base {
    string internal constant VECTOR = "test/vectors/execute-v1.json";
    string internal constant CORE_VECTOR = "../../packages/core/test/vectors/evm-sponsor-v1.json";
    bytes32 internal constant NONCE_SLOT = 0xe526c94a37a61336af23ffe6f077f900033f135d7cb97e988e0cd22f1bf8ed00;

    struct Case {
        uint256 chainId;
        address account;
        address implementation;
        HanaDelegateExecutor.Call[] calls;
        uint256 total;
        uint256 nonce;
        uint256 deadline;
        address relayer;
        uint256 minGas;
    }

    function setUp() public override {}

    function p(string memory c, string memory key) internal pure returns (string memory) {
        return string.concat(c, key);
    }

    function cases(string memory j) internal view returns (uint256 n) {
        while (vm.keyExistsJson(j, string.concat(".cases[", vm.toString(n), "]"))) n++;
    }

    /// If the contract's interface differs from the vector's `contract` block in any way, this fails first.
    function test_vector_contractBlockIsThisContract() public view {
        string memory j = vm.readFile(VECTOR);
        assertEq(vm.parseJsonString(j, ".contract.name"), "HanaDelegateExecutor");
        assertEq(vm.parseJsonString(j, ".contract.version"), "1");
        assertEq(vm.parseJsonBytes32(j, ".contract.domainTypeHash"), DOMAIN_TYPEHASH);
        assertEq(keccak256(bytes(vm.parseJsonString(j, ".contract.domainType"))), DOMAIN_TYPEHASH);
        assertEq(vm.parseJsonBytes32(j, ".contract.executeTypeHash"), EXECUTE_TYPEHASH);
        assertEq(keccak256(bytes(vm.parseJsonString(j, ".contract.executeType"))), EXECUTE_TYPEHASH);
        assertEq(vm.parseJsonBytes32(j, ".contract.callTypeHash"), CALL_TYPEHASH);
        string memory fn = vm.parseJsonString(j, ".contract.function");
        assertEq(fn, "execute((address,uint256,bytes)[],uint256,uint256,address,uint256,bytes)");
        assertEq(bytes4(keccak256(bytes(fn))), HanaDelegateExecutor.execute.selector);
        assertEq(bytes4(vm.parseJsonBytes(j, ".contract.selector")), HanaDelegateExecutor.execute.selector);
        assertEq(HanaDelegateExecutor.execute.selector, bytes4(0x440dfe2d));
        assertGe(cases(j), 3);
    }

    /// The copy is the core file exactly (the core file is the source: `pnpm run generate` copies it here).
    function test_vector_isTheCoreFile() public view {
        assertTrue(vm.exists(CORE_VECTOR), "packages/core/test/vectors/evm-sponsor-v1.json is missing");
        assertEq(keccak256(bytes(vm.readFile(VECTOR))), keccak256(bytes(vm.readFile(CORE_VECTOR))), "copy differs");
    }

    function load(string memory j, string memory c) internal view returns (Case memory v) {
        v.chainId = vm.parseJsonUint(j, p(c, ".inputs.chainId"));
        v.account = vm.parseJsonAddress(j, p(c, ".inputs.account"));
        v.implementation = vm.parseJsonAddress(j, p(c, ".inputs.implementation"));
        uint256 n = 0;
        while (vm.keyExistsJson(j, string.concat(c, ".inputs.calls[", vm.toString(n), "]"))) n++;
        v.calls = new HanaDelegateExecutor.Call[](n);
        for (uint256 k = 0; k < n; k++) {
            string memory ck = string.concat(c, ".inputs.calls[", vm.toString(k), "]");
            v.calls[k] = HanaDelegateExecutor.Call(
                vm.parseJsonAddress(j, p(ck, ".to")),
                vm.parseJsonUint(j, p(ck, ".value")),
                vm.parseJsonBytes(j, p(ck, ".data"))
            );
            v.total += v.calls[k].value;
        }
        v.nonce = vm.parseJsonUint(j, p(c, ".inputs.nonce"));
        v.deadline = vm.parseJsonUint(j, p(c, ".inputs.deadline"));
        v.relayer = vm.parseJsonAddress(j, p(c, ".inputs.relayer"));
        v.minGas = vm.parseJsonUint(j, p(c, ".inputs.minGas"));
    }

    function runCase(uint256 i) internal {
        string memory j = vm.readFile(VECTOR);
        string memory c = string.concat(".cases[", vm.toString(i), "]");
        Case memory v = load(j, c);
        uint256 key = uint256(keccak256(bytes(vm.parseJsonString(j, ".accountKeySeed"))));
        assertEq(vm.addr(key), v.account, "account key");
        assertEq(vm.addr(uint256(keccak256(bytes(vm.parseJsonString(j, ".relayerKeySeed"))))), v.relayer, "relayer key");

        // The hashes, the deterministic (RFC 6979) signature and the calldata.
        assertEq(
            domainSeparator(v.chainId, v.account, v.implementation), vm.parseJsonBytes32(j, p(c, ".domainSeparator"))
        );
        bytes32 structHash =
            keccak256(abi.encode(EXECUTE_TYPEHASH, callsHash(v.calls), v.nonce, v.deadline, v.relayer, v.minGas));
        assertEq(structHash, vm.parseJsonBytes32(j, p(c, ".structHash")), "structHash");
        bytes32 digest =
            digestFor(v.chainId, v.account, v.implementation, v.calls, v.nonce, v.deadline, v.relayer, v.minGas);
        assertEq(digest, vm.parseJsonBytes32(j, p(c, ".digest")), "digest");
        bytes memory sig = vm.parseJsonBytes(j, p(c, ".signature"));
        assertEq(sign(key, digest), sig, "signature");
        bytes memory data = vm.parseJsonBytes(j, p(c, ".calldata"));
        assertEq(
            abi.encodeCall(HanaDelegateExecutor.execute, (v.calls, v.nonce, v.deadline, v.relayer, v.minGas, sig)), data
        );
        assertEq(bytes4(data), bytes4(0x440dfe2d), "selector");

        // The contract accepts it. The implementation is deployed at the vector's address with its constructor run
        // there (so the immutable salt is that address), a CheckIn wherever a call is checkIn(); other targets stay
        // empty accounts, which accept any call.
        vm.chainId(v.chainId);
        deployCodeTo("HanaDelegateExecutor.sol:HanaDelegateExecutor", v.implementation);
        for (uint256 k = 0; k < v.calls.length; k++) {
            if (keccak256(v.calls[k].data) == keccak256(abi.encodeCall(CheckIn.checkIn, ()))) {
                deployCodeTo("CheckIn.sol:CheckIn", v.calls[k].to);
            }
        }
        delegate(key, v.implementation);
        vm.store(v.account, NONCE_SLOT, bytes32(v.nonce));
        vm.deal(v.account, v.total);
        vm.warp(v.deadline);
        vm.recordLogs();
        vm.prank(v.relayer);
        (bool ok,) = v.account.call{gas: v.minGas + 200_000}(data);
        assertTrue(ok, "execute");
        assertEq(HanaDelegateExecutor(payable(v.account)).nonce(), v.nonce + 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory last = logs[logs.length - 1];
        assertEq(last.emitter, v.account);
        assertEq(last.topics[0], HanaDelegateExecutor.Executed.selector);
        assertEq(last.topics[1], digest, "Executed carries the vector's digest");
        for (uint256 k = 0; k < v.calls.length; k++) {
            if (v.calls[k].value > 0) assertEq(v.calls[k].to.balance, v.calls[k].value, "value delivered");
        }
    }

    function test_vector_case0() public {
        runCase(0);
    }

    function test_vector_case1() public {
        runCase(1);
    }

    function test_vector_case2() public {
        runCase(2);
    }

    function test_vector_hasExactlyThreeCases() public view {
        assertEq(cases(vm.readFile(VECTOR)), 3, "a new case needs its own test_vector_caseN");
    }
}
