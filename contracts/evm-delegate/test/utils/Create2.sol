// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// The deterministic deployment proxy (Arachnid's): `salt ‖ initCode` in, the new contract's 20-byte address out.
library Create2 {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// Its runtime code, as deployed on Base Sepolia, Ethereum and most EVM chains.
    bytes internal constant DEPLOYER_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    bytes32 internal constant EXECUTOR_SALT = keccak256("hana-id/evm-delegate/HanaDelegateExecutor/v1");
    bytes32 internal constant CHECK_IN_SALT = keccak256("hana-id/evm-delegate/CheckIn/v1");

    /// Puts the proxy in place if the test chain lacks it, and checks that it is the canonical code.
    function ensureDeployer() internal {
        if (DEPLOYER.code.length == 0) vm.etch(DEPLOYER, DEPLOYER_CODE);
        require(keccak256(DEPLOYER.code) == keccak256(DEPLOYER_CODE), "unexpected code at the deployment proxy");
    }

    function deploy(bytes32 salt, bytes memory initCode) internal returns (address deployed) {
        ensureDeployer();
        (bool ok, bytes memory ret) = DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && ret.length == 20, "CREATE2 deployment failed");
        deployed = address(bytes20(ret));
    }
}
