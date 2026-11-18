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

## Architecture

- `src/domain` holds pure TypeScript business rules.
- `src/data` will hold local persistence and remote/native adapters.
- `src/presentation` will hold the React Native screens and UI state.
- `backend` will hold the telemetry gateway.
- `native` will hold Codegen specifications and native module implementations.

See [docs/PROGRESS.md](docs/PROGRESS.md) for implemented work, tests, and known environment limitations.
