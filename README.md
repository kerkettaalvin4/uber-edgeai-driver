# Uber EdgeAI Driver

React Native driver-side client for the EdgeAI logistics project. The app uses the React Native Community CLI and the New Architecture; native tracking and telemetry will be added through Kotlin and Swift modules as the project progresses.

## Current status

The React Native 0.88 application connects to the development gateway, replays a synthetic drive, and queues demo trip-status operations in AsyncStorage. The domain layer now includes a tested GPS Kalman filter, but it is not yet connected to device location; driver availability, native tracking, and maps are still pending.

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

The backend is a separate TypeScript service; it is not part of the React Native bundle. To run it with Redis and PostGIS using Docker Compose, copy `.env.example` to `.env`, replace the development JWT secret with a random value of at least 32 characters, then run `docker compose up --build`. The gateway listens on port 3001. Request a local development token with `POST http://localhost:3001/v1/dev-token`, then connect to `ws://localhost:3001/v1/stream` with `Authorization: Bearer <token>`. After sending a `session.resume` envelope, list sample drives with `GET /v1/dev/scenarios` and start one with `POST /v1/dev/scenarios/blr-short-drive-v1/replay` and JSON body `{"tripId":"trip-demo-1","maxMessagesPerSecond":10`. It replays 11 synthetic Bangalore location points, five resolution-8 H3 surge updates, and a route update on the WebSocket. Replay is limited to 20 messages per second. The authenticated `POST /v1/sync` accepts up to 200 UUIDv7 operations, deduplicates them in PostgreSQL, and returns state merged with max-ordinal, HLC last-writer-wins, and observed-remove set rules.

To work on just the service without Docker, run `npm install` in `backend`, start Redis and PostgreSQL, copy `backend/.env.example` to `backend/.env` and load those variables in your shell, then run `npm run dev` from `backend`. Backend checks are `npm test`, `npm run typecheck`, and `npm run build` from that directory.

## Connect the Android emulator to the gateway

Start the stack with `docker compose up --build`, then start Metro with `npm start` and launch the app in another terminal with `npm run android`. The demo screen uses `http://10.0.2.2:3001` for the Android emulator. Tap **Connect to gateway**, then **Start demo drive** to see location, surge, and route messages. The app sends a heartbeat every 15 seconds and reconnects after a dropped connection using jittered backoff; on reconnect it resumes using the last received server sequence. In **Active trip**, advance the status through the allowed lifecycle or cancel it. Each status is saved with its UUIDv7 operation and HLC/vclock metadata in AsyncStorage; when connected it syncs to `/v1/sync`, and when offline it remains queued for the next retry. Server merged trip state reconciles locally by keeping the more advanced lifecycle status. A received HLC more than 60 seconds ahead of the device clock triggers a warning. For an iOS simulator, the app uses `localhost`; for a physical phone, change the base URL in `src/config/gateway.ts` to your computer's LAN IP. Rebuild the native app after installing AsyncStorage.

## Architecture

- `src/domain` holds pure TypeScript business rules.
- `src/data` holds local sync persistence and remote/native adapters.
- `src/presentation` will hold the React Native screens and UI state.
- `backend` will hold the telemetry gateway.
- `native` will hold Codegen specifications and native module implementations.

See [docs/PROGRESS.md](docs/PROGRESS.md) for implemented work, tests, and known environment limitations.



