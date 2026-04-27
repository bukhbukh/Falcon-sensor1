import { useState, useEffect, useRef, useCallback } from "react";

// ── Haversine: distance in meters between two GPS points ──────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const MOTION_PIXEL_COUNT = 80;

export default function App() {
  const [screen, setScreen] = useState("role_select"); // role_select | waiting | race
  const [role, setRole] = useState(null);              // "start" | "finish"
  const [sessionCode, setSessionCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [status, setStatus] = useState("idle");        // idle | waiting | ready | racing | finished
  const [finalTime, setFinalTime] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [motionLevel, setMotionLevel] = useState(0);
  const [detectionEnabled, setDetectionEnabled] = useState(false);
  const [log, setLog] = useState([]);
  const [sensitivity, setSensitivity] = useState(25);

  // GPS
  const [myLocation, setMyLocation] = useState(null);
  const [remoteLocation, setRemoteLocation] = useState(null);
  const [distance, setDistance] = useState(null);
  const [gpsAccuracy, setGpsAccuracy] = useState(null);
  const [gpsStatus, setGpsStatus] = useState("idle"); // idle | acquiring | active | error

  // Refs (used inside callbacks/animation loops)
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const prevFrameRef = useRef(null);
  const animFrameRef = useRef(null);
  const startTimeRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const detectionEnabledRef = useRef(false);
  const roleRef = useRef(null);
  const statusRef = useRef("idle");
  const channelRef = useRef(null);
  const gpsWatchRef = useRef(null);
  const sensitivityRef = useRef(25);

  // Keep refs in sync
  useEffect(() => { detectionEnabledRef.current = detectionEnabled; }, [detectionEnabled]);
  useEffect(() => { roleRef.current = role; }, [role]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);

  // Recalculate distance when either GPS updates
  useEffect(() => {
    if (myLocation && remoteLocation) {
      setDistance(haversineDistance(myLocation.lat, myLocation.lon, remoteLocation.lat, remoteLocation.lon));
    }
  }, [myLocation, remoteLocation]);

  // ── Logging ────────────────────────────────────────────────────────────────
  const addLog = useCallback((msg) => {
    const time = new Date().toLocaleTimeString();
    setLog(prev => [`${time}: ${msg}`, ...prev.slice(0, 9)]);
  }, []);

  // ── GPS ────────────────────────────────────────────────────────────────────
  const startGPS = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsStatus("error");
      addLog("❌ GPS not available on this device");
      return;
    }
    setGpsStatus("acquiring");
    addLog("📡 Acquiring GPS signal...");

    gpsWatchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setMyLocation(loc);
        setGpsAccuracy(Math.round(pos.coords.accuracy));
        setGpsStatus("active");
        // Share my location with peer phone
        channelRef.current?.postMessage({
          type: "GPS_UPDATE",
          from: roleRef.current,
          lat: loc.lat,
          lon: loc.lon,
          accuracy: Math.round(pos.coords.accuracy),
        });
      },
      (err) => {
        setGpsStatus("error");
        addLog("❌ GPS error: " + err.message);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }, [addLog]);

  // ── BroadcastChannel (peer communication) ─────────────────────────────────
  const handleRemoteMessage = useCallback((msg) => {
    if (msg.type === "GPS_UPDATE") {
      setRemoteLocation({ lat: msg.lat, lon: msg.lon });
      return;
    }
    addLog(`📲 Remote: ${msg.type}`);

    if (msg.type === "START_DETECTED" && roleRef.current === "finish") {
      startTimeRef.current = msg.timestamp;
      setStatus("racing");
      statusRef.current = "racing";
      setDetectionEnabled(true);
      startElapsedTimer();
      addLog("⚡ Falcon passed start! Watching finish...");
    }
    if (msg.type === "FINISH_DETECTED" && roleRef.current === "start") {
      const t = msg.timestamp - startTimeRef.current;
      setFinalTime(t);
      setStatus("finished");
      stopElapsedTimer();
      addLog(`🏆 Race done: ${formatTime(t)}s`);
    }
    if (msg.type === "RESET") {
      doReset();
    }
    if (msg.type === "PEER_READY") {
      setStatus("ready");
      addLog("✅ Both phones connected!");
    }
  }, [addLog]);

  const setupChannel = useCallback((code) => {
    channelRef.current?.close();
    const ch = new BroadcastChannel(`falcon_${code}`);
    ch.onmessage = (e) => handleRemoteMessage(e.data);
    channelRef.current = ch;
    addLog(`🔗 Session: ${code}`);
  }, [handleRemoteMessage, addLog]);

  const sendMessage = useCallback((type, data = {}) => {
    channelRef.current?.postMessage({ type, ...data, from: roleRef.current });
  }, []);

  // ── Timer ──────────────────────────────────────────────────────────────────
  const startElapsedTimer = () => {
    clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = setInterval(() => {
      if (startTimeRef.current) setElapsed(Date.now() - startTimeRef.current);
    }, 50);
  };
  const stopElapsedTimer = () => clearInterval(timerIntervalRef.current);

  // ── Camera & Motion ────────────────────────────────────────────────────────
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 60 } },
        audio: false,
      });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      addLog("📷 Camera ready");
      startMotionLoop();
    } catch (e) {
      addLog("❌ Camera error: " + e.message);
    }
  };

  const startMotionLoop = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = 320;
    canvas.height = 240;

    const loop = () => {
      if (!videoRef.current || videoRef.current.readyState < 2) {
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }
      ctx.drawImage(videoRef.current, 0, 0, 320, 240);
      const frame = ctx.getImageData(0, 0, 320, 240);

      if (prevFrameRef.current) {
        const result = computeMotion(frame.data, prevFrameRef.current);
        setMotionLevel(result.level);

        if (detectionEnabledRef.current && result.triggered) {
          const ts = Date.now();
          if (roleRef.current === "start" && statusRef.current === "ready") {
            // ── START detected ──
            startTimeRef.current = ts;
            setStatus("racing");
            statusRef.current = "racing";
            setDetectionEnabled(false);
            detectionEnabledRef.current = false;
            sendMessage("START_DETECTED", { timestamp: ts });
            startElapsedTimer();
            addLog("🚀 START — falcon detected!");
          } else if (roleRef.current === "finish" && statusRef.current === "racing") {
            // ── FINISH detected ──
            const t = ts - startTimeRef.current;
            setFinalTime(t);
            setStatus("finished");
            statusRef.current = "finished";
            setDetectionEnabled(false);
            detectionEnabledRef.current = false;
            stopElapsedTimer();
            sendMessage("FINISH_DETECTED", { timestamp: ts });
            addLog(`🏁 FINISH — ${formatTime(t)}s`);
          }
        }
      }

      prevFrameRef.current = frame.data.slice();
      animFrameRef.current = requestAnimationFrame(loop);
    };
    animFrameRef.current = requestAnimationFrame(loop);
  };

  const computeMotion = (curr, prev) => {
    let changed = 0;
    const thresh = sensitivityRef.current;
    for (let i = 0; i < curr.length; i += 16) {
      const diff = Math.abs(curr[i] - prev[i]) + Math.abs(curr[i+1] - prev[i+1]) + Math.abs(curr[i+2] - prev[i+2]);
      if (diff > thresh) changed++;
    }
    const total = curr.length / 16;
    return { level: Math.min(100, (changed / total) * 400), triggered: changed > MOTION_PIXEL_COUNT };
  };

  // ── Actions ────────────────────────────────────────────────────────────────
  const doReset = () => {
    setStatus("ready");
    setFinalTime(null);
    setElapsed(0);
    startTimeRef.current = null;
    stopElapsedTimer();
    setDetectionEnabled(false);
    detectionEnabledRef.current = false;
    addLog("🔄 Race reset");
  };

  const generateCode = () => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    setSessionCode(code);
    return code;
  };

  const handleRoleSelect = (r) => {
    setRole(r);
    roleRef.current = r;
    if (r === "start") {
      const code = generateCode();
      setupChannel(code);
      setScreen("waiting");
      setStatus("waiting");
      addLog(`🟢 Start phone ready. Code: ${code}`);
    } else {
      setScreen("waiting");
      setStatus("waiting");
      addLog("📱 Finish phone — enter the code from start phone");
    }
  };

  const handleStartReady = () => {
    setStatus("ready");
    setScreen("race");
    sendMessage("PEER_READY");
    startCamera();
    startGPS();
  };

  const handleFinishJoin = () => {
    if (inputCode.trim().length < 4) return;
    const code = inputCode.trim().toUpperCase();
    setSessionCode(code);
    setupChannel(code);
    setStatus("ready");
    setScreen("race");
    sendMessage("PEER_READY");
    startCamera();
    startGPS();
    addLog(`🔗 Joined session ${code}`);
  };

  const handleArm = () => {
    setDetectionEnabled(true);
    detectionEnabledRef.current = true;
    addLog("🎯 ARMED — watching for falcon...");
  };

  const handleReset = () => {
    doReset();
    sendMessage("RESET");
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const formatTime = (ms) => {
    if (ms === null || ms === undefined) return "0.000";
    return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}`;
  };

  const formatDist = (d) => {
    if (d === null) return "---";
    return d >= 1000 ? `${(d / 1000).toFixed(3)} km` : `${d.toFixed(1)} m`;
  };

  const getDistColor = (d) => {
    if (d === null) return "#444";
    const nearest = Math.round(d / 50) * 50;
    const diff = Math.abs(d - nearest);
    if (diff <= 8) return "#00ff88";
    if (diff <= 25) return "#ffaa00";
    return "#ff6644";
  };

  const getDistHint = (d) => {
    if (d === null) return "Waiting for both GPS signals...";
    const nearest = Math.round(d / 50) * 50;
    const diff = Math.round(d - nearest);
    if (Math.abs(diff) <= 8) return `✅ Good — approx ${nearest}m`;
    if (diff > 0) return `Move finish phone ${diff}m closer ←`;
    return `Move finish phone ${Math.abs(diff)}m further →`;
  };

  const motionColor = motionLevel > 60 ? "#ff4444" : motionLevel > 20 ? "#ffaa00" : "#00ff88";
  const distColor = getDistColor(distance);

  // ════════════════════════════════════════════════════════════════════════════
  // SCREENS
  // ════════════════════════════════════════════════════════════════════════════

  // ── Role Select ────────────────────────────────────────────────────────────
  if (screen === "role_select") return (
    <div style={css.root}>
      <div style={css.hero}>
        <div style={css.heroIcon}>🦅</div>
        <h1 style={css.heroTitle}>FALCON<br />TIMER</h1>
        <p style={css.heroSub}>GPS · MOTION DETECTION · PRECISION TIMING</p>
      </div>
      <div style={css.roleWrap}>
        <p style={css.roleQ}>Which phone is this?</p>
        <button style={{ ...css.roleBtn, borderColor: "#1e6b3a" }} onClick={() => handleRoleSelect("start")}>
          <span style={css.roleBtnIcon}>🟢</span>
          <span style={css.roleBtnTitle}>START LINE</span>
          <span style={css.roleBtnSub}>Phone placed at the beginning of the race</span>
        </button>
        <button style={{ ...css.roleBtn, borderColor: "#1e3a6b" }} onClick={() => handleRoleSelect("finish")}>
          <span style={css.roleBtnIcon}>🏁</span>
          <span style={css.roleBtnTitle}>FINISH LINE</span>
          <span style={css.roleBtnSub}>Phone placed at the end of the race</span>
        </button>
      </div>
    </div>
  );

  // ── Waiting — Start Phone ──────────────────────────────────────────────────
  if (screen === "waiting" && role === "start") return (
    <div style={css.root}>
      <div style={css.topBar}>
        <span style={css.topBadge("green")}>🟢 START PHONE</span>
      </div>
      <div style={css.card}>
        <p style={css.cardLabel}>Share this code with the FINISH phone:</p>
        <div style={css.bigCode}>{sessionCode}</div>
        <p style={css.cardHint}>Type this code on the other phone, then tap ready below.</p>
        <button style={css.btn("#1e6b3a")} onClick={handleStartReady}>
          ✅ Other phone is connected — Start
        </button>
      </div>
      <LogBox log={log} />
    </div>
  );

  // ── Waiting — Finish Phone ─────────────────────────────────────────────────
  if (screen === "waiting" && role === "finish") return (
    <div style={css.root}>
      <div style={css.topBar}>
        <span style={css.topBadge("blue")}>🏁 FINISH PHONE</span>
      </div>
      <div style={css.card}>
        <p style={css.cardLabel}>Enter the code shown on the START phone:</p>
        <input
          style={css.codeInput}
          value={inputCode}
          onChange={(e) => setInputCode(e.target.value.toUpperCase())}
          placeholder="e.g. X7K2P1"
          maxLength={8}
          autoCapitalize="characters"
        />
        <button style={css.btn("#1e3a6b")} onClick={handleFinishJoin}>
          🔗 Connect &amp; Start
        </button>
      </div>
      <LogBox log={log} />
    </div>
  );

  // ── Main Race Screen ───────────────────────────────────────────────────────
  return (
    <div style={css.root}>

      {/* Top bar */}
      <div style={css.topBar}>
        <span style={css.topBadge(role === "start" ? "green" : "blue")}>
          {role === "start" ? "🟢 START" : "🏁 FINISH"}
        </span>
        <span style={{ fontSize: 11, color: "#444", letterSpacing: 1 }}>
          SESSION: {sessionCode}
        </span>
      </div>

      {/* GPS Distance Card */}
      <div style={{ ...css.distCard, borderColor: distColor }}>
        <div style={css.distRow}>
          <div>
            <p style={css.distLabel}>📍 DISTANCE BETWEEN PHONES</p>
            <p style={{ ...css.distValue, color: distColor }}>{formatDist(distance)}</p>
            <p style={{ ...css.distHint, color: distColor }}>{getDistHint(distance)}</p>
          </div>
          <div style={css.gpsBox}>
            <div style={{ color: gpsStatus === "active" ? "#00ff88" : gpsStatus === "acquiring" ? "#ffaa00" : "#ff4444", fontSize: 11, marginBottom: 3 }}>
              {gpsStatus === "active" ? "🛰 GPS Active" : gpsStatus === "acquiring" ? "⏳ Acquiring..." : gpsStatus === "error" ? "❌ GPS Error" : "○ GPS Off"}
            </div>
            {gpsAccuracy && <div style={css.gpsLine}>±{gpsAccuracy}m accuracy</div>}
            <div style={css.gpsLine}>{myLocation ? `Me: ${myLocation.lat.toFixed(5)}` : "Me: waiting..."}</div>
            <div style={css.gpsLine}>{remoteLocation ? `Peer: ${remoteLocation.lat.toFixed(5)}` : "Peer: waiting..."}</div>
          </div>
        </div>
      </div>

      {/* Camera preview */}
      <div style={css.camBox}>
        <video ref={videoRef} style={css.video} playsInline muted />
        <canvas ref={canvasRef} style={{ display: "none" }} />
        {/* Vertical detection line */}
        <div style={css.crosshair} />
        <div style={css.camBadge}>{role === "start" ? "🟢 START" : "🏁 FINISH"}</div>
        {/* Motion level bar */}
        <div style={css.motionWrap}>
          <div style={{ height: "100%", width: `${motionLevel}%`, background: motionColor, transition: "width 0.04s, background 0.1s" }} />
        </div>
        {detectionEnabled && (
          <div style={css.armedBadge}>● ARMED</div>
        )}
      </div>

      {/* Timer / Status */}
      <div style={css.timerArea}>
        {status === "finished" ? (
          <div style={{ ...css.timerCard, borderColor: "#f0c040", background: "#110e00" }}>
            <p style={{ ...css.timerLabel, color: "#f0c040" }}>🏆 RACE TIME</p>
            <p style={{ ...css.timerValue, color: "#f0c040" }}>{formatTime(finalTime)}<span style={css.timerUnit}>s</span></p>
            {distance && <p style={css.timerSub}>📍 Distance: {formatDist(distance)}</p>}
          </div>
        ) : status === "racing" ? (
          <div style={{ ...css.timerCard, borderColor: "#00ff88", background: "#001a0a" }}>
            <p style={{ ...css.timerLabel, color: "#00ff88" }}>⚡ RACING</p>
            <p style={{ ...css.timerValue, color: "#00ff88" }}>{formatTime(elapsed)}<span style={css.timerUnit}>s</span></p>
          </div>
        ) : (
          <div style={css.timerCard}>
            <p style={{ ...css.timerLabel, color: "#555" }}>
              {detectionEnabled ? "🎯 ARMED" : status === "ready" ? "READY" : "WAITING"}
            </p>
            <p style={{ ...css.timerValue, color: "#333" }}>
              {detectionEnabled ? "Watching..." : "—"}
            </p>
          </div>
        )}
      </div>

      {/* Buttons */}
      <div style={css.btnRow}>
        {status === "ready" && !detectionEnabled && (
          <button style={{ ...css.btn("#8b2500"), flex: 1 }} onClick={handleArm}>
            🎯 ARM — Start Watching
          </button>
        )}
        {(status === "finished" || status === "racing") && (
          <button style={{ ...css.btn("#222"), flex: 1 }} onClick={handleReset}>
            🔄 Reset Race
          </button>
        )}
      </div>

      {/* Sensitivity */}
      <div style={css.sliderRow}>
        <span style={css.sliderLabel}>Detection Sensitivity</span>
        <input
          type="range" min="5" max="60" value={sensitivity}
          onChange={(e) => setSensitivity(Number(e.target.value))}
          style={{ flex: 1, accentColor: "#f0c040" }}
        />
        <span style={css.sliderVal}>{sensitivity}</span>
      </div>

      <LogBox log={log} />
    </div>
  );
}

function LogBox({ log }) {
  return (
    <div style={{
      width: "100%", maxWidth: 380, background: "#060606",
      border: "1px solid #181818", borderRadius: 8, padding: "8px 10px",
      maxHeight: 88, overflowY: "auto",
    }}>
      {log.length === 0
        ? <div style={{ fontSize: 10, color: "#2a2a2a", fontFamily: "monospace" }}>No events yet...</div>
        : log.map((l, i) => <div key={i} style={{ fontSize: 10, color: i === 0 ? "#555" : "#2e2e2e", marginBottom: 1, fontFamily: "monospace" }}>{l}</div>)
      }
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const css = {
  root: {
    fontFamily: "'Courier New', Courier, monospace",
    background: "#0a0a0a",
    color: "#e0e0e0",
    minHeight: "100vh",
    minHeight: "100dvh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "12px 14px 24px",
    gap: 11,
    boxSizing: "border-box",
  },
  hero: { textAlign: "center", paddingTop: 16, paddingBottom: 4 },
  heroIcon: { fontSize: 56, lineHeight: 1, marginBottom: 8 },
  heroTitle: { fontSize: 38, fontWeight: 900, letterSpacing: 7, margin: "0 0 6px", color: "#f0c040", textTransform: "uppercase", lineHeight: 1.1 },
  heroSub: { fontSize: 10, color: "#3a3a3a", letterSpacing: 3, margin: 0 },
  roleWrap: { width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 10 },
  roleQ: { textAlign: "center", color: "#666", fontSize: 13, margin: "0 0 4px", letterSpacing: 1 },
  roleBtn: {
    background: "#0d0d0d", border: "2px solid #333", borderRadius: 14,
    padding: "18px 16px", cursor: "pointer", display: "flex",
    flexDirection: "column", alignItems: "center", gap: 4, width: "100%",
  },
  roleBtnIcon: { fontSize: 28 },
  roleBtnTitle: { fontSize: 20, fontWeight: 900, color: "#e0e0e0", letterSpacing: 3 },
  roleBtnSub: { fontSize: 11, color: "#555", letterSpacing: 0.5 },

  topBar: { width: "100%", maxWidth: 380, display: "flex", justifyContent: "space-between", alignItems: "center" },
  topBadge: (color) => ({
    fontSize: 11, fontWeight: 700, letterSpacing: 2,
    color: color === "green" ? "#00ff88" : color === "blue" ? "#4488ff" : "#aaa",
    background: color === "green" ? "#001a0a" : color === "blue" ? "#00081a" : "#111",
    padding: "4px 10px", borderRadius: 6,
  }),

  card: { width: "100%", maxWidth: 380, background: "#0e0e0e", border: "1px solid #222", borderRadius: 14, padding: "18px 16px", display: "flex", flexDirection: "column", gap: 12 },
  cardLabel: { color: "#777", fontSize: 12, margin: 0, textAlign: "center", letterSpacing: 1 },
  cardHint: { color: "#444", fontSize: 11, margin: 0, textAlign: "center" },
  bigCode: { background: "#000", border: "2px solid #f0c040", borderRadius: 10, padding: "14px 10px", fontSize: 36, fontWeight: 900, textAlign: "center", letterSpacing: 10, color: "#f0c040" },
  codeInput: { background: "#000", border: "2px solid #333", borderRadius: 10, padding: "14px 10px", fontSize: 28, fontWeight: 700, textAlign: "center", letterSpacing: 8, color: "#fff", width: "100%", boxSizing: "border-box", outline: "none" },

  btn: (bg) => ({ padding: "14px 10px", background: bg, border: "none", borderRadius: 10, color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", letterSpacing: 1, width: "100%", fontFamily: "'Courier New', monospace" }),
  btnRow: { width: "100%", maxWidth: 380, display: "flex", gap: 8 },

  distCard: { width: "100%", maxWidth: 380, background: "#080f08", border: "2px solid #222", borderRadius: 12, padding: "12px 14px", boxSizing: "border-box" },
  distRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  distLabel: { margin: "0 0 3px", fontSize: 9, color: "#444", letterSpacing: 3 },
  distValue: { margin: "0 0 4px", fontSize: 40, fontWeight: 900, letterSpacing: 1 },
  distHint: { margin: 0, fontSize: 11 },
  gpsBox: { textAlign: "right", flexShrink: 0, paddingTop: 2 },
  gpsLine: { fontSize: 9, color: "#333", marginBottom: 2 },

  camBox: { width: "100%", maxWidth: 380, position: "relative", background: "#0a0a0a", borderRadius: 12, overflow: "hidden", border: "2px solid #1e1e1e" },
  video: { width: "100%", display: "block", maxHeight: 200, objectFit: "cover" },
  crosshair: { position: "absolute", top: 0, bottom: 0, left: "50%", width: 2, background: "rgba(240,192,64,0.45)", pointerEvents: "none" },
  camBadge: { position: "absolute", top: 8, left: 8, background: "rgba(0,0,0,0.8)", padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: 1 },
  motionWrap: { position: "absolute", bottom: 0, left: 0, right: 0, height: 5, background: "#111" },
  armedBadge: { position: "absolute", top: 8, right: 8, background: "rgba(139,37,0,0.9)", color: "#ff8855", padding: "3px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, letterSpacing: 2, animation: "none" },

  timerArea: { width: "100%", maxWidth: 380 },
  timerCard: { background: "#0c0c0c", border: "2px solid #1e1e1e", borderRadius: 12, padding: "14px 16px", textAlign: "center" },
  timerLabel: { margin: "0 0 4px", fontSize: 11, letterSpacing: 4 },
  timerValue: { margin: 0, fontSize: 50, fontWeight: 900, lineHeight: 1 },
  timerUnit: { fontSize: 20, fontWeight: 400, marginLeft: 2 },
  timerSub: { margin: "8px 0 0", fontSize: 12, color: "#666" },

  sliderRow: { width: "100%", maxWidth: 380, display: "flex", alignItems: "center", gap: 8, background: "#0e0e0e", border: "1px solid #1a1a1a", borderRadius: 8, padding: "8px 12px" },
  sliderLabel: { color: "#3a3a3a", fontSize: 10, letterSpacing: 1, whiteSpace: "nowrap" },
  sliderVal: { color: "#3a3a3a", fontSize: 10, minWidth: 20, textAlign: "right" },
};
