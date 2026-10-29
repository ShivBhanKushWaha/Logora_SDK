// Put this in src/logora.ts of a React Native app and import it once at startup.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { LogoraSdk } from '@shiv-kush/logora-sdk';

export const logora = new LogoraSdk({
  endpoint: 'https://api.example.com',
  key: 'lgr_replace_me',
  service: 'my-app',
  environment: __DEV__ ? 'development' : 'production',
  storage: AsyncStorage,
  beforeSend: (event) => (event.message.includes('password') ? null : event),
});

logora.installGlobalHandlers();

AppState.addEventListener('change', (state) => {
  if (state === 'background') {
    void logora.flush();
  }
});
