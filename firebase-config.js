/* ---------------------------------------------------------------------
   Firebase configuration
   ---------------------------------------------------------------------
   1. Go to https://console.firebase.google.com -> create a project (free).
   2. Inside the project: Build > Firestore Database > Create database
      (start in "Locked mode", pick a nearby region).
   3. Open the Firestore "Rules" tab and paste the contents of
      firestore.rules from this project, then click "Publish".
   4. That's it — the leaderboard on the menu/win screens will start
      working automatically. If you leave the placeholders below as-is,
      the game still runs fully offline, it just skips the leaderboard.
--------------------------------------------------------------------- */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDD-kNMhhGRBKEOqIY6fKMhaT6pcBEAQnE",
  authDomain: "don-t-look-back-ca0c0.firebaseapp.com",
  databaseURL: "https://don-t-look-back-ca0c0-default-rtdb.firebaseio.com",
  projectId: "don-t-look-back-ca0c0",
  storageBucket: "don-t-look-back-ca0c0.firebasestorage.app",
  messagingSenderId: "978946615417",
  appId: "1:978946615417:web:023880b6b8d623e9efcca8",
  measurementId: "G-MQ3D644D2T",
};
