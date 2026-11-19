import { Platform } from 'react-native';

// Android emulators reach the host machine through 10.0.2.2. iOS simulators
// can use localhost. Set this to your computer's LAN IP when using a device.
export const GATEWAY_HTTP_URL = Platform.OS === 'android'
  ? 'http://10.0.2.2:3001'
  : 'http://localhost:3001';

export const GATEWAY_WS_URL = GATEWAY_HTTP_URL.replace(/^http/, 'ws');
