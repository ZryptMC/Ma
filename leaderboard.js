/* ---------------------------------------------------------------------
   Online leaderboard (Firebase Firestore).
   Fully optional: if firebase-config.js still has placeholder values,
   every function below quietly no-ops and the game runs 100% offline.
--------------------------------------------------------------------- */
"use strict";

const Leaderboard = (() => {
  let db = null;
  let ready = false;

  function isConfigured() {
    const c = window.FIREBASE_CONFIG;
    return c && c.apiKey && c.apiKey !== "YOUR_API_KEY" && typeof firebase !== "undefined";
  }

  function init() {
    if (!isConfigured()) return false;
    try {
      if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
      db = firebase.firestore();
      ready = true;
    } catch (e) {
      console.warn("Leaderboard disabled:", e);
      ready = false;
    }
    return ready;
  }

  async function submitScore(name, timeSeconds, keysCollected) {
    if (!ready) return false;
    const cleanName = (name || "مجهول").toString().trim().slice(0, 16) || "مجهول";
    try {
      await db.collection("scores").add({
        name: cleanName,
        timeSeconds: Math.round(timeSeconds * 10) / 10,
        keysCollected: Math.max(0, Math.min(3, keysCollected | 0)),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    } catch (e) {
      console.warn("submitScore failed:", e);
      return false;
    }
  }

  async function topScores(limit = 10) {
    if (!ready) return [];
    try {
      const snap = await db.collection("scores").orderBy("timeSeconds", "asc").limit(limit).get();
      return snap.docs.map((d) => d.data());
    } catch (e) {
      console.warn("topScores failed:", e);
      return [];
    }
  }

  return { init, submitScore, topScores, isConfigured, isReady: () => ready };
})();
