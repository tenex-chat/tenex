---
title: Swift Rust Architecture
slug: swift-rust-architecture
summary: All business logic belongs in the Rust side; the Swift side handles presentation logic exclusively, dispatching calls to Rust
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-19
updated: 2026-05-19
verified: 2026-05-19
compiled-from: conversation
sources:
  - session:fe63628b-e936-4017-ad5d-db007827b9a2
---

# Swift Rust Architecture

## Architecture Split

All business logic belongs in the Rust side; the Swift side handles presentation logic exclusively, dispatching calls to Rust. For example, a 'rotate key package' button only fires the FFI call. [^fe636-6]

## See Also

