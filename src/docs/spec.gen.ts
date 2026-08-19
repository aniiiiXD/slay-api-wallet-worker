/**
 * GENERATED FILE — do not edit.
 *
 * Source: openapi.yaml
 * Regenerate: npm run docs:gen
 *
 * Edit the YAML, not this. `npm run docs:check` fails if they disagree.
 */

export const spec: unknown = {
  "openapi": "3.1.0",
  "info": {
    "title": "Slay Money API",
    "version": "1.0.0",
    "summary": "Programmatic access to a Slay wallet on the Canton Network.",
    "description": "Two ways in, for two different jobs:\n\n**Agent keys (`/api/v1`)** — server-to-server. A key belongs to one wallet\nand carries mandatory restrictions: what it may do, how much it may move per\ntransaction, which recipients it may pay, which IPs may use it. There is no\nunrestricted key.\n\n**CIP-0103** — browser dApps. Not described here because it is not an HTTP\nAPI: a dApp talks to the Slay browser extension, which implements\n[CIP-0103](https://github.com/canton-foundation/cips/blob/main/cip-0103/cip-0103.md)\nand is discovered at runtime via `canton:announceProvider`. Use\n`@canton-network/dapp-sdk`; nothing in this document is needed for that.\n\n## Getting a key\n\nIssue one from **Dashboard → Build → API keys**. Only a signed-in human can:\na key cannot create another key, so a leaked one cannot quietly issue itself\nsuccessors.\n\nThe screen is also where you freeze a key, rotate it, or revoke it. Rotation\ncreates the successor first and leaves the old key valid for an hour, so a\ndeployment does not need downtime. Freezing is the reversible one — there is\na **Freeze all** control for the moment you are not yet sure what leaked.\n\nAt creation you choose exactly what it may do. There is no unrestricted\nkey and no \"tighten it later\":\n\n| Capability | Grants |\n|---|---|\n| `balance:read` | `GET /api/v1/balance` |\n| `tx:read` | `GET /api/v1/transactions`, `GET /api/v1/transfers/{id}` |\n| `tx:write` | `POST /api/v1/transfers` — moving money |\n\n`tx:write` additionally **requires** both spend caps, `perTransactionCc`\nand `perDayCc`. A key requesting it without them is rejected at creation\nwith 422, not accepted and warned about. You may also pin it to specific\nrecipients and to specific source IPs.\n\nThe secret is shown **once**, at creation, and hashed on the way in. There\nis no endpoint that returns it later. Lost means rotate.\n\n## Two things a valid key still cannot do\n\nA key that authenticates correctly can still be refused, and the two\nreasons look nothing alike:\n\n**`403 trading_not_approved`** — the account is not cleared to move money\nprogrammatically. Reads keep working. This is checked per request rather\nthan baked into the key, so suspending an account stops every key it owns\nat once, with no propagation delay and no key hunting.\n\n**`429 limit_exceeded`** — a spend cap, not a request rate. Despite the\nstatus, backing off does not help: `perTransactionCc` will never accept\nthat amount, and `perDayCc` clears at 00:00 UTC. The message names which\ncap was hit and what has already been spent.\n\n## Amounts are decimal strings\n\n`amountCc` goes over the wire as a **string** — `\"3.5\"`, not `3.5`. CC has\nsix decimal places and IEEE-754 does not represent them exactly. A client\nthat parses to a float, does arithmetic and formats back will eventually\nsend someone the wrong number. Read them, compare them and store them as\nstrings.\n\n## `clientTxId` is what makes a retry safe\n\nEvery transfer requires one, and it is the ONLY thing separating \"my request\ntimed out, try again\" from \"pay them twice\". Generate it once per intended\npayment and reuse the identical value on every retry of that payment. The\nserver matches on it and returns the original transfer instead of making a\nsecond one.\n\n**A timeout is not a failure.** It means the outcome is unknown. Never retry\nwith a fresh id — re-send the same id, or read\n`GET /api/v1/transfers/{clientTxId}` to find out what happened.\n",
    "contact": {
      "name": "Slay Money",
      "url": "https://slay.money"
    },
    "license": {
      "name": "Proprietary"
    }
  },
  "servers": [
    {
      "url": "https://slay-api-wallet-providers.slay-money-api.workers.dev",
      "description": "Production — wallet provider Worker"
    }
  ],
  "security": [
    {
      "AgentKey": []
    }
  ],
  "tags": [
    {
      "name": "Wallet",
      "description": "Balances and history for the wallet a key belongs to."
    },
    {
      "name": "Transfers",
      "description": "Moving CC. Requires the `tx:write` capability."
    },
    {
      "name": "Keys",
      "description": "Creating and managing agent keys. Uses a user session, not a key."
    },
    {
      "name": "Public",
      "description": "No authentication."
    }
  ],
  "paths": {
    "/api/v1/balance": {
      "get": {
        "tags": [
          "Wallet"
        ],
        "summary": "Balance for this key's wallet",
        "description": "Requires the `balance:read` capability.\n\n`availableCc` is `balanceCc − lockedCc` and is the figure to check\nbefore spending. `lockedCc` is real money the holder owns but cannot\nmove — reserved against open positions or in-flight transfers — so\ntreating `balanceCc` as spendable will produce transfers the server\nrefuses.\n",
        "operationId": "getBalance",
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "balanceCc",
                    "lockedCc",
                    "availableCc"
                  ],
                  "properties": {
                    "balanceCc": {
                      "type": "string",
                      "description": "Total held, decimal string.",
                      "example": "87.105300"
                    },
                    "lockedCc": {
                      "type": "string",
                      "description": "Reserved and unspendable.",
                      "example": "0.000000"
                    },
                    "availableCc": {
                      "type": "string",
                      "description": "balanceCc − lockedCc. Spend against this.",
                      "example": "87.105300"
                    },
                    "cantonAddress": {
                      "type": [
                        "string",
                        "null"
                      ],
                      "description": "The wallet's Canton party id. Null when no party has been\nallocated yet — the account exists but cannot transact.\n",
                      "example": "slay-money::12206cab144ff69861e34be8671ece597d978fd70c2e1d6fb2a5da8f17336796ef32"
                    }
                  }
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/InvalidKey"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        }
      }
    },
    "/api/v1/transactions": {
      "get": {
        "tags": [
          "Wallet"
        ],
        "summary": "Transaction history",
        "description": "Requires `tx:read`. Newest first.\n\n`clientTxId` is populated for transfers this API created, so a caller\ncan reconcile its own sends against the ledger without keeping a\nseparate mapping.\n",
        "operationId": "listTransactions",
        "parameters": [
          {
            "name": "limit",
            "in": "query",
            "schema": {
              "type": "integer",
              "minimum": 1,
              "maximum": 200,
              "default": 50
            },
            "description": "Rows to return."
          }
        ],
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "items"
                  ],
                  "properties": {
                    "items": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Transaction"
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/InvalidKey"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        }
      }
    },
    "/api/v1/transfers": {
      "post": {
        "tags": [
          "Transfers"
        ],
        "summary": "Send CC",
        "description": "Requires `tx:write`, and that capability cannot exist without both a\n`perTransactionCc` and a `perDayCc` limit — the server rejects a key\nconfigured otherwise.\n\nIt also requires the **account** to be approved for programmatic\ntrading. That is separate from the key and re-checked on every\nrequest; without it you get `403 trading_not_approved` even with a\nperfectly good key.\n\n**This moves money.** Read the `clientTxId` note in the API description\nbefore writing a retry loop. On a timeout, do not re-send with a new id:\nre-send the same one, or read\n`GET /api/v1/transfers/{clientTxId}`.\n\nThe transfer is also checked against the key's `allowedRecipients` and\nits spend limits before anything moves.\n",
        "operationId": "createTransfer",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "clientTxId",
                  "to",
                  "amountCc"
                ],
                "properties": {
                  "clientTxId": {
                    "type": "string",
                    "description": "Your idempotency key. Reuse the identical value when\nretrying the same payment — it is how a retry is told apart\nfrom a second payment.\n",
                    "example": "b3f1c8e2-4d9a-4c77-8f0e-2a51d9c7e401"
                  },
                  "to": {
                    "type": "string",
                    "description": "A Slay handle (`karan`, `slay@karan`) or a Canton party id\n(contains `::`). The server resolves which and routes\ninternally or on-chain accordingly.\n",
                    "example": "karan"
                  },
                  "amountCc": {
                    "type": "string",
                    "description": "Positive decimal STRING. Not a number.",
                    "example": "3.0"
                  },
                  "memo": {
                    "type": "string",
                    "description": "Free text shown to both parties.",
                    "example": "invoice 41"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Settled. Also returned for a repeat of a `clientTxId` that already\nsucceeded — the original transfer, not a new one.\n\nNote the code: this is **201**, not 200. A client that tests\n`status === 200` will read every successful transfer as a failure,\nand may then retry money that already moved.\n",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Transfer"
                }
              }
            }
          },
          "400": {
            "description": "Missing `clientTxId`, missing `to`, or an `amountCc` that is not a\npositive decimal string. Also returned when the amount is below the\nnetwork's minimum, which is denominated in USD and therefore moves\nwith the CC price.\n",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/InvalidKey"
          },
          "403": {
            "description": "Three different refusals share this status, separated by `code`:\n\n- `trading_not_approved` — **the account is not cleared to move\n  money programmatically.** A valid key with `tx:write` still gets\n  this. It is re-checked on every request rather than stamped onto\n  the key, so suspending an account disables all of its keys at\n  once. Reads keep working.\n- `forbidden` — the key does not carry `tx:write`.\n- `forbidden` — the recipient is not in `allowedRecipients`.\n",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        }
      }
    },
    "/api/v1/transfers/{clientTxId}": {
      "get": {
        "tags": [
          "Transfers"
        ],
        "summary": "Look up a transfer by your own id",
        "description": "Requires `tx:read`. This is the correct move after a timeout: it answers\nwhether the transfer happened, without risking a second one.\n\nA 404 means no transfer with that id exists — nothing was sent, and it\nis safe to submit it.\n",
        "operationId": "getTransfer",
        "parameters": [
          {
            "name": "clientTxId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Found",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Transfer"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/InvalidKey"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "404": {
            "description": "No transfer with this id. Nothing was sent.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        }
      }
    },
    "/api/agents": {
      "post": {
        "tags": [
          "Keys"
        ],
        "summary": "Create an agent key",
        "description": "Authenticated with a **user session**, not an agent key — a key cannot\nmint another key.\n\n`restrictions` is required and has no default. There is no unrestricted\nkey and no \"add limits later\": `tx:write` without `limits.perTransactionCc`\nis rejected outright.\n\n⚠️ `secret` is returned **once**, here, and is never retrievable again.\nIt is hashed on the way in. If it is lost, delete the key and make\nanother.\n",
        "operationId": "createAgentKey",
        "security": [
          {
            "SessionCookie": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "name",
                  "restrictions"
                ],
                "properties": {
                  "name": {
                    "type": "string",
                    "example": "payouts-worker"
                  },
                  "restrictions": {
                    "type": "object",
                    "properties": {
                      "capabilities": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "enum": [
                            "balance:read",
                            "tx:read",
                            "tx:write"
                          ]
                        }
                      },
                      "limits": {
                        "type": "object",
                        "properties": {
                          "perTransactionCc": {
                            "type": "string",
                            "description": "Largest single transfer. Required whenever\n`tx:write` is granted — 422 without it.\n",
                            "example": "25"
                          },
                          "perDayCc": {
                            "type": "string",
                            "description": "Total per UTC day. Also required for `tx:write`,\nand also 422 without it. Reserved before the\ntransfer runs, so a failure leaves the day\noverstated rather than understated.\n",
                            "example": "250"
                          }
                        }
                      },
                      "allowedRecipients": {
                        "type": [
                          "array",
                          "null"
                        ],
                        "items": {
                          "type": "string"
                        },
                        "description": "Null means any recipient."
                      },
                      "allowedIps": {
                        "type": [
                          "array",
                          "null"
                        ],
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created. The only time `secret` is shown.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string"
                    },
                    "name": {
                      "type": "string"
                    },
                    "prefix": {
                      "type": "string",
                      "description": "Stored in clear so a key can be identified in logs.",
                      "example": "sk_live_a1b2c3"
                    },
                    "secret": {
                      "type": "string",
                      "description": "Shown once. Never retrievable.",
                      "example": "sk_live_a1b2c3_9f4e7d2c8b1a6503e4f7a9d2"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/prices/{asset}": {
      "get": {
        "tags": [
          "Public"
        ],
        "summary": "USD spot price",
        "description": "No authentication.\n\n`usd` is nullable and that is not a formality: it is null when the\nupstream has never been reached, precisely so a client shows \"—\" rather\nthan inventing a floor price. Anything multiplying a balance by this\nmust handle null instead of coercing to zero, which would render a real\nholding as $0.00.\n\n`stale: true` means the value is being served from cache after an\nupstream failure. It is usable, but say so.\n",
        "operationId": "getPrice",
        "security": [],
        "parameters": [
          {
            "name": "asset",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "enum": [
                "cc",
                "cbtc",
                "ceth"
              ]
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "usd": {
                      "type": [
                        "number",
                        "null"
                      ],
                      "example": 0.09202
                    },
                    "asOf": {
                      "type": "string",
                      "format": "date-time"
                    },
                    "stale": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "AgentKey": {
        "type": "http",
        "scheme": "bearer",
        "x-displayName": "Agent key",
        "description": "Every `/api/v1` request carries one, as a bearer token:\n\n```\nAuthorization: Bearer sk_live_a1b2c3_9f4e7d2c8b1a6503e4f7a9d2\n```\n\nA key belongs to exactly one wallet and can never reach another. It is\nhashed on arrival, so the value is shown once at creation and cannot be\nrecovered — if it is lost, rotate the key rather than hunting for it.\n\nKeys are not interchangeable with sign-in. A session cookie will not\nauthenticate here, and a key will not authenticate the routes a signed-in\nperson uses. That separation is deliberate: a leaked key must stay a\ncapped, revocable, audited credential rather than becoming account\ntakeover.\n\n**Send it over HTTPS from a server you control.** A key in browser\nJavaScript, a mobile binary, or a public repository is a key someone\nelse has — treat a leak as an incident and rotate immediately.\n"
      },
      "SessionCookie": {
        "type": "apiKey",
        "in": "cookie",
        "name": "session",
        "x-displayName": "Slay sign-in",
        "description": "Your own signed-in session — not something an integrator uses.\n\nIt appears here for one reason: `POST /api/agents` mints keys, and a key\nmust not be able to mint another key. Only a signed-in human can create\none, so that a compromised key cannot quietly issue itself successors.\n"
      }
    },
    "responses": {
      "InvalidKey": {
        "description": "Missing or unrecognised key.",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "Forbidden": {
        "description": "The key is valid but lacks the capability, or a restriction blocked it.\n",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "RateLimited": {
        "description": "`limit_exceeded` — a spend cap on the key, not a request rate.\n\nTwo different caps produce it, and they need opposite handling:\n`perTransactionCc` will never pass for this amount no matter how long\nyou wait, and `perDayCc` resets at 00:00 UTC. Backing off and retrying\nis wrong for the first and slow for the second — read the message,\nwhich names which cap was hit and what was already spent.\n",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      }
    },
    "schemas": {
      "Error": {
        "type": "object",
        "required": [
          "error",
          "code"
        ],
        "properties": {
          "error": {
            "type": "string",
            "description": "Human-readable, safe to log. Wording may change."
          },
          "code": {
            "type": "string",
            "description": "Stable. Branch on this, never on `error`.",
            "enum": [
              "bad_request",
              "client_tx_id_required",
              "invalid_key",
              "forbidden",
              "trading_not_approved",
              "not_found",
              "conflict",
              "gone",
              "unprocessable",
              "limit_exceeded",
              "rate_limited",
              "unavailable",
              "internal"
            ]
          }
        }
      },
      "Transaction": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "type": {
            "type": "string",
            "description": "e.g. `send`, `receive`, `topup`, `house_fee`.",
            "example": "send"
          },
          "amountCc": {
            "type": "string",
            "description": "Signed decimal string. Negative leaves the wallet.\n",
            "example": "-3.000000"
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "confirmed",
              "failed"
            ]
          },
          "memo": {
            "type": [
              "string",
              "null"
            ],
            "description": "The user's memo. Internal bookkeeping the server appends is\nstripped before it reaches you.\n"
          },
          "clientTxId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Set for transfers created through this API."
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "Transfer": {
        "type": "object",
        "required": [
          "clientTxId",
          "status",
          "amountCc"
        ],
        "properties": {
          "clientTxId": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "settled",
              "pending",
              "failed"
            ]
          },
          "amountCc": {
            "type": "string",
            "description": "What actually moved — which is not always what was requested. A\ntransfer fee, when one applies, is taken from the amount, so the\nrecipient receives this figure rather than the number you sent.\nReconcile against this, never against your request.\n",
            "example": "1.894700"
          },
          "id": {
            "type": "string"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    }
  }
};

export default spec;
