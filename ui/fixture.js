// Saved seed-route sample captured on 2026-10-06. Used only when no API snapshot is available.
// Covers one service, invoice, and goods sale. It does not represent current activity.

export const FIXTURE = {
  "entities": [
    {
      "id": "entity-new",
      "displayName": "New Trader",
      "wallets": [
        "addr_test1newtraderwallet00000000000000000000000001"
      ],
      "kycStatus": "pending",
      "kycTier": "none",
      "roles": [
        "buyer",
        "seller"
      ],
      "createdAt": "2026-10-01T00:00:00.000Z"
    },
    {
      "id": "entity-established",
      "displayName": "Meridian Services",
      "wallets": [
        "addr_test1meridianservices00000000000000000000000001",
        "addr_test1meridianservices00000000000000000000000002"
      ],
      "kycStatus": "verified",
      "kycTier": "enhanced",
      "roles": [
        "buyer",
        "seller"
      ],
      "createdAt": "2026-06-01T00:00:00.000Z"
    },
    {
      "id": "entity-farm-a",
      "displayName": "Farm Counterparty A",
      "wallets": [
        "addr_test1farmcounterparty000000000000000000000000a"
      ],
      "kycStatus": "verified",
      "kycTier": "basic",
      "roles": [
        "buyer",
        "seller"
      ],
      "createdAt": "2026-08-01T00:00:00.000Z"
    },
    {
      "id": "entity-farm-b",
      "displayName": "Farm Counterparty B",
      "wallets": [
        "addr_test1farmcounterparty000000000000000000000000b"
      ],
      "kycStatus": "verified",
      "kycTier": "basic",
      "roles": [
        "buyer",
        "seller"
      ],
      "createdAt": "2026-08-01T00:00:00.000Z"
    }
  ],
  "scores": [
    {
      "entityId": "entity-new",
      "category": "fulfillment",
      "role": "buyer",
      "value": 0.5,
      "lowerBound": 0,
      "confidence": 0,
      "eventCount": 0
    },
    {
      "entityId": "entity-new",
      "category": "payment",
      "role": "seller",
      "value": 0.5,
      "lowerBound": 0,
      "confidence": 0,
      "eventCount": 0
    },
    {
      "entityId": "entity-established",
      "category": "fulfillment",
      "role": "seller",
      "value": 0.96,
      "lowerBound": 0.8,
      "confidence": 0.8333333333333334,
      "eventCount": 50
    },
    {
      "entityId": "entity-established",
      "category": "payment",
      "role": "buyer",
      "value": 0.967741935483871,
      "lowerBound": 0.7317073170731707,
      "confidence": 0.7560975609756098,
      "eventCount": 31
    },
    {
      "entityId": "entity-farm-a",
      "category": "delivery",
      "role": "seller",
      "value": 0.9285714285714286,
      "lowerBound": 0.5064935064935064,
      "confidence": 0.5454545454545454,
      "eventCount": 12
    },
    {
      "entityId": "entity-farm-b",
      "category": "delivery",
      "role": "buyer",
      "value": 0.9285714285714286,
      "lowerBound": 0.5064935064935064,
      "confidence": 0.5454545454545454,
      "eventCount": 12
    }
  ],
  "listings": [
    {
      "id": "listing-service-1",
      "sellerId": "entity-established",
      "transactionType": "service",
      "title": "Monthly bookkeeping (up to 200 transactions)",
      "price": 250,
      "pricingMethod": "fixed",
      "requiredTerms": {
        "deliveryDeadline": "2026-10-07T00:00:00.000Z",
        "escrow": "simulated"
      },
      "minSellerReliability": 0.7,
      "createdAt": "2026-10-04T00:00:00.000Z"
    },
    {
      "id": "listing-invoice-1",
      "sellerId": "entity-established",
      "transactionType": "invoice",
      "title": "Net-30 invoice facility up to 5000",
      "pricingMethod": "variable-fee",
      "requiredTerms": {
        "paymentDays": 30,
        "currency": "USD"
      },
      "minBuyerReliability": 0.5,
      "createdAt": "2026-10-04T00:00:00.000Z"
    }
  ],
  "transactions": [
    {
      "id": "tx-service-1",
      "type": "service",
      "participants": [
        {
          "entityId": "entity-new",
          "role": "buyer"
        },
        {
          "entityId": "entity-established",
          "role": "seller"
        }
      ],
      "terms": {
        "service": "Monthly bookkeeping (up to 200 transactions)",
        "deliveryDeadline": "2026-10-07T00:00:00.000Z"
      },
      "versions": [
        {
          "version": 1,
          "terms": {
            "service": "Monthly bookkeeping (up to 200 transactions)",
            "deliveryDeadline": "2026-10-07T00:00:00.000Z"
          },
          "reason": "initial terms",
          "createdAt": "2026-10-04T10:00:00.000Z"
        }
      ],
      "value": 250,
      "createdAt": "2026-10-04T10:00:00.000Z",
      "completedAt": "2026-10-04T12:00:00.000Z"
    },
    {
      "id": "tx-invoice-1",
      "type": "invoice",
      "participants": [
        {
          "entityId": "entity-established",
          "role": "buyer"
        },
        {
          "entityId": "entity-new",
          "role": "seller"
        }
      ],
      "terms": {
        "invoiceId": "INV-2026-1042",
        "amount": 1200,
        "currency": "USD",
        "dueDate": "2026-10-03T00:00:00.000Z"
      },
      "termsHash": "e52b2d27d8051579cc540ed9f280faac6b49049702881c89c451fd82481cecd9",
      "versions": [
        {
          "version": 1,
          "terms": {
            "invoiceId": "INV-2026-1042",
            "amount": 1200,
            "currency": "USD",
            "dueDate": "2026-10-03T00:00:00.000Z"
          },
          "reason": "initial terms",
          "createdAt": "2026-09-03T00:00:00.000Z"
        },
        {
          "version": 2,
          "terms": {
            "invoiceId": "INV-2026-1042",
            "amount": 1200,
            "currency": "USD",
            "dueDate": "2026-10-03T00:00:00.000Z",
            "paymentDays": 30
          },
          "reason": "buyer requested net-30 amendment",
          "createdAt": "2026-09-04T00:00:00.000Z"
        }
      ],
      "value": 1200,
      "createdAt": "2026-09-03T00:00:00.000Z",
      "completedAt": "2026-10-02T00:00:00.000Z"
    },
    {
      "id": "tx-farm-01",
      "type": "goods",
      "participants": [
        {
          "entityId": "entity-farm-b",
          "role": "buyer"
        },
        {
          "entityId": "entity-farm-a",
          "role": "seller"
        }
      ],
      "terms": {
        "goods": "USB-C cable 2m braided",
        "quantity": 10
      },
      "versions": [
        {
          "version": 1,
          "terms": {
            "goods": "USB-C cable 2m braided",
            "quantity": 10
          },
          "reason": "initial terms",
          "createdAt": "2026-09-01T10:00:00.000Z"
        }
      ],
      "value": 50,
      "createdAt": "2026-09-01T10:00:00.000Z",
      "completedAt": "2026-09-01T11:00:00.000Z"
    }
  ],
  "receipts": {
    "tx-service-1": {
      "transaction": {
        "id": "tx-service-1",
        "type": "service",
        "participants": [
          {
            "entityId": "entity-new",
            "role": "buyer"
          },
          {
            "entityId": "entity-established",
            "role": "seller"
          }
        ],
        "terms": {
          "service": "Monthly bookkeeping (up to 200 transactions)",
          "deliveryDeadline": "2026-10-07T00:00:00.000Z"
        },
        "versions": [
          {
            "version": 1,
            "terms": {
              "service": "Monthly bookkeeping (up to 200 transactions)",
              "deliveryDeadline": "2026-10-07T00:00:00.000Z"
            },
            "reason": "initial terms",
            "createdAt": "2026-10-04T10:00:00.000Z"
          }
        ],
        "value": 250,
        "createdAt": "2026-10-04T10:00:00.000Z",
        "completedAt": "2026-10-04T12:00:00.000Z"
      },
      "outcome": {
        "transactionId": "tx-service-1",
        "state": "successful",
        "evidence": {
          "stage": "payment_settled",
          "escrowTx": "simulated-escrow-tx-service-1",
          "deliveryConfirmedAt": "2026-10-04T11:30:00.000Z",
          "producer": "lifecycle-v1",
          "mode": "paper"
        },
        "verificationMethod": "lifecycle",
        "verificationConfidence": 0.5,
        "decidedAt": "2026-10-04T12:00:00.000Z"
      },
      "events": [
        {
          "id": "tx-service-1:entity-new:buyer",
          "transactionId": "tx-service-1",
          "entityId": "entity-new",
          "category": "fulfillment",
          "role": "buyer",
          "outcome": "success",
          "evidence": {
            "stage": "payment_settled",
            "escrowTx": "simulated-escrow-tx-service-1",
            "deliveryConfirmedAt": "2026-10-04T11:30:00.000Z",
            "producer": "lifecycle-v1",
            "mode": "paper"
          },
          "verificationMethod": "lifecycle",
          "verificationConfidence": 0.5,
          "value": 250,
          "createdAt": "2026-10-04T12:00:00.000Z"
        },
        {
          "id": "tx-service-1:entity-established:seller",
          "transactionId": "tx-service-1",
          "entityId": "entity-established",
          "category": "fulfillment",
          "role": "seller",
          "outcome": "success",
          "evidence": {
            "stage": "payment_settled",
            "escrowTx": "simulated-escrow-tx-service-1",
            "deliveryConfirmedAt": "2026-10-04T11:30:00.000Z",
            "producer": "lifecycle-v1",
            "mode": "paper"
          },
          "verificationMethod": "lifecycle",
          "verificationConfidence": 0.5,
          "value": 250,
          "createdAt": "2026-10-04T12:00:00.000Z"
        }
      ],
      "termsDecision": {
        "entityId": "entity-established",
        "category": "fulfillment",
        "inputs": {
          "eventCount": 50,
          "stub": true
        },
        "terms": {
          "deposit": 200,
          "premium": 200,
          "limit": 8000,
          "paymentDays": 49,
          "verificationFrequency": 0.19999999999999996
        },
        "buyerFeeBps": 80,
        "sellerFeeBps": 66,
        "reasonCode": "STRONG_HISTORY",
        "policyVersion": "fee-terms-stub-v0",
        "decidedAt": "2026-10-04T12:00:00.000Z"
      }
    },
    "tx-invoice-1": {
      "transaction": {
        "id": "tx-invoice-1",
        "type": "invoice",
        "participants": [
          {
            "entityId": "entity-established",
            "role": "buyer"
          },
          {
            "entityId": "entity-new",
            "role": "seller"
          }
        ],
        "terms": {
          "invoiceId": "INV-2026-1042",
          "amount": 1200,
          "currency": "USD",
          "dueDate": "2026-10-03T00:00:00.000Z"
        },
        "termsHash": "e52b2d27d8051579cc540ed9f280faac6b49049702881c89c451fd82481cecd9",
        "versions": [
          {
            "version": 1,
            "terms": {
              "invoiceId": "INV-2026-1042",
              "amount": 1200,
              "currency": "USD",
              "dueDate": "2026-10-03T00:00:00.000Z"
            },
            "reason": "initial terms",
            "createdAt": "2026-09-03T00:00:00.000Z"
          },
          {
            "version": 2,
            "terms": {
              "invoiceId": "INV-2026-1042",
              "amount": 1200,
              "currency": "USD",
              "dueDate": "2026-10-03T00:00:00.000Z",
              "paymentDays": 30
            },
            "reason": "buyer requested net-30 amendment",
            "createdAt": "2026-09-04T00:00:00.000Z"
          }
        ],
        "value": 1200,
        "createdAt": "2026-09-03T00:00:00.000Z",
        "completedAt": "2026-10-02T00:00:00.000Z"
      },
      "outcome": {
        "transactionId": "tx-invoice-1",
        "state": "successful",
        "evidence": {
          "termsHash": "e52b2d27d8051579cc540ed9f280faac6b49049702881c89c451fd82481cecd9",
          "dueDate": "2026-10-03T00:00:00.000Z",
          "settlementTimestamp": "2026-10-02T00:00:00.000Z",
          "settlementTxHash": null,
          "producer": "payment-evidence-stub-v0"
        },
        "verificationMethod": "payment-settlement",
        "verificationConfidence": 0.5,
        "decidedAt": "2026-10-02T00:00:00.000Z"
      },
      "events": [
        {
          "id": "tx-invoice-1:entity-established:buyer",
          "transactionId": "tx-invoice-1",
          "entityId": "entity-established",
          "category": "payment",
          "role": "buyer",
          "outcome": "success",
          "evidence": {
            "termsHash": "e52b2d27d8051579cc540ed9f280faac6b49049702881c89c451fd82481cecd9",
            "dueDate": "2026-10-03T00:00:00.000Z",
            "settlementTimestamp": "2026-10-02T00:00:00.000Z",
            "settlementTxHash": null,
            "producer": "payment-evidence-stub-v0"
          },
          "verificationMethod": "payment-settlement",
          "verificationConfidence": 0.5,
          "value": 1200,
          "createdAt": "2026-10-02T00:00:00.000Z"
        },
        {
          "id": "tx-invoice-1:entity-new:seller",
          "transactionId": "tx-invoice-1",
          "entityId": "entity-new",
          "category": "payment",
          "role": "seller",
          "outcome": "success",
          "evidence": {
            "termsHash": "e52b2d27d8051579cc540ed9f280faac6b49049702881c89c451fd82481cecd9",
            "dueDate": "2026-10-03T00:00:00.000Z",
            "settlementTimestamp": "2026-10-02T00:00:00.000Z",
            "settlementTxHash": null,
            "producer": "payment-evidence-stub-v0"
          },
          "verificationMethod": "payment-settlement",
          "verificationConfidence": 0.5,
          "value": 1200,
          "createdAt": "2026-10-02T00:00:00.000Z"
        }
      ],
      "termsDecision": {
        "entityId": "entity-new",
        "category": "payment",
        "inputs": {
          "eventCount": 0,
          "stub": true
        },
        "terms": {
          "deposit": 1000,
          "premium": 1000,
          "limit": 0,
          "paymentDays": 7,
          "verificationFrequency": 1
        },
        "buyerFeeBps": 300,
        "sellerFeeBps": 250,
        "reasonCode": "NEW_ENTITY",
        "policyVersion": "fee-terms-stub-v0",
        "decidedAt": "2026-10-02T00:00:00.000Z"
      }
    },
    "tx-farm-01": {
      "transaction": {
        "id": "tx-farm-01",
        "type": "goods",
        "participants": [
          {
            "entityId": "entity-farm-b",
            "role": "buyer"
          },
          {
            "entityId": "entity-farm-a",
            "role": "seller"
          }
        ],
        "terms": {
          "goods": "USB-C cable 2m braided",
          "quantity": 10
        },
        "versions": [
          {
            "version": 1,
            "terms": {
              "goods": "USB-C cable 2m braided",
              "quantity": 10
            },
            "reason": "initial terms",
            "createdAt": "2026-09-01T10:00:00.000Z"
          }
        ],
        "value": 50,
        "createdAt": "2026-09-01T10:00:00.000Z",
        "completedAt": "2026-09-01T11:00:00.000Z"
      },
      "outcome": {
        "transactionId": "tx-farm-01",
        "state": "successful",
        "evidence": {
          "stage": "payment_settled",
          "escrowTx": "simulated-escrow-tx-farm-01",
          "deliveryConfirmedAt": "2026-09-01T11:00:00.000Z",
          "producer": "lifecycle-v1",
          "mode": "paper"
        },
        "verificationMethod": "lifecycle",
        "verificationConfidence": 0.5,
        "decidedAt": "2026-09-01T11:00:00.000Z"
      },
      "events": [
        {
          "id": "tx-farm-01:entity-farm-b:buyer",
          "transactionId": "tx-farm-01",
          "entityId": "entity-farm-b",
          "category": "delivery",
          "role": "buyer",
          "outcome": "success",
          "evidence": {
            "stage": "payment_settled",
            "escrowTx": "simulated-escrow-tx-farm-01",
            "deliveryConfirmedAt": "2026-09-01T11:00:00.000Z",
            "producer": "lifecycle-v1",
            "mode": "paper"
          },
          "verificationMethod": "lifecycle",
          "verificationConfidence": 0.5,
          "value": 50,
          "createdAt": "2026-09-01T11:00:00.000Z"
        },
        {
          "id": "tx-farm-01:entity-farm-a:seller",
          "transactionId": "tx-farm-01",
          "entityId": "entity-farm-a",
          "category": "delivery",
          "role": "seller",
          "outcome": "success",
          "evidence": {
            "stage": "payment_settled",
            "escrowTx": "simulated-escrow-tx-farm-01",
            "deliveryConfirmedAt": "2026-09-01T11:00:00.000Z",
            "producer": "lifecycle-v1",
            "mode": "paper"
          },
          "verificationMethod": "lifecycle",
          "verificationConfidence": 0.5,
          "value": 50,
          "createdAt": "2026-09-01T11:00:00.000Z"
        }
      ],
      "termsDecision": {
        "entityId": "entity-farm-a",
        "category": "delivery",
        "inputs": {
          "eventCount": 12,
          "stub": true
        },
        "terms": {
          "deposit": 494,
          "premium": 494,
          "limit": 5065,
          "paymentDays": 34,
          "verificationFrequency": 0.49350649350649356
        },
        "buyerFeeBps": 161,
        "sellerFeeBps": 134,
        "reasonCode": "POLICY_DEFAULT",
        "policyVersion": "fee-terms-stub-v0",
        "decidedAt": "2026-09-01T11:00:00.000Z"
      }
    }
  },
  "kycExamples": {
    "cases": [
      {
        "id": "kyc-unverified",
        "label": "Registered person. No check yet.",
        "badge": "unverified",
        "status": "unverified",
        "tier": "none",
        "subjectKind": "person",
        "countsAsVerified": false,
        "reRegistrationOf": null,
        "how": "registered"
      },
      {
        "id": "kyc-pending",
        "label": "Person check is waiting on the mock vendor.",
        "badge": "pending",
        "status": "pending",
        "tier": "none",
        "subjectKind": "person",
        "countsAsVerified": false,
        "reRegistrationOf": null,
        "how": "check_submitted"
      },
      {
        "id": "kyc-verified-basic",
        "label": "Person verified at tier basic.",
        "badge": "verified",
        "status": "verified",
        "tier": "basic",
        "subjectKind": "person",
        "countsAsVerified": true,
        "reRegistrationOf": null,
        "how": "vendor_approved"
      },
      {
        "id": "kyc-verified-enhanced",
        "label": "Business verified at tier enhanced.",
        "badge": "verified",
        "status": "verified",
        "tier": "enhanced",
        "subjectKind": "business",
        "countsAsVerified": true,
        "reRegistrationOf": null,
        "how": "tier_raised"
      },
      {
        "id": "kyc-rejected",
        "label": "Mock vendor rejected the check.",
        "badge": "rejected",
        "status": "rejected",
        "tier": "none",
        "subjectKind": "business",
        "countsAsVerified": false,
        "reRegistrationOf": null,
        "how": "vendor_rejected"
      },
      {
        "id": "kyc-expired",
        "label": "Verification expired. Entity status is unverified.",
        "badge": "expired",
        "status": "unverified",
        "tier": "none",
        "subjectKind": "person",
        "countsAsVerified": false,
        "reRegistrationOf": null,
        "how": "expired"
      },
      {
        "id": "kyc-reregistration",
        "label": "Same mocked document as kyc-unverified. Reliability is not copied.",
        "badge": "unverified",
        "status": "unverified",
        "tier": "none",
        "subjectKind": "person",
        "countsAsVerified": false,
        "reRegistrationOf": "kyc-unverified",
        "how": "registered"
      }
    ]
  }
}
