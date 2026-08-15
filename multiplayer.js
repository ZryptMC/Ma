/* ---------------------------------------------------------------------
   Multiplayer rooms — Firebase Realtime Database.
   Lets a host create a room (with a short join code) and configure
   monster/difficulty, max players, and public/private. Friends join with
   the code. Once the host starts the game, everyone in the room loads the
   same map/difficulty and sees each other move around; the host's client
   is authoritative for the monster so every player sees the same one.

   Fully optional, same spirit as leaderboard.js: if Firebase isn't
   configured or the realtime database can't be reached, every function
   quietly fails and callers fall back to a friendly error message instead
   of crashing.
--------------------------------------------------------------------- */
"use strict";

const Multiplayer = (() => {
  let db = null;
  let ready = false;
  let roomCode = null;
  let isHost = false;
  let playersCache = {};
  let monsterCache = null;
  let roomListenerRef = null;
  let playersListenerRef = null;
  let monsterListenerRef = null;
  let statusCb = null;
  let playersCb = null;
  let chatCb = null;
  let posThrottleAcc = 0;

  // ----- Local (LAN) play — direct WebRTC data channel, no Firebase, no
  // internet required. Only host+1 guest (a single direct P2P link), with
  // manual copy/paste signaling since a browser page can't discover peers
  // on the network by itself. `backend` picks which backend the shared API
  // functions below (sendPosition, getPlayers, leaveRoom, ...) talk to. -----
  let backend = "online";
  let localPc = null;
  let localChannel = null;
  let localIsHost = false;
  let localPlayers = {};
  let localMonster = null;
  let localOpts = { difficulty: "normal", mapId: "corridor" };

  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I

  function uid() {
    // Priority: a real Google account is always most reliable. Next, a
    // typed-name recovery key (see loginWithName) — deterministic, so
    // retyping the same name always lands on the same save. Then an
    // anonymous Firebase session (plain "guest" — intentionally NOT
    // recoverable, matching how guest mode is supposed to work). Only
    // falls back to the old random localStorage id if Firebase auth
    // genuinely isn't available at all.
    if (typeof firebase !== "undefined" && firebase.auth && firebase.auth().currentUser && !firebase.auth().currentUser.isAnonymous) {
      return firebase.auth().currentUser.uid;
    }
    const nameKey = localStorage.getItem("dlb_uid_name_key");
    if (nameKey) return nameKey;
    if (typeof firebase !== "undefined" && firebase.auth && firebase.auth().currentUser) {
      return firebase.auth().currentUser.uid;
    }
    const gid = localStorage.getItem("dlb_uid_google");
    if (gid) return gid;
    let id = localStorage.getItem("dlb_uid");
    if (!id) {
      id = "p" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem("dlb_uid", id);
    }
    return id;
  }

  function getName() {
    return localStorage.getItem("dlb_name") || "Guest";
  }
  function setName(name) {
    const clean = (name || "Guest").toString().trim().slice(0, 14) || "Guest";
    localStorage.setItem("dlb_name", clean);
    syncUserProfile();
    return clean;
  }
  function getGender() {
    return localStorage.getItem("dlb_gender") || "boy";
  }
  // Keep in sync with CHARACTER_KEYS in game.js — any character key added
  // there for a new selectable model needs to be added here too, or this
  // will silently clamp it back down to "boy".
  const VALID_GENDERS = ["boy", "girl", "boy2"];
  function setGender(g) {
    const clean = VALID_GENDERS.includes(g) ? g : "boy";
    localStorage.setItem("dlb_gender", clean);
    syncProfileData();
    return clean; // callers (Freddy settings save) rely on this to sync to the room
  }

  /* ----- XP (local for now — used by the hub/lobby XP bar) ----- */
  function getXp() {
    return parseInt(localStorage.getItem("dlb_xp") || "0", 10);
  }
  function addXp(amount) {
    const next = Math.max(0, getXp() + (amount | 0));
    localStorage.setItem("dlb_xp", String(next));
    syncProfileData();
    return next;
  }

  /* ---------------------------------------------------------------------
     Friends — request / accept / invite straight into your current room.
     Your permanent "friend code" is just your own uid() (short + stable),
     shown in the friends screen for others to type once. After that,
     invites use your room code automatically — no one has to type a
     room code by hand again.
  --------------------------------------------------------------------- */
  let friendReqListenerRef = null;
  let friendsListenerRef = null;
  let inviteListenerRef = null;

  function myFriendCode() { return uid(); }

  // Keep /users/{me}/name fresh so friends see a readable name, not just
  // a code. Safe to call anytime; silently no-ops if not ready yet.
  function syncUserProfile() {
    if (!ready) return;
    db.ref(`users/${uid()}/name`).set(getName()).catch(() => {});
  }

  // Pushes the account-y bits (skin choice, XP, purchased cosmetics) up to
  // Firebase under this uid, so they can be pulled back down later. Called
  // any time one of those actually changes — see setGender/addXp below and
  // the market purchase/equip code in game.js.
  function syncProfileData() {
    if (!ready) return Promise.resolve();
    let market = null;
    try { market = JSON.parse(localStorage.getItem("dlb_market") || "null"); } catch (e) { market = null; }
    return db.ref(`users/${uid()}/profile`).set({
      gender: getGender(),
      xp: getXp(),
      market: market || { owned: [], equipped: null },
    }).catch(() => {});
  }

  // Turns a typed name into a stable, reusable Firebase key. Firebase
  // Realtime Database keys just can't contain . # $ [ ] or / — everything
  // else (Arabic included) is fine as-is. Two people typing the exact same
  // name will end up sharing one save — that's an accepted tradeoff of a
  // no-password "type your name to get your stuff back" system, same as
  // the reference site's username-only login.
  function nameToKey(name) {
    const clean = (name || "").toString().trim().toLowerCase();
    const safe = clean.replace(/[.#$\[\]/]/g, "").replace(/\s+/g, "_");
    return safe ? "n_" + safe : null;
  }

  // The core of "type your name to get your account back": saves the name
  // locally as usual, then either PULLS a previously-saved profile down
  // (skin/xp/cosmetics) if this exact name has been used before, or PUSHES
  // the current local profile up as this name's very first save. Returns
  // true if an existing save was found and restored, false if this is a
  // brand-new name (so the caller can decide whether to still show the
  // skin-pick screen, for example).
  async function loginWithName(name) {
    const clean = setName(name);
    const key = nameToKey(clean);
    if (!key) return false;
    localStorage.setItem("dlb_uid_name_key", key);
    if (!ready) return false;
    try {
      const snap = await db.ref(`users/${key}/profile`).get();
      if (snap.exists()) {
        const p = snap.val() || {};
        if (p.gender) localStorage.setItem("dlb_gender", p.gender);
        if (typeof p.xp === "number") localStorage.setItem("dlb_xp", String(p.xp));
        if (p.market) localStorage.setItem("dlb_market", JSON.stringify(p.market));
        syncUserProfile();
        return true;
      }
      await syncProfileData();
      return false;
    } catch (e) {
      console.warn("loginWithName failed:", e);
      return false;
    }
  }

  // Hands out "GuestNN" names in order (Guest01, Guest02, ...) instead of
  // every guest defaulting to the same generic "Guest"/"لاعب" label. Uses a
  // Firebase transaction on a shared counter so two people tapping "ضيف" at
  // the same moment can never both get the same number. Only ever called
  // ONCE per device — the very first time it plays as a guest — because
  // the resulting name then gets saved to localStorage (dlb_name) and
  // reused after that; see authGuestBtn in game.js.
  async function nextGuestName() {
    if (!ready) return "Guest";
    try {
      const result = await db.ref("meta/guestCounter").transaction((current) => (current || 0) + 1);
      if (!result.committed || result.snapshot.val() == null) return "Guest";
      const n = result.snapshot.val();
      return "Guest" + String(n).padStart(2, "0");
    } catch (e) {
      return "Guest";
    }
  }

  async function sendFriendRequest(targetCode) {
    if (!ready) throw new Error("multiplayer-unavailable");
    const target = (targetCode || "").trim();
    if (!target) throw new Error("empty-code");
    const myUid = uid();
    if (target === myUid) throw new Error("self-add");
    const targetSnap = await db.ref(`users/${target}/name`).get();
    if (!targetSnap.exists()) throw new Error("user-not-found");
    await db.ref(`users/${target}/friendRequestsIncoming/${myUid}`).set({
      name: getName(), at: firebase.database.ServerValue.TIMESTAMP
    });
  }

  function listenFriendRequests(cb) {
    if (!ready) return;
    if (friendReqListenerRef) friendReqListenerRef.off();
    friendReqListenerRef = db.ref(`users/${uid()}/friendRequestsIncoming`);
    friendReqListenerRef.on("value", (snap) => cb(snap.val() || {}));
  }

  async function acceptFriendRequest(fromUid, fromName) {
    if (!ready) return;
    const myUid = uid();
    await Promise.all([
      db.ref(`users/${myUid}/friends/${fromUid}`).set({ name: fromName || "صديق", since: Date.now() }),
      db.ref(`users/${fromUid}/friends/${myUid}`).set({ name: getName(), since: Date.now() }),
      db.ref(`users/${myUid}/friendRequestsIncoming/${fromUid}`).remove()
    ]);
  }

  async function declineFriendRequest(fromUid) {
    if (!ready) return;
    await db.ref(`users/${uid()}/friendRequestsIncoming/${fromUid}`).remove();
  }

  function listenFriends(cb) {
    if (!ready) return;
    if (friendsListenerRef) friendsListenerRef.off();
    friendsListenerRef = db.ref(`users/${uid()}/friends`);
    friendsListenerRef.on("value", (snap) => cb(snap.val() || {}));
  }

  // Invite a friend straight into whatever room you're in right now —
  // they never type a code, they just tap "انضمام" on the popup.
  async function inviteFriendToRoom(friendUid) {
    if (!ready || !roomCode) throw new Error("no-active-room");
    await db.ref(`users/${friendUid}/invites/${roomCode}`).set({
      from: uid(), fromName: getName(), at: firebase.database.ServerValue.TIMESTAMP
    });
  }

  function listenInvites(cb) {
    if (!ready) return;
    if (inviteListenerRef) inviteListenerRef.off();
    inviteListenerRef = db.ref(`users/${uid()}/invites`);
    inviteListenerRef.on("value", (snap) => cb(snap.val() || {}));
  }

  async function dismissInvite(code) {
    if (!ready) return;
    await db.ref(`users/${uid()}/invites/${code}`).remove();
  }

  /* ----- In-room text chat ----- */
  let chatListenerRef = null;
  function sendChatMessage(text) {
    const clean = (text || "").toString().trim().slice(0, 140);
    if (!clean) return;
    if (backend === "local") {
      const msg = { uid: uid(), name: getName(), text: clean, at: Date.now() };
      localSend({ type: "chat", ...msg });
      if (chatCb) chatCb(msg); // local echo — Firebase's own child_added fires for the sender too
      return;
    }
    if (!ready || !roomCode) return;
    db.ref(`rooms/${roomCode}/chat`).push({
      uid: uid(), name: getName(), text: clean, at: firebase.database.ServerValue.TIMESTAMP
    });
  }
  function listenChat(cb) {
    chatCb = cb;
    if (backend === "local") return;
    if (!ready || !roomCode) return;
    if (chatListenerRef) chatListenerRef.off();
    chatListenerRef = db.ref(`rooms/${roomCode}/chat`).limitToLast(50);
    chatListenerRef.on("child_added", (snap) => cb(snap.val()));
  }
  function stopChatListener() {
    chatCb = null;
    if (chatListenerRef) { chatListenerRef.off(); chatListenerRef = null; }
  }

  function isConfigured() {
    const c = window.FIREBASE_CONFIG;
    return c && c.apiKey && c.apiKey !== "YOUR_API_KEY" && typeof firebase !== "undefined" && firebase.database;
  }

  /* =======================================================================
     Local (LAN) play
     =======================================================================
     No signaling server at all — the SDP offer/answer is just a blob of
     text the two players paste to each other by hand (chat app, AirDrop,
     whatever). Once exchanged, RTCPeerConnection connects the two browsers
     directly. iceServers is deliberately empty: no STUN/TURN means only
     local-network ("host") candidates are gathered, so this truly doesn't
     touch the internet, but it also means it only works when both devices
     are actually reachable on the same network.
  --------------------------------------------------------------------- */
  const LOCAL_ICE_TIMEOUT_MS = 4000;

  function localWaitIceComplete(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { pc.removeEventListener("icegatheringstatechange", done); resolve(); };
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") done();
      });
      setTimeout(done, LOCAL_ICE_TIMEOUT_MS);
    });
  }

  function encodeLocalCode(desc) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(desc))));
  }
  function decodeLocalCode(code) {
    return JSON.parse(decodeURIComponent(escape(atob((code || "").trim()))));
  }

  function localReset() {
    if (localChannel) { try { localChannel.close(); } catch (e) {} }
    if (localPc) { try { localPc.close(); } catch (e) {} }
    localPc = null;
    localChannel = null;
    localIsHost = false;
    localPlayers = {};
    localMonster = null;
    backend = "online";
  }

  function localSend(msg) {
    if (localChannel && localChannel.readyState === "open") {
      try { localChannel.send(JSON.stringify(msg)); } catch (e) { /* peer gone */ }
    }
  }

  function localHandlePeerGone() {
    if (localIsHost) {
      const otherUid = Object.keys(localPlayers).find((u) => u !== uid());
      if (otherUid) delete localPlayers[otherUid];
      if (playersCb) playersCb({ ...localPlayers });
    } else if (statusCb) {
      statusCb(null); // mirrors the online "host closed the room" signal
    }
  }

  function localHandleMessage(msg) {
    switch (msg && msg.type) {
      case "hello":
        localPlayers[msg.uid] = { name: msg.name, gender: msg.gender, joinedAt: Date.now(), x: 0, z: 0, yaw: 0, isHost: !localIsHost };
        if (playersCb) playersCb({ ...localPlayers });
        break;
      case "pos":
        if (localPlayers[msg.uid]) Object.assign(localPlayers[msg.uid], { x: msg.x, z: msg.z, yaw: msg.yaw });
        if (playersCb) playersCb({ ...localPlayers });
        break;
      case "selfupdate":
        if (localPlayers[msg.uid]) Object.assign(localPlayers[msg.uid], msg.fields);
        if (playersCb) playersCb({ ...localPlayers });
        break;
      case "monster":
        localMonster = { x: msg.x, z: msg.z, mode: msg.mode, active: msg.active, updatedAt: Date.now() };
        break;
      case "chat":
        if (chatCb) chatCb({ uid: msg.uid, name: msg.name, text: msg.text, at: Date.now() });
        break;
      case "status":
        if (statusCb) statusCb({ status: msg.status, difficulty: msg.difficulty, mapId: msg.mapId, hostId: msg.hostId });
        break;
      case "leave":
        localHandlePeerGone();
        break;
    }
  }

  function localAttachChannelHandlers(dc, myName, myGender) {
    localChannel = dc;
    dc.onopen = () => localSend({ type: "hello", uid: uid(), name: myName, gender: myGender });
    dc.onclose = () => localHandlePeerGone();
    dc.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      localHandleMessage(msg);
    };
  }

  /** Host side, step 1: create the peer connection + offer. Returns a
   *  copy-paste code to send to the other player. */
  async function createLocalRoom(opts) {
    localReset();
    backend = "local";
    localIsHost = true;
    localOpts = { difficulty: (opts && opts.difficulty) || "normal", mapId: (opts && opts.mapId) || "corridor" };
    const myUid = uid();
    localPlayers = { [myUid]: { name: getName(), gender: getGender(), joinedAt: Date.now(), x: 0, z: 0, yaw: 0, isHost: true } };

    localPc = new RTCPeerConnection({ iceServers: [] });
    localAttachChannelHandlers(localPc.createDataChannel("game"), getName(), getGender());
    localPc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(localPc.connectionState)) localHandlePeerGone();
    };

    const offer = await localPc.createOffer();
    await localPc.setLocalDescription(offer);
    await localWaitIceComplete(localPc);
    return encodeLocalCode(localPc.localDescription);
  }

  /** Host side, step 2: paste in the guest's answer code to finish connecting. */
  async function completeLocalRoom(answerCode) {
    if (!localPc) throw new Error("no-local-host-pending");
    const answer = decodeLocalCode(answerCode);
    await localPc.setRemoteDescription(answer);
  }

  /** Guest side, step 1: paste in the host's offer code; returns the answer
   *  code to send back. Connection finishes as soon as the host applies it. */
  async function joinLocalRoom(offerCode) {
    localReset();
    backend = "local";
    localIsHost = false;
    const myUid = uid();
    localPlayers = { [myUid]: { name: getName(), gender: getGender(), joinedAt: Date.now(), x: 0, z: 0, yaw: 0, isHost: false } };

    const offer = decodeLocalCode(offerCode);
    localPc = new RTCPeerConnection({ iceServers: [] });
    localPc.ondatachannel = (ev) => localAttachChannelHandlers(ev.channel, getName(), getGender());
    localPc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(localPc.connectionState)) localHandlePeerGone();
    };

    await localPc.setRemoteDescription(offer);
    const answer = await localPc.createAnswer();
    await localPc.setLocalDescription(answer);
    await localWaitIceComplete(localPc);
    return encodeLocalCode(localPc.localDescription);
  }

  function leaveLocalRoom() {
    localSend({ type: "leave" });
    localReset();
  }

  function init() {
    if (!isConfigured()) return false;
    try {
      if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
      db = firebase.database();
      ready = true;
      // NOTE: syncUserProfile() used to run unconditionally right here, on
      // every single boot — which meant just opening the game (without
      // ever touching the auth screen) created a throwaway "users/{uid}"
      // record in Firebase every time. That's what was flooding the
      // database with thousands of one-off guest accounts, especially
      // when localStorage doesn't survive between launches (e.g. opening
      // index.html straight from a file manager's built-in previewer
      // instead of a real browser) and a fresh random uid gets minted
      // every time. Now it only runs once the player has actually gotten
      // past the auth screen (dlb_logged_in is set) — see enterHubAfterAuth
      // in game.js, which calls syncUserProfile() itself right after that.
      if (localStorage.getItem("dlb_logged_in") === "1") syncUserProfile();
      cleanupOrphanedRoom();
    } catch (e) {
      console.warn("Multiplayer disabled:", e);
      ready = false;
    }
    return ready;
  }

  // Safety net for the "room stays after I leave" bug: if the tab/app was
  // closed before the leaveRoom() delete request reached the server (e.g.
  // the exit button closes the tab right after firing the request), the
  // room is orphaned in the database. We remember the last room we hosted
  // in localStorage and sweep it away the next time the game boots, before
  // the player can create a new one and end up with two.
  async function cleanupOrphanedRoom() {
    const staleCode = localStorage.getItem("dlb_hosted_room");
    if (!staleCode) return;
    localStorage.removeItem("dlb_hosted_room");
    try {
      const snap = await db.ref(`rooms/${staleCode}`).get();
      if (snap.exists() && snap.val().hostId === uid()) {
        await db.ref(`rooms/${staleCode}`).remove();
      }
    } catch (e) { /* best effort, not fatal */ }
  }

  function genCode() {
    let c = "";
    for (let i = 0; i < 5; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    return c;
  }

  function attachRoomListeners(code) {
    detachListeners();
    roomListenerRef = db.ref(`rooms/${code}`);
    roomListenerRef.on("value", (snap) => {
      const val = snap.val();
      if (!val) { if (statusCb) statusCb(null); return; }
      if (statusCb) statusCb(val);
    });
    playersListenerRef = db.ref(`rooms/${code}/players`);
    playersListenerRef.on("value", (snap) => {
      playersCache = snap.val() || {};
      if (playersCb) playersCb(playersCache);
    });
    monsterListenerRef = db.ref(`rooms/${code}/monster`);
    monsterListenerRef.on("value", (snap) => {
      monsterCache = snap.val() || null;
    });
  }

  function detachListeners() {
    if (roomListenerRef) roomListenerRef.off();
    if (playersListenerRef) playersListenerRef.off();
    if (monsterListenerRef) monsterListenerRef.off();
    roomListenerRef = playersListenerRef = monsterListenerRef = null;
  }

  /** Host creates a room. opts: {isPrivate, maxPlayers, difficulty, mapId} */
  async function createRoom(opts) {
    if (!ready) throw new Error("multiplayer-unavailable");
    backend = "online";
    const myUid = uid();
    let code, exists = true, tries = 0;
    do {
      code = genCode();
      const snap = await db.ref(`rooms/${code}`).get();
      exists = snap.exists();
      tries++;
    } while (exists && tries < 8);

    const roomRef = db.ref(`rooms/${code}`);
    await roomRef.set({
      hostId: myUid,
      hostName: getName(),
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      isPrivate: !!opts.isPrivate,
      maxPlayers: opts.maxPlayers || 4,
      difficulty: opts.difficulty || "normal",
      mapId: opts.mapId || "corridor",
      status: "lobby",
      players: {
        [myUid]: { name: getName(), gender: getGender(), joinedAt: Date.now(), x: 0, z: 0, yaw: 0, isHost: true }
      }
    });

    roomCode = code;
    isHost = true;
    localStorage.setItem("dlb_hosted_room", code); // cleared on a clean leaveRoom(); swept on next boot otherwise
    const myRef = db.ref(`rooms/${code}/players/${myUid}`);
    myRef.onDisconnect().remove();
    // If the host disconnects, close the whole room for everyone.
    roomRef.onDisconnect().remove();

    attachRoomListeners(code);
    return code;
  }

  /** Scans open rooms for a public (non-private) one in its lobby with a
   *  free slot, and returns its code — or null if none are open right now.
   *  Client-side filtered since this project has no server functions;
   *  fine at the scale of a small game, and `rooms` is capped at 40 reads. */
  async function searchPublicRoom() {
    if (!ready) throw new Error("multiplayer-unavailable");
    const snap = await db.ref("rooms").limitToFirst(40).get();
    const all = snap.val() || {};
    const candidates = Object.keys(all).filter((code) => {
      const r = all[code];
      if (!r || r.isPrivate || r.status !== "lobby") return false;
      const count = r.players ? Object.keys(r.players).length : 0;
      return count < (r.maxPlayers || 4);
    });
    if (!candidates.length) return null;
    return candidates[(Math.random() * candidates.length) | 0];
  }

  /** Lists open public rooms (lobby status, not full) for the room-browser
   *  screen. Same 40-room client-side scan as searchPublicRoom(), just
   *  returning the full list with display info instead of one random pick. */
  async function listPublicRooms() {
    if (!ready) throw new Error("multiplayer-unavailable");
    const snap = await db.ref("rooms").limitToFirst(40).get();
    const all = snap.val() || {};
    return Object.keys(all)
      .map((code) => {
        const r = all[code];
        if (!r) return null;
        return {
          code,
          hostName: r.hostName || "لاعب",
          mapId: r.mapId || "corridor",
          difficulty: r.difficulty || "normal",
          isPrivate: !!r.isPrivate,
          status: r.status || "lobby",
          maxPlayers: r.maxPlayers || 4,
          playerCount: r.players ? Object.keys(r.players).length : 0,
          createdAt: r.createdAt || 0,
        };
      })
      .filter((r) => r && !r.isPrivate && r.status === "lobby" && r.playerCount < r.maxPlayers)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** Guest joins an existing room by code. Throws with a code the UI can translate. */
  async function joinRoom(code) {    if (!ready) throw new Error("multiplayer-unavailable");
    backend = "online";
    code = (code || "").trim().toUpperCase();
    const roomRef = db.ref(`rooms/${code}`);
    const snap = await roomRef.get();
    if (!snap.exists()) throw new Error("room-not-found");
    const val = snap.val();
    if (val.status !== "lobby") throw new Error("room-already-started");
    const currentCount = val.players ? Object.keys(val.players).length : 0;
    if (currentCount >= (val.maxPlayers || 4)) throw new Error("room-full");

    const myUid = uid();
    const myRef = db.ref(`rooms/${code}/players/${myUid}`);
    await myRef.set({ name: getName(), gender: getGender(), joinedAt: Date.now(), x: 0, z: 0, yaw: 0, isHost: false });
    myRef.onDisconnect().remove();

    roomCode = code;
    isHost = false;
    attachRoomListeners(code);
    return val;
  }

  async function leaveRoom() {
    if (backend === "local") { leaveLocalRoom(); return; }
    if (!roomCode || !ready) { roomCode = null; isHost = false; return; }
    const myUid = uid();
    try {
      if (isHost) {
        await db.ref(`rooms/${roomCode}`).remove();
      } else {
        await db.ref(`rooms/${roomCode}/players/${myUid}`).remove();
      }
      localStorage.removeItem("dlb_hosted_room");
    } catch (e) {
      // Don't hide this: a failed delete here is exactly how a room
      // ends up orphaned (still visible in the browse list, and doubled
      // up the next time this player hosts). cleanupOrphanedRoom() will
      // still catch it on next boot since the localStorage marker above
      // is only cleared on success.
      console.error("leaveRoom: failed to remove room on server", e);
    }
    detachListeners();
    roomCode = null;
    isHost = false;
    playersCache = {};
    monsterCache = null;
  }

  /** Host only: flips room status to "playing" so every client's lobby listener fires. */
  async function startRoomGame() {
    if (backend === "local") {
      if (!localIsHost) return;
      const val = { status: "playing", difficulty: localOpts.difficulty, mapId: localOpts.mapId, hostId: uid() };
      localSend({ type: "status", ...val });
      if (statusCb) statusCb(val); // host doesn't receive its own broadcast — fire it locally too
      return;
    }
    if (!roomCode || !isHost) return;
    await db.ref(`rooms/${roomCode}/status`).set("playing");
  }

  function onRoomStatus(cb) { statusCb = cb; }
  function onPlayers(cb) { playersCb = cb; }

  function sendPosition(x, z, yaw) {
    if (backend === "local") {
      if (localPlayers[uid()]) Object.assign(localPlayers[uid()], { x, z, yaw });
      localSend({ type: "pos", uid: uid(), x, z, yaw });
      return;
    }
    if (!roomCode || !ready) return;
    const myUid = uid();
    db.ref(`rooms/${roomCode}/players/${myUid}`).update({ x, z, yaw });
  }

  function sendMonsterState(x, z, mode, active) {
    if (backend === "local") {
      if (!localIsHost) return;
      localMonster = { x, z, mode, active, updatedAt: Date.now() };
      localSend({ type: "monster", x, z, mode, active });
      return;
    }
    if (!roomCode || !ready || !isHost) return;
    db.ref(`rooms/${roomCode}/monster`).set({ x, z, mode, active, updatedAt: Date.now() });
  }

  function updateSelf(fields) {
    if (backend === "local") {
      if (localPlayers[uid()]) Object.assign(localPlayers[uid()], fields);
      localSend({ type: "selfupdate", uid: uid(), fields });
      return;
    }
    if (!roomCode || !ready) return;
    db.ref(`rooms/${roomCode}/players/${uid()}`).update(fields);
  }

  function getPlayers() { return backend === "local" ? localPlayers : playersCache; }
  function getMonsterState() { return backend === "local" ? localMonster : monsterCache; }
  function myId() { return uid(); }
  function currentRoomCode() { return backend === "local" ? "شبكة محلية" : roomCode; }
  function amHost() { return backend === "local" ? localIsHost : isHost; }

  /* ----- Google sign-in (replaces manually typing a name) -----
     Requires: Firebase Console > Authentication > Sign-in method >
     enable "Google". Falls back to the old manual name if auth isn't
     set up or the user closes the popup — never blocks play. */
  let authUser = null;

  function authAvailable() {
    return typeof firebase !== "undefined" && firebase.auth && isConfigured();
  }

  // Resolves once with whatever session Firebase already has saved on this
  // device (Google OR anonymous), or null if there truly isn't one. This
  // replaces guessing from a hand-set localStorage flag — Firebase's own
  // session store (IndexedDB) is the source of truth, and it's what
  // actually decides whether the player gets bounced back to the login
  // screen or not.
  function waitForAuthState() {
    if (!authAvailable()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const unsub = firebase.auth().onAuthStateChanged((user) => {
        unsub();
        resolve(user);
      });
    });
  }

  // Creates (or reuses) a real, persistent Firebase identity for guest/name
  // players too — not just Google. Previously guests only had a random id
  // hand-rolled into localStorage, which is why a guest's "login" was so
  // fragile. A Firebase Anonymous account is a real signed-in session that
  // Firebase's own SDK is responsible for remembering, the same mechanism
  // Google sign-in already relies on. Requires "Anonymous" to be turned on
  // under Firebase Console → Authentication → Sign-in method — signInGuestPersistent
  // simply resolves to null and the game falls back to the old local-only
  // behavior if that isn't enabled yet.
  async function signInGuestPersistent() {
    if (!authAvailable()) return null;
    if (firebase.auth().currentUser) return firebase.auth().currentUser;
    try {
      const result = await firebase.auth().signInAnonymously();
      return result.user;
    } catch (e) {
      console.warn("Anonymous sign-in unavailable (enable it in Firebase Console → Authentication):", e);
      return null;
    }
  }

  function watchAuth(cb) {
    if (!authAvailable()) return;
    firebase.auth().onAuthStateChanged((user) => {
      authUser = user;
      if (user && !user.isAnonymous) {
        // Real Google account — use its display name automatically and
        // remember its uid as the "linked" identity (used by uid()'s old
        // fallback path, and lets a friend recognize this account by a
        // stable id even in the rare case Firebase auth isn't available).
        setName(user.displayName || getName());
        localStorage.setItem("dlb_uid_google", user.uid);
      }
      if (cb) cb(user);
    });
  }

  // signInWithPopup silently fails (or just hangs) in two very common
  // situations for this game: (1) installed as a PWA with
  // "display": "fullscreen" in manifest.json — those windows can't spawn a
  // popup at all — and (2) any mobile browser, because the auth button
  // first calls requestFullscreenLandscape(), and entering fullscreen
  // right before opening a popup makes most browsers treat the popup as no
  // longer a direct result of the user's tap and block it.
  //
  // signInWithRedirect avoids both: instead of spawning a second window it
  // navigates the *whole page* to Google and back, so it works the same
  // inside a fullscreen PWA as in a normal tab. The catch is that this
  // means the page fully reloads — nothing after the call below in the
  // caller's async function will ever run in this session. The result only
  // becomes available on the NEXT page load, via resolveGoogleRedirect().
  async function signInWithGoogle() {
    if (!authAvailable()) throw new Error("auth-unavailable");
    const provider = new firebase.auth.GoogleAuthProvider();
    await firebase.auth().signInWithRedirect(provider);
  }

  // Call once at boot, after init(), to pick up the result of a
  // signInWithRedirect from before the page reloaded. Resolves to the
  // signed-in user, or null if this load isn't a return trip from Google
  // (the overwhelmingly common case — a normal boot).
  let lastRedirectDebug = null;

  async function resolveGoogleRedirect() {
    if (!authAvailable()) { lastRedirectDebug = "auth-unavailable"; return null; }
    try {
      const result = await firebase.auth().getRedirectResult();
      if (result && result.user) {
        lastRedirectDebug = "ok:" + result.user.uid;
        return result.user;
      }
      lastRedirectDebug = "no-user-no-error";
      return null;
    } catch (e) {
      console.warn("Google redirect sign-in failed:", e);
      lastRedirectDebug = "error:" + (e.code || e.message || "unknown");
      return null;
    }
  }

  function getLastRedirectDebug() { return lastRedirectDebug; }

  async function signOutGoogle() {
    if (!authAvailable()) return;
    await firebase.auth().signOut();
  }

  function currentGoogleUser() { return (authUser && !authUser.isAnonymous) ? authUser : null; }

  /* ----- Logout / delete account (used by the Account tab in Settings) -----
     Logout just forgets the "already logged in" flag so the auth screen
     shows again next launch, and signs out of Google if that's how they
     signed in — it never wipes local progress (name/xp/gender) since guests
     don't have a real account to lose.
     Delete account clears everything local and, if signed in with Google,
     deletes the Firebase Auth user too. */
  async function logout() {
    if (authAvailable() && authUser) {
      try { await firebase.auth().signOut(); } catch (e) {}
    }
    localStorage.removeItem("dlb_logged_in");
  }

  async function deleteAccount() {
    if (authAvailable() && authUser) {
      try { await authUser.delete(); }
      catch (e) {
        // Firebase requires a recent login to delete the account; fall back
        // to just signing out + clearing local data instead of blocking.
        try { await firebase.auth().signOut(); } catch (e2) {}
      }
    }
    ["dlb_logged_in", "dlb_uid", "dlb_uid_google", "dlb_name", "dlb_gender", "dlb_xp"]
      .forEach((k) => localStorage.removeItem(k));
  }

  return {
    init, isConfigured, isReady: () => ready,
    createRoom, joinRoom, searchPublicRoom, listPublicRooms, leaveRoom, startRoomGame,
    createLocalRoom, completeLocalRoom, joinLocalRoom,
    onRoomStatus, onPlayers, sendPosition, sendMonsterState,
    getPlayers, getMonsterState, myId, currentRoomCode, amHost, updateSelf,
    getName, setName, getGender, setGender, getXp, addXp, syncUserProfile, nextGuestName,
    syncProfileData, loginWithName,
    signInWithGoogle, signOutGoogle, watchAuth, currentGoogleUser, authAvailable,
    waitForAuthState, signInGuestPersistent, getLastRedirectDebug,
    resolveGoogleRedirect,
    logout, deleteAccount,
    myFriendCode, sendFriendRequest, listenFriendRequests, acceptFriendRequest,
    declineFriendRequest, listenFriends, inviteFriendToRoom, listenInvites, dismissInvite,
    sendChatMessage, listenChat, stopChatListener
  };
})();

window.Multiplayer = Multiplayer;
