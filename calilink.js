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
    let pc = null, hbWatch = null, iceQ = [];
    const send = (event, payload) => { try { ch.send({ type: "broadcast", event, payload }); } catch {} };
    ch.on("broadcast", { event: "offer" }, async ({ payload }) => {
      try {
        if (pc) try { pc.close(); } catch {}
        iceQ = [];
        pc = new RTCPeerConnection({ iceServers: ICE });
        pc.ontrack = ev => { try { cb.onStream(ev.streams[0]); } catch {} };
        try{ if (hbWatch) clearInterval(hbWatch); }catch{}
        pc.ondatachannel = ev => {
          if (ev.channel.label !== "hb") return;
          let last = Date.now();
          ev.channel.onmessage = m => {
            last = Date.now();
            if (m.data !== "h") { try { cb.onMsg && cb.onMsg(JSON.parse(m.data)); } catch {} }
          };
          hbWatch = setInterval(() => { if (Date.now() - last > 3500){ clearInterval(hbWatch); cb.onDrop && cb.onDrop(); } }, 700);
        };
        pc.onconnectionstatechange = () => {
          const s = pc.connectionState;
          if (s === "failed" || s === "closed") { cb.onDrop && cb.onDrop(); }
          else if (s === "disconnected") setTimeout(() => { try{ if (pc.connectionState === "disconnected") cb.onDrop && cb.onDrop(); }catch{} }, 4000);
        };
        pc.onicecandidate = ev => { if (ev.candidate) send("ice-t", ev.candidate); };
        await pc.setRemoteDescription(payload.sdp);
        for (const cand of iceQ.splice(0)) { try { await pc.addIceCandidate(cand); } catch {} }
        try { const up = cb.upstream && cb.upstream();            // tablet's front camera -> the phone (the POV shot)
          if (up) up.getTracks().forEach(t => pc.addTrack(t, up)); } catch {}
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        send("answer", { sdp: pc.localDescription });
      } catch (e) { cb.onState && cb.onState("error"); }
    });
    ch.on("broadcast", { event: "ice-p" }, ({ payload }) => {
      if (pc && pc.remoteDescription) { try { pc.addIceCandidate(payload); } catch {} }
      else iceQ.push(payload);                       // arrived before the offer was processed — hold it
    });
    ch.on("broadcast", { event: "ping"  }, () => send("pong", {}));
    ch.subscribe(st => cb.onState && cb.onState(st));
    return { stop() { try { pc && pc.close(); } catch {}; try { ch.unsubscribe(); } catch {} } };
  }

  // PHONE: probe for the tablet, then offer the stream; self-heals on drops.
  function cast(room, stream, cb) {
    const ch = client().channel("cali-link-" + room);
    let pc = null, hbCh = null, gotPong = false, stopped = false, connected = false, probing = false, tIceQ = [], offerT = null, media = stream, lastPong = 0;
    const send = (event, payload) => { try { ch.send({ type: "broadcast", event, payload }); } catch {} };
    async function offer() {
      if (stopped || !media) return;
      try {
        if (pc) try { pc.close(); } catch {}
        tIceQ = [];
        pc = new RTCPeerConnection({ iceServers: ICE });
        try{ hbCh = pc.createDataChannel("hb"); const hb = hbCh; let hbT = null;
          hb.onopen = () => { hbT = setInterval(() => { try{ hb.send("h"); }catch{} }, 1000); };
          hb.onclose = () => { if (hbT) clearInterval(hbT); };
        }catch{}
        pc.ontrack = ev => { try { cb.onTrack && cb.onTrack(ev.streams[0]); } catch {} };
        media.getTracks().forEach(t => pc.addTrack(t, media));
        pc.onicecandidate = ev => { if (ev.candidate) send("ice-p", ev.candidate); };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "connected") { connected = true; clearTimeout(offerT); cb.onState && cb.onState("connected"); }
          else if (["failed", "closed", "disconnected"].includes(pc.connectionState) && !stopped && connected) {
            connected = false; cb.onState && cb.onState("retry"); setTimeout(probe, 1500);
          }
        };
        const off = await pc.createOffer();
        await pc.setLocalDescription(off);
        setTimeout(() => send("offer", { sdp: pc.localDescription }), 350);   // trickle carries the rest
        clearTimeout(offerT);                            // no answer/connection in 6.5s -> start over (lost broadcast etc)
        offerT = setTimeout(() => { if (!stopped && !connected) probe(); }, 6500);
      } catch (e) { cb.onState && cb.onState("error"); }
    }
    function probe() {
      if (stopped || connected || probing) return;
      probing = true; gotPong = false; send("ping", {});
      setTimeout(() => {
        probing = false;
        if (stopped || connected) return;
        if (gotPong) {
          lastPong = Date.now();
          if (media) offer();
          else { cb.onState && cb.onState("found"); setTimeout(probe, 5000); }   // stay warm until the camera starts
        }
        else { cb.onState && cb.onState("waiting"); setTimeout(probe, 1800); }
      }, 800);
    }
    ch.on("broadcast", { event: "pong"   }, () => { gotPong = true; });
    ch.on("broadcast", { event: "answer" }, async ({ payload }) => {
      try {
        await pc.setRemoteDescription(payload.sdp);
        for (const cand of tIceQ.splice(0)) { try { await pc.addIceCandidate(cand); } catch {} }
      } catch {}
    });
    ch.on("broadcast", { event: "ice-t"  }, ({ payload }) => {
      if (pc && pc.remoteDescription) { try { pc.addIceCandidate(payload); } catch {} }
      else tIceQ.push(payload);                      // answer not applied yet — hold it
    });
    ch.subscribe(st => { cb.onState && cb.onState(st); if (st === "SUBSCRIBED") probe(); });
    return { stop() { stopped = true; try { pc && pc.close(); } catch {}; try { ch.unsubscribe(); } catch {} },
             send(obj) { try { if (hbCh && hbCh.readyState === "open") hbCh.send(JSON.stringify(obj)); } catch {} },
             attach(s) { media = s; if (!connected && !stopped) { if (Date.now() - lastPong < 8000) offer(); else probe(); } } };
  }
  return { listen, cast };
})();
