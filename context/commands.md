# Commands Module

## Overview

The `src/commands` module defines the command-line interface of the TENEX application. It uses the `commander` library to create a hierarchy of commands and subcommands, and it maps each command to a specific action. This module is the main entry point for users interacting with TENEX from the command line.

## Key Components

- **`tenex.ts`**: The root file of the CLI, which initializes the `commander` program and adds all the main commands.

- **`agent/`**: Contains the logic for the `agent` command and its subcommands, such as `add`, `list`, and `remove`. These commands are used to manage the agents in the system.

- **`daemon/`**: Contains the logic for the `daemon` command, which is used to start and stop the TENEX daemon process.

- **`debug/`**: Contains a set of debugging commands, such as `chat`, `conversation`, and `timeline`, which are useful for inspecting the internal state of the application.

- **`project/`**: Contains the logic for the `project` command, which is used to manage TENEX projects.

- **`setup/`**: Contains the logic for the `setup` command, which is used to configure the TENEX CLI.

- **`inventory/`**: Contains the logic for the `inventory` command, which is used to generate an inventory of the project.

- **`mcp/`**: Contains the logic for the `mcp` command, which is used to interact with the Model Context Protocol.
