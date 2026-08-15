/* =========================================================================
   controls.js — every on-screen control button lives here:
     - move joystick (moveStick / moveKnob)
     - look zone (lookZone, drag-to-look on touch)
     - flashlight button (flashlightBtn)
     - run button (runBtn)              <-- new
     - jump button (jumpBtn)            <-- new
     - mic button (voiceMicBtn)
     - chat button + panel (chatToggleBtn / chatSendBtn / chatInput)

   This is a plain classic <script> (same as game.js, multiplayer.js,
   voicechat.js — no type="module"), so it shares the same top-level
   script scope as game.js and can use its globals directly: $, state,
   touch, Settings, isCoarsePointer, toggleFlashlight, triggerJump,
   chatHasUnread, tryStartVoiceChat, clamp. It must be included via
   <script src="controls.js"> in index.html (order relative to game.js
   doesn't matter — setupControls() is only actually called from
   game.js's boot(), which runs on window "load", well after every
   script on the page has finished executing).
========================================================================= */

function setupControls() {
  setupTouchControls();
  setupSocialControls();
}

/* --- Movement joystick + look zone + flashlight/run/jump buttons ------- */
function setupTouchControls() {
  if (!isCoarsePointer) return;

  const stick = $("moveStick"), knob = $("moveKnob"), lookZone = $("lookZone");
  const flBtn = $("flashlightBtn"), runBtn = $("runBtn"), jumpBtn = $("jumpBtn");
  const stickRect = () => stick.getBoundingClientRect();

  stick.addEventListener("touchstart", (e) => {
    touch.moveActive = true;
    touch.moveId = e.changedTouches[0].identifier;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === touch.moveId) {
        const r = stickRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        let dx = (t.clientX - cx) / (r.width / 2), dy = (t.clientY - cy) / (r.height / 2);
        const len = Math.hypot(dx, dy);
        if (len > 1) { dx /= len; dy /= len; }
        touch.moveVec.x = dx; touch.moveVec.y = dy;
        knob.style.transform = `translate(calc(-50% + ${dx * 34}px), calc(-50% + ${dy * 34}px))`;
      }
      if (t.identifier === touch.lookId && state.running) {
        const dx = t.clientX - touch.lastLook.x, dy = t.clientY - touch.lastLook.y;
        const tsens = 0.0032 * Settings.get("sensitivity");
        state.yaw -= dx * tsens;
        state.pitch -= dy * tsens;
        state.pitch = clamp(state.pitch, -1.3, 1.3);
        touch.lastLook = { x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: true });

  window.addEventListener("touchend", (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === touch.moveId) {
        touch.moveActive = false; touch.moveId = null; touch.moveVec = { x: 0, y: 0 };
        knob.style.transform = "translate(-50%,-50%)";
      }
      if (t.identifier === touch.lookId) { touch.lookId = null; touch.lastLook = null; }
    }
  }, { passive: true });

  lookZone.addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0];
    touch.lookId = t.identifier;
    touch.lastLook = { x: t.clientX, y: t.clientY };
  }, { passive: true });

  // Flashlight: simple tap toggle (on/off), same as before.
  flBtn.addEventListener("touchstart", (e) => { e.preventDefault(); toggleFlashlight(); }, { passive: false });

  // Run: hold-to-sprint, like holding Shift on desktop. touch.runHeld is
  // read every frame by updatePlayer() in game.js as part of the
  // sprinting condition. touchcancel is also handled so a finger sliding
  // off the button (instead of a clean lift) doesn't leave sprint stuck on.
  runBtn.addEventListener("touchstart", (e) => { e.preventDefault(); touch.runHeld = true; }, { passive: false });
  runBtn.addEventListener("touchend", (e) => { e.preventDefault(); touch.runHeld = false; }, { passive: false });
  runBtn.addEventListener("touchcancel", (e) => { e.preventDefault(); touch.runHeld = false; }, { passive: false });

  // Jump: single tap triggers one jump arc — see triggerJump() in game.js.
  // Mashing it mid-air is a no-op there (state.jumping guards it), so no
  // debouncing is needed here.
  jumpBtn.addEventListener("touchstart", (e) => { e.preventDefault(); triggerJump(); }, { passive: false });
}

/* --- In-game mic + text chat (only visible while state.mp.active) ------ */
function setupSocialControls() {
  $("voiceMicBtn").addEventListener("click", async () => {
    if (!window.VoiceChat || !VoiceChat.isActive()) {
      await tryStartVoiceChat();
      return;
    }
    const muted = VoiceChat.toggleMute();
    $("voiceMicBtn").classList.toggle("muted", muted);
    $("voiceMicBtn").innerHTML = muted
      ? '<i class="fa-solid fa-microphone-slash"></i>'
      : '<i class="fa-solid fa-microphone"></i>';
  });

  $("chatToggleBtn").addEventListener("click", () => {
    const panel = $("chatPanel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      chatHasUnread = false;
      $("chatToggleBtn").classList.remove("has-unread");
      $("chatInput").focus();
    }
  });

  function sendCurrentChatInput() {
    const val = $("chatInput").value;
    if (!val.trim() || !window.Multiplayer) return;
    Multiplayer.sendChatMessage(val);
    $("chatInput").value = "";
  }
  $("chatSendBtn").addEventListener("click", sendCurrentChatInput);
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendCurrentChatInput();
    e.stopPropagation(); // don't let WASD-style key handlers eat this input
  });
}
