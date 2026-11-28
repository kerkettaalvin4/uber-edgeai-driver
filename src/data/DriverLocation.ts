import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import type { EmitterSubscription } from 'react-native';

export interface NativeLocationFix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  timestampMs: number;
  bearingDeg?: number;
}

interface DriverLocationNativeModule {
  startTracking(): Promise<boolean>;
  stopTracking(): Promise<boolean>;
}

const nativeModule = NativeModules.DriverLocation as DriverLocationNativeModule | undefined;

export async function startDriverLocationTracking(): Promise<void> {
  if (Platform.OS !== 'android' || !nativeModule) {
    throw new Error('Live GPS tracking is currently implemented for Android only.');
  }
  await nativeModule.startTracking();
}

export async function stopDriverLocationTracking(): Promise<void> {
  if (nativeModule) await nativeModule.stopTracking();
}

export function subscribeToDriverLocation(
  listener: (fix: NativeLocationFix) => void,
): EmitterSubscription | null {
  if (Platform.OS !== 'android' || !nativeModule) return null;
  return DeviceEventEmitter.addListener('driverLocation', listener);
}
