# Nostr Module

## Overview

The `src/nostr` module is responsible for all interactions with the Nostr protocol. This includes managing the Nostr client, publishing events, and handling tasks received from the Nostr network. This module is key to the decentralized and collaborative capabilities of TENEX.

## Key Components

- **`ndkClient.ts`**: Initializes and manages the Nostr Development Kit (NDK) client. It handles the connection to Nostr relays and provides a high-level API for interacting with the Nostr network.

- **`AgentPublisher.ts`**: A class that simplifies the process of publishing agent-related events to the Nostr network. It handles the creation and signing of events, and ensures that they are sent to the appropriate relays.


- **`AgentStreamer.ts`**: Handles streaming of agent responses over the Nostr network.

- **`AgentEventEncoder.ts`** and **`AgentEventDecoder.ts`**: Handle encoding and decoding of agent events for Nostr communication.

- **`types.ts`**: Defines the data structures and types used throughout the Nostr module, such as `NostrEvent`, `NostrTag`, and `NostrProfile`.
