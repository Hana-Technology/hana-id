// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {LowLevelCall} from "@openzeppelin/contracts/utils/LowLevelCall.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/**
 * @title HanaDelegateExecutor
 * @notice EIP-7702 delegate for sponsored transactions. A user's account (an EOA) delegates to this code; a relayer
 *         then submits a batch of calls the account's key signed (EIP-712), paying the gas, and the calls run from the
 *         account: `msg.sender` at each target is the account, and any value comes from the account's balance.
 *
 *         The code runs in the account's context, so `address(this)` is the account and the only accepted signer is
 *         the account's own key. The signature binds the batch to the account (`verifyingContract`), the chain
 *         (`chainId`), this implementation (`salt`), one relayer (`relayer`, which must be `msg.sender`) and a floor on
 *         the gas left for the calls (`minGas`). A sequential nonce in the account's storage (ERC-7201 namespace
 *         `hana.storage.DelegateExecutor`) makes every signed batch usable once, and a deadline bounds when.
 *
 *         No owner, no initializer, no upgrade path, no storage besides the nonce. The account's key keeps full
 *         control: it can still send its own transactions, re-delegate or remove the delegation at any time.
 *
 *         Design and security notes: docs/decisions.md D841 and D845.
 */
contract HanaDelegateExecutor is ReentrancyGuardTransient, ERC721Holder, ERC1155Holder, IERC1271 {
    /// @notice One call of a batch: `to` is called from the account with `value` wei and `data` as calldata.
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    /// @custom:storage-location erc7201:hana.storage.DelegateExecutor
    struct NonceStorage {
        uint256 nonce;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("hana.storage.DelegateExecutor")) - 1)) & ~bytes32(uint256(0xff)).
    ///      Never change it: the nonce of every account that delegated here lives in this slot.
    bytes32 private constant NONCE_STORAGE = 0xe526c94a37a61336af23ffe6f077f900033f135d7cb97e988e0cd22f1bf8ed00;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)");
    bytes32 private constant NAME_HASH = keccak256("HanaDelegateExecutor");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant CALL_TYPEHASH = keccak256("Call(address to,uint256 value,bytes data)");
    bytes32 private constant EXECUTE_TYPEHASH = keccak256(
        "Execute(Call[] calls,uint256 nonce,uint256 deadline,address relayer,uint256 minGas)Call(address to,uint256 value,bytes data)"
    );

    /// @dev At most this many bytes of a failed call's revert data are copied into `CallFailed`, so a target that
    ///      reverts with a huge buffer cannot make the copy run out of gas.
    uint256 private constant MAX_REASON_BYTES = 1024;

    /// @dev This contract's own address, fixed at deployment. It is the EIP-712 domain's `salt`, so a signature for
    ///      this implementation is refused by any other one, even with the same name and version.
    address private immutable IMPLEMENTATION = address(this);

    /// @notice A signed batch ran: `digest` is the EIP-712 digest the account signed, `nonce` the nonce it used.
    event Executed(bytes32 indexed digest, uint256 nonce, uint256 callCount);

    /// @notice The account skipped a nonce (`incrementNonce`): batches signed for lower nonces can no longer run.
    event NonceIncremented(uint256 newNonce);

    /// @notice `block.timestamp` is past the signed deadline.
    error Expired();
    /// @notice The nonce is not the account's current one (already used, or not reached yet).
    error InvalidNonce();
    /// @notice The signature is malformed (not 65 bytes, high s, bad v) or not by the account's key over this batch.
    error InvalidSignature();
    /// @notice The batch has no calls.
    error EmptyBatch();
    /// @notice `incrementNonce` was called by someone other than the account itself.
    error OnlyEOA();
    /// @notice `msg.sender` is not the signed relayer.
    error WrongRelayer();
    /// @notice Less gas than the signed `minGas` was left for the calls.
    error InsufficientGas();
    /// @notice Call `index` of the batch reverted; `reason` is the first 1024 bytes of its revert data. The whole
    ///         batch is undone, the nonce included.
    error CallFailed(uint256 index, bytes reason);

    /// @notice Accepts plain native-token transfers to the account.
    receive() external payable {}

    /**
     * @notice Runs a batch the account signed, from the account.
     * @dev Checks, in order: a non-empty batch, the deadline, the relayer, the nonce, the signature; then consumes the
     *      nonce, checks the gas left against `minGas` and makes the calls one after another. Any failing call reverts
     *      the whole batch with `CallFailed(index, reason)`, so a target's revert data can never pass for one of this
     *      contract's own errors. A successful call's return data is never copied.
     * @param calls The calls, in order; at least one.
     * @param nonce_ The account's current nonce (`nonce()`).
     * @param deadline The last `block.timestamp` at which the batch may run.
     * @param relayer The only address allowed to submit the batch (`msg.sender`); the zero address matches no one.
     * @param minGas The least gas that must be left, after the checks, for the calls.
     * @param signature The account key's 65-byte signature (r, s, v; low s) over the EIP-712 digest of the batch.
     */
    function execute(
        Call[] calldata calls,
        uint256 nonce_,
        uint256 deadline,
        address relayer,
        uint256 minGas,
        bytes calldata signature
    ) external nonReentrant {
        if (calls.length == 0) revert EmptyBatch();
        if (block.timestamp > deadline) revert Expired();
        if (msg.sender != relayer) revert WrongRelayer();
        NonceStorage storage $ = _nonceStorage();
        if (nonce_ != $.nonce) revert InvalidNonce();

        bytes32 digest = _hashTypedData(
            keccak256(abi.encode(EXECUTE_TYPEHASH, _hashCalls(calls), nonce_, deadline, relayer, minGas))
        );
        if (!_signedByThisAccount(digest, signature)) revert InvalidSignature();

        $.nonce = nonce_ + 1;
        if (gasleft() < minGas) revert InsufficientGas();

        for (uint256 i = 0; i < calls.length; ++i) {
            Call calldata c = calls[i];
            if (!LowLevelCall.callNoReturn(c.to, c.value, c.data)) revert CallFailed(i, _revertReason());
        }
        emit Executed(digest, nonce_, calls.length);
    }

    /// @notice The account's current nonce: the one its next signed batch must use.
    function nonce() external view returns (uint256) {
        return _nonceStorage().nonce;
    }

    /// @notice Skips the current nonce, so a batch signed for it can no longer run. Only the account itself can call
    ///         it: its own transaction to itself, or a call to itself inside a signed batch.
    function incrementNonce() external {
        if (msg.sender != address(this)) revert OnlyEOA();
        NonceStorage storage $ = _nonceStorage();
        uint256 next = $.nonce + 1;
        $.nonce = next;
        emit NonceIncremented(next);
    }

    /**
     * @notice ERC-1271: whether `signature` is the account key's signature over `hash`. True exactly when ECDSA
     *         recovery gives the account's address, from a 65-byte (r, s, v) or a 64-byte ERC-2098 compact (r, vs)
     *         signature, low s in both: the check a protocol makes for a plain EOA (Permit2 takes both forms from an
     *         address without code, and asks here once the address has code). Nothing more is accepted. `execute`
     *         itself takes only the 65-byte form.
     * @return The ERC-1271 magic value `0x1626ba7e` if valid, else `0xffffffff`.
     */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        bool valid;
        if (signature.length == 64) {
            (address signer, ECDSA.RecoverError err,) =
                ECDSA.tryRecover(hash, bytes32(signature[0:32]), bytes32(signature[32:64]));
            valid = err == ECDSA.RecoverError.NoError && signer == address(this);
        } else {
            valid = _signedByThisAccount(hash, signature);
        }
        return valid ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    /**
     * @notice ERC-5267: the EIP-712 domain a batch for this account is signed under. `fields` 0x1f: name, version,
     *         chainId, verifyingContract (the account) and salt (this implementation's address, left-padded).
     */
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (
            hex"1f",
            "HanaDelegateExecutor",
            "1",
            block.chainid,
            address(this),
            bytes32(uint256(uint160(IMPLEMENTATION))),
            new uint256[](0)
        );
    }

    /// @notice ERC-165: ERC-165 itself, the ERC-721 and ERC-1155 receivers and ERC-1271.
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IERC721Receiver).interfaceId || interfaceId == type(IERC1271).interfaceId
            || super.supportsInterface(interfaceId);
    }

    function _nonceStorage() private pure returns (NonceStorage storage $) {
        assembly ("memory-safe") {
            $.slot := NONCE_STORAGE
        }
    }

    /// @dev True when `signature` is a well-formed (65 bytes, low s, v 27 or 28) ECDSA signature over `hash` by the
    ///      key whose address is this account's. Never true on the implementation itself (no key has its address).
    function _signedByThisAccount(bytes32 hash, bytes calldata signature) private view returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        return err == ECDSA.RecoverError.NoError && signer == address(this);
    }

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                NAME_HASH,
                VERSION_HASH,
                block.chainid,
                address(this),
                bytes32(uint256(uint160(IMPLEMENTATION)))
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    /// @dev EIP-712 `hashStruct` of a `Call[]`: keccak256 of the concatenated `Call` struct hashes.
    function _hashCalls(Call[] calldata calls) private pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; ++i) {
            hashes[i] = keccak256(abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data)));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @dev The last call's revert data, cut to MAX_REASON_BYTES.
    function _revertReason() private pure returns (bytes memory reason) {
        uint256 size = LowLevelCall.returnDataSize();
        if (size > MAX_REASON_BYTES) size = MAX_REASON_BYTES;
        assembly ("memory-safe") {
            reason := mload(0x40)
            mstore(reason, size)
            returndatacopy(add(reason, 0x20), 0, size)
            mstore(0x40, add(reason, and(add(size, 0x3f), not(0x1f))))
        }
    }
}
