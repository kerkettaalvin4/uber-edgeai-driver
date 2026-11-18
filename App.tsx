import { StatusBar, StyleSheet, Text, View } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';

function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>
            Uber EdgeAI Driver
          </Text>
          <Text style={styles.subtitle}>React Native mobile foundation</Text>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f5f7fa',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    color: '#172033',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#526078',
    fontSize: 16,
    marginTop: 8,
  },
});

export default App;
