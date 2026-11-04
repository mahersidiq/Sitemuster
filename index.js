// App entry: register the Android headless tracking task before the router mounts the app
// (react-native-background-geolocation "enableHeadless"; docs/spec/03).
import './src/tracking/headless-entry';
import 'expo-router/entry';
