/* ---------------------------------------------------------------------
   In-game voice chat — WebRTC mesh between everyone in the same room.
   Signaling (offers/answers/ICE candidates) travels through the same
   Firebase Realtime Database already used for rooms/positions, under
   rooms/{code}/rtc/{pairKey}. No media ever touches Firebase — once a
   peer connection is up, audio flows directly device-to-device.

   Fully optional, same spirit as multiplayer.js: if the mic permission
   is denied, WebRTC isn't supported, or Firebase isn't configured, every
   function quietly fails and the game keeps working without voice.
--------------------------------------------------------------------- */
"use strict";

const VoiceChat = (() => {
  let db = null;
  let roomCode = null;
  let myUid = null;
  let localStream = null;
  let muted = false;
  const peers = {};      // otherUid -> RTCPeerConnection
  const audioEls = {};   // otherUid -> <audio>
  const sigRefs = {};    // otherUid -> {offerRef, answerRef, myCandRef, theirCandRef}
  let statusCb = null;   // (speakingMap) => void, optional

  const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  function available() {
    return typeof firebase !== "undefined" && firebase.database &&
      !!navigator.mediaDevices && !!window.RTCPeerConnection;
  }

  // Deterministic pair key so both sides write/read the same path
  // regardless of who initiates ("a_b", always lower uid first).
  function pairKey(a, b) { return a < b ? `${a}_${b}` : `${b}_${a}`; }
  function amInitiator(otherUid) { return myUid < otherUid; }

  function ensureAudioEl(uid) {
    if (audioEls[uid]) return audioEls[uid];
    const el = document.createElement("audio");
    el.autoplay = true;
    el.setAttribute("playsinline", "");
    el.dataset.peer = uid;
    document.body.appendChild(el);
    audioEls[uid] = el;
    return el;
  }

  function removePeer(uid) {
    if (peers[uid]) { try { peers[uid].close(); } catch (e) {} delete peers[uid]; }
    if (audioEls[uid]) { audioEls[uid].remove(); delete audioEls[uid]; }
    const refs = sigRefs[uid];
    if (refs) {
      Object.values(refs).forEach((r) => { try { r.off(); } catch (e) {} });
      delete sigRefs[uid];
    }
  }

  async function connectTo(otherUid) {
    if (peers[otherUid] || !localStream) return;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peers[otherUid] = pc;
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    pc.ontrack = (e) => { ensureAudioEl(otherUid).srcObject = e.streams[0]; };

    const key = pairKey(myUid, otherUid);
    const base = db.ref(`rooms/${roomCode}/rtc/${key}`);
    const iAmA = myUid < otherUid;
    const myCandRef = base.child(iAmA ? "candA" : "candB");
    const theirCandRef = base.child(iAmA ? "candB" : "candA");
    sigRefs[otherUid] = { offerRef: base.child("offer"), answerRef: base.child("answer"), myCandRef, theirCandRef };

    pc.onicecandidate = (e) => {
      if (e.candidate) myCandRef.push(e.candidate.toJSON());
    };

    theirCandRef.on("child_added", (snap) => {
      const cand = snap.val();
      if (cand && pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
    });

    if (amInitiator(otherUid)) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await base.child("offer").set({ sdp: offer.sdp, type: offer.type });
      base.child("answer").on("value", async (snap) => {
        const val = snap.val();
        if (val && pc.signalingState === "have-local-offer") {
          await pc.setRemoteDescription(new RTCSessionDescription(val));
        }
      });
    } else {
      base.child("offer").on("value", async (snap) => {
        const val = snap.val();
        if (val && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(val));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await base.child("answer").set({ sdp: answer.sdp, type: answer.type });
        }
      });
    }
  }

  /** Call once when entering a multiplayer room's actual gameplay. */
  async function start(code, uid, initialPeerUids) {
    if (!available()) return false;
    try {
      db = firebase.database();
      roomCode = code;
      myUid = uid;
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      muted = false;
      (initialPeerUids || []).forEach((p) => { if (p !== myUid) connectTo(p); });
      return true;
    } catch (e) {
      console.warn("Voice chat unavailable:", e);
      return false;
    }
  }

  /** Call whenever the room's player list changes, so new joiners connect. */
  function syncPeers(currentUids) {
    if (!localStream) return;
    const wanted = new Set((currentUids || []).filter((u) => u !== myUid));
    wanted.forEach((u) => { if (!peers[u]) connectTo(u); });
    Object.keys(peers).forEach((u) => { if (!wanted.has(u)) removePeer(u); });
  }

  function setMuted(m) {
    muted = !!m;
    if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  }
  function toggleMute() { setMuted(!muted); return muted; }
  function isMuted() { return muted; }
  function isActive() { return !!localStream; }

  function stop() {
    Object.keys(peers).forEach(removePeer);
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    roomCode = null; myUid = null;
  }

  return { available, start, syncPeers, setMuted, toggleMute, isMuted, isActive, stop };
})();

window.VoiceChat = VoiceChat;
