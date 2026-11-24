// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PonteRouteDecisionEvidenceRegistry} from "../src/PonteRouteDecisionEvidenceRegistry.sol";

interface Vm {
    function chainId(uint256 newChainId) external;

    function prank(address msgSender) external;

    function expectRevert(bytes4 revertData) external;

    function expectRevert(bytes calldata revertData) external;

    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData) external;

    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;

    function store(address target, bytes32 slot, bytes32 value) external;
}

/// @dev Dependency-free Foundry tests. The Vm interface targets Foundry's documented cheatcode address.
contract PonteRouteDecisionEvidenceRegistryTest {
    error AssertionFailed();

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ADMIN = address(0xA11CE);
    address private constant ATTESTOR = address(0xA771E570);
    address private constant OUTSIDER = address(0xB0B);
    address private constant SECOND_ATTESTOR = address(0xCAFE);
    address private constant NEXT_ADMIN = address(0xD00D);
    address private constant OTHER_ADMIN = address(0xD00E);

    bytes32 private constant EVIDENCE_A = keccak256("PONTE_EVIDENCE_A");
    bytes32 private constant EVIDENCE_B = keccak256("PONTE_EVIDENCE_B");
    bytes32 private constant PAYLOAD_A1 = keccak256("PONTE_PAYLOAD_A1");
    bytes32 private constant PAYLOAD_A2 = keccak256("PONTE_PAYLOAD_A2");
    bytes32 private constant PAYLOAD_B1 = keccak256("PONTE_PAYLOAD_B1");
    bytes32 private constant OTHER_HASH = keccak256("PONTE_OTHER_HASH");

    PonteRouteDecisionEvidenceRegistry private registry;

    event EvidenceAnchored(
        bytes32 indexed evidenceId,
        bytes32 indexed payloadHash,
        address indexed attestor,
        uint64 sequence,
        PonteRouteDecisionEvidenceRegistry.EvidenceKind kind,
        bytes32 previousPayloadHash
    );

    event AttestorSet(address indexed attestor, bool allowed);

    event AdminTransferProposed(address indexed currentAdmin, address indexed proposedAdmin);

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    function setUp() public {
        vm.chainId(421614);
        registry = new PonteRouteDecisionEvidenceRegistry(ADMIN, ATTESTOR);
    }

    // Constructor and network restriction

    function testConstructsOnArbitrumSepolia() public view {
        _assertEq(registry.admin(), ADMIN);
        _assertEq(registry.pendingAdmin(), address(0));
        _assertTrue(registry.isAttestor(ATTESTOR));
    }

    function testRejectsUnsupportedChain() public {
        vm.chainId(31337);
        vm.expectRevert(
            abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.UnsupportedChain.selector, uint256(31337))
        );
        new PonteRouteDecisionEvidenceRegistry(ADMIN, ATTESTOR);
    }

    function testRejectsZeroAdmin() public {
        vm.expectRevert(PonteRouteDecisionEvidenceRegistry.ZeroAddress.selector);
        new PonteRouteDecisionEvidenceRegistry(address(0), ATTESTOR);
    }

    function testRejectsZeroAttestor() public {
        vm.expectRevert(PonteRouteDecisionEvidenceRegistry.ZeroAddress.selector);
        new PonteRouteDecisionEvidenceRegistry(ADMIN, address(0));
    }

    function testRejectsIdenticalInitialRoles() public {
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.RoleOverlap.selector, ADMIN));
        new PonteRouteDecisionEvidenceRegistry(ADMIN, ADMIN);
    }

    function testConstructorSetsRolesAndEmitsEvents() public {
        vm.expectEmit(true, true, false, false);
        emit AdminTransferred(address(0), OTHER_ADMIN);
        vm.expectEmit(true, false, false, true);
        emit AttestorSet(SECOND_ATTESTOR, true);

        PonteRouteDecisionEvidenceRegistry fresh = new PonteRouteDecisionEvidenceRegistry(OTHER_ADMIN, SECOND_ATTESTOR);

        _assertEq(fresh.admin(), OTHER_ADMIN);
        _assertEq(fresh.pendingAdmin(), address(0));
        _assertTrue(fresh.isAttestor(SECOND_ATTESTOR));
        _assertFalse(fresh.isAttestor(OTHER_ADMIN));
    }

    // Role separation and handover

    function testAdminCanGrantAndRevokeAttestor() public {
        vm.prank(ADMIN);
        vm.expectEmit(true, false, false, true, address(registry));
        emit AttestorSet(SECOND_ATTESTOR, true);
        registry.setAttestor(SECOND_ATTESTOR, true);
        _assertTrue(registry.isAttestor(SECOND_ATTESTOR));

        vm.prank(ADMIN);
        vm.expectEmit(true, false, false, true, address(registry));
        emit AttestorSet(SECOND_ATTESTOR, false);
        registry.setAttestor(SECOND_ATTESTOR, false);
        _assertFalse(registry.isAttestor(SECOND_ATTESTOR));
    }

    function testNonAdminCannotChangeAttestors() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.Unauthorized.selector, OUTSIDER));
        registry.setAttestor(SECOND_ATTESTOR, true);
    }

    function testAdminCannotBecomeAttestor() public {
        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.RoleOverlap.selector, ADMIN));
        registry.setAttestor(ADMIN, true);
    }

    function testPendingAdminCannotBecomeAttestor() public {
        _proposeNextAdmin();

        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.RoleOverlap.selector, NEXT_ADMIN));
        registry.setAttestor(NEXT_ADMIN, true);
    }

    function testExistingAttestorCannotBeProposedAsAdmin() public {
        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.RoleOverlap.selector, ATTESTOR));
        registry.proposeAdmin(ATTESTOR);
    }

    function testRoleOperationsRejectZeroAddress() public {
        vm.prank(ADMIN);
        vm.expectRevert(PonteRouteDecisionEvidenceRegistry.ZeroAddress.selector);
        registry.setAttestor(address(0), true);

        vm.prank(ADMIN);
        vm.expectRevert(PonteRouteDecisionEvidenceRegistry.ZeroAddress.selector);
        registry.proposeAdmin(address(0));
    }

    function testAdminCannotProposeItself() public {
        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.AlreadyAdmin.selector, ADMIN));
        registry.proposeAdmin(ADMIN);
    }

    function testProposedAdminHasNoAuthorityBeforeAcceptance() public {
        _proposeNextAdmin();

        vm.prank(NEXT_ADMIN);
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.Unauthorized.selector, NEXT_ADMIN));
        registry.setAttestor(SECOND_ATTESTOR, true);

        _assertEq(registry.admin(), ADMIN);
        _assertEq(registry.pendingAdmin(), NEXT_ADMIN);
    }

    function testOnlyProposedAdminCanAccept() public {
        _proposeNextAdmin();

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.NotPendingAdmin.selector, OUTSIDER));
        registry.acceptAdmin();
    }

    function testAcceptWithoutProposalReverts() public {
        vm.prank(NEXT_ADMIN);
        vm.expectRevert(PonteRouteDecisionEvidenceRegistry.NoPendingAdmin.selector);
        registry.acceptAdmin();
    }

    function testAdminHandoverEmitsEventAndClearsPendingAdmin() public {
        _proposeNextAdmin();

        vm.prank(NEXT_ADMIN);
        vm.expectEmit(true, true, false, false, address(registry));
        emit AdminTransferred(ADMIN, NEXT_ADMIN);
        registry.acceptAdmin();

        _assertEq(registry.admin(), NEXT_ADMIN);
        _assertEq(registry.pendingAdmin(), address(0));
    }

    function testPreviousAdminLosesAuthorityAfterHandover() public {
        _acceptNextAdmin();

        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.Unauthorized.selector, ADMIN));
        registry.setAttestor(SECOND_ATTESTOR, true);
    }

    function testNewAdminDoesNotGainAttestorStatusAndCanManageAttestors() public {
        _acceptNextAdmin();

        _assertFalse(registry.isAttestor(NEXT_ADMIN));

        vm.prank(NEXT_ADMIN);
        registry.setAttestor(SECOND_ATTESTOR, true);
        _assertTrue(registry.isAttestor(SECOND_ATTESTOR));
    }

    // Evidence anchoring

    function testAuthorizedAttestorAnchorsAndEmitsExactEvent() public {
        vm.prank(ATTESTOR);
        vm.expectEmit(true, true, true, true, address(registry));
        emit EvidenceAnchored(
            EVIDENCE_A,
            PAYLOAD_A1,
            ATTESTOR,
            1,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            bytes32(0)
        );
        registry.anchor(
            EVIDENCE_A,
            1,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            bytes32(0),
            PAYLOAD_A1
        );

        PonteRouteDecisionEvidenceRegistry.EvidenceHead memory head = registry.evidenceHead(EVIDENCE_A);
        _assertEq(head.latestSequence, 1);
        _assertEq(head.latestPayloadHash, PAYLOAD_A1);
    }

    function testUnauthorisedCallerCannotAnchor() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.Unauthorized.selector, OUTSIDER));
        registry.anchor(
            EVIDENCE_A,
            1,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            bytes32(0),
            PAYLOAD_A1
        );
    }

    function testRevokedAttestorCannotAnchor() public {
        vm.prank(ADMIN);
        registry.setAttestor(ATTESTOR, false);

        vm.prank(ATTESTOR);
        vm.expectRevert(abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.Unauthorized.selector, ATTESTOR));
        registry.anchor(
            EVIDENCE_A,
            1,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            bytes32(0),
            PAYLOAD_A1
        );
    }

    function testRejectsZeroEvidenceId() public {
        vm.prank(ATTESTOR);
        vm.expectRevert(PonteRouteDecisionEvidenceRegistry.ZeroEvidenceId.selector);
        registry.anchor(
            bytes32(0),
            1,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            bytes32(0),
            PAYLOAD_A1
        );
    }

    function testRejectsZeroPayloadHash() public {
        vm.prank(ATTESTOR);
        vm.expectRevert(PonteRouteDecisionEvidenceRegistry.ZeroPayloadHash.selector);
        registry.anchor(
            EVIDENCE_A,
            1,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            bytes32(0),
            bytes32(0)
        );
    }

    function testRejectsUnsupportedEvidenceKind() public {
        vm.prank(ATTESTOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                PonteRouteDecisionEvidenceRegistry.InvalidEvidenceKind.selector,
                uint8(PonteRouteDecisionEvidenceRegistry.EvidenceKind.None)
            )
        );
        registry.anchor(EVIDENCE_A, 1, PonteRouteDecisionEvidenceRegistry.EvidenceKind.None, bytes32(0), PAYLOAD_A1);
    }

    function testRejectsIncorrectGenesisSequence() public {
        vm.prank(ATTESTOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                PonteRouteDecisionEvidenceRegistry.InvalidSequence.selector, EVIDENCE_A, uint64(1), uint64(2)
            )
        );
        registry.anchor(
            EVIDENCE_A,
            2,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            bytes32(0),
            PAYLOAD_A1
        );
    }

    function testRejectsIncorrectPredecessorHash() public {
        vm.prank(ATTESTOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                PonteRouteDecisionEvidenceRegistry.PreviousHashMismatch.selector, EVIDENCE_A, bytes32(0), OTHER_HASH
            )
        );
        registry.anchor(
            EVIDENCE_A,
            1,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            OTHER_HASH,
            PAYLOAD_A1
        );
    }

    function testRejectsRepeatedSequenceAfterGenesis() public {
        _anchorGenesis(EVIDENCE_A, PAYLOAD_A1);

        vm.prank(ATTESTOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                PonteRouteDecisionEvidenceRegistry.InvalidSequence.selector, EVIDENCE_A, uint64(2), uint64(1)
            )
        );
        registry.anchor(
            EVIDENCE_A,
            1,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            PAYLOAD_A1,
            PAYLOAD_A2
        );
    }

    function testAnchorsValidSequentialRecordAndUpdatesHead() public {
        _anchorGenesis(EVIDENCE_A, PAYLOAD_A1);

        vm.prank(ATTESTOR);
        registry.anchor(
            EVIDENCE_A,
            2,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            PAYLOAD_A1,
            PAYLOAD_A2
        );

        PonteRouteDecisionEvidenceRegistry.EvidenceHead memory head = registry.evidenceHead(EVIDENCE_A);
        _assertEq(head.latestSequence, 2);
        _assertEq(head.latestPayloadHash, PAYLOAD_A2);
    }

    function testSeparateEvidenceIdsMaintainSeparateHeads() public {
        _anchorGenesis(EVIDENCE_A, PAYLOAD_A1);
        _anchorGenesis(EVIDENCE_B, PAYLOAD_B1);

        PonteRouteDecisionEvidenceRegistry.EvidenceHead memory first = registry.evidenceHead(EVIDENCE_A);
        PonteRouteDecisionEvidenceRegistry.EvidenceHead memory second = registry.evidenceHead(EVIDENCE_B);

        _assertEq(first.latestSequence, 1);
        _assertEq(first.latestPayloadHash, PAYLOAD_A1);
        _assertEq(second.latestSequence, 1);
        _assertEq(second.latestPayloadHash, PAYLOAD_B1);
    }

    function testEvidenceHeadPersistsAcrossRoleChanges() public {
        _anchorGenesis(EVIDENCE_A, PAYLOAD_A1);

        vm.prank(ADMIN);
        registry.setAttestor(ATTESTOR, false);
        _acceptNextAdmin();

        PonteRouteDecisionEvidenceRegistry.EvidenceHead memory head = registry.evidenceHead(EVIDENCE_A);
        _assertEq(head.latestSequence, 1);
        _assertEq(head.latestPayloadHash, PAYLOAD_A1);
    }

    function testRejectsSequenceOverflow() public {
        // Storage declaration order fixes _evidenceHeads at slot 3. A mapping value
        // starts at keccak256(abi.encode(key, slot)); latestSequence occupies its first slot.
        bytes32 headSlot = keccak256(abi.encode(EVIDENCE_A, uint256(3)));
        vm.store(address(registry), headSlot, bytes32(uint256(type(uint64).max)));

        vm.prank(ATTESTOR);
        vm.expectRevert(
            abi.encodeWithSelector(PonteRouteDecisionEvidenceRegistry.SequenceExhausted.selector, EVIDENCE_A)
        );
        registry.anchor(
            EVIDENCE_A,
            type(uint64).max,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            bytes32(0),
            PAYLOAD_A1
        );
    }

    function _proposeNextAdmin() private {
        vm.prank(ADMIN);
        vm.expectEmit(true, true, false, false, address(registry));
        emit AdminTransferProposed(ADMIN, NEXT_ADMIN);
        registry.proposeAdmin(NEXT_ADMIN);
    }

    function _acceptNextAdmin() private {
        _proposeNextAdmin();
        vm.prank(NEXT_ADMIN);
        registry.acceptAdmin();
    }

    function _anchorGenesis(bytes32 evidenceId, bytes32 payloadHash) private {
        vm.prank(ATTESTOR);
        registry.anchor(
            evidenceId,
            1,
            PonteRouteDecisionEvidenceRegistry.EvidenceKind.SimulatedRouteDecision,
            bytes32(0),
            payloadHash
        );
    }

    function _assertTrue(bool condition) private pure {
        if (!condition) {
            revert AssertionFailed();
        }
    }

    function _assertFalse(bool condition) private pure {
        _assertTrue(!condition);
    }

    function _assertEq(address actual, address expected) private pure {
        if (actual != expected) {
            revert AssertionFailed();
        }
    }

    function _assertEq(bytes32 actual, bytes32 expected) private pure {
        if (actual != expected) {
            revert AssertionFailed();
        }
    }

    function _assertEq(uint64 actual, uint64 expected) private pure {
        if (actual != expected) {
            revert AssertionFailed();
        }
    }
}
