// CaliLink — WebRTC pairing signalled over Supabase Realtime instead of the PeerJS cloud.
// WHY: venue wifi (gyms/offices) often category-blocks 0.peerjs.com ("P2P"), killing pairing.
// The gym already talks to *.supabase.co all day (coach app, signage, leaderboards), so the
// handshake rides a domain that provably passes. Media then flows direct phone->tablet (LAN).
const CaliLink = (() => {
  const URL_ = "https://youggtwsexrpmjmwjvcc.supabase.co";
  const KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvdWdndHdzZXhycG1qbXdqdmNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NDM1MDMsImV4cCI6MjA5MDIxOTUwM30.IRtm57C9OonhJWZi8Q7aKLdzSyxAmKMfss0mim1Q2FI";
  const ICE  = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  let sb = null;
  const client = () => (sb ||= window.supabase.createClient(URL_, KEY));

  // TABLET: answer offers on this room forever; each new phone takes the screen over.
  function listen(room, cb) {
    const ch = client().channel("cali-link-" + room);
    let pc = null;
    const send = (event, payload) => { try { ch.send({ type: "broadcast", event, payload }); } catch {} };
    ch.on("broadcast", { event: "offer" }, async ({ payload }) => {
      try {
        if (pc) try { pc.close(); } catch {}
        pc = new RTCPeerConnection({ iceServers: ICE });
        pc.ontrack = ev => { try { cb.onStream(ev.streams[0]); } catch {} };
        pc.onicecandidate = ev => { if (ev.candidate) send("ice-t", ev.candidate); };
        await pc.setRemoteDescription(payload.sdp);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        send("answer", { sdp: pc.localDescription });
      } catch (e) { cb.onState && cb.onState("error"); }
    });
    ch.on("broadcast", { event: "ice-p" }, ({ payload }) => { try { pc && pc.addIceCandidate(payload); } catch {} });
    ch.on("broadcast", { event: "ping"  }, () => send("pong", {}));
    ch.subscribe(st => cb.onState && cb.onState(st));
    return { stop() { try { pc && pc.close(); } catch {}; try { ch.unsubscribe(); } catch {} } };
  }

  // PHONE: probe for the tablet, then offer the stream; self-heals on drops.
  function cast(room, stream, cb) {
    const ch = client().channel("cali-link-" + room);
    let pc = null, gotPong = false, stopped = false, connected = false, probing = false;
    const send = (event, payload) => { try { ch.send({ type: "broadcast", event, payload }); } catch {} };
    async function offer() {
      if (stopped) return;
      try {
        if (pc) try { pc.close(); } catch {}
        pc = new RTCPeerConnection({ iceServers: ICE });
        stream.getTracks().forEach(t => pc.addTrack(t, stream));
        pc.onicecandidate = ev => { if (ev.candidate) send("ice-p", ev.candidate); };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "connected") { connected = true; cb.onState && cb.onState("connected"); }
          else if (["failed", "closed", "disconnected"].includes(pc.connectionState) && !stopped && connected) {
            connected = false; cb.onState && cb.onState("retry"); setTimeout(probe, 1500);
          }
        };
        const off = await pc.createOffer();
        await pc.setLocalDescription(off);
        setTimeout(() => send("offer", { sdp: pc.localDescription }), 350);   // trickle carries the rest
      } catch (e) { cb.onState && cb.onState("error"); }
    }
    function probe() {
      if (stopped || connected || probing) return;
      probing = true; gotPong = false; send("ping", {});
      setTimeout(() => {
        probing = false;
        if (stopped || connected) return;
        if (gotPong) offer();
        else { cb.onState && cb.onState("waiting"); setTimeout(probe, 1800); }
      }, 800);
    }
    ch.on("broadcast", { event: "pong"   }, () => { gotPong = true; });
    ch.on("broadcast", { event: "answer" }, async ({ payload }) => { try { await pc.setRemoteDescription(payload.sdp); } catch {} });
    ch.on("broadcast", { event: "ice-t"  }, ({ payload }) => { try { pc && pc.addIceCandidate(payload); } catch {} });
    ch.subscribe(st => { cb.onState && cb.onState(st); if (st === "SUBSCRIBED") probe(); });
    return { stop() { stopped = true; try { pc && pc.close(); } catch {}; try { ch.unsubscribe(); } catch {} } };
  }
  return { listen, cast };
})();
