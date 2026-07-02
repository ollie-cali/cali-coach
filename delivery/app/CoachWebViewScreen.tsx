// TODAY-TIER: ship Cali Coach inside the app as a WebView (zero native work).
// [Maker Ollie delivery] The demo is live at https://ollie-cali.github.io/cali-coach/
// Requires: npx expo install react-native-webview
// iOS: add NSCameraUsageDescription to app.json infoPlist.
// Android: camera permission + webview grants below.
import React from "react";
import { WebView } from "react-native-webview";

export default function CoachWebViewScreen() {
  return (
    <WebView
      source={{ uri: "https://ollie-cali.github.io/cali-coach/" }}
      style={{ flex: 1, backgroundColor: "#0d1014" }}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      // Android: grant the camera to the page
      onPermissionRequest={(e: any) => e?.nativeEvent?.grant?.()}
      javaScriptEnabled
      domStorageEnabled
    />
  );
}
// Later: postMessage bridge — the page can postMessage(sessionJSON) and this
// screen inserts into coach_sessions via supabase-js, so even the WebView tier
// feeds the Skill Swirl. (window.ReactNativeWebView.postMessage in the page.)
