import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import { GATEWAY_HTTP_URL } from './src/config/gateway';
import {
  GatewayClient,
  type GatewayConnectionState,
  type GatewayFrame,
} from './src/data/GatewayClient';

interface LocationSummary {
  lat: number;
  lng: number;
  speed: number;
}

interface SurgeSummary {
  h3: string;
  multiplier: number;
}

interface DriveSummary {
  locationBatches: number;
  surgeUpdates: number;
  routeVersion: number | null;
  lastLocation: LocationSummary | null;
  surgeCells: SurgeSummary[];
  lastMessageType: string | null;
}

const emptyDrive: DriveSummary = {
  locationBatches: 0,
  surgeUpdates: 0,
  routeVersion: null,
  lastLocation: null,
  surgeCells: [],
  lastMessageType: null,
};

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== 'object' || value[0] === null) return null;
  return value[0] as Record<string, unknown>;
}

function isScenarioMessage(type: string): boolean {
  return type === 'telemetry.location.batch' || type === 'pricing.surge' || type === 'route.update';
}

function App() {
  const [connection, setConnection] = useState<GatewayConnectionState>('offline');
  const [error, setError] = useState('');
  const [drive, setDrive] = useState<DriveSummary>(emptyDrive);
  const [isReplaying, setIsReplaying] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState('No status has been synced yet');
  const scenarioFrameCount = useRef(0);
  const clientRef = useRef<GatewayClient | null>(null);

  const handleFrame = useCallback((frame: GatewayFrame) => {
    if (isScenarioMessage(frame.type)) {
      scenarioFrameCount.current += 1;
      if (scenarioFrameCount.current >= 17) setIsReplaying(false);
    }

    setDrive(current => {
      const next = { ...current, lastMessageType: frame.type };
      if (frame.type === 'telemetry.location.batch') {
        const point = firstRecord(frame.payload.points);
        if (point && typeof point.lat === 'number' && typeof point.lng === 'number') {
          next.locationBatches += 1;
          next.lastLocation = {
            lat: point.lat,
            lng: point.lng,
            speed: typeof point.spdMps === 'number' ? point.spdMps : 0,
          };
        }
      } else if (frame.type === 'pricing.surge') {
        next.surgeUpdates += 1;
        const changed = Array.isArray(frame.payload.changed) ? frame.payload.changed : [];
        next.surgeCells = changed.flatMap(item => {
          if (!item || typeof item !== 'object') return [];
          const cell = item as Record<string, unknown>;
          if (typeof cell.h3 !== 'string' || typeof cell.mult !== 'number') return [];
          return [{ h3: cell.h3, multiplier: cell.mult }];
        });
      } else if (frame.type === 'route.update' && typeof frame.payload.routeVersion === 'number') {
        next.routeVersion = frame.payload.routeVersion;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const client = new GatewayClient({
      onStateChange: setConnection,
      onFrame: handleFrame,
      onError: setError,
    });
    clientRef.current = client;
    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [handleFrame]);

  const connect = async () => {
    setError('');
    try {
      await clientRef.current?.connect();
    } catch {
      // GatewayClient reports a readable error through onError.
    }
  };

  const replayDrive = async () => {
    setError('');
    setDrive(emptyDrive);
    scenarioFrameCount.current = 0;
    try {
      await clientRef.current?.replayScenario();
      setIsReplaying(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start the demo drive');
    }
  };

  const disconnect = () => {
    clientRef.current?.disconnect();
    setIsReplaying(false);
  };

  const syncDemoStatus = async () => {
    setError('');
    setIsSyncing(true);
    try {
      const receipt = await clientRef.current?.syncDemoStatus();
      if (receipt) {
        const pending = await clientRef.current?.getPendingSyncCount() ?? 0;
        setSyncSummary(`${receipt.accepted.length} accepted · ${pending} waiting to sync · server version ${receipt.serverVersion}`);
      }
    } catch (reason) {
      const pending = await clientRef.current?.getPendingSyncCount() ?? 0;
      if (pending > 0) setSyncSummary(`${pending} operation saved on this device; it will retry next time you sync`);
      setError(reason instanceof Error ? reason.message : 'Could not sync trip status');
    } finally {
      setIsSyncing(false);
    }
  };

  const connected = connection === 'live';

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>Uber EdgeAI Driver</Text>
          <Text style={styles.subtitle}>Gateway connection demo</Text>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Connection</Text>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, connected ? styles.statusLive : connection === 'connecting' ? styles.statusConnecting : styles.statusOffline]} />
              <Text style={styles.statusText} accessibilityLabel={`Gateway ${connection}`}>
                {connection === 'live' ? 'Connected' : connection === 'connecting' ? 'Connecting…' : 'Offline'}
              </Text>
              {connection === 'connecting' ? <ActivityIndicator size="small" color="#1c6b52" /> : null}
            </View>
            <Text style={styles.address}>Gateway: {GATEWAY_HTTP_URL}</Text>
            <Pressable
              accessibilityRole="button"
              disabled={connection === 'connecting'}
              onPress={connected ? disconnect : connect}
              style={[styles.button, connected ? styles.secondaryButton : styles.primaryButton, connection === 'connecting' && styles.disabledButton]}>
              <Text style={[styles.buttonText, connected && styles.secondaryButtonText]}>
                {connected ? 'Disconnect' : 'Connect to gateway'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Demo drive</Text>
            <Text style={styles.description}>Replay a synthetic Bengaluru trip through the live connection.</Text>
            <Pressable
              accessibilityRole="button"
              disabled={!connected || isReplaying}
              onPress={replayDrive}
              style={[styles.button, styles.primaryButton, (!connected || isReplaying) && styles.disabledButton]}>
              <Text style={styles.buttonText}>{isReplaying ? 'Drive is playing…' : 'Start demo drive'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!connected || isSyncing}
              onPress={syncDemoStatus}
              style={[styles.button, styles.secondaryButton, styles.syncButton, (!connected || isSyncing) && styles.disabledButton]}>
              <Text style={styles.secondaryButtonText}>{isSyncing ? 'Syncing…' : 'Sync demo status'}</Text>
            </Pressable>
            <Text style={styles.muted}>{syncSummary}</Text>
          </View>

          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Live data</Text>
            <View style={styles.metrics}>
              <Metric label="Location batches" value={drive.locationBatches} />
              <Metric label="Surge updates" value={drive.surgeUpdates} />
              <Metric label="Route version" value={drive.routeVersion ?? '—'} />
            </View>
            {drive.lastLocation ? (
              <Text style={styles.dataLine}>
                Latest fix: {drive.lastLocation.lat.toFixed(5)}, {drive.lastLocation.lng.toFixed(5)} · {drive.lastLocation.speed.toFixed(1)} m/s
              </Text>
            ) : <Text style={styles.muted}>Waiting for location data</Text>}
            {drive.surgeCells.map(cell => (
              <Text key={cell.h3} style={styles.dataLine}>{cell.h3} · {cell.multiplier.toFixed(1)}× surge</Text>
            ))}
            {drive.lastMessageType ? <Text style={styles.muted}>Last message: {drive.lastMessageType}</Text> : null}
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f3f6f4' },
  content: { padding: 22, paddingBottom: 36 },
  title: { color: '#17231d', fontSize: 27, fontWeight: '700' },
  subtitle: { color: '#617168', fontSize: 15, marginTop: 5, marginBottom: 20 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 18, marginBottom: 14, borderWidth: 1, borderColor: '#e2e9e4' },
  sectionTitle: { color: '#17231d', fontSize: 18, fontWeight: '700', marginBottom: 13 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusLive: { backgroundColor: '#15925e' },
  statusConnecting: { backgroundColor: '#e2a521' },
  statusOffline: { backgroundColor: '#9aa8a0' },
  statusText: { color: '#24362c', fontSize: 16, fontWeight: '600', flex: 1 },
  address: { color: '#728078', fontSize: 12, marginBottom: 14 },
  description: { color: '#617168', fontSize: 14, lineHeight: 20, marginBottom: 14 },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 11, paddingHorizontal: 14 },
  primaryButton: { backgroundColor: '#146b4d' },
  secondaryButton: { backgroundColor: '#e6f1eb' },
  syncButton: { marginTop: 10 },
  disabledButton: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryButtonText: { color: '#146b4d' },
  error: { color: '#a83232', backgroundColor: '#fff0f0', borderRadius: 10, padding: 12, marginBottom: 14 },
  metrics: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  metric: { flex: 1 },
  metricValue: { color: '#146b4d', fontSize: 25, fontWeight: '700' },
  metricLabel: { color: '#728078', fontSize: 11, marginTop: 3 },
  dataLine: { color: '#32463a', fontSize: 13, marginTop: 7 },
  muted: { color: '#849189', fontSize: 12, marginTop: 9 },
});

export default App;
