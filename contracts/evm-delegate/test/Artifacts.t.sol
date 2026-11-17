// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {HanaDelegateExecutor} from "../src/HanaDelegateExecutor.sol";
import {Create2} from "./utils/Create2.sol";

/// The checked-in artifacts (artifacts/*.json) match this build, and a real CREATE2 deployment through the
/// deterministic deployment proxy lands at the address they predict with the runtime code hash they pin. A failure
/// here means the artifacts are stale: run `pnpm run generate` in this package and commit the result
/// (and call out the new address: D841). `forge test --mc ArtifactsTest -vv` prints the addresses.
contract ArtifactsTest is Test {
    function checkArtifact(string memory name, string memory artifactPath, bytes32 salt)
        internal
        returns (address deployed)
    {
        string memory j = vm.readFile(string.concat("artifacts/", name, ".json"));
        bytes memory creation = vm.parseJsonBytes(j, ".bytecode");
        bytes memory runtime = vm.parseJsonBytes(j, ".deployedBytecode");
        assertEq(creation, vm.getCode(artifactPath), "stale creation bytecode");
        assertEq(runtime, vm.getDeployedCode(artifactPath), "stale runtime bytecode");
        assertEq(vm.parseJsonAddress(j, ".create2.deployer"), Create2.DEPLOYER);
        assertEq(vm.parseJsonBytes32(j, ".create2.salt"), salt, "salt");
        assertEq(vm.parseJsonBytes32(j, ".create2.initCodeHash"), keccak256(creation));

        address predicted = vm.computeCreate2Address(salt, keccak256(creation), Create2.DEPLOYER);
        assertEq(vm.parseJsonAddress(j, ".create2.address"), predicted, "predicted address");
        deployed = Create2.deploy(salt, creation);
        assertEq(deployed, predicted, "deployed address");
        assertEq(deployed.codehash, vm.parseJsonBytes32(j, ".runtimeCodeHash"), "runtime code hash");

        // The deployed code is the artifact's runtime bytecode with each immutable filled in, and nothing else.
        bytes memory onChain = deployed.code;
        assertEq(onChain.length, runtime.length);
        for (uint256 r = 0; vm.keyExistsJson(j, string.concat(".immutableReferences[", vm.toString(r), "]")); r++) {
            uint256 start = vm.parseJsonUint(j, string.concat(".immutableReferences[", vm.toString(r), "].start"));
            for (uint256 k = 0; k < 32; k++) {
                runtime[start + k] = onChain[start + k];
            }
            bytes32 word;
            assembly ("memory-safe") {
                word := mload(add(add(onChain, 0x20), start))
            }
            assertEq(word, bytes32(uint256(uint160(deployed))), "the immutable is the implementation's own address");
        }
        assertEq(onChain, runtime);

        console.log(name, "CREATE2 address", deployed);
        console.log(name, "runtime code hash", vm.toString(deployed.codehash));
    }

    function test_executorArtifact_isCurrent_andPredictsTheDeployment() public {
        address deployed = checkArtifact(
            "HanaDelegateExecutor", "HanaDelegateExecutor.sol:HanaDelegateExecutor", Create2.EXECUTOR_SALT
        );
        string memory j = vm.readFile("artifacts/HanaDelegateExecutor.json");
        (,,,,, bytes32 salt,) = HanaDelegateExecutor(payable(deployed)).eip712Domain();
        assertEq(vm.parseJsonBytes32(j, ".eip712.salt"), salt);
        assertEq(vm.parseJsonString(j, ".eip712.name"), "HanaDelegateExecutor");
        assertEq(vm.parseJsonString(j, ".eip712.version"), "1");
        assertEq(vm.parseJsonUint(j, ".compiler.optimizer.runs"), 10_000);
        assertEq(vm.parseJsonString(j, ".compiler.evmVersion"), "prague");
        assertEq(vm.parseJsonString(j, ".compiler.version"), "0.8.28+commit.7893614a");
    }

    function test_checkInArtifact_isCurrent_andPredictsTheDeployment() public {
        checkArtifact("CheckIn", "CheckIn.sol:CheckIn", Create2.CHECK_IN_SALT);
    }
}
