# Uber EdgeAI Driver

React Native driver-side client for the EdgeAI logistics project. The app uses the React Native Community CLI and the New Architecture; native tracking and telemetry will be added through Kotlin and Swift modules as the project progresses.

## Current status

The React Native 0.88 application shell and native Android/iOS projects are scaffolded. The current screen is only the app root; it does not yet implement online availability, tracking, maps, or synchronization.

## Requirements

- Node.js 22.11 or newer and npm.
- Android development: Android Studio, Android SDK, and a compatible JDK. Install the SDK and JDK versions listed in the React Native environment setup guide.
- iOS development: macOS with Xcode and CocoaPods.

## Install and run

```sh
npm install
npm test
npm run lint
npm run typecheck
npm start
```

In another terminal, run `npm run android` or `npm run ios` after setting up the relevant native toolchain and emulator/device.

## Telemetry gateway (development)

The backend is a separate TypeScript service; it is not part of the React Native bundle. To run it with Redis and PostGIS using Docker Compose, copy `.env.example` to `.env`, replace the development JWT secret with a random value of at least 32 characters, then run `docker compose up --build`. The gateway listens on port 3001. Request a local development token with `POST http://localhost:3001/v1/dev-token`, then connect to `ws://localhost:3001/v1/stream` with `Authorization: Bearer <token>`. The authenticated `POST /v1/sync` accepts up to 200 UUIDv7 operations and stores idempotency records in PostgreSQL.

To work on just the service without Docker, run `npm install` in `backend`, start Redis and PostgreSQL, copy `backend/.env.example` to `backend/.env` and load those variables in your shell, then run `npm run dev` from `backend`. Backend checks are `npm test`, `npm run typecheck`, and `npm run build` from that directory.

## Architecture

- `src/domain` holds pure TypeScript business rules.
- `src/data` will hold local persistence and remote/native adapters.
- `src/presentation` will hold the React Native screens and UI state.
- `backend` will hold the telemetry gateway.
- `native` will hold Codegen specifications and native module implementations.

See [docs/PROGRESS.md](docs/PROGRESS.md) for implemented work, tests, and known environment limitations.

