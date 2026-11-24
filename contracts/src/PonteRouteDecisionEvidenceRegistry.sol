// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Ponte Route-Decision Evidence Registry
/// @notice Append-only attestations for simulated PONTE route-decision commitments.
/// @dev This contract neither handles assets nor verifies quote calculation inputs.
contract PonteRouteDecisionEvidenceRegistry {
    enum EvidenceKind {
        None,
        SimulatedRouteDecision
    }

    struct EvidenceHead {
        uint64 latestSequence;
        bytes32 latestPayloadHash;
    }

    error UnsupportedChain(uint256 actualChainId);
    error ZeroAddress();
    error Unauthorized(address caller);
    error RoleOverlap(address account);
    error AlreadyAdmin(address account);
    error InvalidEvidenceKind(uint8 kind);
    error ZeroEvidenceId();
    error ZeroPayloadHash();
    error InvalidSequence(bytes32 evidenceId, uint64 expected, uint64 actual);
    error PreviousHashMismatch(bytes32 evidenceId, bytes32 expected, bytes32 actual);
    error SequenceExhausted(bytes32 evidenceId);
    error NoPendingAdmin();
    error NotPendingAdmin(address caller);

    event EvidenceAnchored(
        bytes32 indexed evidenceId,
        bytes32 indexed payloadHash,
        address indexed attestor,
        uint64 sequence,
        EvidenceKind kind,
        bytes32 previousPayloadHash
    );

    event AttestorSet(address indexed attestor, bool allowed);

    event AdminTransferProposed(address indexed currentAdmin, address indexed proposedAdmin);

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    address public admin;
    address public pendingAdmin;

    mapping(address => bool) public isAttestor;
    mapping(bytes32 => EvidenceHead) private _evidenceHeads;

    constructor(address initialAdmin, address initialAttestor) {
        if (block.chainid != 421614) {
            revert UnsupportedChain(block.chainid);
        }
        if (initialAdmin == address(0) || initialAttestor == address(0)) {
            revert ZeroAddress();
        }
        if (initialAdmin == initialAttestor) {
            revert RoleOverlap(initialAdmin);
        }

        admin = initialAdmin;
        isAttestor[initialAttestor] = true;

        emit AdminTransferred(address(0), initialAdmin);
        emit AttestorSet(initialAttestor, true);
    }

    /// @notice Returns the latest append-only head for an opaque evidence ID.
    function evidenceHead(bytes32 evidenceId) external view returns (EvidenceHead memory) {
        return _evidenceHeads[evidenceId];
    }

    /// @notice Appends an attestor-authored simulated route-decision commitment.
    function anchor(
        bytes32 evidenceId,
        uint64 sequence,
        EvidenceKind kind,
        bytes32 previousPayloadHash,
        bytes32 payloadHash
    ) external {
        if (!isAttestor[msg.sender]) {
            revert Unauthorized(msg.sender);
        }
        if (evidenceId == bytes32(0)) {
            revert ZeroEvidenceId();
        }
        if (payloadHash == bytes32(0)) {
            revert ZeroPayloadHash();
        }
        if (kind != EvidenceKind.SimulatedRouteDecision) {
            revert InvalidEvidenceKind(uint8(kind));
        }

        EvidenceHead storage head = _evidenceHeads[evidenceId];
        if (head.latestSequence == type(uint64).max) {
            revert SequenceExhausted(evidenceId);
        }

        uint64 expectedSequence = head.latestSequence + 1;
        if (sequence != expectedSequence) {
            revert InvalidSequence(evidenceId, expectedSequence, sequence);
        }
        if (previousPayloadHash != head.latestPayloadHash) {
            revert PreviousHashMismatch(evidenceId, head.latestPayloadHash, previousPayloadHash);
        }

        head.latestSequence = sequence;
        head.latestPayloadHash = payloadHash;

        emit EvidenceAnchored(evidenceId, payloadHash, msg.sender, sequence, kind, previousPayloadHash);
    }

    /// @notice Adds or revokes an attestor without allowing administrator overlap.
    function setAttestor(address account, bool allowed) external {
        _requireAdmin();
        if (account == address(0)) {
            revert ZeroAddress();
        }
        if (account == admin || account == pendingAdmin) {
            revert RoleOverlap(account);
        }

        isAttestor[account] = allowed;
        emit AttestorSet(account, allowed);
    }

    /// @notice Starts a two-step administrator handover to a non-attestor.
    function proposeAdmin(address candidate) external {
        _requireAdmin();
        if (candidate == address(0)) {
            revert ZeroAddress();
        }
        if (candidate == admin) {
            revert AlreadyAdmin(candidate);
        }
        if (isAttestor[candidate]) {
            revert RoleOverlap(candidate);
        }

        pendingAdmin = candidate;
        emit AdminTransferProposed(admin, candidate);
    }

    /// @notice Completes a proposed handover without granting attestor authority.
    function acceptAdmin() external {
        address candidate = pendingAdmin;
        if (candidate == address(0)) {
            revert NoPendingAdmin();
        }
        if (msg.sender != candidate) {
            revert NotPendingAdmin(msg.sender);
        }
        if (isAttestor[msg.sender]) {
            revert RoleOverlap(msg.sender);
        }

        address previousAdmin = admin;
        admin = msg.sender;
        pendingAdmin = address(0);

        emit AdminTransferred(previousAdmin, msg.sender);
    }

    function _requireAdmin() private view {
        if (msg.sender != admin) {
            revert Unauthorized(msg.sender);
        }
    }
}
