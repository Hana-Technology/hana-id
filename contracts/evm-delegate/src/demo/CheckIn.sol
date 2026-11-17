// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title CheckIn
 * @notice Demo target for sponsored transactions: anyone can check in, as often as they like, and the contract counts
 *         check-ins per caller. Holds no funds (nothing is payable) and has no owner. Under a sponsored batch the caller
 *         (`msg.sender`) is the user's account, not the relayer that paid the gas.
 */
contract CheckIn {
    /// @notice How many times each account has checked in.
    mapping(address account => uint256 count) public checkIns;

    /// @notice `account` checked in; `count` is its total so far, this one included.
    event CheckedIn(address indexed account, uint256 count);

    /// @notice Records a check-in by the caller.
    function checkIn() external {
        uint256 count = checkIns[msg.sender] + 1;
        checkIns[msg.sender] = count;
        emit CheckedIn(msg.sender, count);
    }
}
