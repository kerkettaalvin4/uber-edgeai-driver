import { render, screen } from '@testing-library/react-native';
import App from '../../App';

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');

  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    SafeAreaView: View,
  };
});

test('shows the EdgeAI driver app root', async () => {
  await render(<App />);

  expect(
    screen.getByRole('header', { name: 'Uber EdgeAI Driver' }),
  ).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Connect to gateway' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Start demo drive' })).toBeDisabled();
  expect(screen.getByText('En Route To Pickup')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Mark arrived at pickup' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Cancel trip' })).toBeEnabled();
}, 10_000);
