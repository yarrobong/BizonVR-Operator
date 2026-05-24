# BizonVR Club Control

This repository combines the MVP requirements for the BizonVR Meta Quest management system.
We utilize a full-stack Node.js + Express + React architecture configured to run on a single cloud service to ease deployment and meet AI Studio runtime requirements, while splitting out the local components.

## Directory Structure

*   \`/src/server/\` and \`server.ts\` - **Cloud Backend** (Express, standard REST API + SQLite mock for MVP)
*   \`/src/components/\` and \`/src/pages/\` - **Web Operator Panel** (React, Tailwind, TanStack Query)
*   \`/local-hub/\` - **Local Hub** (Node.js script polling the backend for device commands)
*   \`/quest-agent/\` - **Quest Agent** Boilerplate (Android/Kotlin layout)
*   \`/docs/\` - Documentation files

## Running the Architecture

1.  The cloud backend and web UI run via \`npm run dev\`.
2.  The local hub runs via \`node local-hub/hub.js\`.

## Constraints Addressed
- Command chain: Web -> Cloud API -> DeviceCommand DB -> Local Hub Sync.
- No direct cloud-to-device ADB.
- Safe process runners for ADB commands.
