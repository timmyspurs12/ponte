# PONTE Phase 0.1 — Route-Decision Evidence Registry Specification

**Status:** Frozen implementation specification. This document is authoritative for the Route-Decision Evidence Registry until a later, explicitly approved version replaces it.

**Scope:** Specification only. It does not implement, deploy, activate, or transact with a contract.

**Target network:** Arbitrum Sepolia (`chainId = 421614`)

**Evidence kind:** `SIMULATED_ROUTE_DECISION` (`uint8(1)`)

---

## 1. Product boundary and evidence meaning

PONTE currently demonstrates an explicitly simulated invoice and payment lifecycle:

```text
Draft → Pending payment → Funded → Routing → Settled / Failed
```

The current payment and settlement operations are simulations. PONTE has no connected live Pix provider, no real USDG transfer, no actual liquidity market, and no real payment execution or supplier settlement.

The proposed registry records an authorized, append-only onchain commitment to a **simulated route decision**. It does **not** prove that:

- BRL was received or Pix payment cleared;
- an invoice was paid;
- a supplier received funds;
- USDG exists, was issued, or transferred;
- a route had liquidity or was executed in a real market;
- a real payment or settlement happened;
- the Rust code, Stylus wrapper, or the registry calculated the route; or
- the backend's simulated route calculation is independently correct.

The PostgreSQL database remains the application authority for the simulated payment lifecycle. The onchain record is an attestor-authored claim about a versioned offchain simulation, not a replacement state machine or a financial settlement primitive.

The attestor is backend-controlled. Therefore, a matching event proves that an authorized attestor anchored the stated commitment; it does not independently prove the truth or correctness of its undisclosed or disclosed application inputs.

---

## 2. Existing PONTE data model and the corrected persisted-quote mapping

### 2.1 Existing model facts

The relevant application types are intentionally simulation-only:

- `Invoice.fundingCurrency` is exactly `"BRL"`.
- `Invoice.fundingMinor` is the BRL funding amount in minor units.
- `Payment.currency` is exactly `"BRL"`.
- `PaymentQuote.asset` is exactly `"USDG"`.
- `PaymentQuote.demoAssetDecimals` is exactly `2`.
- `PaymentQuote.fundingMinor`, `rate`, `executionCostMinor`, `simulated`, and `routes` are quote-data properties.
- Each `RouteCandidate` provides `id`, `feeBps`, `feeMinor`, `outputMinor`, `slippageBps`, `toleranceBps`, and `minimumOutputMinor`.

The two-decimal USDG output representation is a demo/display convention. It is not a statement about a real asset, an onchain token, token metadata, or real token decimals.

### 2.2 Persisted quote row versus quote JSON

`PaymentQuote` does **not** have a `source` property. The evidence generator must not read or validate `quote.source`.

The `quotes` table persists metadata separately from its JSON payload:

| Persisted `quotes` row field | Meaning |
|---|---|
| `source` | Source metadata; current schema constrains it to `simulation-fixed-525` |
| `simulated` | Persisted simulation marker |
| `expires_at` | Persisted quote expiry timestamp |
| `data` | JSON quote payload containing `PaymentQuote` data |

Relevant fields inside the row's `data` JSON are:

| Quote-data field | Meaning |
|---|---|
| `simulated` | Quote-data simulation marker |
| `asset` | `USDG` demo output label |
| `demoAssetDecimals` | Demo output decimal scale, `2` |
| `fundingMinor` | BRL funding minor-unit amount represented by the quote |
| `rate` | Current fixed simulation rate numerator and denominator |
| `executionCostMinor` | Current fixed demo execution cost field |
| `routes` | Canonically committed route candidates |

The current row insertion stores `source = 'simulation-fixed-525'`, `simulated = true`, the quote JSON in `data`, and an independently persisted `expires_at` value. The current routing lookup reads a valid row with `expires_at > clock_timestamp()`.

### 2.3 Required generator validation and data sources

When a future evidence generator is called after a route has been locked, it must load the persisted quote row and use:

- row `source` for source metadata;
- row `simulated` for persisted simulation status;
- row `expires_at` for expiry; and
- row `data` for the `PaymentQuote` properties.

It must reject creation unless all of the following hold:

```text
invoice.fundingCurrency == "BRL"
invoice.fundingMinor == quoteRow.data.fundingMinor
quoteRow.source == "simulation-fixed-525"
quoteRow.simulated == true
quoteRow.data.simulated == true
quoteRow.data.asset == "USDG"
quoteRow.data.demoAssetDecimals == 2
```

The persisted `expires_at` value is authoritative. The generator converts that timestamp to its exact UTC Unix-millisecond value for the commitment; it must not mint, substitute, or round to a replacement expiry timestamp. If a persisted timestamp cannot be represented or round-tripped at millisecond precision, evidence generation must fail rather than silently changing the committed value.

---

## 3. Quote calculation: fixed simulated arithmetic

This section records the existing TypeScript simulation fixture. It does not describe a market, token conversion, settlement engine, or executable route.

All arithmetic is integer arithmetic with floor/truncation semantics:

```text
gross output   = (funding * 100) / 525
net output     = (funding * 100 * (10000 - feeBps)) / (525 * 10000)
fee            = gross - net output
minimum output = net output * 9950 / 10000
```

The frozen route parameters are:

| Route | Route code | Fee | Slippage | Tolerance |
|---|---:|---:|---:|---:|
| `direct` | 1 | 35 bps | 5 bps | 50 bps |
| `split` | 2 | 48 bps | 8 bps | 50 bps |
| `multi` | 3 | 65 bps | 12 bps | 50 bps |

Other fixed quote values:

| Field | Value |
|---|---:|
| `rate.numerator` | `525` |
| `rate.denominator` | `100` |
| `executionCostMinor` | `2` |
| Quote source | `simulation-fixed-525` |
| Funding currency | `BRL`, 2 decimals |
| Demo output label | `USDG`, 2 demo decimals |

The selected-route output is not reduced by `executionCostMinor` in the existing calculation. This specification preserves that arithmetic rather than inventing a new interpretation of the demo field.

---

## 4. Cryptographic commitment format

### 4.1 Primitive, encoding, and identifier rules

- Hash function: Ethereum legacy `keccak256`.
- Encoding: Solidity `abi.encode(...)` of static, fixed-width values only.
- No JSON serialization participates in any hash.
- `bytes32` inputs are exact 32-byte values.
- Unsigned integers are ABI-encoded as 32-byte big-endian words.
- `address` is the standard ABI left-padded 20-byte address word.
- Boolean `true` is the standard ABI word value `1`.
- Literal-domain strings are their exact UTF-8/ASCII bytes, with no newline or NUL terminator, before hashing.

`evidenceId` and `salt` are independently generated, nonzero, CSPRNG-produced `bytes32` values. An evidence ID must be unique in the evidence store. A private salt must never enter calldata, events, browser payloads, logs, or public documentation.

### 4.2 Domains and label hashes

| Constant | Exact input | `keccak256` result |
|---|---|---|
| `ROUTE_DOMAIN` | `PONTE_SIMULATED_ROUTE_V1` | `0xfc0c08e07f015619f760ffd85ef8f672e611ba6e80af7148cf14f8b5058db94d` |
| `ROUTES_DOMAIN` | `PONTE_SIMULATED_ROUTES_V1` | `0xc7f109716592d2a66ecf48b3fa7705a566b35e83cc67b77dc3644bf479304fdf` |
| `QUOTE_DOMAIN` | `PONTE_SIMULATED_QUOTE_SNAPSHOT_V1` | `0x263723f595ee5d8bf1972157c8b23eae390b79ed6db3c7b6906a2761c7df081c` |
| `PAYLOAD_DOMAIN` | `PONTE_ROUTE_DECISION_EVIDENCE_V1` | `0x70b55455e73e74fc79b7486d850ac0e524ac3212aaaa85b19b7dbd3291642287` |
| `SIMULATION_SOURCE_HASH` | `simulation-fixed-525` | `0xd123a8bb572dbb96623878447f6dea644243cc9d6a3d8c8838371a712bd150f1` |
| `FUNDING_CURRENCY_LABEL_HASH` | `BRL` | `0x7bfbac288a9bfb4b6175ad0a3f7a03f7790c6f9b3637924a40742a6a5c41c62b` |
| `DEMO_OUTPUT_ASSET_LABEL_HASH` | `USDG` | `0x50c06f78ad2e5bdc0d81007456f70e6c87ac46669280a41f915860e5145b02ea` |

`FUNDING_CURRENCY_LABEL_HASH` and `DEMO_OUTPUT_ASSET_LABEL_HASH` each bind an accompanying decimal label of `2`.

### 4.3 Versions, kind, and canonical route order

| Field | ABI type | Value |
|---|---|---:|
| Evidence schema version | `uint16` | `1` |
| Quote schema version | `uint16` | `1` |
| Chain ID | `uint256` | `421614` |
| `SIMULATED_ROUTE_DECISION` | `uint8` | `1` |
| `direct` | `uint8` | `1` |
| `split` | `uint8` | `2` |
| `multi` | `uint8` | `3` |
| Funding-currency decimals | `uint8` | `2` |
| Demo-output decimals | `uint8` | `2` |

Quote schema version remains `1` because this corrected format is frozen before any registry deployment or production evidence record.

Routes are always committed in this exact order:

```text
direct, split, multi
```

A generator must reject an unknown, duplicate, missing, or order-inconsistent route rather than rearranging or partially committing it.

### 4.4 Per-route and routes commitments

```solidity
routeHash = keccak256(
    abi.encode(
        ROUTE_DOMAIN,         // bytes32
        routeCode,            // uint8
        feeBps,               // uint16
        slippageBps,          // uint16
        toleranceBps,         // uint16
        feeMinor,             // uint256
        outputMinor,          // uint256
        minimumOutputMinor    // uint256
    )
);
```

```solidity
routesHash = keccak256(
    abi.encode(
        ROUTES_DOMAIN,        // bytes32
        directRouteHash,      // bytes32
        splitRouteHash,       // bytes32
        multiRouteHash        // bytes32
    )
);
```

Route names and display labels are not separately hashed. The route code and committed numerical fields are authoritative.

### 4.5 Corrected quote snapshot commitment

```solidity
quoteSnapshotHash = keccak256(
    abi.encode(
        QUOTE_DOMAIN,                     // bytes32
        quoteSchemaVersion,               // uint16 = 1
        simulated,                        // bool = true
        simulationSourceHash,             // bytes32
        fundingCurrencyLabelHash,         // bytes32 = keccak256("BRL")
        fundingCurrencyDecimals,          // uint8 = 2
        demoOutputAssetLabelHash,         // bytes32 = keccak256("USDG")
        demoOutputAssetDecimals,          // uint8 = 2
        fundingMinor,                     // uint256
        rateNumerator,                    // uint256 = 525
        rateDenominator,                  // uint256 = 100
        executionCostMinor,               // uint256 = 2
        expiresAtUnixMs,                  // uint64
        routesHash                        // bytes32
    )
);
```

The BRL funding and simulated USDG output fields are distinct commitments. The output label is not a claim of a token transfer or real USDG asset metadata.

For this preimage, `simulated` is taken from the persisted quote-row `simulated` column after it is checked against `data.simulated`; `simulationSourceHash` is derived from the persisted row `source`; `expiresAtUnixMs` is derived from the persisted row `expires_at`; and all remaining quote fields are read from the row's `data` JSON. This is intentionally not a `quote.source` lookup.

### 4.6 Evidence payload commitment

```solidity
payloadHash = keccak256(
    abi.encode(
        PAYLOAD_DOMAIN,                   // bytes32
        evidenceSchemaVersion,            // uint16 = 1
        chainId,                          // uint256 = 421614
        registry,                         // address
        evidenceId,                       // bytes32
        sequence,                         // uint64
        evidenceKind,                     // uint8 = 1
        quoteSnapshotHash,                // bytes32
        selectedRouteCode,                // uint8
        simulationSourceHash,             // bytes32
        quoteSchemaVersion,               // uint16 = 1
        previousPayloadHash,              // bytes32
        salt                              // bytes32
    )
);
```

For a new stream, `sequence` is `1` and `previousPayloadHash` is the all-zero `bytes32`. The contract supports successors that have the immediately previous sequence and hash, but normal application V1 route-decision evidence creates only a genesis record. A product feature using a later sequence requires a new approved specification.

---

## 5. Corrected synthetic test vectors

### 5.1 Test-only registry address

All vectors use this deliberately non-deployed, synthetic address:

```text
0x1111111111111111111111111111111111111111
```

It is not an Arbitrum Sepolia deployment address. Actual payload hashes change when a real registry address is approved and deployed.

All vectors use chain ID `421614`, evidence schema version `1`, quote schema version `1`, evidence kind `1`, source `simulation-fixed-525`, funding `BRL` with decimals `2`, demo output label `USDG` with decimals `2`, rate `525/100`, execution cost `2`, and the domains in section 4.

### 5.2 Vector 1 — genesis / direct

Raw route fields:

| Route | Code | Fee bps | Slippage bps | Tolerance bps | Fee minor | Output minor | Minimum output minor |
|---|---:|---:|---:|---:|---:|---:|---:|
| `direct` | 1 | 35 | 5 | 50 | 1667 | 474523 | 472150 |
| `split` | 2 | 48 | 8 | 50 | 2286 | 473904 | 471534 |
| `multi` | 3 | 65 | 12 | 50 | 3095 | 473095 | 470729 |

| Input or derived value | Value |
|---|---|
| Funding minor | `2500000` |
| Expiry Unix milliseconds | `1803859140000` |
| Direct route hash | `0xe85d2a8ca64bc1f3ad17af15cdbf9ecbafd6b6e0dbcc0204c88dff4c053c49c5` |
| Split route hash | `0x14cc28efa0b0a5ef475291933e00fd4df57799b4df4e17f8e708d30cf39b85a8` |
| Multi route hash | `0x3228aca2f7a5eff947fbb4f3eb26ba1c10040af08fc55334e0d0e79d746988ee` |
| Routes hash | `0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c` |
| Quote snapshot hash | `0xb693b1782cabfe3e00a58212fc4ce0a2e16908c8739c095824b68e3a7c463d74` |
| Evidence ID | `0x0000000000000000000000000000000000000000000000000000000000000001` |
| Sequence | `1` |
| Selected route/code | `direct` / `1` |
| Previous payload hash | `0x0000000000000000000000000000000000000000000000000000000000000000` |
| Salt | `0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |
| Final payload hash | `0x2869f332484338b67f38eec00bf504f2b20333100d78054bfad729133cb51c1c` |

The quote preimage is, in the exact ABI field order specified in section 4.5:

```text
QUOTE_DOMAIN
1
true
SIMULATION_SOURCE_HASH
FUNDING_CURRENCY_LABEL_HASH
2
DEMO_OUTPUT_ASSET_LABEL_HASH
2
2500000
525
100
2
1803859140000
0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c
```

The payload preimage is, in the exact ABI field order specified in section 4.6:

```text
PAYLOAD_DOMAIN
1
421614
0x1111111111111111111111111111111111111111
0x0000000000000000000000000000000000000000000000000000000000000001
1
1
0xb693b1782cabfe3e00a58212fc4ce0a2e16908c8739c095824b68e3a7c463d74
1
SIMULATION_SOURCE_HASH
1
0x0000000000000000000000000000000000000000000000000000000000000000
0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

### 5.3 Vector 2 — genesis / split

Raw route fields:

| Route | Code | Fee bps | Slippage bps | Tolerance bps | Fee minor | Output minor | Minimum output minor |
|---|---:|---:|---:|---:|---:|---:|---:|
| `direct` | 1 | 35 | 5 | 50 | 1667 | 474523 | 472150 |
| `split` | 2 | 48 | 8 | 50 | 2286 | 473904 | 471534 |
| `multi` | 3 | 65 | 12 | 50 | 3095 | 473095 | 470729 |

| Input or derived value | Value |
|---|---|
| Funding minor | `2500001` |
| Expiry Unix milliseconds | `1803859200123` |
| Direct route hash | `0xe85d2a8ca64bc1f3ad17af15cdbf9ecbafd6b6e0dbcc0204c88dff4c053c49c5` |
| Split route hash | `0x14cc28efa0b0a5ef475291933e00fd4df57799b4df4e17f8e708d30cf39b85a8` |
| Multi route hash | `0x3228aca2f7a5eff947fbb4f3eb26ba1c10040af08fc55334e0d0e79d746988ee` |
| Routes hash | `0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c` |
| Quote snapshot hash | `0x8c41b320380c228d5172f13864bd36d7e61e23b2e9e068d64f2de2623fed8252` |
| Evidence ID | `0x2222222222222222222222222222222222222222222222222222222222222222` |
| Sequence | `1` |
| Selected route/code | `split` / `2` |
| Previous payload hash | `0x0000000000000000000000000000000000000000000000000000000000000000` |
| Salt | `0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` |
| Final payload hash | `0x5f0541d836de3041127cb8d933d3d595281528a1c7185127a4680a0cc1339700` |

The quote preimage is, in the exact ABI field order specified in section 4.5:

```text
QUOTE_DOMAIN
1
true
SIMULATION_SOURCE_HASH
FUNDING_CURRENCY_LABEL_HASH
2
DEMO_OUTPUT_ASSET_LABEL_HASH
2
2500001
525
100
2
1803859200123
0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c
```

The payload preimage is, in the exact ABI field order specified in section 4.6:

```text
PAYLOAD_DOMAIN
1
421614
0x1111111111111111111111111111111111111111
0x2222222222222222222222222222222222222222222222222222222222222222
1
1
0x8c41b320380c228d5172f13864bd36d7e61e23b2e9e068d64f2de2623fed8252
2
SIMULATION_SOURCE_HASH
1
0x0000000000000000000000000000000000000000000000000000000000000000
0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

### 5.4 Vector 3 — chained protocol encoding / multi

This is a protocol replay/sequence vector, not a permitted V1 application flow. Vector 1 remains its own standalone genesis record with `sequence = 1`.

Raw route fields:

| Route | Code | Fee bps | Slippage bps | Tolerance bps | Fee minor | Output minor | Minimum output minor |
|---|---:|---:|---:|---:|---:|---:|---:|
| `direct` | 1 | 35 | 5 | 50 | 3333 | 949047 | 944301 |
| `split` | 2 | 48 | 8 | 50 | 4571 | 947809 | 943069 |
| `multi` | 3 | 65 | 12 | 50 | 6190 | 946190 | 941459 |

| Input or derived value | Value |
|---|---|
| Funding minor | `5000000` |
| Expiry Unix milliseconds | `1803945600456` |
| Direct route hash | `0x93c38546f39e37643579eeb4bea6696304e51afd603dcd30c02683cf9299e31c` |
| Split route hash | `0x96517268d767325dae3a17bc3c64b9abc818d659dd927f23e604d02a28a17544` |
| Multi route hash | `0x837ee60fa02a13f7f993699443908818d270e94adb32309d1a894991d0db8fab` |
| Routes hash | `0x5e5dfc0a0e07390bbdb27f48ea7d19ba202df8bb153d9882a9cbb9da2a7bad20` |
| Quote snapshot hash | `0x5dd4937b035ce91a24c6d484b708f2755a8378953b84630dcf3c36cc5a11be8f` |
| Evidence ID | `0x0000000000000000000000000000000000000000000000000000000000000001` |
| Sequence | `2` |
| Selected route/code | `multi` / `3` |
| Previous payload hash | Vector 1 payload: `0x2869f332484338b67f38eec00bf504f2b20333100d78054bfad729133cb51c1c` |
| Salt | `0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc` |
| Final payload hash | `0xb234a077908740c190f26a2af9f83a47f832fe4008daef1ed8a9749a59eb05c7` |

The quote preimage is, in the exact ABI field order specified in section 4.5:

```text
QUOTE_DOMAIN
1
true
SIMULATION_SOURCE_HASH
FUNDING_CURRENCY_LABEL_HASH
2
DEMO_OUTPUT_ASSET_LABEL_HASH
2
5000000
525
100
2
1803945600456
0x5e5dfc0a0e07390bbdb27f48ea7d19ba202df8bb153d9882a9cbb9da2a7bad20
```

The payload preimage is, in the exact ABI field order specified in section 4.6:

```text
PAYLOAD_DOMAIN
1
421614
0x1111111111111111111111111111111111111111
0x0000000000000000000000000000000000000000000000000000000000000001
2
1
0x5dd4937b035ce91a24c6d484b708f2755a8378953b84630dcf3c36cc5a11be8f
3
SIMULATION_SOURCE_HASH
1
0x2869f332484338b67f38eec00bf504f2b20333100d78054bfad729133cb51c1c
0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
```

### 5.5 Prior independent verification record

The Phase 0.1 audit reported that the complete vector calculations matched between:

1. a custom static Ethereum ABI-word encoder with PyCryptodome Keccak; and
2. an independent `ethers` v6.16.0 `AbiCoder`/`keccak256` calculation.

That audit regenerated route values from the quote arithmetic and did not use expected derived hashes as calculation inputs. For Vector 3, it derived Vector 1 first and supplied that calculated payload hash as the required predecessor.

This document records that prior audit result. It does not claim that publishing this document reran those two implementations.

---

## 6. Public synthetic evidence package

A public package is permitted only for intentionally synthetic demo evidence. It discloses the demo salt and all preimage data so a verifier can recompute the hashes. It must contain no real tenant, invoice, supplier, customer wallet, payment reference, private salt, or private preimage.

The package must include all three routes in canonical order, all commitment preimage fields, and no fabricated onchain transaction. Until a real, separate demo transaction exists, it must report `transactionHash: null` and a status such as `not-anchored-test-vector`.

The following complete Vector 1 example is internally reconstructible. It uses the test-only registry address from section 5.1.

```json
{
  "schema": "ponte-route-decision-evidence/v1",
  "synthetic": true,
  "assertion": "PONTE recorded an explicitly simulated route decision. This does not prove BRL receipt, Pix clearing, USDG issuance or transfer, liquidity, exchange execution, or supplier settlement.",
  "commitment": {
    "hash": "keccak256",
    "encoding": "Solidity abi.encode of the static types fixed in this specification",
    "routeOrder": ["direct", "split", "multi"],
    "domains": {
      "route": "0xfc0c08e07f015619f760ffd85ef8f672e611ba6e80af7148cf14f8b5058db94d",
      "routes": "0xc7f109716592d2a66ecf48b3fa7705a566b35e83cc67b77dc3644bf479304fdf",
      "quote": "0x263723f595ee5d8bf1972157c8b23eae390b79ed6db3c7b6906a2761c7df081c",
      "payload": "0x70b55455e73e74fc79b7486d850ac0e524ac3212aaaa85b19b7dbd3291642287"
    }
  },
  "network": {
    "name": "Arbitrum Sepolia",
    "chainId": "421614",
    "registry": "0x1111111111111111111111111111111111111111",
    "registryStatus": "test-only placeholder; not a deployment"
  },
  "quote": {
    "schemaVersion": "1",
    "simulated": true,
    "source": "simulation-fixed-525",
    "sourceHash": "0xd123a8bb572dbb96623878447f6dea644243cc9d6a3d8c8838371a712bd150f1",
    "funding": {
      "currencyLabel": "BRL",
      "currencyLabelHash": "0x7bfbac288a9bfb4b6175ad0a3f7a03f7790c6f9b3637924a40742a6a5c41c62b",
      "currencyDecimals": "2",
      "minor": "2500000"
    },
    "demoOutput": {
      "assetLabel": "USDG",
      "assetLabelHash": "0x50c06f78ad2e5bdc0d81007456f70e6c87ac46669280a41f915860e5145b02ea",
      "demoAssetDecimals": "2",
      "meaning": "Synthetic display/output unit only; not token metadata or proof of a financial asset."
    },
    "rate": {
      "numerator": "525",
      "denominator": "100"
    },
    "executionCostMinor": "2",
    "expiresAtUnixMs": "1803859140000",
    "routes": [
      {
        "id": "direct",
        "code": "1",
        "feeBps": "35",
        "slippageBps": "5",
        "toleranceBps": "50",
        "feeMinor": "1667",
        "outputMinor": "474523",
        "minimumOutputMinor": "472150"
      },
      {
        "id": "split",
        "code": "2",
        "feeBps": "48",
        "slippageBps": "8",
        "toleranceBps": "50",
        "feeMinor": "2286",
        "outputMinor": "473904",
        "minimumOutputMinor": "471534"
      },
      {
        "id": "multi",
        "code": "3",
        "feeBps": "65",
        "slippageBps": "12",
        "toleranceBps": "50",
        "feeMinor": "3095",
        "outputMinor": "473095",
        "minimumOutputMinor": "470729"
      }
    ]
  },
  "evidence": {
    "evidenceSchemaVersion": "1",
    "evidenceId": "0x0000000000000000000000000000000000000000000000000000000000000001",
    "sequence": "1",
    "kind": "SIMULATED_ROUTE_DECISION",
    "kindCode": "1",
    "selectedRouteId": "direct",
    "selectedRouteCode": "1",
    "previousPayloadHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "salt": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "commitmentPreimages": {
    "quote": {
      "domain": "0x263723f595ee5d8bf1972157c8b23eae390b79ed6db3c7b6906a2761c7df081c",
      "quoteSchemaVersion": "1",
      "simulated": true,
      "simulationSourceHash": "0xd123a8bb572dbb96623878447f6dea644243cc9d6a3d8c8838371a712bd150f1",
      "fundingCurrencyLabelHash": "0x7bfbac288a9bfb4b6175ad0a3f7a03f7790c6f9b3637924a40742a6a5c41c62b",
      "fundingCurrencyDecimals": "2",
      "demoOutputAssetLabelHash": "0x50c06f78ad2e5bdc0d81007456f70e6c87ac46669280a41f915860e5145b02ea",
      "demoOutputAssetDecimals": "2",
      "fundingMinor": "2500000",
      "rateNumerator": "525",
      "rateDenominator": "100",
      "executionCostMinor": "2",
      "expiresAtUnixMs": "1803859140000",
      "routesHash": "0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c"
    },
    "payload": {
      "domain": "0x70b55455e73e74fc79b7486d850ac0e524ac3212aaaa85b19b7dbd3291642287",
      "evidenceSchemaVersion": "1",
      "chainId": "421614",
      "registry": "0x1111111111111111111111111111111111111111",
      "evidenceId": "0x0000000000000000000000000000000000000000000000000000000000000001",
      "sequence": "1",
      "evidenceKind": "1",
      "quoteSnapshotHash": "0xb693b1782cabfe3e00a58212fc4ce0a2e16908c8739c095824b68e3a7c463d74",
      "selectedRouteCode": "1",
      "simulationSourceHash": "0xd123a8bb572dbb96623878447f6dea644243cc9d6a3d8c8838371a712bd150f1",
      "quoteSchemaVersion": "1",
      "previousPayloadHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "salt": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  },
  "derived": {
    "routeHashes": {
      "direct": "0xe85d2a8ca64bc1f3ad17af15cdbf9ecbafd6b6e0dbcc0204c88dff4c053c49c5",
      "split": "0x14cc28efa0b0a5ef475291933e00fd4df57799b4df4e17f8e708d30cf39b85a8",
      "multi": "0x3228aca2f7a5eff947fbb4f3eb26ba1c10040af08fc55334e0d0e79d746988ee"
    },
    "routesHash": "0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c",
    "quoteSnapshotHash": "0xb693b1782cabfe3e00a58212fc4ce0a2e16908c8739c095824b68e3a7c463d74",
    "payloadHash": "0x2869f332484338b67f38eec00bf504f2b20333100d78054bfad729133cb51c1c"
  },
  "chainEvidence": {
    "status": "not-anchored-test-vector",
    "transactionHash": null,
    "blockNumber": null,
    "eventName": null
  }
}
```

The fixed schema in sections 4 and 5 supplies the ABI types and domain literals needed to recompute this example. JSON field order is not a commitment input.

---

## 7. Solidity registry specification

### 7.1 Contract properties and limits

The registry is an immutable, non-payable Solidity registry for Arbitrum Sepolia. It has no proxy or upgradeability mechanism, no external calls, no token transfers, no approval logic, and no asset custody.

Its constructor must reject every chain other than Arbitrum Sepolia:

```solidity
if (block.chainid != 421614) {
    revert UnsupportedChain(block.chainid);
}
```

Tests configure their simulated EVM's chain ID to `421614` before a successful deployment test. A separate negative test uses another chain ID and asserts this exact constructor restriction. There is no test-only constructor bypass.

### 7.2 Interface and state

```solidity
interface IPonteRouteDecisionEvidenceRegistry {
    enum EvidenceKind {
        None,
        SimulatedRouteDecision
    }

    struct EvidenceHead {
        uint64 latestSequence;
        bytes32 latestPayloadHash;
    }

    event EvidenceAnchored(
        bytes32 indexed evidenceId,
        bytes32 indexed payloadHash,
        address indexed attestor,
        uint64 sequence,
        EvidenceKind kind,
        bytes32 previousPayloadHash
    );

    event AttestorSet(address indexed attestor, bool allowed);

    event AdminTransferProposed(
        address indexed currentAdmin,
        address indexed proposedAdmin
    );

    event AdminTransferred(
        address indexed previousAdmin,
        address indexed newAdmin
    );

    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function isAttestor(address account) external view returns (bool);
    function evidenceHead(
        bytes32 evidenceId
    ) external view returns (EvidenceHead memory);

    function anchor(
        bytes32 evidenceId,
        uint64 sequence,
        EvidenceKind kind,
        bytes32 previousPayloadHash,
        bytes32 payloadHash
    ) external;

    function setAttestor(address account, bool allowed) external;
    function proposeAdmin(address candidate) external;
    function acceptAdmin() external;
}
```

Conceptual storage is limited to:

```solidity
address public admin;
address public pendingAdmin;
mapping(address => bool) public isAttestor;
mapping(bytes32 => EvidenceHead) private _evidenceHeads;
```

The chain record stores only the evidence stream head. Event logs carry the append history. Neither storage nor events receive invoice IDs, customer/supplier identity, user/supplier wallet addresses, raw invoice amounts, payment references, salts, or preimages.

### 7.3 Constructor and role separation

The constructor accepts:

```solidity
constructor(address initialAdmin, address initialAttestor)
```

It must reject:

```text
block.chainid != 421614
initialAdmin == address(0)
initialAttestor == address(0)
initialAdmin == initialAttestor
```

On success it sets the separate roles and emits:

```solidity
emit AdminTransferred(address(0), initialAdmin);
emit AttestorSet(initialAttestor, true);
```

Those events make the initial authorization reconstructable from public logs and the deployment receipt.

The following rules are mandatory and enforceable:

1. Initial admin and initial attestor are nonzero and different.
2. The current admin cannot be an attestor.
3. A pending admin cannot be an attestor.
4. `proposeAdmin` rejects a candidate already authorized as an attestor.
5. `setAttestor` rejects the current admin and pending admin as targets.
6. Handover is two-step: only the current admin can propose, and only the proposed account can accept.
7. A pending admin receives no authority until `acceptAdmin` succeeds.
8. `acceptAdmin` rechecks that the accepting address is not an attestor, clears `pendingAdmin`, and does not grant attestor status.
9. The former admin has no administrative authority after a successful handover.
10. Only an authorized attestor can call `anchor`.

A conceptual access-control shape is:

```solidity
setAttestor(account, allowed):
    require msg.sender == admin
    require account != address(0)
    require account != admin
    require account != pendingAdmin
    isAttestor[account] = allowed
    emit AttestorSet(account, allowed)

proposeAdmin(candidate):
    require msg.sender == admin
    require candidate != address(0)
    require candidate != admin
    require !isAttestor[candidate]
    pendingAdmin = candidate
    emit AdminTransferProposed(admin, candidate)

acceptAdmin():
    require msg.sender == pendingAdmin
    require !isAttestor[msg.sender]
    previousAdmin = admin
    admin = msg.sender
    pendingAdmin = address(0)
    emit AdminTransferred(previousAdmin, msg.sender)
```

The contract should use custom errors, including `UnsupportedChain`, `ZeroAddress`, `Unauthorized`, `RoleOverlap`, `InvalidEvidenceKind`, `ZeroEvidenceId`, `ZeroPayloadHash`, `InvalidSequence`, `PreviousHashMismatch`, `SequenceExhausted`, `NoPendingAdmin`, and `NotPendingAdmin`.

### 7.4 Append and replay rules

`anchor` accepts only `EvidenceKind.SimulatedRouteDecision`. It must reject zero evidence IDs and zero payload hashes.

For an evidence ID with no stored head:

```text
stored sequence = 0
stored payload hash = bytes32(0)
required supplied sequence = 1
required supplied predecessor = bytes32(0)
```

For an existing head, `anchor` requires:

```text
supplied sequence == stored latest sequence + 1
supplied previousPayloadHash == stored latest payload hash
stored latest sequence != type(uint64).max
```

After validation, the contract updates the head and emits `EvidenceAnchored`. It makes no external call.

Required future contract tests include constructor chain/address guards, initial authorization events, attestor grant/revocation, prohibited admin/attestor overlaps, proposed-admin restrictions, two-step handover, post-handover revocation of former admin authority, valid anchoring, unauthorized anchoring, zero-field rejection, kind rejection, exact-sequence enforcement, predecessor mismatch, overflow, and expected event data.

---

## 8. Evidence record and outbox architecture

### 8.1 Selected architecture

The selected architecture is the **PONTE Route-Decision Evidence Registry**. It is a product integration for a simulated route lock, not a deployment-checkbox contract and not a payment or settlement engine.

The future insertion point is the existing `Routing` transition, after the service has validated the persisted quote and selected route and after it inserts the simulated settlement record, but before it saves the invoice state, appends the lifecycle event, and commits the PostgreSQL transaction.

Within that same PostgreSQL transaction, the application must create:

1. the immutable private evidence record with the fixed payload hash; and
2. the durable evidence-outbox job in a `pending` state.

This means a failed route transaction cannot leave a durable outbox row, and a committed route decision cannot lack its corresponding pending evidence record.

PostgreSQL and Arbitrum do **not** participate in one atomic transaction. No RPC submission occurs inside the database transaction.

### 8.2 Worker, retry, and confirmation boundaries

After commit, an asynchronous backend worker claims an outbox job and submits the already-fixed commitment. It must never generate a replacement evidence ID, salt, quote, route, sequence, predecessor, or payload hash.

Evidence status must be distinct from simulated payment and settlement state. At minimum the application distinguishes:

```text
pending
submitted
confirmed
retryable
failed
```

Before a retry, the worker should inspect the onchain `evidenceHead(evidenceId)`:

| Observed head | Required worker response |
|---|---|
| Already equals target sequence and payload hash | Reconcile and mark confirmed after receipt/event validation |
| Equals expected predecessor | Submit or retry the original immutable call |
| Different sequence or hash | Mark a reconciliation conflict for operator review |
| RPC unavailable | Keep retryable state; do not change invoice simulation state |

A submitted transaction is not confirmed solely because it has a transaction hash. Confirmation requires a successful receipt and matching registry-emitted `EvidenceAnchored` log fields: registry address, evidence ID, sequence, kind, predecessor, payload hash, and attestor. The future confirmation threshold and reorganisation policy remain operational decisions.

Same-nonce replacements, if approved later, must preserve the signer, nonce, calldata, evidence ID, sequence, predecessor, and payload hash. They must not create a second independently constructed commitment.

### 8.3 Persistence isolation and public disclosure

Evidence and outbox records are separate from:

- `payments`;
- `quotes`;
- `settlements`;
- `payment_events`; and
- `settlements.transaction_hash`.

The existing settlement transaction-hash field is intentionally constrained to `NULL` for the simulated settlement model. An evidence anchoring transaction hash must never be stored as a settlement transaction hash.

A future UI status must use wording such as:

> **Simulated route-decision evidence anchored**

It must not imply that a payment, token transfer, or settlement occurred.

---

## 9. Private-evidence protection

Public synthetic fixtures may disclose their demo salts and full preimages. Private evidence must not.

The minimum acceptable private-evidence standard is application-layer envelope encryption before database insertion:

| Component | Minimum requirement |
|---|---|
| Data encryption key | Fresh 256-bit CSPRNG DEK per private evidence record |
| Content encryption | AES-256-GCM |
| Nonce | Fresh 96-bit CSPRNG nonce per encryption |
| Integrity | Store and verify the GCM authentication tag |
| Key wrapping | Wrap each DEK with a KMS/HSM-managed key-encryption key |
| Stored material | Ciphertext, nonce, tag, wrapped DEK, algorithm version, KMS key version, and non-secret metadata only |
| Decryption | Only the authorized evidence worker/verifier service identity may decrypt |
| Operations | Audit access, support key rotation, and avoid long-lived plaintext caching |

Authenticated additional data must bind a versioned, canonical record identity and chain context, including:

```text
PONTE_PRIVATE_ROUTE_EVIDENCE_V1
internal evidence record ID
business ID
invoice ID
quote ID
public evidence ID
evidence schema version
chain ID
registry address
```

The AAD binds ciphertext to the correct record, tenant context, chain, and registry. It is authenticated rather than secret and should not contain free-form customer data.

Private salts and preimages must never be included in logs, CI output, browser payloads, calldata, registry events, public documentation, support exports, error messages, or dead-letter payloads. This specification does not introduce a KMS implementation, a real KMS provider, or secrets.

---

## 10. Threat model and explicit non-claims

| Threat | Required mitigation |
|---|---|
| Compromised attestor | Separate admin/attestor roles, revocation, auditable events, narrowly scoped no-custody contract, and clear disclosure that the record is attestor-authored |
| Unauthorized anchoring | Attestor gate, two-step admin handover, no client-side signing route |
| Replay or reordering | Opaque evidence ID, exact sequence rule, predecessor-hash rule, and outbox reconciliation |
| Database/chain mismatch | Route-lock and outbox creation in one PostgreSQL transaction; asynchronous reconciliation after commit |
| RPC outage or replacement confusion | Durable retry states, immutable payload inputs, receipt/log verification, and future approved replacement policy |
| Tenant leakage | Existing tenant-scoped database access, private data separation, no tenant identity in public event payload |
| Preimage disclosure | Fresh salt, application-layer encryption, and public data restricted to intentional synthetic fixtures |
| Misleading financial assertion | Explicit simulation labels; no payment/settlement wording for an evidence event |

The registry does not provide custody, escrow, payment-provider integration, Pix processing, token transfer, liquidity sourcing, settlement finality, an optimizer guarantee, or an independent audit of backend business logic.

---

## 11. Judge/verifier procedure

A public synthetic fixture may be verified without PONTE database access:

1. Obtain the synthetic JSON package and confirm it is marked synthetic.
2. Use the exact fixed ABI types and domain literals in this document, not JSON-byte serialization.
3. Recompute three route hashes in canonical order, then `routesHash`, `quoteSnapshotHash`, and `payloadHash`.
4. Compare computed values with the fixture's derived values.
5. For an anchored future public demo, confirm the RPC network chain ID is `421614`, inspect bytecode at the declared registry, fetch its receipt, and decode `EvidenceAnchored`.
6. Confirm emitter, evidence ID, sequence, kind, predecessor, payload hash, and attestor match the recomputed package.
7. Review the explicit assertion: verification proves only an attestor anchored a simulated route-decision commitment.

The Vector 1 package in section 6 is intentionally not anchored and has `transactionHash: null`; it is a reproducibility fixture, not an onchain deployment claim.

---

## 12. Unresolved operational decisions

The following must receive explicit future decisions; this specification does not invent them:

1. Production and testnet admin/attestor addresses, custody, rotation, and revocation operations.
2. Solidity toolchain, pinned compiler, and reproducible build procedure.
3. RPC provider, failover policy, rate limits, and archival/historical-log access.
4. Confirmation threshold and reorganisation handling.
5. Transaction retry, timeout, nonce, and replacement policy.
6. KMS/HSM provider, operational owner, service identity, key policy, and private-data retention/deletion policy.
7. Public verifier and synthetic-artifact distribution channel.
8. Contract source-verification venue and process.
9. Semantics for any sequence greater than the V1 genesis flow and the Vector 3 protocol fixture.
10. Production/demo hosting and authentication policy.
11. Actual deployed registry address and deployment procedure.

---

## 13. Separate Stylus evidence

PONTE's successful local Nitro Stylus proof remains a separate achievement. It demonstrates local, disposable-devnet build/deployment/activation/execution evidence for the existing synthetic wrapper.

It does not establish a public Arbitrum Sepolia Stylus activation, public activation approval, production compatibility, or eligibility for any activation process. The Solidity EVM Evidence Registry described here does not depend on public Stylus activation and must not be presented as a Stylus substitute.
