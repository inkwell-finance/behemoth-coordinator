# behemoth-coordinator

> **🔓 OPEN SOURCE** - Code is auditable, but configuration values remain private.

## Overview

The coordinator acts as the trusted bridge between the P2P research network and the private trading system. It:

- Validates research proposals
- Distributes backtest jobs to compute nodes
- Aggregates results and applies noise
- Calculates impact scores
- Interfaces with Solana for rewards

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   BEHEMOTH COORDINATOR                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    P2P Bridge                            │    │
│  │  (Connects to behemoth-researcher nodes via libp2p)     │    │
│  └───────────────────────────┬─────────────────────────────┘    │
│                              │                                   │
│  ┌───────────┬───────────────┼───────────────┬───────────┐      │
│  │           │               │               │           │      │
│  ▼           ▼               ▼               ▼           ▼      │
│ ┌───────┐ ┌───────┐   ┌───────────┐   ┌───────┐ ┌───────────┐  │
│ │Rate   │ │Proposal│   │Job        │   │Result │ │Impact     │  │
│ │Limiter│ │Validator│   │Distributor│   │Aggreg │ │Calculator │  │
│ └───────┘ └───────┘   └───────────┘   └───────┘ └───────────┘  │
│                              │               │                   │
│                              │               ▼                   │
│                              │         ┌───────────┐            │
│                              │         │Noise      │            │
│                              │         │Injector   │            │
│                              │         └───────────┘            │
│                              │                                   │
│  ┌───────────────────────────▼─────────────────────────────┐    │
│  │              gRPC Client (to behemoth-trader)           │    │
│  │              (Internal network only, mTLS)              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Solana Client (rewards, registry)          │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Why Open Source?

- **Trust**: Participants can verify proposal validation is fair
- **Audit**: Security researchers can review the codebase
- **Transparency**: Noise injection logic is visible (parameters are not)

## What Stays Private

The `config/` directory contains private values:
- `noise.score_variance`: Exact noise percentage
- `noise.false_rejection_rate`: Rate of valid proposal rejections
- `rate_limits.*`: Exact rate limiting parameters
- `audit.sample_rate`: Random audit percentage

## Running

```bash
# Development
bun run dev

# Production (requires private config)
CONFIG_PATH=/path/to/private/config.yaml bun run start
```

## Dependencies

- `@behemoth/protocol`: Shared types and schemas
- `@behemoth/contracts-sdk`: Solana program interfaces

