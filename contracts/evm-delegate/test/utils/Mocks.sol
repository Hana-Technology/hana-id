// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {HanaDelegateExecutor} from "../../src/HanaDelegateExecutor.sol";

/// Records who called it, with what value and argument; can revert or return on demand.
contract Target {
    address public lastSender;
    uint256 public lastValue;
    uint256 public lastArg;
    uint256 public calls;

    function record(uint256 arg) external payable {
        lastSender = msg.sender;
        lastValue = msg.value;
        lastArg = arg;
        calls++;
    }

    /// Reverts with exactly `reason` as revert data (any bytes, a spoofed selector included).
    function failWith(bytes calldata reason) external pure {
        assembly ("memory-safe") {
            let p := mload(0x40)
            calldatacopy(p, reason.offset, reason.length)
            revert(p, reason.length)
        }
    }

    /// Returns `size` bytes (first byte 0xab, the rest zero): a return bomb when `size` is large. Only the memory
    /// expansion is paid for, which is what a copy by the caller would cost again.
    function bomb(uint256 size) external pure {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore8(p, 0xab)
            return(p, size)
        }
    }

    /// Reverts with `size` bytes (at least 1024): byte 0 is 0xab, byte 1023 is 0xcd, the rest zero.
    function revertBomb(uint256 size) external pure {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore8(p, 0xab)
            mstore8(add(p, 1023), 0xcd)
            revert(p, size)
        }
    }

    uint256 public takes;
    bytes32 public lastTaken;

    /// Takes any bytes (the fuzzed batches' data).
    function take(bytes calldata data) external {
        takes++;
        lastTaken = keccak256(data);
    }

    /// Succeeds only with at least `needed` gas left, the way a target with a gas-sensitive branch behaves.
    function needsGas(uint256 needed) external {
        require(gasleft() >= needed, "starved");
        calls++;
    }
}

/// Records the gas it was given (the first thing it does), to check the floor the executor guarantees.
contract GasProbe {
    uint256 public seen;

    function probe() external {
        uint256 g = gasleft();
        seen = g;
    }
}

/// Burns about 100 gas per iteration.
contract Burner {
    function burn(uint256 iterations) external pure returns (uint256 acc) {
        for (uint256 i = 0; i < iterations; i++) {
            acc = uint256(keccak256(abi.encode(acc, i)));
        }
    }
}

/// A target that swallows an inner out-of-gas: with too little gas it still succeeds, degraded. This is the target
/// a signed gas floor (minGas) protects against a relayer that chooses the gas limit.
contract Swallower {
    Burner public immutable burner = new Burner();
    bool public full;

    /// The cheap path a degraded run takes (an event, no storage), so it can finish on the 1/64 left to it.
    event Degraded();

    function work(uint256 iterations) external {
        try burner.burn(iterations) {
            full = true;
        } catch {
            emit Degraded();
        }
    }
}

/// Calls back into the account it was called from, with whatever calldata it is given (a reentrancy attempt).
contract Reenterer {
    bytes public payload;

    function setPayload(bytes calldata p) external {
        payload = p;
    }

    function poke() external {
        (bool ok, bytes memory ret) = msg.sender.call(payload);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

/// A relayer contract that submits two batches in one transaction: the first is expected to revert, the second to
/// succeed. Shows that the reentrancy guard does not stay set after a reverted batch.
contract TwoSubmits {
    function run(address account, bytes calldata failing, bytes calldata passing) external returns (bool firstOk) {
        (firstOk,) = account.call(failing);
        (bool ok, bytes memory ret) = account.call(passing);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

/// Copies the callee's return data the way a plain Solidity `call` does: the contrast for the return-bomb test.
contract NaiveCaller {
    function callAndCopy(address to, bytes calldata data) external returns (uint256) {
        (bool ok, bytes memory ret) = to.call(data);
        require(ok, "call failed");
        return ret.length;
    }
}

contract Mock721 is ERC721("Mock", "M721") {
    function safeMint(address to, uint256 id) external {
        _safeMint(to, id);
    }
}

contract Mock1155 is ERC1155("") {
    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts) external {
        _mintBatch(to, ids, amounts, "");
    }
}

/// A protocol that accepts a signature over its own EIP-712 digest, checked the way Permit2 and OpenZeppelin's
/// SignatureChecker do: ecrecover for an address without code, ERC-1271 for one with code.
contract PermitLike {
    bytes32 public constant DOMAIN_SEPARATOR = keccak256(
        abi.encode(
            keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
            keccak256("PermitLike"),
            uint256(1),
            address(0x000000000022D473030F116dDEE9F6B43aC78BA3)
        )
    );
    bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address spender,uint256 amount,uint256 nonce)");

    mapping(address owner => uint256) public nonces;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    function digest(address spender, uint256 amount, uint256 nonce) public pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                hex"1901", DOMAIN_SEPARATOR, keccak256(abi.encode(PERMIT_TYPEHASH, spender, amount, nonce))
            )
        );
    }

    function permit(address owner, address spender, uint256 amount, bytes calldata signature) external {
        bytes32 h = digest(spender, amount, nonces[owner]);
        require(SignatureChecker.isValidSignatureNow(owner, h, signature), "bad signature");
        nonces[owner]++;
        allowance[owner][spender] = amount;
    }
}

/// Exposes the executor's error selectors for the tests.
library Errors {
    bytes4 internal constant REENTRANT = bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    function callFailed(uint256 index, bytes memory reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(HanaDelegateExecutor.CallFailed.selector, index, reason);
    }
}
