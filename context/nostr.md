# Nostr Module

## Overview

The `src/nostr` module is responsible for all interactions with the Nostr protocol. This includes managing the Nostr client, publishing events, and handling tasks received from the Nostr network. This module is key to the decentralized and collaborative capabilities of TENEX.

## Key Components

- **`ndkClient.ts`**: Initializes and manages the Nostr Development Kit (NDK) client. It handles the connection to Nostr relays and provides a high-level API for interacting with the Nostr network.

- **`NostrPublisher.ts`**: A class that simplifies the process of publishing events to the Nostr network. It handles the creation and signing of events, and ensures that they are sent to the appropriate relays.

- **`TaskPublisher.ts`**: A specialized publisher for tasks. It publishes tasks to the Nostr network and allows other clients to subscribe to them.

- **`TypingIndicatorManager.ts`**: Manages the sending and receiving of typing indicators over the Nostr network, providing real-time feedback to users during conversations.

- **`factory.ts`**: A factory for creating different types of Nostr events.

- **`types.ts`**: Defines the data structures and types used throughout the Nostr module, such as `NostrEvent`, `NostrTag`, and `NostrProfile`.
