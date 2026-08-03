
    (function(){
      function syncMainHeaderPad(){
        var hdr = document.querySelector('.header');
        var main = document.querySelector('.main-content');
        if (!hdr || !main) return;
        var narrow = window.matchMedia('(max-width: 480px)').matches;
        var base = narrow ? 16 : 24;
        var h = hdr.getBoundingClientRect().height;
        if (h < 32) {
          requestAnimationFrame(syncMainHeaderPad);
          return;
        }
        var slack = narrow ? 12 : 4;
        main.style.paddingTop = (base + h + slack) + 'px';
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncMainHeaderPad);
      else syncMainHeaderPad();
      window.addEventListener('resize', syncMainHeaderPad);
      window.addEventListener('orientationchange', function(){ setTimeout(syncMainHeaderPad, 200); });
      if (window.visualViewport) window.visualViewport.addEventListener('resize', syncMainHeaderPad);
    })();
    function arrayBufferToBase64(buffer){
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      return btoa(binary);
    }
    (function(){
      var overlay = document.getElementById('overlay');
      if (overlay) overlay.addEventListener('click', function(e){ e.preventDefault(); if (window.g1CloseDrawer) window.g1CloseDrawer(); });
      var navLinks = document.querySelectorAll('.sidebar nav a');
      for (var ai = 0; ai < navLinks.length; ai++) {
        navLinks[ai].addEventListener('click', function(e){
          e.preventDefault();
          var sec = this.getAttribute('data-section');
          if (sec && window.g1ActivateClientSection) window.g1ActivateClientSection(sec);
        });
      }
      if (window.g1CloseDrawer) window.g1CloseDrawer();
    })();

    const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
    const wsParlaUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/parla';
    const wsGrokVoiceUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/grok-voice';
    var _talkAgentMode = 'none';
    function applyTalkAgentLayout(mode){
      _talkAgentMode = mode || 'none';
      var grok = document.getElementById('grokVoicePanel');
      var legacy = document.getElementById('legacyTalkPanel');
      if (grok) {
        grok.classList.toggle('is-active', _talkAgentMode === 'grok');
        grok.classList.toggle('is-collapsed', _talkAgentMode !== 'grok');
      }
      if (legacy) {
        legacy.classList.toggle('is-active', _talkAgentMode === 'legacy');
        legacy.classList.toggle('is-collapsed', _talkAgentMode !== 'legacy');
      }
    }
    window.g1SetTalkAgentMode = function(mode){
      mode = (mode === 'grok' || mode === 'legacy') ? mode : 'none';
      if (mode === 'grok') {
        var wt = document.getElementById('wakeListenToggle');
        if (wt && wt.checked) {
          wt.checked = false;
          if (typeof stopWakeRecorder === 'function') stopWakeRecorder();
          if (typeof resetWakeCommandMode === 'function') resetWakeCommandMode();
        }
        var wl = document.getElementById('wakeToggleLabel');
        if (wl) wl.textContent = 'OFF';
      } else if (mode === 'legacy' && typeof window.g1GrokVoiceStop === 'function') {
        window.g1GrokVoiceStop(true);
      }
      applyTalkAgentLayout(mode);
    };
    applyTalkAgentLayout('none');
    (function(){
      var grokWs = null, grokMicStream = null, grokCaptureCtx = null, grokCaptureNode = null;
      var grokPlaybackCtx = null, grokNextPlayTime = 0, grokActive = false, grokSessionReady = false;
      var GROK_SAMPLE_RATE = 24000;
      function grokEl(id){ return document.getElementById(id); }
      function grokSetStatus(t){ var el = grokEl('grokVoiceStatus'); if (el) el.textContent = t; }
      var grokUserText = '', grokAssistantText = '';
      function grokUpdateTranscript(){
        var el = grokEl('grokVoiceTranscript');
        if (!el) return;
        var parts = [];
        if (grokUserText) parts.push('Tu: ' + grokUserText);
        if (grokAssistantText) parts.push('Grok: ' + grokAssistantText);
        el.textContent = parts.join(' · ');
      }
      function grokDownsample(buffer, fromRate, toRate){
        if (fromRate === toRate) return buffer;
        var ratio = fromRate / toRate;
        var newLen = Math.round(buffer.length / ratio);
        var out = new Float32Array(newLen);
        for (var i = 0; i < newLen; i++) out[i] = buffer[Math.floor(i * ratio)] || 0;
        return out;
      }
      function grokFloatToPcm16(float32){
        var buf = new ArrayBuffer(float32.length * 2);
        var view = new DataView(buf);
        for (var i = 0; i < float32.length; i++){
          var s = Math.max(-1, Math.min(1, float32[i]));
          view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        return buf;
      }
      function grokPlayPcmDelta(b64){
        try {
          var raw = atob(b64);
          var bytes = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          var int16 = new Int16Array(bytes.buffer);
          var float32 = new Float32Array(int16.length);
          for (var j = 0; j < int16.length; j++) float32[j] = int16[j] / 32768;
          if (!grokPlaybackCtx) {
            grokPlaybackCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: GROK_SAMPLE_RATE });
            var spk = grokEl('speaker');
            var sink = spk && spk.value && spk.value.indexOf('browser_') === 0 ? spk.value.replace(/^browser_/, '') : '';
            if (sink && sink !== 'default' && typeof grokPlaybackCtx.setSinkId === 'function') {
              grokPlaybackCtx.setSinkId(sink).catch(function(){});
            }
          }
          if (grokPlaybackCtx.state === 'suspended') grokPlaybackCtx.resume();
          var buffer = grokPlaybackCtx.createBuffer(1, float32.length, GROK_SAMPLE_RATE);
          buffer.copyToChannel(float32, 0);
          var src = grokPlaybackCtx.createBufferSource();
          src.buffer = buffer;
          src.connect(grokPlaybackCtx.destination);
          var t = Math.max(grokPlaybackCtx.currentTime, grokNextPlayTime);
          src.start(t);
          grokNextPlayTime = t + buffer.duration;
        } catch (_) {}
      }
      function grokSend(obj){
        if (grokWs && grokWs.readyState === 1) grokWs.send(JSON.stringify(obj));
      }
      function grokStopMic(){
        if (grokCaptureNode) { try { grokCaptureNode.disconnect(); } catch(_){} grokCaptureNode.onaudioprocess = null; grokCaptureNode = null; }
        if (grokCaptureCtx) { try { grokCaptureCtx.close(); } catch(_){} grokCaptureCtx = null; }
        if (grokMicStream) { grokMicStream.getTracks().forEach(function(t){ try { t.stop(); } catch(_){} }); grokMicStream = null; }
      }
      function grokStopWs(){
        if (grokWs) { try { grokWs.close(); } catch(_){} grokWs = null; }
      }
      window.g1GrokVoiceStop = function(keepLayout){
        var wasActive = grokActive;
        grokActive = false;
        grokSessionReady = false;
        grokNextPlayTime = 0;
        grokUserText = '';
        grokAssistantText = '';
        grokStopMic();
        grokStopWs();
        var wt = grokEl('wakeListenToggle');
        if (wt) wt.disabled = false;
        var tg = grokEl('grokVoiceToggle');
        if (tg) tg.checked = false;
        var tl = grokEl('grokVoiceToggleLabel');
        if (tl) tl.textContent = 'OFF';
        if (wasActive) grokSetStatus('Disattivato');
        grokUpdateTranscript();
        if (!keepLayout) {
          if (_talkAgentMode === 'grok') applyTalkAgentLayout('none');
          setTimeout(function(){ if (typeof startParlaMicPreviewIfEligible === 'function') startParlaMicPreviewIfEligible(); }, 180);
        }
      };
      function grokConfigureSession(){
        grokSend({
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad' },
            audio: {
              input: { format: { type: 'audio/pcm', rate: GROK_SAMPLE_RATE } },
              output: { format: { type: 'audio/pcm', rate: GROK_SAMPLE_RATE } }
            }
          }
        });
      }
      var grokLastLevelTs = 0;
      async function grokStartMic(){
        var micSel = grokEl('mic');
        var micValue = micSel ? String(micSel.value || '') : '';
        if (micValue.indexOf('local_') === 0) {
          grokSetStatus('Microfono DJI sulla Jetson — attendo sessione…');
          return;
        }
        if (micValue.indexOf('net_') === 0) {
          window.g1GrokVoiceStop();
          grokSetStatus('Seleziona il DJI Jetson oppure un microfono Browser');
          return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          window.g1GrokVoiceStop();
          grokSetStatus('Microfono browser non disponibile');
          return;
        }
        var devId = micValue.indexOf('webmic_') === 0 ? decodeURIComponent(micValue.slice(7)) : '';
        grokSetStatus('Apertura microfono…');
        try {
          if (typeof getUserMediaWithFallback === 'function') {
            grokMicStream = await getUserMediaWithFallback(devId || null);
          } else {
            grokMicStream = await navigator.mediaDevices.getUserMedia(
              typeof buildAudioCaptureConstraints === 'function'
                ? buildAudioCaptureConstraints(devId)
                : { audio: devId ? { deviceId: { exact: devId } } : true }
            );
          }
        } catch (e) {
          window.g1GrokVoiceStop();
          grokSetStatus((e && e.message) ? e.message : 'Permesso microfono negato');
          return;
        }
        grokCaptureCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (grokCaptureCtx.state === 'suspended') await grokCaptureCtx.resume();
        var source = grokCaptureCtx.createMediaStreamSource(grokMicStream);
        grokCaptureNode = grokCaptureCtx.createScriptProcessor(8192, 1, 1);
        var grokSilentOut = grokCaptureCtx.createGain();
        grokSilentOut.gain.value = 0;
        grokCaptureNode.onaudioprocess = function(ev){
          if (!grokActive || !grokSessionReady || !grokWs || grokWs.readyState !== 1) return;
          var input = ev.inputBuffer.getChannelData(0);
          var inputGain = typeof getParlaMonitorGain === 'function' ? getParlaMonitorGain() : 1;
          var peak = 0;
          for (var p = 0; p < input.length; p++) peak = Math.max(peak, Math.abs(input[p]));
          var peak255 = Math.min(255, Math.round(peak * 255 * inputGain));
          var now = Date.now();
          if (now - grokLastLevelTs >= 120 && typeof window.g1UpdateTalkMicLevel === 'function') {
            grokLastLevelTs = now;
            window.g1UpdateTalkMicLevel(peak255);
          }
          var threshold = typeof getWakeVoiceThreshold === 'function' ? getWakeVoiceThreshold() : 20;
          var adjusted = new Float32Array(input.length);
          if (peak255 >= threshold) {
            for (var a = 0; a < input.length; a++) adjusted[a] = Math.max(-1, Math.min(1, input[a] * inputGain));
          }
          var pcm = grokDownsample(adjusted, grokCaptureCtx.sampleRate, GROK_SAMPLE_RATE);
          var buf = grokFloatToPcm16(pcm);
          grokSend({ type: 'input_audio_buffer.append', audio: arrayBufferToBase64(buf) });
        };
        source.connect(grokCaptureNode);
        grokCaptureNode.connect(grokSilentOut);
        grokSilentOut.connect(grokCaptureCtx.destination);
        grokSetStatus('In ascolto — parla con Grok');
      }
      function grokHandleEvent(ev){
        if (!ev || !ev.type) return;
        if (ev.type === 'proxy.ready') {
          grokSessionReady = false;
          grokConfigureSession();
          return;
        }
        if (ev.type === 'proxy.mic_info') {
          grokSetStatus('In ascolto dal ' + (ev.name || 'microfono Jetson'));
          return;
        }
        if (ev.type === 'proxy.mic_level') {
          if (typeof window.g1UpdateTalkMicLevel === 'function') {
            window.g1UpdateTalkMicLevel(ev.peak255 || 0);
          }
          return;
        }
        if (ev.type === 'session.updated' || ev.type === 'session.created') {
          grokSessionReady = true;
          grokSetStatus('Agente attivo — parla');
          return;
        }
        if (ev.type === 'response.output_audio.delta' && ev.delta) {
          grokPlayPcmDelta(ev.delta);
          grokSetStatus('Grok sta parlando…');
          return;
        }
        if (ev.type === 'response.output_audio_transcript.delta' && ev.delta) {
          grokAssistantText += ev.delta;
          grokUpdateTranscript();
          return;
        }
        if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript) {
          grokUserText = ev.transcript;
          grokAssistantText = '';
          grokUpdateTranscript();
          return;
        }
        if (ev.type === 'response.created') grokAssistantText = '';
        if (ev.type === 'input_audio_buffer.speech_started') grokSetStatus('Ti sto ascoltando…');
        if (ev.type === 'response.done') grokSetStatus('In ascolto — parla con Grok');
        if (ev.type === 'error') {
          grokSetStatus('Errore: ' + (ev.error && ev.error.message ? ev.error.message : (ev.error || 'sconosciuto')));
        }
      }
      window.g1GrokVoiceStart = async function(){
        if (grokActive) return;
        window.g1SetTalkAgentMode('grok');
        if (typeof stopParlaMicPreview === 'function') stopParlaMicPreview();
        if (typeof stopWakeRecorder === 'function') stopWakeRecorder();
        var wt = grokEl('wakeListenToggle');
        if (wt) { wt.checked = false; wt.disabled = true; }
        grokActive = true;
        grokSetStatus('Connessione a Grok…');
        grokUserText = '';
        grokAssistantText = '';
        grokUpdateTranscript();
        var micEl = grokEl('mic');
        var micValue = micEl ? String(micEl.value || '') : '';
        var grokUrl = wsGrokVoiceUrl;
        if (micValue.indexOf('local_') === 0) {
          var gain = typeof getParlaMonitorGain === 'function' ? getParlaMonitorGain() : 1;
          var threshold = typeof getWakeVoiceThreshold === 'function' ? getWakeVoiceThreshold() : 20;
          grokUrl += '?input=jetson&gain=' + encodeURIComponent(gain) + '&threshold=' + encodeURIComponent(threshold);
        }
        grokWs = new WebSocket(grokUrl);
        grokWs.onopen = function(){ grokSetStatus('Connesso — configurazione sessione…'); };
        grokWs.onmessage = function(msg){
          try { grokHandleEvent(JSON.parse(msg.data)); } catch (_) {}
        };
        grokWs.onerror = function(){ grokSetStatus('Errore WebSocket'); };
        grokWs.onclose = function(){
          grokWs = null;
          if (grokActive) {
            grokActive = false;
            grokStopMic();
            grokSetStatus('Connessione chiusa');
            var tg = grokEl('grokVoiceToggle');
            if (tg) tg.checked = false;
            var wt = grokEl('wakeListenToggle');
            if (wt) wt.disabled = false;
          }
        };
        await grokStartMic();
      };
      function grokRefreshPanel(){
        fetch('/api/grok-voice/status').then(function(r){ return r.json(); }).then(function(d){
          var panel = grokEl('grokVoicePanel');
          var hint = grokEl('grokVoiceConfigHint');
          var tg = grokEl('grokVoiceToggle');
          if (!panel) return;
          if (!d.configured) {
            if (hint) hint.style.display = 'block';
            if (tg) tg.disabled = true;
            grokSetStatus('Non configurato sul server');
          } else {
            if (hint) hint.style.display = 'none';
            if (tg) tg.disabled = false;
            grokSetStatus('Disattivato' + (d.agent_id ? ' (agent ' + d.agent_id + ')' : ''));
          }
        }).catch(function(){});
      }
      var grokToggle = grokEl('grokVoiceToggle');
      if (grokToggle) {
        grokToggle.onchange = function(){
          var lbl = grokEl('grokVoiceToggleLabel');
          if (lbl) lbl.textContent = grokToggle.checked ? 'ON' : 'OFF';
          if (grokToggle.checked) {
            window.g1SetTalkAgentMode('grok');
            window.g1GrokVoiceStart();
          } else {
            window.g1GrokVoiceStop();
          }
        };
      }
      grokRefreshPanel();
    })();
    var btn = null;
    let _loadDevicesSeq = 0;
    let _micPermissionGranted = false;
    let wsParla = null;
    let recordingServerJetson = false;
    const MAX_REC_SEC = 20;
    /* PTT: un filo più lungo prima dell'invio (meno frasi troncate). */
    const MIN_REC_MS = 1200;
    let ws = null, mediaRecorder = null, chunks = [], recTimeout = null, lastPlayOn = 'browser', lastSinkId = null;
    let serverTtsDeviceId = null;
    const TTS_PLAY_DEST_LS = 'g1_tts_play_dest';
    function getTtsPlayDest() {
      var el = document.getElementById('ttsPlayDest');
      if (el && (el.value === 'server' || el.value === 'browser')) return el.value;
      try {
        var v = localStorage.getItem(TTS_PLAY_DEST_LS);
        if (v === 'server' || v === 'browser') return v;
      } catch(_){}
      return 'browser';
    }
    function setTtsPlayDest(v, persist) {
      var val = (v === 'server') ? 'server' : 'browser';
      var el = document.getElementById('ttsPlayDest');
      if (el) el.value = val;
      if (persist !== false) {
        try { localStorage.setItem(TTS_PLAY_DEST_LS, val); } catch(_){}
      }
      var hint = document.getElementById('ttsServerHint');
      if (hint) {
        hint.style.display = 'block';
        hint.textContent = (val === 'server')
          ? 'Salvato: audio sulla cassa Jetson/robot.'
          : 'Salvato: audio sul browser (PC/telefono).';
        hint.style.color = val === 'server' ? '#a78bfa' : '#14b8a6';
      }
    }
    function restoreTtsPlayDest() {
      try {
        var v = localStorage.getItem(TTS_PLAY_DEST_LS);
        if (v === 'server' || v === 'browser') setTtsPlayDest(v, false);
      } catch(_){}
    }
    let _serverDevicesCache = { microphones: [], speakers: [], hardware_probe: null };
    function escapeHtmlDevices(s){
      return String(s||'').replace(/&/g,'&amp;').replace(/\u003c/g,'&lt;').replace(/"/g,'&quot;');
    }
    function updateActiveMicIndicator(){
      const dot = document.getElementById('activeMicDot');
      const lbl = document.getElementById('activeMicLabel');
      if (!dot || !lbl) return;
      const micSel = document.getElementById('mic');
      const val = micSel ? micSel.value : '';
      const opt = micSel ? micSel.options[micSel.selectedIndex] : null;
      const name = (opt && opt.textContent) ? String(opt.textContent).trim() : '';
      const isLocal = val && String(val).indexOf('local_') === 0;
      const isBrowser = val && String(val).indexOf('webmic_') === 0;
      const wt = document.getElementById('wakeListenToggle');
      const listening = wt && wt.checked;
      if (isLocal) {
        dot.style.background = listening ? '#22c55e' : '#14b8a6';
        dot.style.boxShadow = listening ? '0 0 6px #22c55e' : 'none';
        lbl.innerHTML = 'Microfono: <strong style="color:#2dd4bf;">' + escapeHtmlDevices(name || 'Jetson USB') + '</strong>' + (listening ? ' <span style="color:#22c55e;">(ascolto attivo)</span>' : '');
      } else if (isBrowser) {
        dot.style.background = listening ? '#22c55e' : '#3b82f6';
        dot.style.boxShadow = listening ? '0 0 6px #22c55e' : 'none';
        lbl.innerHTML = 'Microfono: <strong style="color:#60a5fa;">' + escapeHtmlDevices(name || 'Browser') + '</strong>' + (listening ? ' <span style="color:#22c55e;">(ascolto attivo)</span>' : '');
      } else if (name && name !== 'Caricamento...' && name !== 'Nessun microfono browser') {
        dot.style.background = '#71717a';
        dot.style.boxShadow = 'none';
        lbl.innerHTML = 'Microfono: <strong style="color:#e4e4e7;">' + escapeHtmlDevices(name) + '</strong>';
      } else {
        dot.style.background = '#71717a';
        dot.style.boxShadow = 'none';
        lbl.innerHTML = '<span style="color:#71717a;">Microfono: attivazione…</span>';
      }
    }
    function micForBrowserCapture(){
      const v = document.getElementById('mic') && document.getElementById('mic').value;
      if (!v || v === 'web_wait') return null;
      if (String(v).indexOf('local_') === 0) return null;
      if (String(v).indexOf('net_') === 0) return null;
      if (String(v).indexOf('webmic_') === 0) {
        try { return decodeURIComponent(v.slice(7)); } catch(_) { return null; }
      }
      return String(v).length > 5 ? v : null;
    }
    function buildMicCfgFromSelect(val){
      if (!val || val === 'web_wait') return { type: 'network', value: 'web_wait', name: '', device_id: '' };
      if (val.indexOf('local_') === 0) {
        const id = parseInt(val.split('_')[1], 10);
        const m = (_serverDevicesCache.microphones || []).find(function(x){ return x && x.value === val; });
        return { type: 'local', device_id: id, value: val, name: (m && m.name) || '' };
      }
      if (val.indexOf('net_') === 0) {
        const m = (_serverDevicesCache.microphones || []).find(function(x){ return x && x.value === val; });
        return { type: 'network', device_id: val.replace(/^net_/, ''), value: val, name: (m && m.name) || '' };
      }
      if (val.indexOf('webmic_') === 0) {
        try {
          const id = decodeURIComponent(val.slice(7));
          return { type: 'network', device_id: id, value: id, name: 'Browser' };
        } catch(_) { return { type: 'network', value: 'web_wait', name: '', device_id: '' }; }
      }
      return { type: 'network', device_id: val, value: val, name: 'Browser' };
    }
    function buildSpkCfgFromSelect(val){
      if (!val) return { type: 'network', value: 'web_wait', name: 'Browser' };
      if (val.indexOf('local_') === 0) {
        const id = parseInt(val.split('_')[1], 10);
        const s = (_serverDevicesCache.speakers || []).find(function(x){ return x && x.value === val; });
        return { type: 'local', device_id: id, value: val, name: (s && s.name) || '' };
      }
      if (val.indexOf('net_') === 0) {
        const s = (_serverDevicesCache.speakers || []).find(function(x){ return x && x.value === val; });
        return { type: 'network', device_id: val.replace(/^net_/, ''), value: val, name: (s && s.name) || '' };
      }
      if (val.indexOf('browser_') === 0) {
        const rest = val.slice(8);
        if (rest === 'default') return { type: 'network', value: 'web_wait', name: 'Browser predefinito' };
        return { type: 'network', device_id: rest, value: rest, name: 'Browser' };
      }
      return { type: 'network', value: 'web_wait', name: 'Browser' };
    }
    function updateHwProbe(hp){
      const el = document.getElementById('hwProbe');
      if (!el) return;
      if (!hp) { el.textContent = '(nessun dato - server non Linux?)'; return; }
      const bits = [];
      if (hp.arecord_l) bits.push('=== arecord -l (ingressi ALSA) ===\\n' + hp.arecord_l);
      if (hp.aplay_l) bits.push('=== aplay -l (uscite ALSA) ===\\n' + hp.aplay_l);
      if (hp.lsusb) bits.push('=== lsusb (audio/USB) ===\\n' + hp.lsusb);
      if (hp.asound_cards) bits.push('=== /proc/asound/cards ===\\n' + hp.asound_cards);
      el.textContent = bits.length ? bits.join('\\n\\n') : '(vuoto)';
    }
    let recStartTime = 0, recDurationInterval = null, levelInterval = null, analyserNode = null, audioCtx = null;
    let isRecording = false, pendingStop = false, currentStream = null;
    let pttInputGainNode = null;
    let wakeStream = null, wakeRawStream = null, wakeListenPending = false;
    let wakeListenActive = false, wakeMimeType = '', wakeActiveMr = null, wakeDiscardCurrentSlice = false;
    let wsListenServer = null, wakeServerMode = false;
    let wakeCommandMode = false, wakeCommandIdleTimer = null;
    let wakeAudioInFlight = false, wakeQueuedBlob = null;
    let listenServerWakeLatched = false;
    let wakeLevelCtx = null, wakeAnalyser = null, wakeInputGainNode = null, wakeLevelSampleInterval = null;
    let wakeSlicePeak = 0;
    /** Default soglia voce (0-255 FFT); override con slider e localStorage g1_wake_voice_threshold. */
    const WAKE_VOICE_THRESHOLD_DEFAULT = 20;
    function getWakeVoiceThreshold() {
      try {
        var raw = localStorage.getItem('g1_wake_voice_threshold');
        if (raw != null && raw !== '') {
          var v = parseInt(raw, 10);
          if (!isNaN(v) && v >= 1 && v <= 80) return v;
        }
      } catch (_) {}
      return WAKE_VOICE_THRESHOLD_DEFAULT;
    }
    let parlaPreviewTimer = null;
    let parlaPreviewCtx = null;
    let parlaPreviewAnalyser = null;
    let parlaPreviewStream = null;
    function getParlaMonitorGain() {
      try {
        var g = parseFloat(localStorage.getItem('g1_mic_monitor_gain'));
        if (!isNaN(g) && g >= 0.4 && g <= 4) return g;
      } catch (_) {}
      return 1;
    }
    function applyLocalMicDefaultsIfUnset(micValue) {
      if (!micValue || String(micValue).indexOf('local_') !== 0) return;
      try {
        var migrated = localStorage.getItem('g1_dji_levels_v1') === '1';
        var oldThreshold = localStorage.getItem('g1_wake_voice_threshold');
        var oldGain = localStorage.getItem('g1_mic_monitor_gain');
        if (oldThreshold == null || (!migrated && oldThreshold === '20')) {
          localStorage.setItem('g1_wake_voice_threshold', '5');
        }
        if (oldGain == null || (!migrated && (oldGain === '1' || oldGain === '1.0'))) {
          localStorage.setItem('g1_mic_monitor_gain', '2');
        }
        localStorage.setItem('g1_dji_levels_v1', '1');
      } catch (_) {}
      var threshold = getWakeVoiceThreshold();
      var gain = getParlaMonitorGain();
      var thSlider = document.getElementById('micWakeThresholdSlider');
      var thDisplay = document.getElementById('wakeThDisplay');
      var gainSlider = document.getElementById('micMonitorGainSlider');
      var gainDisplay = document.getElementById('micGainDisplay');
      if (thSlider) thSlider.value = String(threshold);
      if (thDisplay) thDisplay.textContent = String(threshold);
      if (gainSlider) gainSlider.value = String(gain);
      if (gainDisplay) gainDisplay.textContent = gain.toFixed(1);
      updateParlaThresholdLine();
    }
    function stopParlaMicPreview() {
      if (parlaPreviewTimer) { clearInterval(parlaPreviewTimer); parlaPreviewTimer = null; }
      if (parlaPreviewCtx) {
        try { parlaPreviewCtx.close(); } catch (_) {}
        parlaPreviewCtx = null;
      }
      parlaPreviewAnalyser = null;
      if (parlaPreviewStream) {
        try { parlaPreviewStream.getTracks().forEach(function(t){ try { t.stop(); } catch(_){} }); } catch (_) {}
        parlaPreviewStream = null;
      }
    }
    function updateParlaThresholdLine() {
      var line = document.getElementById('parlaPreviewThresholdLine');
      if (!line) return;
      var th = getWakeVoiceThreshold();
      var pct = Math.max(0, Math.min(100, (th / 255) * 100));
      line.style.left = 'calc(' + pct + '% - 1px)';
    }
    window.g1UpdateTalkMicLevel = function(peak){
      peak = Math.max(0, Math.min(255, Number(peak) || 0));
      var th = getWakeVoiceThreshold();
      var gain = getParlaMonitorGain();
      var barW = Math.min(100, peak * (100 / 255));
      var fill = document.getElementById('parlaPreviewBarFill');
      var st = document.getElementById('parlaPreviewStatus');
      var gate = document.getElementById('parlaPreviewGate');
      if (fill) fill.style.width = barW.toFixed(1) + '%';
      if (st) st.textContent = 'Picco: ' + Math.round(peak) + ' / 255 · soglia: ' + th + ' · gain: ' + gain.toFixed(1) + '×';
      if (gate) {
        if (peak >= th) {
          gate.textContent = 'VOCE';
          gate.style.background = 'rgba(34,197,94,0.25)';
          gate.style.color = '#4ade80';
        } else {
          gate.textContent = 'Silenzio';
          gate.style.background = '#27272a';
          gate.style.color = '#71717a';
        }
      }
      updateParlaThresholdLine();
    };
    (function initParlaMicControls(){
      var wTh = document.getElementById('micWakeThresholdSlider');
      var wDisp = document.getElementById('wakeThDisplay');
      var gSl = document.getElementById('micMonitorGainSlider');
      var gDisp = document.getElementById('micGainDisplay');
      if (wTh) {
        wTh.value = String(getWakeVoiceThreshold());
        if (wDisp) wDisp.textContent = wTh.value;
        wTh.addEventListener('input', function(){
          var v = parseInt(wTh.value, 10);
          if (isNaN(v)) v = WAKE_VOICE_THRESHOLD_DEFAULT;
          v = Math.max(1, Math.min(80, v));
          try { localStorage.setItem('g1_wake_voice_threshold', String(v)); } catch (_) {}
          if (wDisp) wDisp.textContent = String(v);
          updateParlaThresholdLine();
        });
      }
      if (gSl) {
        var gv = getParlaMonitorGain();
        gSl.value = String(gv);
        if (gDisp) gDisp.textContent = gv.toFixed(1);
        gSl.addEventListener('input', function(){
          var g = parseFloat(gSl.value);
          if (isNaN(g)) g = 1;
          g = Math.max(0.4, Math.min(4, g));
          try { localStorage.setItem('g1_mic_monitor_gain', String(g)); } catch (_) {}
          if (gDisp) gDisp.textContent = g.toFixed(1);
          if (wakeInputGainNode) wakeInputGainNode.gain.value = g;
          if (pttInputGainNode) pttInputGainNode.gain.value = g;
        });
      }
      updateParlaThresholdLine();
    })();
    function startParlaMicPreviewIfEligible() {
      var sec = document.getElementById('section-parla');
      if (!sec || !sec.classList.contains('active')) return;
      if (_talkAgentMode === 'grok' || _talkAgentMode === 'legacy') {
        stopParlaMicPreview();
        return;
      }
      stopParlaMicPreview();
      var micEl = document.getElementById('mic');
      var micVal = micEl ? micEl.value : '';
      var wrap = document.getElementById('parlaPreviewMeterWrap');
      var msg = document.getElementById('parlaPreviewDisabledMsg');
      var isBrowserMic = micVal && micVal.indexOf('webmic_') === 0;
      var isLocalMic = micVal && micVal.indexOf('local_') === 0;
      if (isLocalMic) {
        if (wrap) wrap.style.display = '';
        if (msg) msg.style.display = 'none';
        updateParlaThresholdLine();
        return;
      }
      if (!isBrowserMic) {
        if (wrap) wrap.style.display = 'none';
        if (msg) {
          msg.style.display = 'block';
          msg.innerHTML = 'Microfono attuale: Jetson o rete — il livello qui vale solo per il microfono <strong>Browser</strong> (telefono / DJI Mic).';
        }
        return;
      }
      if (wrap) wrap.style.display = '';
      if (msg) msg.style.display = 'none';
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      var previewOpen = (typeof getUserMediaWithFallback === 'function')
        ? getUserMediaWithFallback(micForBrowserCapture())
        : navigator.mediaDevices.getUserMedia(buildAudioCaptureConstraints(micForBrowserCapture()));
      previewOpen.then(function(stream){
        parlaPreviewStream = stream;
        var Ctx = window.AudioContext || window.webkitAudioContext;
        parlaPreviewCtx = new Ctx();
        var src = parlaPreviewCtx.createMediaStreamSource(stream);
        parlaPreviewAnalyser = parlaPreviewCtx.createAnalyser();
        parlaPreviewAnalyser.fftSize = 512;
        parlaPreviewAnalyser.smoothingTimeConstant = 0.35;
        src.connect(parlaPreviewAnalyser);
        if (parlaPreviewCtx.resume) parlaPreviewCtx.resume();
        var buf = new Uint8Array(parlaPreviewAnalyser.frequencyBinCount);
        updateParlaThresholdLine();
        parlaPreviewTimer = setInterval(function(){
          if (!parlaPreviewAnalyser) return;
          var secEl = document.getElementById('section-parla');
          if (!secEl || !secEl.classList.contains('active')) return;
          if (isRecording) return;
          parlaPreviewAnalyser.getByteFrequencyData(buf);
          var peak = 0;
          for (var i = 0; i < buf.length; i++) if (buf[i] > peak) peak = buf[i];
          var gain = getParlaMonitorGain();
          window.g1UpdateTalkMicLevel(Math.min(255, peak * gain));
        }, 55);
      }).catch(function(err){
        var m = document.getElementById('parlaPreviewDisabledMsg');
        if (m) {
          m.style.display = 'block';
          m.textContent = (err && err.message) ? err.message : "Microfono non disponibile: abilita l'accesso nelle impostazioni del browser per questo sito.";
        }
      });
    }
    const WAKE_SLICE_MS = __STT_WAKE_SLICE_MS__;
    const CMD_SLICE_MS  = __STT_CMD_SLICE_MS__;
    const CMD_SILENCE_MS = __STT_CMD_SILENCE_MS__;
    const CMD_MIN_VOICE_MS = __STT_CMD_MIN_VOICE_MS__;
    const CMD_TIMEOUT_MS = 45000;
    let _wakeSliceScheduled = false;
    let scheduleNextWakeSliceIfListening = function(){};
    /** Coda riproduzione TTS: evita che due risposte MP3 si sovrappongano. */
    let ttsPlaybackQueue = [];
    let ttsPlaybackBusy = false;
    const TTS_BEFORE_PLAY_GAP_MS = 60;
    /**
     * Uscita browser: solo se esplicita (Soundboard «Riproduci su» o altoparlante Browser non-Predefinito).
     * Se null → niente setSinkId: il sistema sceglie (su Android spesso la cassa BT se è l’uscita media predefinita).
     */
    function resolveBrowserPlaybackSinkIdLikeSoundboard() {
      var sbOut = document.getElementById('sbOutput');
      if (sbOut && sbOut.value && sbOut.value !== 'default') return sbOut.value;
      var spk = document.getElementById('speaker');
      if (spk) {
        var v = spk.value;
        if (v && v.indexOf('browser_') === 0 && v !== 'browser_default')
          return v.replace(/^browser_/, '');
      }
      return null;
    }
    function applySinkThenPlay(audio, sinkId) {
      var p = Promise.resolve();
      if (sinkId && audio.setSinkId) {
        p = audio.setSinkId(sinkId).catch(function() { return Promise.resolve(); });
      }
      return p.then(function() { return audio.play(); });
    }
    let sbBrowserCtx = null, sbBrowserSource = null, sbBrowserAudioEl = null;
    function sbStopSoundboardPlayback(){
      try {
        try { if (sbBrowserSource) { sbBrowserSource.stop(); sbBrowserSource.disconnect(); } } catch(_){}
        sbBrowserSource = null;
        try { if (sbBrowserCtx) { sbBrowserCtx.close().catch(function(){}); } } catch(_){}
        sbBrowserCtx = null;
        if (sbBrowserAudioEl) { try { sbBrowserAudioEl.pause(); sbBrowserAudioEl.removeAttribute('src'); sbBrowserAudioEl.load(); } catch(_){} }
        sbBrowserAudioEl = null;
      } catch(_){}
    }
    function getSoundboardBrowserGain(){
      try {
        var v = parseFloat(localStorage.getItem('g1_soundboard_gain'));
        if (!isNaN(v) && v >= 0.35 && v <= 3.5) return v;
      } catch(_){}
      return 1.35;
    }
    function setSoundboardBrowserGain(v){
      try { localStorage.setItem('g1_soundboard_gain', String(v)); } catch(_){}
    }
    function playSoundboardBrowser(b64, fmt, onStart){
      sbStopSoundboardPlayback();
      if (!b64 || String(b64).length < 50) return;
      var mime = sbMimeForFmt(fmt);
      var gain = getSoundboardBrowserGain();
      var sinkId = resolveBrowserPlaybackSinkIdLikeSoundboard();
      function fireOnStart(){
        if (typeof onStart === 'function') {
          try { onStart(); } catch(_) {}
        }
      }
      var bin = atob(String(b64));
      var buf = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      var ctxOpts = {};
      if (sinkId) { try { ctxOpts.sinkId = sinkId; } catch(_){} }
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        var a0 = new Audio('data:'+mime+';base64,'+b64);
        sbBrowserAudioEl = a0;
        a0.addEventListener('playing', function onPlay(){ a0.removeEventListener('playing', onPlay); fireOnStart(); });
        applySinkThenPlay(a0, sinkId).catch(function(){});
        a0.onended = function(){ sbBrowserAudioEl = null; };
        return;
      }
      var ctx;
      try { ctx = new Ctx(ctxOpts); } catch(_) { ctx = new Ctx(); }
      sbBrowserCtx = ctx;
      if (ctx.resume) ctx.resume();
      ctx.decodeAudioData(ab, function(decoded){
        if (!sbBrowserCtx || sbBrowserCtx !== ctx) return;
        var src = ctx.createBufferSource();
        src.buffer = decoded;
        var gn = ctx.createGain();
        gn.gain.value = gain;
        src.connect(gn);
        gn.connect(ctx.destination);
        sbBrowserSource = src;
        src.onended = function(){
          sbBrowserSource = null;
          if (sbBrowserCtx === ctx) { try { ctx.close().catch(function(){}); } catch(_){} sbBrowserCtx = null; }
        };
        fireOnStart();
        src.start(0);
      }, function(){
        sbBrowserCtx = null;
        var a1 = new Audio('data:'+mime+';base64,'+b64);
        sbBrowserAudioEl = a1;
        a1.addEventListener('playing', function onPlay(){ a1.removeEventListener('playing', onPlay); fireOnStart(); });
        applySinkThenPlay(a1, sinkId).catch(function(){});
        a1.onended = function(){ sbBrowserAudioEl = null; };
      });
    }
    function sbFireSlotRobotIfConfigured(sd, slotIndex) {
      if (typeof slotIndex === 'number' && slotIndex < SB_ROBOT_START) return;
      if (!sd) return;
      var arm = (sd.robot_arm && String(sd.robot_arm).trim()) || '';
      var loco = (sd.robot_loco && String(sd.robot_loco).trim()) || '';
      var led = (sd.led_effect && String(sd.led_effect).trim()) || '';
      var teach = (sd.teaching_slot != null && String(sd.teaching_slot).trim()) || '';
      if (arm && teach) teach = '';
      if (!arm && !loco && !teach && !led) return;
      var ip = '192.168.123.161';
      try {
        var ls = localStorage.getItem('g1_robot_ip');
        if (ls && ls.trim()) ip = ls.trim();
      } catch(_) {}
      if (led) {
        fetch('/api/led', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ effect: led }) }).catch(function(){});
      }
      if (teach) {
        fetch('/api/explore-teachings/play', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name: sbNormalizeTeachingRef(teach) }) }).catch(function(){});
      }
      if (arm) {
        fetch('/api/robot-action', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ action_id: arm, robot_ip: ip }) }).catch(function(){});
      }
      if (loco) {
        fetch('/api/robot-loco', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ command: loco, robot_ip: ip }) }).catch(function(){});
      }
    }
    function syncSbOutputFromSpeaker() {
      var spk = document.getElementById('speaker');
      var sbOut = document.getElementById('sbOutput');
      if (!spk || !sbOut) return;
      var v = spk.value;
      if (v && v.indexOf('browser_') === 0 && v !== 'browser_default') {
        var id = v.replace(/^browser_/, '');
        for (var i = 0; i < sbOut.options.length; i++) {
          if (sbOut.options[i].value === id) { sbOut.selectedIndex = i; return; }
        }
      }
      try { sbOut.value = 'default'; } catch(_){}
    }
    function syncSpeakerFromSbOutput() {
      var spk = document.getElementById('speaker');
      var sbOut = document.getElementById('sbOutput');
      if (!spk || !sbOut) return;
      var id = sbOut.value;
      if (!id || id === 'default') {
        lastSinkId = null;
        var cur = spk.value;
        if (cur && cur.indexOf('browser_') === 0 && cur !== 'browser_default') {
          for (var k = 0; k < spk.options.length; k++) {
            if (spk.options[k].value === 'browser_default') { spk.selectedIndex = k; return; }
          }
        }
        return;
      }
      lastSinkId = id;
      var want = 'browser_' + id;
      for (var j = 0; j < spk.options.length; j++) {
        if (spk.options[j].value === want) { spk.selectedIndex = j; return; }
      }
    }
    function enqueueTtsPlayback(b64, onPlaybackFullyEnded) {
      if (!b64 || String(b64).length < 30) {
        if (onPlaybackFullyEnded) onPlaybackFullyEnded();
        return;
      }
      ttsPlaybackQueue.push({ b64: String(b64), onEnded: onPlaybackFullyEnded });
      pumpTtsPlaybackQueue();
    }
    var _ttsGainValue = parseFloat(localStorage.getItem('g1_tts_gain') || '2.5');
    function getTtsGain() { return _ttsGainValue; }
    function setTtsGain(v) { _ttsGainValue = v; localStorage.setItem('g1_tts_gain', String(v)); }
    function pumpTtsPlaybackQueue() {
      if (ttsPlaybackBusy) return;
      if (ttsPlaybackQueue.length === 0) return;
      ttsPlaybackBusy = true;
      const item = ttsPlaybackQueue.shift();
      setTimeout(function() {
        try {
          var gain = getTtsGain();
          var ttsSink = resolveBrowserPlaybackSinkIdLikeSoundboard();
          if (gain > 1.05 && window.AudioContext) {
            var raw = atob(item.b64);
            var buf = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
            var ctxOpts = {};
            if (ttsSink) { try { ctxOpts.sinkId = ttsSink; } catch(_){} }
            var ctx;
            try { ctx = new AudioContext(ctxOpts); } catch(_) { ctx = new AudioContext(); }
            ctx.decodeAudioData(buf.buffer, function(decoded) {
              var src = ctx.createBufferSource();
              src.buffer = decoded;
              var gn = ctx.createGain();
              gn.gain.value = gain;
              var limiter = ctx.createDynamicsCompressor();
              limiter.threshold.value = -3;
              limiter.knee.value = 6;
              limiter.ratio.value = 20;
              limiter.attack.value = 0.002;
              limiter.release.value = 0.05;
              src.connect(gn);
              gn.connect(limiter);
              limiter.connect(ctx.destination);
              src.onended = function() {
                ctx.close().catch(function(){});
                ttsPlaybackBusy = false;
                if (item.onEnded) item.onEnded();
                pumpTtsPlaybackQueue();
              };
              src.start(0);
            }, function() {
              _pumpTtsFallback(item, ttsSink);
            });
          } else {
            _pumpTtsFallback(item, ttsSink);
          }
        } catch(_) {
          ttsPlaybackBusy = false;
          if (item.onEnded) item.onEnded();
          pumpTtsPlaybackQueue();
        }
      }, TTS_BEFORE_PLAY_GAP_MS);
    }
    function _pumpTtsFallback(item, sinkId) {
      try {
        const audio = new Audio('data:audio/mpeg;base64,' + item.b64);
        audio.volume = 1.0;
        audio.onended = function() {
          ttsPlaybackBusy = false;
          if (item.onEnded) item.onEnded();
          pumpTtsPlaybackQueue();
        };
        audio.onerror = function() {
          ttsPlaybackBusy = false;
          if (item.onEnded) item.onEnded();
          pumpTtsPlaybackQueue();
        };
        applySinkThenPlay(audio, sinkId).catch(function() {
          ttsPlaybackBusy = false;
          if (item.onEnded) item.onEnded();
          pumpTtsPlaybackQueue();
        });
      } catch(_) {
        ttsPlaybackBusy = false;
        if (item.onEnded) item.onEnded();
        pumpTtsPlaybackQueue();
      }
    }
    function clearTtsPlaybackQueue() {
      ttsPlaybackQueue = [];
      ttsPlaybackBusy = false;
    }
    /** Stesso codec/bitrate del push-to-talk; MIME allineato a mediaRecorder.mimeType lato PTT. */
    function preferredRecorderMime() {
      return MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    }
    /** Vincoli microfono: soppressione rumore browser + mono + AGC. Su Chromium si rafforzano i flag legacy se presenti. */
    function buildAudioCaptureConstraints(deviceIdExact) {
      const a = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      };
      if (deviceIdExact && String(deviceIdExact).length > 5) {
        a.deviceId = { exact: deviceIdExact };
      }
      try {
        var ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
        if (/Chrome|Chromium|Edg/i.test(ua) && !/OPR|Opera/i.test(ua)) {
          a.googEchoCancellation = true;
          a.googNoiseSuppression = true;
          a.googAutoGainControl = true;
          a.googHighpassFilter = true;
        }
      } catch(_){}
      return { audio: a };
    }
    /** Vincoli leggeri per USB/wireless (es. DJI Mic): evita hang del browser con processing aggressivo. */
    function buildAudioCaptureConstraintsMinimal(deviceIdExact) {
      const a = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      };
      if (deviceIdExact && String(deviceIdExact).length > 5) {
        a.deviceId = { ideal: deviceIdExact };
      }
      return { audio: a };
    }
    async function getUserMediaWithFallback(deviceId, timeoutMs) {
      timeoutMs = timeoutMs || 9000;
      function withTimeout(promise) {
        return Promise.race([
          promise,
          new Promise(function(_, reject) {
            setTimeout(function(){ reject(new Error('Microfono: timeout apertura (' + Math.round(timeoutMs / 1000) + 's)')); }, timeoutMs);
          })
        ]);
      }
      var attempts = [
        buildAudioCaptureConstraints(deviceId),
        buildAudioCaptureConstraintsMinimal(deviceId),
        { audio: deviceId ? { deviceId: { ideal: deviceId }, channelCount: 1 } : { channelCount: 1 } }
      ];
      var lastErr = null;
      for (var i = 0; i < attempts.length; i++) {
        try {
          return await withTimeout(navigator.mediaDevices.getUserMedia(attempts[i]));
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('Microfono non disponibile');
    }
    /** Soglia uguale al controllo su /ws (audio troppo corto) e a sendAudio. */
    const WS_AUDIO_MIN_BYTES = 2000;
    /** Costruisce e invia lo stesso messaggio usato da Parla (PTT). */
    function sendAudioOverWs(b64, mime, opts) {
      opts = opts || {};
      const playOn = opts.playOn || 'browser';
      const msg = {
        type: 'audio',
        data: b64,
        play_on: playOn,
        skip_wake: opts.skipWake !== undefined ? opts.skipWake : true,
        format: mime || preferredRecorderMime()
      };
      if (playOn === 'server' && opts.deviceId != null) msg.device_id = opts.deviceId;
      ws.send(JSON.stringify(msg));
    }
    let thinkingInterval = null, thinkingAudioCtx = null;
    function startThinkingFeedback(showRecDebug){
      stopThinkingFeedback();
      if (showRecDebug !== false) {
        const el = document.getElementById('recDebug');
        if (el) { el.textContent = 'Sto elaborando (trascrizione + IA)…'; el.style.color = '#3b82f6'; }
      }
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        thinkingAudioCtx = new Ctx();
        thinkingInterval = setInterval(function(){
          if (!thinkingAudioCtx) return;
          const o = thinkingAudioCtx.createOscillator();
          const g = thinkingAudioCtx.createGain();
          o.frequency.value = 392;
          g.gain.setValueAtTime(0.04, thinkingAudioCtx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.001, thinkingAudioCtx.currentTime + 0.11);
          o.connect(g); g.connect(thinkingAudioCtx.destination);
          o.start();
          o.stop(thinkingAudioCtx.currentTime + 0.11);
          thinkingAudioCtx.resume && thinkingAudioCtx.resume();
        }, 800);
      } catch(_){}
    }
    function stopThinkingFeedback(){
      if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; }
      if (thinkingAudioCtx) { try { thinkingAudioCtx.close(); } catch(_){} thinkingAudioCtx = null; }
    }
    var _listenHumCtx = null, _listenHumOsc = null, _listenHumGain = null;
    function startListeningHum(){
      stopListeningHum();
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        _listenHumCtx = new Ctx();
        if (_listenHumCtx.resume) _listenHumCtx.resume();
        _listenHumOsc = _listenHumCtx.createOscillator();
        _listenHumOsc.type = 'sine';
        _listenHumOsc.frequency.value = 440;
        _listenHumGain = _listenHumCtx.createGain();
        _listenHumGain.gain.value = 0.03;
        var lfo = _listenHumCtx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 2;
        var lfoGain = _listenHumCtx.createGain();
        lfoGain.gain.value = 0.015;
        lfo.connect(lfoGain);
        lfoGain.connect(_listenHumGain.gain);
        lfo.start();
        _listenHumOsc.connect(_listenHumGain);
        _listenHumGain.connect(_listenHumCtx.destination);
        _listenHumOsc.start();
      } catch(_) { stopListeningHum(); }
    }
    function stopListeningHum(){
      if (_listenHumOsc) { try { _listenHumOsc.stop(); } catch(_){} _listenHumOsc = null; }
      if (_listenHumCtx) { try { _listenHumCtx.close(); } catch(_){} _listenHumCtx = null; }
      _listenHumGain = null;
    }
    function playStopChime(){
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        var ctx = new Ctx();
        if (ctx.resume) ctx.resume();
        var o = ctx.createOscillator(); var g = ctx.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(660, ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(330, ctx.currentTime + 0.2);
        g.gain.setValueAtTime(0.2, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        o.connect(g); g.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + 0.2);
        setTimeout(function(){ ctx.close().catch(function(){}); }, 300);
      } catch(_){}
    }
    function playWakeChime(){
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        if (ctx.resume) ctx.resume();
        const t0 = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.value = 0.78;
        master.connect(ctx.destination);
        function wakeNote(freq, delay, dur, peak){
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'triangle';
          o.frequency.value = freq;
          g.gain.setValueAtTime(0.0001, t0 + delay);
          g.gain.exponentialRampToValueAtTime(Math.max(0.08, peak), t0 + delay + 0.035);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + dur);
          o.connect(g);
          g.connect(master);
          o.start(t0 + delay);
          o.stop(t0 + delay + dur + 0.03);
        }
        /* Arpeggio maggiore con nona (C-E-G + D alta): tono chiaro, “jazz / positivo” */
        wakeNote(523.25, 0.0, 0.2, 0.52);
        wakeNote(659.25, 0.1, 0.2, 0.55);
        wakeNote(783.99, 0.2, 0.2, 0.58);
        wakeNote(1174.66, 0.3, 0.26, 0.5);
        wakeNote(1046.5, 0.42, 0.16, 0.38);
        setTimeout(function(){ ctx.close().catch(function(){}); }, 950);
      } catch(_){}
    }
    function resetWakeCommandMode(){
      wakeCommandMode = false;
      stopListeningHum();
      if (wakeCommandIdleTimer) { clearTimeout(wakeCommandIdleTimer); wakeCommandIdleTimer = null; }
      wakeQueuedBlob = null;
      if (wakeActiveMr) {
        wakeDiscardCurrentSlice = true;
        try { if (wakeActiveMr.state !== 'inactive') wakeActiveMr.stop(); } catch(_){}
      }
    }
    /** Dopo la risposta vocale: spegne «Hey G1 continuo» (solo se l'utente vuole stop esplicito). */
    function disableWakeListenAfterResponse(){
      var el = document.getElementById('wakeListenToggle');
      var wtl = document.getElementById('wakeToggleLabel');
      var st = document.getElementById('wakeListenStatus');
      if (el && el.checked) {
        el.checked = false;
        if (wtl) wtl.textContent = 'OFF';
      }
      stopWakeRecorder();
      resetWakeCommandMode();
      setRobotLed('idle');
      if (st) st.textContent = 'Ascolto disattivato — riattiva «Hey G1 continuo» per parlare di nuovo';
      wakeLog('Risposta finita: ascolto disattivato', '#71717a');
      updateActiveMicIndicator();
    }
    function clearWakePipelineLock(){
      wakeAudioInFlight = false;
      wakeListenPending = false;
      if (wakeResponseTimeout) { clearTimeout(wakeResponseTimeout); wakeResponseTimeout = null; }
    }
    /** Dopo TTS: resta in ascolto per domande successive (presentazione / dialogo). */
    function resumeWakeListenAfterResponse(){
      clearWakePipelineLock();
      wakeQueuedBlob = null;
      wakeDiscardCurrentSlice = false;
      _wakeDropSlicesAfterTts = 0;
      setRobotLed('listening');
      var el = document.getElementById('wakeListenToggle');
      var st = document.getElementById('wakeListenStatus');
      if (!el || !el.checked) return;
      wakeCommandMode = true;
      startWakeCommandIdleTimer();
      if (st) st.textContent = "Ti ascolto\u2026 puoi fare un'altra domanda.";
      setTimeout(function(){ startListeningHum(); }, 250);
      scheduleNextWakeSliceIfListening();
      wakeLog('Pronto per altra domanda', '#14b8a6');
    }
    function startWakeCommandIdleTimer(){
      if (wakeCommandIdleTimer) clearTimeout(wakeCommandIdleTimer);
      wakeCommandIdleTimer = setTimeout(function(){
        if (wakeCommandMode) {
          wakeLog('Timeout comando, torno in ascolto wake', '#71717a');
          resetWakeCommandMode();
          scheduleNextWakeSliceIfListening();
        }
      }, CMD_TIMEOUT_MS);
    }
    /** High-pass + compressore + guadagno UI → stream processato (Talk classico + Grok browser). */
    function createSpeechEnhancedPipeline(rawStream, analyserFftSize) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(rawStream);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 100;
      hp.Q.value = 0.707;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -28;
      comp.knee.value = 20;
      comp.ratio.value = 3.5;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = analyserFftSize || 512;
      analyser.smoothingTimeConstant = 0.35;
      const micGain = ctx.createGain();
      micGain.gain.value = getParlaMonitorGain();
      const dest = ctx.createMediaStreamDestination();
      src.connect(hp);
      hp.connect(comp);
      comp.connect(micGain);
      micGain.connect(analyser);
      micGain.connect(dest);
      ctx.resume && ctx.resume();
      return { ctx: ctx, analyser: analyser, inputGainNode: micGain, stream: dest.stream };
    }
    function stopWakeLevelMeter(){
      if (wakeLevelSampleInterval) { clearInterval(wakeLevelSampleInterval); wakeLevelSampleInterval = null; }
      if (wakeLevelCtx) { try { wakeLevelCtx.close(); } catch(_){} wakeLevelCtx = null; }
      wakeAnalyser = null;
      wakeInputGainNode = null;
      wakeSlicePeak = 0;
    }
    /** High-pass (taglia rimbombo/gravi) + compressore leggero → voce più stabile nel brusio; stream processato per MediaRecorder. */
    function startWakeSpeechEnhancer(){
      stopWakeLevelMeter();
      if (!wakeRawStream) return;
      try {
        const pipeline = createSpeechEnhancedPipeline(wakeRawStream, 512);
        wakeLevelCtx = pipeline.ctx;
        wakeAnalyser = pipeline.analyser;
        wakeInputGainNode = pipeline.inputGainNode;
        wakeStream = pipeline.stream;
      } catch(_) {
        wakeStream = wakeRawStream;
        try {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          wakeLevelCtx = new Ctx();
          wakeAnalyser = wakeLevelCtx.createAnalyser();
          wakeAnalyser.fftSize = 512;
          wakeAnalyser.smoothingTimeConstant = 0.35;
          wakeLevelCtx.createMediaStreamSource(wakeRawStream).connect(wakeAnalyser);
          wakeLevelCtx.resume && wakeLevelCtx.resume();
        } catch(__){ wakeAnalyser = null; }
      }
    }
    var WAKE_POST_TTS_PAUSE_MS = 350;
    var _wakeDropSlicesAfterTts = 0;
    function setRobotLed(state){
      try { fetch('/api/led', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({state:state})}); } catch(e){}
    }
    function onWakeResponseDone(){
      setTimeout(function(){
        resumeWakeListenAfterResponse();
      }, WAKE_POST_TTS_PAUSE_MS);
    }
    let wakeResponseTimeout = null;
    function ttsDestFromUi() {
      const dest = getTtsPlayDest();
      const spkEl = document.getElementById('speaker');
      const spkVal = spkEl ? String(spkEl.value || '') : '';
      if (dest === 'server') {
        var devId = (serverTtsDeviceId !== null && !isNaN(serverTtsDeviceId)) ? serverTtsDeviceId : null;
        if (spkVal.indexOf('local_') === 0) {
          var id = parseInt(spkVal.split('_')[1], 10);
          if (!isNaN(id)) devId = id;
        }
        return { playOn: 'server', deviceId: devId };
      }
      if (spkVal.indexOf('browser_') === 0 && spkVal !== 'browser_default') {
        lastSinkId = spkVal.replace(/^browser_/, '');
      } else {
        lastSinkId = null;
      }
      return { playOn: 'browser', deviceId: null };
    }
    function trySendWakeChunk(blob, skipWakeForBlob){
      if (!blob || blob.size < WS_AUDIO_MIN_BYTES) { scheduleNextWakeSliceIfListening(); return; }
      if (!document.getElementById('wakeListenToggle').checked) return;
      if (isRecording) { scheduleNextWakeSliceIfListening(); return; }
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        wakeLog('WebSocket non pronto — in attesa connessione…', '#f59e0b');
        var wst = document.getElementById('wakeListenStatus');
        if (wst) wst.textContent = 'Connessione server…';
        scheduleNextWakeSliceIfListening();
        return;
      }
      var sk = (typeof skipWakeForBlob === 'boolean') ? skipWakeForBlob : !!wakeCommandMode;
      if (wakeAudioInFlight) {
        wakeQueuedBlob = { blob: blob, skipWake: sk };
        return;
      }
      wakeAudioInFlight = true;
      wakeListenPending = true;
      if (wakeResponseTimeout) clearTimeout(wakeResponseTimeout);
      wakeResponseTimeout = setTimeout(function(){
        if (wakeAudioInFlight) {
          wakeLog('Timeout risposta server, riprovo...', '#ef4444');
          wakeAudioInFlight = false;
          wakeListenPending = false;
          stopThinkingFeedback();
          scheduleNextWakeSliceIfListening();
        }
      }, 70000);
      const fr = new FileReader();
      fr.onload = function(){
        const b64 = arrayBufferToBase64(fr.result);
        try {
          if (sk) { stopListeningHum(); playStopChime(); startThinkingFeedback(); }
          const td = ttsDestFromUi();
          lastPlayOn = td.playOn;
          sendAudioOverWs(b64, wakeMimeType, { playOn: td.playOn, skipWake: sk, deviceId: td.deviceId });
        } catch(_){
          wakeListenPending = false;
          wakeAudioInFlight = false;
          stopThinkingFeedback();
          scheduleNextWakeSliceIfListening();
        }
      };
      fr.onerror = function(){
        wakeListenPending = false;
        wakeAudioInFlight = false;
        scheduleNextWakeSliceIfListening();
      };
      fr.readAsArrayBuffer(blob);
    }
    function stopWakeRecorder(){
      wakeListenActive = false;
      scheduleNextWakeSliceIfListening = function(){};
      stopWakeLevelMeter();
      clearTtsPlaybackQueue();
      stopWakeServerListener();
      try {
        if (wakeActiveMr && wakeActiveMr.state !== 'inactive') wakeActiveMr.stop();
      } catch(_){}
      wakeActiveMr = null;
      if (wakeRawStream) {
        try { wakeRawStream.getTracks().forEach(function(t){ try { t.stop(); } catch(_){} }); } catch(_){}
        wakeRawStream = null;
      }
      wakeStream = null;
      const st = document.getElementById('wakeListenStatus');
      if (st && !document.getElementById('wakeListenToggle').checked) st.textContent = 'Disattivato';
      resetWakeCommandMode();
      wakeQueuedBlob = null;
      wakeAudioInFlight = false;
      wakeDiscardCurrentSlice = false;
      _wakeSliceScheduled = false;
      _wakeDropSlicesAfterTts = 0;
      updateActiveMicIndicator();
    }
    var wsLevelMonitor = null;
    function startLevelMonitor(){
      if (wsLevelMonitor) return;
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsLevelMonitor = new WebSocket(proto + '//' + location.host + '/ws/mic-level');
      var bar = document.getElementById('levelBar');
      var lbl = document.getElementById('levelLabel');
      var dbg = document.getElementById('recDebug');
      wsLevelMonitor.onmessage = function(ev){
        try {
          var d = JSON.parse(ev.data);
          if (d.type === 'info') {
            if (dbg) { dbg.textContent = 'Mic Jetson: ' + d.name; dbg.style.color = '#14b8a6'; }
          } else if (d.type === 'level') {
            var pct = Math.max(0, Math.min(100, ((d.db + 60) / 60) * 100));
            if (bar) {
              bar.style.width = pct.toFixed(1) + '%';
              bar.style.background = d.peak > 0.5 ? '#ef4444' : d.rms > 0.02 ? '#22c55e' : d.rms > 0.005 ? '#eab308' : '#52525b';
            }
            if (lbl) lbl.textContent = d.rms > 0.01 ? 'Audio: ' + (pct|0) + '% (RMS ' + d.rms.toFixed(3) + ')' : 'Silenzio (RMS ' + d.rms.toFixed(4) + ')';
          } else if (d.type === 'error') {
            if (lbl) lbl.textContent = 'Errore mic: ' + (d.data || '?');
          }
        } catch(_){}
      };
      wsLevelMonitor.onclose = function(){ wsLevelMonitor = null; if (bar) bar.style.width = '0%'; if (lbl) lbl.textContent = 'Livello: --'; };
      wsLevelMonitor.onerror = function(){ try { wsLevelMonitor.close(); } catch(_){} wsLevelMonitor = null; };
    }
    function stopLevelMonitor(){
      if (wsLevelMonitor) { try { wsLevelMonitor.close(); } catch(_){} wsLevelMonitor = null; }
      var bar = document.getElementById('levelBar');
      var lbl = document.getElementById('levelLabel');
      if (bar) bar.style.width = '0%';
      if (lbl) lbl.textContent = 'Livello: --';
    }
    function stopWakeServerListener(){
      wakeServerMode = false;
      listenServerWakeLatched = false;
      if (wsListenServer) {
        try { wsListenServer.close(); } catch(_){}
        wsListenServer = null;
      }
      stopLevelMonitor();
    }
    function startWakeServerListener(){
      wakeServerMode = true;
      var td = ttsDestFromUi();
      lastPlayOn = td.playOn;
      var wsListenUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/listen?play_on=' + encodeURIComponent(td.playOn);
      var listenGain = typeof getParlaMonitorGain === 'function' ? getParlaMonitorGain() : 1;
      var listenThreshold = typeof getWakeVoiceThreshold === 'function' ? getWakeVoiceThreshold() : 20;
      wsListenUrl += '&gain=' + encodeURIComponent(listenGain) + '&threshold=' + encodeURIComponent(listenThreshold);
      if (td.playOn === 'server' && td.deviceId != null) {
        wsListenUrl += '&device_id=' + encodeURIComponent(String(td.deviceId));
      }
      wsListenServer = new WebSocket(wsListenUrl);
      var st = document.getElementById('wakeListenStatus');
      wsListenServer.onopen = function(){
        listenServerWakeLatched = false;
        if (st) st.textContent = 'In ascolto per «Hey G1» (mic Jetson)…';
        updateActiveMicIndicator();
        startLevelMonitor();
      };
      wsListenServer.onmessage = function(ev){
        try {
          var msg = JSON.parse(ev.data);
          if (msg.type === 'error') {
            if (st) st.textContent = 'Errore server: ' + (msg.data || '?');
            stopWakeServerListener();
            var el = document.getElementById('wakeListenToggle');
            if (el) el.checked = false;
            return;
          }
          if (msg.type === 'status') {
            if (st) st.textContent = msg.data || 'In ascolto…';
            return;
          }
          if (msg.type === 'response' && msg.data) {
            var d = msg.data;
            if (d.wake_miss) return;
            if (d.wake_ack) {
              if (listenServerWakeLatched) return;
              listenServerWakeLatched = true;
              if (d.response && String(d.response).trim()) {
                var resEl = document.getElementById('result');
                if (resEl) resEl.innerHTML = '<div class="ok"><strong>Tu:</strong> ' + (d.text||'').replace(/</g,'&lt;') + '<br><strong>G1:</strong> ' + (d.response||'').replace(/</g,'&lt;') + '</div>';
              } else {
                playWakeChime();
              }
              if (st) st.textContent = 'Dì Hey G1 + domanda';
              return;
            }
            listenServerWakeLatched = false;
            if (d.response) {
              var resEl = document.getElementById('result');
              if (resEl) resEl.innerHTML = '<div class="ok"><strong>Tu:</strong> ' + (d.text||'').replace(/</g,'&lt;') + '<br><strong>G1:</strong> ' + (d.response||'').replace(/</g,'&lt;') + '</div>';
              if (st) st.textContent = 'In ascolto per «Hey G1»…';
              if (d.audio_base64 && String(d.audio_base64).length > 50 && getTtsPlayDest() === 'browser') {
                enqueueTtsPlayback(d.audio_base64, null);
              }
            }
          }
        } catch(_){}
      };
      wsListenServer.onclose = function(){
        wakeServerMode = false;
        wsListenServer = null;
        stopLevelMonitor();
        var el = document.getElementById('wakeListenToggle');
        if (el && el.checked) {
          if (st) st.textContent = 'Connessione persa. Riattiva per riprovare.';
          el.checked = false;
        }
        updateActiveMicIndicator();
      };
      wsListenServer.onerror = function(){
        if (st) st.textContent = 'Errore connessione WebSocket listen.';
        stopWakeServerListener();
        var el = document.getElementById('wakeListenToggle');
        if (el) el.checked = false;
        updateActiveMicIndicator();
      };
    }
    async function startWakeRecorder(){
      const el = document.getElementById('wakeListenToggle');
      if (!el || !el.checked) return;
      if (isRecording) return;
      stopWakeRecorder();
      const micId = document.getElementById('mic') ? document.getElementById('mic').value : '';
      if (micId && String(micId).indexOf('local_') === 0) {
        startWakeServerListener();
        return;
      }
      if (!navigator.mediaDevices) {
        const st = document.getElementById('wakeListenStatus');
        if (st) st.textContent = 'MediaDevices non disponibile (serve HTTPS).';
        el.checked = false;
        return;
      }
      try {
        stopParlaMicPreview();
        if (typeof getUserMediaWithFallback === 'function') {
          wakeRawStream = await getUserMediaWithFallback(micForBrowserCapture());
        } else {
          wakeRawStream = await navigator.mediaDevices.getUserMedia(buildAudioCaptureConstraints(micForBrowserCapture()));
        }
        startWakeSpeechEnhancer();
      } catch(e) {
        const st = document.getElementById('wakeListenStatus');
        if (st) st.textContent = 'Microfono non disponibile per ascolto continuo.';
        el.checked = false;
        return;
      }
      await new Promise(function(r){ setTimeout(r, 150); });
      wakeMimeType = preferredRecorderMime();
      wakeListenActive = true;
      scheduleNextWakeSliceIfListening = function(){
        if (_wakeSliceScheduled) return;
        if (!wakeListenActive) return;
        const tg = document.getElementById('wakeListenToggle');
        if (!tg || !tg.checked) return;
        if (isRecording) return;
        _wakeSliceScheduled = true;
        setTimeout(function(){ _wakeSliceScheduled = false; runWakeSlice(); }, 40);
      };
      function runWakeSlice(){
        if (!wakeListenActive || !document.getElementById('wakeListenToggle').checked) return;
        if (isRecording) { setTimeout(runWakeSlice, 350); return; }
        if (!wakeStream) return;
        if (wakeActiveMr) return;
        const isCmd = wakeCommandMode;
        const sliceMs = isCmd ? CMD_SLICE_MS : WAKE_SLICE_MS;
        const mr = new MediaRecorder(wakeStream, { mimeType: wakeMimeType, audioBitsPerSecond: 128000 });
        wakeActiveMr = mr;
        const ch = [];
        wakeSlicePeak = 0;
        let voiceDurationMs = 0, lastVoiceTs = 0, stopped = false;
        let sliceInterval = null;
        function stopMr(){
          if (stopped) return; stopped = true;
          if (sliceInterval) { clearInterval(sliceInterval); sliceInterval = null; }
          try { if (mr.state !== 'inactive') { if (typeof mr.requestData === 'function') mr.requestData(); mr.stop(); } } catch(_){}
        }
        if (wakeAnalyser) {
          if (wakeLevelSampleInterval) clearInterval(wakeLevelSampleInterval);
          sliceInterval = setInterval(function(){
            if (!wakeAnalyser) return;
            const buf = new Uint8Array(wakeAnalyser.frequencyBinCount);
            wakeAnalyser.getByteFrequencyData(buf);
            let s = 0;
            for (let i = 0; i < buf.length; i++) if (buf[i] > s) s = buf[i];
            if (s > wakeSlicePeak) wakeSlicePeak = s;
            var sliceGain = typeof getParlaMonitorGain === 'function' ? getParlaMonitorGain() : 1;
            if (typeof window.g1UpdateTalkMicLevel === 'function') window.g1UpdateTalkMicLevel(Math.min(255, s * sliceGain));
            const th = getWakeVoiceThreshold();
            if (s >= th) { voiceDurationMs += 50; lastVoiceTs = Date.now(); }
            if (isCmd && voiceDurationMs >= CMD_MIN_VOICE_MS && lastVoiceTs > 0 && (Date.now() - lastVoiceTs >= CMD_SILENCE_MS)) {
              stopMr();
            }
          }, 50);
          wakeLevelSampleInterval = sliceInterval;
        }
        mr.ondataavailable = function(ev){ if (ev.data && ev.data.size) ch.push(ev.data); };
        mr.onstop = function(){
          wakeActiveMr = null;
          if (sliceInterval) { clearInterval(sliceInterval); }
          sliceInterval = null;
          wakeLevelSampleInterval = null;
          if (!wakeListenActive) return;
          if (wakeDiscardCurrentSlice) {
            wakeDiscardCurrentSlice = false;
            return;
          }
          const blob = new Blob(ch, { type: wakeMimeType });
          var voiced = !wakeAnalyser || wakeSlicePeak >= getWakeVoiceThreshold();
          if (!isCmd) {
            scheduleNextWakeSliceIfListening();
            if (blob.size >= WS_AUDIO_MIN_BYTES && voiced) trySendWakeChunk(blob, false);
          } else {
            if (blob.size >= WS_AUDIO_MIN_BYTES && voiced) trySendWakeChunk(blob, true);
            else scheduleNextWakeSliceIfListening();
          }
        };
        mr.start();
        setTimeout(function(){ stopMr(); }, sliceMs);
      }
      runWakeSlice();
      const st = document.getElementById('wakeListenStatus');
      if (st) st.textContent = 'In ascolto per \u00abHey G1\u00bb\u2026';
    }
    const wakeListenToggleEl = document.getElementById('wakeListenToggle');
    if (wakeListenToggleEl) {
      wakeListenToggleEl.onchange = async function(){
        if (wakeListenToggleEl.checked) {
          window.g1SetTalkAgentMode('legacy');
          const st = document.getElementById('wakeListenStatus');
          const micVal = document.getElementById('mic') ? document.getElementById('mic').value : '';
          const isLocalMic = micVal && String(micVal).indexOf('local_') === 0;
          const isBrowserMic = micVal && String(micVal).indexOf('webmic_') === 0;
          if (!isLocalMic && !isBrowserMic) {
            if (st) st.textContent = 'Seleziona un microfono Browser in Audio Talk (es. RealSense / DJI).';
            wakeListenToggleEl.checked = false;
            var wtl0 = document.getElementById('wakeToggleLabel');
            if (wtl0) wtl0.textContent = 'OFF';
            if (typeof requestAndLoadDevices === 'function') requestAndLoadDevices();
            return;
          }
          if (st) st.textContent = 'Connessione server…';
          try {
            await ensureWakeWs();
          } catch(e) {
            if (st) st.textContent = 'WebSocket non connesso — ricarica la pagina (Ctrl+Shift+R).';
            wakeListenToggleEl.checked = false;
            var wtl1 = document.getElementById('wakeToggleLabel');
            if (wtl1) wtl1.textContent = 'OFF';
            return;
          }
          if (st) st.textContent = 'Avvio ascolto…';
          startWakeRecorder();
        } else {
          stopWakeRecorder();
          resetWakeCommandMode();
          if (_talkAgentMode === 'legacy') applyTalkAgentLayout('none');
          const st = document.getElementById('wakeListenStatus');
          if (st) st.textContent = 'Disattivato';
          setTimeout(function(){ if (typeof startParlaMicPreviewIfEligible === 'function') startParlaMicPreviewIfEligible(); }, 300);
        }
        var wtl = document.getElementById('wakeToggleLabel');
        if (wtl) wtl.textContent = wakeListenToggleEl.checked ? 'ON' : 'OFF';
      };
    }

    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const isSecure = location.protocol === 'https:';
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isLocalhost && !isSecure) {
      document.getElementById('secureContextWarn').style.display = 'block';
      const shl = document.getElementById('secureHttpsLink');
      if (shl) {
        const u = 'https://' + location.hostname + ':8081' + location.pathname + location.search;
        shl.href = u;
        shl.textContent = u;
      }
      document.getElementById('secureWarnMobile').style.display = isMobile ? 'block' : 'none';
      document.getElementById('secureWarnDesktop').style.display = isMobile ? 'none' : 'block';
      var _ha = document.getElementById('hintAccess'); if (_ha) _ha.style.display = 'none';
      var _aw = document.getElementById('allowWrap'); if (_aw) _aw.style.display = 'none';
      var _dw = document.getElementById('devicesWrap'); if (_dw) _dw.style.display = 'none';
      var _swm = document.getElementById('secureWarnMore');
      if (_swm) _swm.onclick = (e)=>{ e.preventDefault(); const d=document.getElementById('secureWarnDetails'); d.style.display = d.style.display==='none' ? 'block' : 'none'; };
    }
    if (!navigator.mediaDevices) {
      document.getElementById('secureContextWarn').style.display = 'block';
      var _ha2 = document.getElementById('hintAccess'); if (_ha2) _ha2.style.display = 'none';
      var _aw2 = document.getElementById('allowWrap'); if (_aw2) _aw2.style.display = 'none';
      var _dw2 = document.getElementById('devicesWrap'); if (_dw2) _dw2.style.display = 'none';
      document.getElementById('recStatus').style.display = 'none';
      document.getElementById('result').innerHTML = '';
    }


    function wakeLog(msg, color) {
      var el = document.getElementById('wakeDebugLog');
      if (!el) return;
      el.style.display = '';
      var d = document.createElement('div');
      d.style.color = color || '#71717a';
      var t = new Date(); var ts = t.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      d.textContent = ts + ' ' + msg;
      el.appendChild(d);
      if (el.children.length > 20) el.removeChild(el.firstChild);
      el.scrollTop = el.scrollHeight;
    }
    function onWsPipelineMessage(e){
      let d;
      try { d = JSON.parse(e.data); } catch(_) { document.getElementById('result').innerHTML = '<div class="warn">Errore risposta server</div>'; return; }
      if(d.type==='response'){
        stopThinkingFeedback();
        const r = d.data;
        let resumeWakeListen = false;
        try {
          if (wakeListenPending) {
            wakeListenPending = false;
            if (r.wake_miss) {
              wakeAudioInFlight = false;
              if (wakeResponseTimeout) { clearTimeout(wakeResponseTimeout); wakeResponseTimeout = null; }
              var sttTxt = String(r.text||'').trim();
              wakeLog(sttTxt ? 'STT: "'+sttTxt+'" \u2192 miss (no wake word)' : 'silenzio / no speech', '#71717a');
              if (btn) btn.disabled = false;
              resumeWakeListen = true;
              return;
            }
            if (r.wake_cmd_inline) {
              wakeDiscardCurrentSlice = true;
              wakeQueuedBlob = null;
              if (wakeActiveMr) {
                try { if (wakeActiveMr.state !== 'inactive') wakeActiveMr.stop(); } catch(_){}
              }
              wakeLog('WAKE + CMD inline: "'+String(r.text||'')+'"', '#22c55e');
              playWakeChime();
            }
            if (r.wake_ack) {
              clearWakePipelineLock();
              if (wakeCommandMode) {
                if (btn) btn.disabled = false;
                scheduleNextWakeSliceIfListening();
                return;
              }
              wakeDiscardCurrentSlice = true;
              wakeQueuedBlob = null;
              _wakeSliceScheduled = false;
              _wakeDropSlicesAfterTts = 0;
              if (wakeActiveMr) {
                try { if (wakeActiveMr.state !== 'inactive') wakeActiveMr.stop(); } catch(_){}
              }
              if (r.response && String(r.response).trim()) {
                wakeLog('WAKE: ' + String(r.response), '#22c55e');
                document.getElementById('result').innerHTML = '<div><b>Hai detto:</b> '+(r.text||'')+'</div><div><b>Risposta:</b> '+(r.response||'')+'</div>';
                var ackHasTts = lastPlayOn === 'browser' && r.audio_base64 && String(r.audio_base64).length > 50;
                if (ackHasTts) {
                  enqueueTtsPlayback(r.audio_base64, function(){
                    resumeWakeListenAfterResponse();
                  });
                  if (btn) btn.disabled = false;
                  return;
                }
              } else {
                wakeLog('WAKE! Ti ascolto\u2026', '#22c55e');
                playWakeChime();
              }
              resumeWakeListenAfterResponse();
              if (btn) btn.disabled = false;
              return;
            }
            if (!r.response && r.message) {
              clearWakePipelineLock();
              wakeLog('msg: '+r.message, '#f59e0b');
              const wst = document.getElementById('wakeListenStatus');
              if (wst) wst.textContent = wakeCommandMode ? 'Ti ascolto\u2026' : 'In ascolto per \u00abHey G1\u00bb\u2026';
              document.getElementById('result').innerHTML = '<div class="warn">'+r.message+'</div>';
              if (btn) btn.disabled = false;
              resumeWakeListen = true;
              return;
            }
            if (r.text) wakeLog('CMD: "'+String(r.text||'')+'" \u2192 risposta', '#14b8a6');
          }
          if (btn) btn.disabled = false;
          recordingServerJetson = false;
          document.getElementById('recDebug').textContent = r.text ? '' : (r.message || '');
          document.getElementById('recDebug').style.color = r.message ? '#f59e0b' : '#71717a';
          const msg = r.message ? '<div class="warn">'+r.message+'</div>' : '';
          const dur = r.duration_ms ? ' <span style="color:#71717a;font-size:12px;">('+r.duration_ms+' ms)</span>' : '';
          document.getElementById('result').innerHTML = msg + '<div><b>Hai detto:</b> '+(r.text||'')+'</div><div><b>Risposta:</b> '+(r.response||'')+dur+'</div>';
          const hasTts = lastPlayOn === 'browser' && r.audio_base64 && String(r.audio_base64).length > 50;
          const hasServerTts = lastPlayOn === 'server' && r.response && String(r.response).trim().length > 0;
          if (r.response && String(r.response).trim()) {
            if (hasTts) {
              enqueueTtsPlayback(r.audio_base64, onWakeResponseDone);
            } else if (hasServerTts) {
              setTimeout(onWakeResponseDone, 1200);
            } else {
              onWakeResponseDone();
            }
          } else {
            clearWakePipelineLock();
            var wt = document.getElementById('wakeListenToggle');
            if (wt && wt.checked) resumeWakeListenAfterResponse();
          }
        } finally {
          if (resumeWakeListen) {
            wakeDiscardCurrentSlice = false;
            setRobotLed('listening');
            scheduleNextWakeSliceIfListening();
          }
        }
      } else if(d.type==='wake_chime'){
        if (!wakeCommandMode) { playWakeChime(); wakeLog('Hey G1 rilevato, elaboro...', '#22c55e'); }
      } else if(d.type==='error'){
        stopThinkingFeedback();
        clearTtsPlaybackQueue();
        wakeAudioInFlight = false;
        wakeQueuedBlob = null;
        if (btn) btn.disabled = false;
        recordingServerJetson = false;
        document.getElementById('result').innerHTML = '<div class="warn">Errore: '+ (d.data || '')+'</div>';
      } else if(d.type==='play' && d.data){
        enqueueTtsPlayback(d.data, null);
      }
    }
    function connect(){
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        var res = document.getElementById('result');
        if (res && !res.innerHTML) {
          res.innerHTML = '<div class="ok">Connesso al server. Attiva Talk classico o scrivi una domanda.</div>';
        }
        var dbg = document.getElementById('recDebug');
        if (dbg) dbg.textContent = 'WebSocket OK';
        var wst = document.getElementById('wakeListenStatus');
        var wt = document.getElementById('wakeListenToggle');
        if (wst && wt && wt.checked && wst.textContent.indexOf('Connessione') >= 0) {
          wst.textContent = 'In ascolto per \u00abHey G1\u00bb\u2026';
        }
      };
      ws.onclose = () => {
        setTimeout(connect, 3000);
        var res = document.getElementById('result');
        if (res) res.innerHTML = '<div class="warn">Riconnessione WebSocket…</div>';
        var dbg = document.getElementById('recDebug');
        if (dbg) dbg.textContent = 'WebSocket disconnesso';
      };
      ws.onmessage = onWsPipelineMessage;
    }
    function ensureWakeWs(){
      return new Promise(function(resolve, reject){
        if (ws && ws.readyState === WebSocket.OPEN) return resolve();
        if (ws && ws.readyState === WebSocket.CONNECTING) {
          var t0 = Date.now();
          var iv = setInterval(function(){
            if (ws && ws.readyState === WebSocket.OPEN) { clearInterval(iv); resolve(); }
            else if (!ws || ws.readyState === WebSocket.CLOSED || Date.now() - t0 > 12000) {
              clearInterval(iv);
              reject(new Error('WebSocket non connesso'));
            }
          }, 120);
          return;
        }
        try {
          ws = new WebSocket(wsUrl);
          ws.onmessage = onWsPipelineMessage;
          ws.onclose = function(){ setTimeout(connect, 3000); };
          var to = setTimeout(function(){ reject(new Error('timeout WebSocket')); }, 12000);
          ws.onopen = function(){ clearTimeout(to); resolve(); };
          ws.onerror = function(){ clearTimeout(to); reject(new Error('WebSocket errore')); };
        } catch(err) { reject(err); }
      });
    }
    function ensureParlaWs(){
      return new Promise(function(resolve, reject){
        if (wsParla && wsParla.readyState === WebSocket.OPEN) return resolve();
        try {
          wsParla = new WebSocket(wsParlaUrl);
          wsParla.onmessage = onWsPipelineMessage;
          wsParla.onerror = function(){ reject(new Error('ws parla')); };
          const to = setTimeout(function(){ reject(new Error('timeout ws parla')); }, 10000);
          wsParla.onopen = function(){ clearTimeout(to); resolve(); };
        } catch(err) { reject(err); }
      });
    }
    async function startRecServerPtt(){
      if (isRecording) return;
      wakeListenPending = false;
      stopWakeRecorder();
      const spkVal = document.getElementById('speaker') ? document.getElementById('speaker').value : '';
      const td = ttsDestFromUi();
      lastPlayOn = td.playOn;
      lastSinkId = (spkVal && spkVal.startsWith('browser_') && spkVal !== 'browser_default') ? spkVal.replace('browser_','') : null;
      if (td.playOn === 'browser') syncSbOutputFromSpeaker();
      try {
        await ensureParlaWs();
      } catch(e) {
        document.getElementById('result').innerHTML = '<div class="warn">Connessione WebSocket «Parla robot» fallita. Verifica microfono locale in <a href="/" style="color:#14b8a6">setup</a> e ricarica.</div>';
        return;
      }
      recordingServerJetson = true;
      isRecording = true;
      pendingStop = false;
      if (btn) btn.classList.add('recording');
      document.getElementById('levelBar').style.width = '60%';
      document.getElementById('levelBar').style.background = '#14b8a6';
      document.getElementById('levelLabel').textContent = 'Ingresso: Jetson USB (mic sul robot)';
      document.getElementById('recDebug').textContent = 'Registrazione dal microfono sul robot…';
      document.getElementById('recDebug').style.color = '#22c55e';
      updateActiveMicIndicator();
      recStartTime = Date.now();
      var pulseTick = 0;
      recDurationInterval = setInterval(function(){
        const s = ((Date.now()-recStartTime)/1000).toFixed(1);
        document.getElementById('recDebug').textContent = 'Registrazione Jetson: '+s+' sec';
        pulseTick++;
        var w = 40 + 30 * Math.abs(Math.sin(pulseTick * 0.25));
        document.getElementById('levelBar').style.width = w.toFixed(0)+'%';
      }, 150);
      recTimeout = setTimeout(function(){ stopRec(); }, MAX_REC_SEC * 1000);
      try {
        wsParla.send(JSON.stringify({
          type: 'start',
          gain: typeof getParlaMonitorGain === 'function' ? getParlaMonitorGain() : 1
        }));
      } catch(err) {
        recordingServerJetson = false;
        isRecording = false;
        if (btn) btn.classList.remove('recording');
        clearAllIntervals();
        document.getElementById('result').innerHTML = '<div class="warn">Invio start fallito.</div>';
      }
    }
    /* connect() dopo init UI — vedi fine script */
    (function loadServerTtsConfig(){
      restoreTtsPlayDest();
      fetch('/api/config').then(function(r){ return r.json(); }).then(function(cfg){
        var sp = cfg && cfg.speaker;
        if (cfg && (cfg.tts_output === 'server' || cfg.tts_output === 'browser')) {
          setTtsPlayDest(cfg.tts_output, true);
        }
        if (sp && sp.type === 'local' && sp.device_id !== undefined && sp.device_id !== null && sp.device_id !== '') {
          serverTtsDeviceId = parseInt(sp.device_id, 10);
        }
        var wrap = document.getElementById('ttsOutputWrap');
        if (wrap) wrap.style.display = 'block';
        updateSbBrowserRowVisibility();
      }).catch(function(){});
    })();

    async function ensureMicPermissionForEnumerate(){
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
      if (_micPermissionGranted) return true;
      try {
        if (navigator.permissions && navigator.permissions.query) {
          var pst = await navigator.permissions.query({ name: 'microphone' });
          if (pst.state === 'granted') {
            _micPermissionGranted = true;
            return true;
          }
          if (pst.state === 'denied') return false;
        }
      } catch(_){}
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(function(t){ t.stop(); });
        _micPermissionGranted = true;
        return true;
      } catch(_) {
        return false;
      }
    }

    function preferBrowserMicOnClient(){
      var micSel = document.getElementById('mic');
      if (!micSel || !micSel.options || !micSel.options.length) return;
      var pick = -1;
      for (var i = 0; i < micSel.options.length; i++) {
        var v = micSel.options[i].value;
        if (v && v.indexOf('webmic_') === 0 && v.length > 7) {
          var txt = (micSel.options[i].textContent || '').toLowerCase();
          if (txt.indexOf('dji') >= 0) { pick = i; break; }
          if (txt.indexOf('realsense') >= 0 && pick < 0) pick = i;
          if (pick < 0) pick = i;
        }
      }
      if (pick >= 0) {
        micSel.selectedIndex = pick;
        updateActiveMicIndicator();
        var st = document.getElementById('deviceStatus');
        if (st) st.textContent = 'Microfono: ' + (micSel.options[pick].textContent || 'browser') + ' — premi Salva per memorizzarlo sul server.';
        if (typeof startParlaMicPreviewIfEligible === 'function') setTimeout(startParlaMicPreviewIfEligible, 80);
      }
    }

    async function requestAndLoadDevices(){
      if (!navigator.mediaDevices) return;
      const statusEl = document.getElementById('deviceStatus');
      if (statusEl) statusEl.textContent = 'Microfono: attivazione…';
      try {
        var ok = await ensureMicPermissionForEnumerate();
        if (!ok) throw new Error('permesso negato');
        await loadDevices({ ensureMic: false, preferBrowser: true });
      } catch(e) {
        if (statusEl) statusEl.textContent = 'Microfono: permesso negato — abilita il mic per questo sito nelle impostazioni browser.';
        await loadDevices({ ensureMic: false, preferBrowser: false });
        updateActiveMicIndicator();
      }
    }
    window.initClientMic = requestAndLoadDevices;

    function applyMicListToUi(micSel, spkSel, serverData, mics, spks, seq){
      const sm = (serverData.microphones || []).filter(function(m){
        return m && (m.type === 'local' || (m.value && String(m.value).indexOf('local_') === 0));
      });
      const netm = (serverData.microphones || []).filter(function(m){
        return m && m.type === 'network' && m.value && m.value !== 'web_wait';
      });
      let micHtml = '';
      function attrEsc(v){ return String(v||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }
      if (sm.length) {
        micHtml += '<optgroup label="Jetson - server (PortAudio)">';
        sm.forEach(function(m){ micHtml += '<option value="'+attrEsc(m.value)+'">'+escapeHtmlDevices(m.name)+'</option>'; });
        micHtml += '</optgroup>';
      }
      if (netm.length) {
        micHtml += '<optgroup label="Client rete">';
        netm.forEach(function(m){ micHtml += '<option value="'+attrEsc(m.value)+'">'+escapeHtmlDevices(m.name)+'</option>'; });
        micHtml += '</optgroup>';
      }
      micHtml += '<optgroup label="Browser - questo dispositivo">';
      if (mics.length === 0) micHtml += '<option value="">Nessun microfono browser</option>';
      else mics.forEach(function(m,i){
        const lab = m.label || ('Microfono '+(i+1));
        micHtml += '<option value="webmic_'+encodeURIComponent(m.deviceId)+'">'+escapeHtmlDevices(lab)+'</option>';
      });
      micHtml += '</optgroup>';
      if (seq !== _loadDevicesSeq) return false;
      micSel.innerHTML = micHtml;
      micSel.onchange = function(){
        applyLocalMicDefaultsIfUnset(micSel.value);
        updateActiveMicIndicator();
        autoSaveMicConfigFromUi();
        stopParlaMicPreview();
        if (_talkAgentMode === 'grok') {
          window.g1GrokVoiceStop(true);
          var gt = document.getElementById('grokVoiceToggle');
          if (gt) gt.checked = true;
          setTimeout(function(){ window.g1GrokVoiceStart(); }, 200);
        } else if (_talkAgentMode === 'legacy') {
          stopWakeRecorder();
          setTimeout(function(){ startWakeRecorder(); }, 200);
        } else {
          setTimeout(function(){ if (typeof startParlaMicPreviewIfEligible === 'function') startParlaMicPreviewIfEligible(); }, 120);
        }
      };

      const ss = (serverData.speakers || []).filter(function(s){
        return s && (s.type === 'local' || (s.value && String(s.value).indexOf('local_') === 0));
      });
      const nets = (serverData.speakers || []).filter(function(s){
        return s && s.type === 'network' && s.value && s.value !== 'web_wait';
      });
      spkSel.innerHTML = '';
      function optLabel(s, fb){ var n = (s && s.name) ? String(s.name) : ''; return n.trim() ? n : (fb || (s && s.value) || '?'); }
      if (ss.length) {
        const og = document.createElement('optgroup');
        og.label = 'Jetson - server (cassa robot)';
        ss.forEach(function(s){ og.appendChild(new Option(optLabel(s, 'Cassa Jetson'), s.value)); });
        spkSel.appendChild(og);
      }
      if (nets.length) {
        const og2 = document.createElement('optgroup');
        og2.label = 'Client rete';
        nets.forEach(function(s){ og2.appendChild(new Option(optLabel(s, 'Client rete'), s.value)); });
        spkSel.appendChild(og2);
      }
      const ogB = document.createElement('optgroup');
      ogB.label = 'Browser - telefono/PC';
      if (spks.length === 0) ogB.appendChild(new Option('Predefinito', 'browser_default'));
      else spks.forEach(function(s,i){ ogB.appendChild(new Option(s.label || ('Output '+(i+1)), 'browser_'+s.deviceId)); });
      spkSel.appendChild(ogB);
      spkSel.onchange = function(){
        const v = spkSel.value;
        lastSinkId = (v && v.indexOf('browser_') === 0 && v !== 'browser_default') ? v.replace(/^browser_/, '') : null;
        var tts = document.getElementById('ttsPlayDest');
        if (v === 'browser_default' || v.indexOf('browser_') === 0) {
          setTtsPlayDest('browser', true);
        }
        syncSbOutputFromSpeaker();
        updateActiveMicIndicator();
        autoSaveMicConfigFromUi();
        if (_talkAgentMode === 'grok') {
          window.g1GrokVoiceStop(true);
          var gt = document.getElementById('grokVoiceToggle');
          if (gt) gt.checked = true;
          setTimeout(function(){ window.g1GrokVoiceStart(); }, 120);
        }
      };
      const sbOut = document.getElementById('sbOutput');
      if (sbOut) {
        sbOut.innerHTML = '<option value="default">Predefinito</option>' + spks.map(function(s,i){
          return '<option value="'+s.deviceId+'">'+escapeHtmlDevices(s.label || ('Output '+(i+1)))+'</option>';
        }).join('');
        sbOut.onchange = function(){ syncSpeakerFromSbOutput(); updateActiveMicIndicator(); };
      }
      return true;
    }

    function autoSaveMicConfigFromUi(){
      var micSel = document.getElementById('mic');
      var spkSel = document.getElementById('speaker');
      if (!micSel || !spkSel || !micSel.value) return;
      var body = {
        microphone: buildMicCfgFromSelect(micSel.value),
        speaker: buildSpkCfgFromSelect(spkSel.value),
        tts_output: getTtsPlayDest()
      };
      fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(function(){});
    }

    function finishMicDeviceUi(micSel, spkSel, statusEl, mics, spks, serverData, seq){
      updateActiveMicIndicator();
      const nJet = ((serverData.microphones || []).filter(function(m){ return m && String(m.value||'').indexOf('local_') === 0; }).length)
        + ((serverData.speakers || []).filter(function(s){ return s && String(s.value||'').indexOf('local_') === 0; }).length);
        if (statusEl) {
          if (!_micPermissionGranted && mics.length === 0 && (isSecure || isLocalhost)) {
            statusEl.textContent = "Microfono: consenti l'accesso nelle impostazioni del browser per questo sito.";
          } else if (mics.length) {
            var selOpt = micSel.options[micSel.selectedIndex];
            statusEl.textContent = 'Microfono attivo: ' + ((selOpt && selOpt.textContent) ? selOpt.textContent.trim() : mics.length + ' device');
          } else {
            statusEl.textContent = nJet ? ('Jetson: '+nJet+' device · Browser: nessun mic') : ('Browser: nessun microfono rilevato');
          }
        }
      fetch('/api/config').then(function(r){ return r.json(); }).then(function(cfg){
        if (seq !== _loadDevicesSeq || !cfg || !micSel) return;
        var restoredMic = false;
        if (cfg.microphone && cfg.microphone.value) {
          var mv = cfg.microphone.value;
          if (cfg.microphone.type === 'network' && mv && mv !== 'web_wait' && mv.indexOf('local_') !== 0 && mv.indexOf('net_') !== 0) {
            for (var i = 0; i < micSel.options.length; i++) {
              var o = micSel.options[i];
              if (o.value.indexOf('webmic_') === 0 && decodeURIComponent(o.value.slice(7)) === mv) {
                micSel.selectedIndex = i;
                restoredMic = true;
                break;
              }
            }
          } else if (mv) {
            try {
              micSel.value = mv;
              restoredMic = micSel.value === mv;
            } catch(_){}
          }
        }
        if (cfg.speaker && cfg.speaker.value) {
          try { spkSel.value = cfg.speaker.value; } catch(_){}
        }
        var curMic = micSel.value || '';
        if (mics.length > 0 && (curMic.indexOf('local_') === 0 || curMic.indexOf('net_') === 0 || !curMic || curMic === 'web_wait')) {
          preferBrowserMicOnClient();
        } else if (!restoredMic && (!cfg.microphone || !cfg.microphone.value || cfg.microphone.value === 'web_wait')) {
          preferBrowserMicOnClient();
        }
        applyLocalMicDefaultsIfUnset(micSel.value);
        autoSaveMicConfigFromUi();
        var vsp = spkSel.value;
        lastSinkId = (vsp && vsp.indexOf('browser_') === 0 && vsp !== 'browser_default') ? vsp.replace(/^browser_/, '') : null;
        syncSbOutputFromSpeaker();
        updateActiveMicIndicator();
        if (statusEl) {
          var selected = micSel.options[micSel.selectedIndex];
          statusEl.textContent = 'Microfono attivo: ' + ((selected && selected.textContent) ? selected.textContent.trim() : '—');
        }
        if (typeof startParlaMicPreviewIfEligible === 'function') setTimeout(startParlaMicPreviewIfEligible, 120);
      }).catch(function(){ updateActiveMicIndicator(); });
    }

    async function loadDevices(opts){
      opts = opts || {};
      if (!navigator.mediaDevices) return;
      const micSel = document.getElementById('mic');
      const spkSel = document.getElementById('speaker');
      const statusEl = document.getElementById('deviceStatus');
      if (!micSel || !spkSel) return;
      var seq = ++_loadDevicesSeq;
      if (opts.ensureMic !== false && (isSecure || isLocalhost)) {
        var permOk = await ensureMicPermissionForEnumerate();
        if (seq !== _loadDevicesSeq) return;
      }
      let serverData = { microphones: [], speakers: [], hardware_probe: null };
      try {
        var devs = await navigator.mediaDevices.enumerateDevices();
        if (seq !== _loadDevicesSeq) return;
        var mics = devs.filter(function(d){ return d.kind === 'audioinput' && d.deviceId; });
        var spks = devs.filter(function(d){ return d.kind === 'audiooutput' && d.deviceId; });
        try {
          var r = await Promise.race([
            fetch('/api/devices?all=1').then(function(resp){ return resp.ok ? resp.json() : serverData; }),
            new Promise(function(resolve){ setTimeout(function(){ resolve(serverData); }, 4000); })
          ]);
          if (r && typeof r === 'object') serverData = r;
        } catch(_) {}
        if (seq !== _loadDevicesSeq) return;
        _serverDevicesCache.microphones = serverData.microphones || [];
        _serverDevicesCache.speakers = serverData.speakers || [];
        _serverDevicesCache.hardware_probe = serverData.hardware_probe || null;
        updateHwProbe(serverData.hardware_probe);
        if (!applyMicListToUi(micSel, spkSel, serverData, mics, spks, seq)) return;
        finishMicDeviceUi(micSel, spkSel, statusEl, mics, spks, serverData, seq);
      } catch(e) {
        micSel.innerHTML = '<option value="">Errore: '+escapeHtmlDevices(e.message)+'</option>';
        spkSel.innerHTML = '<option value="browser_default">Riproduci qui</option>';
        const sbOut = document.getElementById('sbOutput');
        if (sbOut) {
          sbOut.innerHTML = '<option value="default">Predefinito</option>';
          sbOut.onchange = function(){ syncSpeakerFromSbOutput(); updateActiveMicIndicator(); };
        }
        if (statusEl) statusEl.textContent = 'Errore lettura dispositivi.';
        updateActiveMicIndicator();
      }
    }

    (function bindDevicesPanel(){
      const dlf = document.getElementById('devicesLoadFull');
      if (dlf) dlf.onclick = function(){
        const pre = document.getElementById('devicesFullDump');
        const st = document.getElementById('devicesSaveStatus');
        if (pre) { pre.style.display = 'block'; pre.textContent = 'Caricamento…'; }
        fetch('/api/devices-detailed').then(function(r){ return r.json(); }).then(function(d){
          if (pre) pre.textContent = JSON.stringify(d, null, 2);
          if (st) st.textContent = d.ok ? ('OK: '+d.portaudio_count+' device PortAudio') : '';
        }).catch(function(e){
          if (pre) pre.textContent = 'Errore: '+(e.message||String(e));
        });
      };
      const dr = document.getElementById('devicesRefresh');
      const ds = document.getElementById('devicesSave');
      if (dr) dr.onclick = function(){ requestAndLoadDevices(); };
      if (ds) ds.onclick = function(){
        const st = document.getElementById('devicesSaveStatus');
        const micVal = document.getElementById('mic').value;
        const spkVal = document.getElementById('speaker').value;
        const body = {
          microphone: buildMicCfgFromSelect(micVal),
          speaker: buildSpkCfgFromSelect(spkVal),
          tts_output: getTtsPlayDest()
        };
        if (st) st.textContent = 'Salvataggio…';
        fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then(function(r){ if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
          .then(function(){
            if (st) st.textContent = 'Salvato.';
            setTtsPlayDest(getTtsPlayDest(), true);
            fetch('/api/config').then(function(r){ return r.json(); }).then(function(cfg){
              var sp = cfg && cfg.speaker;
              if (sp && sp.type === 'local' && sp.device_id != null && sp.device_id !== '') {
                serverTtsDeviceId = parseInt(sp.device_id, 10);
              }
              if (typeof updateSbBrowserRowVisibility === 'function') updateSbBrowserRowVisibility();
            }).catch(function(){});
          })
          .catch(function(e){ if (st) st.textContent = 'Errore: '+(e.message||String(e)); });
      };
    })();
    (function(){
      var sl = document.getElementById('ttsGainSlider');
      var lb = document.getElementById('ttsGainLabel');
      var sl2 = document.getElementById('parlaGainSlider');
      var lb2 = document.getElementById('parlaGainLabel');
      var ttsDest = document.getElementById('ttsPlayDest');
      if (ttsDest) {
        ttsDest.addEventListener('change', function(){
          setTtsPlayDest(ttsDest.value, true);
          autoSaveMicConfigFromUi();
        });
      }
      function syncAll(v){
        setTtsGain(v);
        if (sl) { sl.value = v; }
        if (lb) { lb.textContent = v.toFixed(1) + 'x'; }
        if (sl2) { sl2.value = v; }
        if (lb2) { lb2.textContent = v.toFixed(1) + 'x'; }
      }
      syncAll(getTtsGain());
      if (sl) sl.addEventListener('input', function(){ syncAll(parseFloat(sl.value)); });
      if (sl2) sl2.addEventListener('input', function(){ syncAll(parseFloat(sl2.value)); });
    })();
    (function(){
      var sbg = document.getElementById('sbGainSlider');
      var sbl = document.getElementById('sbGainLabel');
      if (sbg) {
        var gv = getSoundboardBrowserGain();
        sbg.value = String(Math.min(3, Math.max(0.5, gv)));
        if (sbl) sbl.textContent = parseFloat(sbg.value).toFixed(2) + '\u00d7';
        sbg.addEventListener('input', function(){
          var v = parseFloat(sbg.value);
          if (!isNaN(v)) { setSoundboardBrowserGain(v); if (sbl) sbl.textContent = v.toFixed(2) + '\u00d7'; }
        });
      }
    })();
    if (navigator.mediaDevices) {
      if (isLocalhost || isSecure) {
        requestAndLoadDevices();
        try {
          navigator.mediaDevices.addEventListener('devicechange', function(){
            loadDevices({ ensureMic: false, preferBrowser: true });
          });
        } catch(_){}
      } else {
        loadDevices({ ensureMic: false, preferBrowser: false });
      }
    }

    let knowledgeGroups = [];
    function knowledgeEsc(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    }
    function knowledgeGroupCounts() {
      var total = 0, active = 0;
      (knowledgeGroups || []).forEach(function(g) {
        var n = Object.keys(g.entries || {}).length;
        total += n;
        if (g.enabled !== false) active += n;
      });
      return { total: total, active: active };
    }
    function renderKnowledge() {
      var el = document.getElementById('knowledgeGroups');
      var cnt = document.getElementById('knowledgeCount');
      var counts = knowledgeGroupCounts();
      if (cnt) cnt.textContent = counts.total ? (counts.active + ' attivi / ' + counts.total + ' totali') : 'vuoto';
      if (!el) return;
      if (!knowledgeGroups.length) {
        el.innerHTML = '<span style="color:#71717a;">(nessun gruppo)</span>';
        return;
      }
      el.innerHTML = knowledgeGroups.map(function(g, gi) {
        var enabled = g.enabled !== false;
        var entries = g.entries || {};
        var rows = Object.entries(entries).map(function(pair) {
          var k = pair[0], v = pair[1];
          return '<div style="display:flex;align-items:center;gap:6px;margin:4px 0;font-size:12px;opacity:' + (enabled ? '1' : '0.55') + ';">' +
            '<span style="color:#9ca3af;min-width:120px;">' + knowledgeEsc(k) + '</span>' +
            '<span style="color:#e8eaed;flex:1;">' + knowledgeEsc(v.length > 40 ? v.substring(0, 40) + '...' : v) + '</span>' +
            '<button type="button" class="knowledgeDel" data-gi="' + gi + '" data-key="' + encodeURIComponent(k) + '" style="padding:2px 8px;background:rgba(239,68,68,0.3);color:#fca5a5;border:none;border-radius:4px;cursor:pointer;font-size:11px;">Elimina</button></div>';
        }).join('') || '<div style="color:#71717a;font-size:12px;">(nessun pattern)</div>';
        return '<div class="knowledge-group" style="margin:10px 0;padding:10px;border:1px solid rgba(255,255,255,0.08);border-radius:10px;' + (enabled ? '' : 'opacity:0.75;') + '">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#e8eaed;flex:1;">' +
          '<input type="checkbox" class="knowledgeGroupToggle" data-gi="' + gi + '" ' + (enabled ? 'checked' : '') + ' style="accent-color:#14b8a6;" />' +
          '<input type="text" class="knowledgeGroupName" data-gi="' + gi + '" value="' + knowledgeEsc(g.name || g.id || '') + '" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:#27272a;color:#fff;font-size:12px;" />' +
          '</label>' +
          '<button type="button" class="knowledgeGroupDel" data-gi="' + gi + '" style="padding:4px 10px;background:rgba(239,68,68,0.2);color:#fca5a5;border:none;border-radius:6px;cursor:pointer;font-size:11px;">Elimina gruppo</button>' +
          '</div>' + rows +
          '<div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap;">' +
          '<input type="text" class="knowledgePattern" data-gi="' + gi + '" placeholder="Pattern" style="flex:1;min-width:100px;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:#27272a;color:#fff;font-size:12px;" />' +
          '<input type="text" class="knowledgeResponse" data-gi="' + gi + '" placeholder="Risposta" style="flex:2;min-width:140px;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:#27272a;color:#fff;font-size:12px;" />' +
          '<button type="button" class="knowledgeAdd" data-gi="' + gi + '" style="padding:6px 10px;background:#14b8a6;color:#0c0e14;border:none;border-radius:6px;cursor:pointer;font-size:11px;">Aggiungi</button>' +
          '</div></div>';
      }).join('');
      el.querySelectorAll('.knowledgeGroupToggle').forEach(function(cb) {
        cb.onchange = function() {
          var gi = +cb.dataset.gi;
          if (knowledgeGroups[gi]) knowledgeGroups[gi].enabled = !!cb.checked;
          renderKnowledge();
        };
      });
      el.querySelectorAll('.knowledgeGroupName').forEach(function(inp) {
        inp.oninput = function() {
          var gi = +inp.dataset.gi;
          if (knowledgeGroups[gi]) knowledgeGroups[gi].name = inp.value;
        };
      });
      el.querySelectorAll('.knowledgeGroupDel').forEach(function(btn) {
        btn.onclick = function() {
          var gi = +btn.dataset.gi;
          if (!confirm('Eliminare questo gruppo?')) return;
          knowledgeGroups.splice(gi, 1);
          renderKnowledge();
        };
      });
      el.querySelectorAll('.knowledgeDel').forEach(function(btn) {
        btn.onclick = function() {
          var gi = +btn.dataset.gi;
          var key = decodeURIComponent(btn.dataset.key || '');
          if (knowledgeGroups[gi] && knowledgeGroups[gi].entries) delete knowledgeGroups[gi].entries[key];
          renderKnowledge();
        };
      });
      el.querySelectorAll('.knowledgeAdd').forEach(function(btn) {
        btn.onclick = function() {
          var gi = +btn.dataset.gi;
          var wrap = btn.parentElement;
          var p = ((wrap.querySelector('.knowledgePattern') || {}).value || '').trim();
          var r = ((wrap.querySelector('.knowledgeResponse') || {}).value || '').trim();
          if (!p || !r) return;
          if (!knowledgeGroups[gi].entries) knowledgeGroups[gi].entries = {};
          knowledgeGroups[gi].entries[p] = r;
          renderKnowledge();
        };
      });
    }
    fetch('/api/knowledge').then(function(r) { return r.json(); }).then(function(d) {
      knowledgeGroups = (d.groups || []).map(function(g) {
        return {
          id: g.id || '',
          name: g.name || g.id || 'Gruppo',
          enabled: g.enabled !== false,
          entries: Object.assign({}, g.entries || {})
        };
      });
      if (!knowledgeGroups.length && d.entries) {
        knowledgeGroups = [{ id: 'general', name: 'Generale', enabled: true, entries: Object.assign({}, d.entries) }];
      }
      renderKnowledge();
    }).catch(function() {
      var c = document.getElementById('knowledgeCount');
      if (c) c.textContent = 'errore caricamento';
    });
    var knowledgeAddGroupEl = document.getElementById('knowledgeAddGroup');
    if (knowledgeAddGroupEl) knowledgeAddGroupEl.onclick = function() {
      var n = knowledgeGroups.length + 1;
      knowledgeGroups.push({ id: 'group_' + Date.now(), name: 'Gruppo ' + n, enabled: true, entries: {} });
      renderKnowledge();
    };
    var knowledgeSaveEl = document.getElementById('knowledgeSave');
    if (knowledgeSaveEl) knowledgeSaveEl.onclick = function() {
      fetch('/api/knowledge/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups: knowledgeGroups }) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok) {
            knowledgeSaveEl.textContent = 'Salvato!';
            setTimeout(function() { knowledgeSaveEl.textContent = 'Salva su server'; }, 2000);
          } else {
            alert(d.error || 'Errore');
          }
        })
        .catch(function(e) { alert('Errore: ' + e.message); });
    };

    let soundboardSlots = [];
    let sbTextMax = 280;
    let sbEditIdx = -1, sbEditAudio = null, sbEditFmt = '', sbEditAudioRaw = null;
    let sbEditAudioClean = null, sbEditFmtClean = 'mp3', sbEditAudioCleared = false;
    function sbMimeForFmt(fmt){
      const f = (fmt||'webm').toLowerCase();
      if(f==='mp3') return 'audio/mpeg';
      if(f==='wav') return 'audio/wav';
      return 'audio/'+f;
    }
    function updateSbBrowserRowVisibility(){
      const destEl = document.getElementById('sbPlayDest');
      const dest = (destEl && destEl.value) || 'server';
      const show = dest === 'browser';
      ['sbBrowserSinkLabel','sbOutput','sbOutputRefresh'].forEach(function(id){
        const el = document.getElementById(id);
        if (el) el.style.display = show ? '' : 'none';
      });
    }
    function sbPlaySlot(s, slotIndex){
      const destEl = document.getElementById('sbPlayDest');
      const dest = (destEl && destEl.value) || 'server';
      if (dest === 'server' && typeof slotIndex === 'number') {
        fetch('/api/soundboard-play-local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot: slotIndex })
        }).then(async function(r){
          const d = await r.json().catch(function(){ return {}; });
          if (!r.ok) {
            const msg = (d.detail && (typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail))) || d.message || ('HTTP '+r.status);
            alert('Cassa robot: ' + msg);
          }
        }).catch(function(e){ alert('Cassa robot: ' + (e.message || String(e))); });
        return;
      }
      function playFromData(sd){
        if(!sd.audio_base64_clean || sd.audio_base64_clean.length<=50) return;
        const b64 = sd.audio_base64_clean, fmt = sd.format_clean||'mp3';
        var audioDelay = parseInt(sd.audio_delay_ms, 10) || 0;
        var gestureDelay = parseInt(sd.gesture_delay_ms, 10) || 0;
        if (audioDelay < 0) audioDelay = 0;
        if (gestureDelay < 0) gestureDelay = 0;
        if (audioDelay > 15000) audioDelay = 15000;
        if (gestureDelay > 15000) gestureDelay = 15000;
        if (audioDelay === 0 && gestureDelay === 0) {
          playSoundboardBrowser(b64, fmt, function(){
            sbFireSlotRobotIfConfigured(sd, slotIndex);
          });
        } else {
          setTimeout(function(){
            playSoundboardBrowser(b64, fmt);
          }, Math.max(0, audioDelay));
          setTimeout(function(){
            sbFireSlotRobotIfConfigured(sd, slotIndex);
          }, Math.max(0, gestureDelay));
        }
      }
      if (s.audio_base64_clean && s.audio_base64_clean.length>50) {
        var arm0 = (s.robot_arm && String(s.robot_arm).trim()) || '';
        var loco0 = (s.robot_loco && String(s.robot_loco).trim()) || '';
        var led0 = (s.led_effect && String(s.led_effect).trim()) || '';
        var teach0 = (s.teaching_slot != null && String(s.teaching_slot).trim()) || '';
        if ((!arm0 && !loco0 && !led0 && !teach0) && typeof slotIndex === 'number') {
          fetch('/api/soundboard-slot/'+slotIndex).then(function(r){
            if (!r.ok) return Promise.resolve(s);
            return r.json();
          }).then(function(full){
            var merged = Object.assign({}, s, {
              robot_arm: (full && full.robot_arm) ? String(full.robot_arm) : '',
              robot_loco: (full && full.robot_loco) ? String(full.robot_loco) : '',
              led_effect: (full && full.led_effect) ? String(full.led_effect) : '',
              teaching_slot: (full && full.teaching_slot) ? String(full.teaching_slot) : '',
              audio_delay_ms: (full && full.audio_delay_ms != null) ? full.audio_delay_ms : 0,
              gesture_delay_ms: (full && full.gesture_delay_ms != null) ? full.gesture_delay_ms : 0
            });
            playFromData(merged);
          }).catch(function(){ playFromData(s); });
          return;
        }
        playFromData(s);
        return;
      }
      if (typeof slotIndex !== 'number') return;
      fetch('/api/soundboard-slot/'+slotIndex).then(function(r){
        if (!r.ok) return Promise.reject(new Error('HTTP '+r.status));
        return r.json();
      }).then(playFromData).catch(function(e){ alert('Soundboard browser: '+(e.message||String(e))); });
    }
    const sbDefaultIcons = ['🎤','🔊','📢','🎵','🎶','🎧','🎭','🚀','⭐','💡','🤝','☕','🎬','📷','🚪','🎁','✨','🏢','👋','🙏'];
    function sbIconAt(i){ return sbDefaultIcons[i % sbDefaultIcons.length]; }
    function updateSbCharCount(){
      const ta = document.getElementById('sbModalText');
      const n = (ta && ta.value) ? ta.value.length : 0;
      const el = document.getElementById('sbModalCharCount');
      if(el) el.textContent = n;
    }
    const SB_AUDIO_COUNT = 50;
    const SB_ROBOT_START = 50;
    const SB_EXPLORE_GESTURE_PREFIX = 'explore::';
    const SB_LOCAL_GESTURE_PREFIX = 'local::';
    var _sbArmGestureRefreshGen = 0;
    var _sbArmGestureRefreshPromise = null;
    function sbNormalizeTeachingRef(teach){
      teach = String(teach || '').trim();
      if (!teach) return '';
      if (teach.indexOf(SB_LOCAL_GESTURE_PREFIX) === 0 || teach.indexOf(SB_EXPLORE_GESTURE_PREFIX) === 0) return teach;
      if (/^\d+$/.test(teach)) return SB_LOCAL_GESTURE_PREFIX + teach;
      return SB_EXPLORE_GESTURE_PREFIX + teach;
    }
    function sbRemoveTeachingGestureGroups(sel){
      if (!sel) return;
      sel.querySelectorAll('optgroup').forEach(function(og){
        if (og.id === 'sbExploreGesturesGroup' || og.id === 'sbLocalGesturesGroup'
          || og.label === 'Addestrati (Explore)' || og.label === 'Registrati Jetson (braccia)') og.remove();
      });
    }
    function sbRemoveExploreGestureGroups(sel){ sbRemoveTeachingGestureGroups(sel); }
    function sbAppendTeachingGestureGroups(sel, items){
      if (!sel || !items || !items.length) return;
      var explore = items.filter(function(t){ return (t.source || '') !== 'local_arm'; });
      var local = items.filter(function(t){ return (t.source || '') === 'local_arm'; });
      function addGroup(id, label, rows, valueFn, textFn){
        if (!rows.length) return;
        var og = document.createElement('optgroup');
        og.id = id;
        og.label = label;
        rows.forEach(function(t){
          var val = valueFn(t);
          if (!val) return;
          var opt = document.createElement('option');
          opt.value = val;
          opt.textContent = textFn(t);
          og.appendChild(opt);
        });
        sel.appendChild(og);
      }
      addGroup('sbExploreGesturesGroup', 'Addestrati (Explore)', explore,
        function(t){ return t.ref || (SB_EXPLORE_GESTURE_PREFIX + String(t.name || '').trim()); },
        function(t){ return String(t.display_name || t.name || '').trim(); });
      addGroup('sbLocalGesturesGroup', 'Registrati Jetson (braccia)', local,
        function(t){ return t.ref || (SB_LOCAL_GESTURE_PREFIX + String(t.slot_id != null ? t.slot_id : '')); },
        function(t){ return String(t.display_name || t.name || '').trim(); });
    }
    function sbRefreshArmGestureOptions(){
      var sel = document.getElementById('sbModalArm');
      if (!sel) return Promise.resolve();
      if (_sbArmGestureRefreshPromise) return _sbArmGestureRefreshPromise;
      sbRemoveTeachingGestureGroups(sel);
      var gen = ++_sbArmGestureRefreshGen;
      _sbArmGestureRefreshPromise = fetch('/api/explore-teachings')
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (gen !== _sbArmGestureRefreshGen) return;
          sbRemoveTeachingGestureGroups(sel);
          var items = (d && d.ok && d.teachings) ? d.teachings : [];
          sbAppendTeachingGestureGroups(sel, items);
        })
        .catch(function(){})
        .finally(function(){
          if (gen === _sbArmGestureRefreshGen) _sbArmGestureRefreshPromise = null;
        });
      return _sbArmGestureRefreshPromise;
    }
    function sbGetModalGesture(){
      var v = (document.getElementById('sbModalArm')||{}).value || '';
      if (v.indexOf(SB_EXPLORE_GESTURE_PREFIX) === 0 || v.indexOf(SB_LOCAL_GESTURE_PREFIX) === 0) {
        return { robot_arm: '', teaching_slot: v };
      }
      return { robot_arm: v, teaching_slot: '' };
    }
    function sbGestureFieldsForSave(){
      var g = sbGetModalGesture();
      return {
        robot_arm: g.robot_arm || '',
        teaching_slot: g.teaching_slot || ''
      };
    }
    function sbParseDelayMs(el){
      var v = parseInt((el && el.value) || '0', 10);
      if (!isFinite(v) || v < 0) return 0;
      return Math.min(v, 15000);
    }
    function sbSetModalGesture(s){
      var sel = document.getElementById('sbModalArm');
      if (!sel) return;
      var teach = (s && s.teaching_slot != null) ? String(s.teaching_slot).trim() : '';
      var arm = (s && s.robot_arm != null) ? String(s.robot_arm).trim() : '';
      var want = '';
      if (teach) want = sbNormalizeTeachingRef(teach);
      else if (arm) want = arm;
      var hasOpt = Array.prototype.some.call(sel.options, function(o){ return o.value === want; });
      if (want && !hasOpt && teach) {
        sbAppendTeachingGestureGroups(sel, [{
          source: want.indexOf(SB_LOCAL_GESTURE_PREFIX) === 0 ? 'local_arm' : 'explore_app',
          ref: want,
          name: teach,
          display_name: teach,
          slot_id: want.indexOf(SB_LOCAL_GESTURE_PREFIX) === 0 ? parseInt(want.slice(SB_LOCAL_GESTURE_PREFIX.length), 10) : null
        }]);
      }
      sel.value = want;
    }
    function sbSlotHasAudio(s){
      return (typeof s.has_clean === 'boolean') ? s.has_clean : !!(s.audio_base64_clean && s.audio_base64_clean.length > 50);
    }
    function sbBuildSlotHtml(s, i, zone){
      const hasAudio = sbSlotHasAudio(s);
      const hasRobot = zone === 'robot' && !!(s.has_robot || (s.teaching_slot && String(s.teaching_slot).trim()) || (s.robot_arm && String(s.robot_arm).trim()));
      let cls = 'sb-slot';
      let badgeColor = '#71717a';
      if (zone === 'robot') {
        if (hasAudio) { cls += ' sb-slot-filled-purple'; badgeColor = '#a78bfa'; }
      } else {
        if (hasAudio) { cls += ' sb-slot-filled-teal'; badgeColor = '#14b8a6'; }
      }
      let badgeTitle = 'Vuoto', badgeHtml = '&#8212;';
      if (hasAudio && hasRobot) { badgeTitle = 'Audio + movimento'; badgeHtml = '&#9654;&#129302;'; }
      else if (hasAudio){ badgeTitle = 'Audio'; badgeHtml = '&#9654;'; }
      else if (hasRobot) { badgeTitle = 'Movimento robot'; badgeHtml = '&#129302;'; }
      const badge = hasAudio
        ? '<span style="position:absolute;top:4px;right:4px;font-size:9px;font-weight:700;color:'+badgeColor+';" title="'+badgeTitle+'">'+badgeHtml+'</span>'
        : '<span style="position:absolute;top:4px;right:4px;font-size:10px;color:#71717a;" title="Vuoto">&#8212;</span>';
      const label = (s.text||'Comando '+(i+1)).replace(/\u003c/g,'&lt;').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
      return '<div id="sb'+i+'" class="'+cls+'" role="button" tabindex="0" aria-label="Riproduci slot '+(i+1)+'">'+badge+'<span class="sb-slot-icon" style="pointer-events:none;">'+(s.icon||sbIconAt(i))+'</span><span class="sb-slot-text" style="pointer-events:none;">'+label+'</span><button type="button" class="sb-slot-edit" onclick="event.stopPropagation();editSoundboard('+i+')">✏️</button></div>';
    }
    function sbBindSlotEvents(){
      soundboardSlots.forEach((s,i)=>{
        const el = document.getElementById('sb'+i);
        if (!el) return;
        const playIfNotBtn = (ev) => {
          const t = ev.target;
          if (t && t.closest && t.closest('button')) return;
          sbPlaySlot(s, i);
        };
        if (window.PointerEvent) {
          el.addEventListener('pointerup', playIfNotBtn);
        } else {
          el.onclick = playIfNotBtn;
        }
        el.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); sbPlaySlot(s, i); }
        });
      });
    }
    function renderSoundboard(){
      const gridAudio = document.getElementById('soundboardGridAudio');
      const gridRobot = document.getElementById('soundboardGridRobot');
      if (!gridAudio && !gridRobot) return;
      const audioSlots = soundboardSlots.slice(0, SB_AUDIO_COUNT);
      const robotSlots = soundboardSlots.slice(SB_ROBOT_START);
      if (gridAudio) gridAudio.innerHTML = audioSlots.map((s,i)=>sbBuildSlotHtml(s, i, 'audio')).join('');
      if (gridRobot) gridRobot.innerHTML = robotSlots.map((s,j)=>sbBuildSlotHtml(s, SB_ROBOT_START + j, 'robot')).join('');
      sbBindSlotEvents();
    }
    window.renderSoundboard = renderSoundboard;
    function sbSetLoadErr(msg){
      const e = document.getElementById('soundboardLoadErr');
      if (!e) return;
      if (msg) { e.style.display = 'block'; e.textContent = msg; }
      else { e.style.display = 'none'; e.textContent = ''; }
    }
    function sbApplyLitePayload(d){
      sbSetLoadErr('');
      var n = (d && typeof d.slot_count === 'number' && d.slot_count > 0) ? d.slot_count : 100;
      if (d && d.slots && d.slots.length) {
        soundboardSlots = d.slots.slice();
        while (soundboardSlots.length < n) {
          var i = soundboardSlots.length;
          soundboardSlots.push({ icon: sbIconAt(i), text: 'Comando '+(i+1), has_robot: false, has_clean: false });
        }
        var withAudio = soundboardSlots.filter(function(s){ return s.has_clean; }).length;
        var hint = document.getElementById('soundboardLoadHint');
        if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
      } else {
        var hint2 = document.getElementById('soundboardLoadHint');
        if (hint2) { hint2.style.display = 'none'; hint2.textContent = ''; }
      }
      if (typeof d.text_max_len === 'number' && d.text_max_len > 0) { sbTextMax = d.text_max_len; const mx = document.getElementById('sbModalCharMax'); if(mx) mx.textContent = sbTextMax; }
      sbRefreshArmGestureOptions();
      renderSoundboard();
      const sbpd = document.getElementById('sbPlayDest');
      if (sbpd && !sbpd._sbVisBound) { sbpd._sbVisBound = true; sbpd.addEventListener('change', updateSbBrowserRowVisibility); }
      updateSbBrowserRowVisibility();
    }
    function sbLoadLiteSlots(){
      return fetch('/api/soundboard?lite=1').then(function(r){
        if (!r.ok) return Promise.reject(new Error('HTTP '+r.status));
        return r.json();
      }).then(sbApplyLitePayload).catch(function(err){
        sbSetLoadErr('Elenco slot dal server non disponibile ('+(err && err.message ? err.message : 'rete')+'). I pulsanti sotto restano usabili; torna su Sound o ricarica per riprovare.');
      });
    }
    soundboardSlots = Array.from({length: 100}, function(_, i){
      return { icon: sbIconAt(i), text: 'Comando '+(i+1), has_robot: false, has_clean: false };
    });
    renderSoundboard();
    sbLoadLiteSlots();
    (function(){
      var baseNav = window.g1ActivateClientSection;
      if (typeof baseNav !== 'function') return;
      window.g1ActivateClientSection = function(sec){
        baseNav(sec);
        if (sec === 'soundboard') {
          setTimeout(function(){
            if (!soundboardSlots.length) { sbLoadLiteSlots(); }
            else if (typeof window.renderSoundboard === 'function') { window.renderSoundboard(); }
          }, 0);
        }
        if (sec === 'parla') {
          setTimeout(function(){
            if (typeof requestAndLoadDevices === 'function') requestAndLoadDevices();
            if (typeof startParlaMicPreviewIfEligible === 'function') startParlaMicPreviewIfEligible();
          }, 120);
        } else {
          if (typeof stopParlaMicPreview === 'function') stopParlaMicPreview();
        }
        if (sec === 'occhi') {
          setTimeout(function(){ if (typeof window.g1ClientCameraOnShow === 'function') window.g1ClientCameraOnShow(); }, 80);
        } else if (typeof window.g1ClientCameraOnHide === 'function') {
          window.g1ClientCameraOnHide();
        }
        if (sec === 'info' && typeof window.g1RefreshLanLinks === 'function') {
          setTimeout(window.g1RefreshLanLinks, 0);
        }
        if (sec === 'log' && typeof window.g1ClientLogOnShow === 'function') {
          setTimeout(window.g1ClientLogOnShow, 0);
        } else if (typeof window.g1ClientLogOnHide === 'function') {
          window.g1ClientLogOnHide();
        }
        if (sec === 'teaching' && typeof window.g1LoadExploreTeachings === 'function') {
          setTimeout(window.g1LoadExploreTeachings, 0);
        }
        return false;
      };
    })();
    window.g1PlayExploreTeaching = function(ref){
      ref = sbNormalizeTeachingRef(ref);
      if (!ref) return;
      fetch('/api/explore-teachings/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ref })
      }).then(function(r){ return r.json(); }).then(function(d){
        if (!d.ok) alert('Teaching: ' + (d.message || 'errore'));
        if (typeof window.g1RefreshExploreTeachFsm === 'function') window.g1RefreshExploreTeachFsm();
      }).catch(function(e){ alert('Teaching: ' + (e.message || String(e))); });
    };
    window.g1PrepareExploreTeaching = function(){
      fetch('/api/robot-loco', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'arm_ready' })
      }).then(function(r){ return r.json(); }).then(function(d){
        if (!d.ok) alert('Prepara robot: ' + (d.message || 'errore'));
        if (typeof window.g1RefreshExploreTeachFsm === 'function') window.g1RefreshExploreTeachFsm();
      }).catch(function(e){ alert('Prepara robot: ' + (e.message || String(e))); });
    };
    window.g1RefreshExploreTeachFsm = function(){
      var el = document.getElementById('exploreTeachFsm');
      if (!el) return;
      fetch('/api/explore-teachings/status').then(function(r){ return r.json(); }).then(function(d){
        var sport = (d && d.sport) ? d.sport : {};
        var label = sport.sport_label || sport.sport_status || '—';
        var detail = sport.detail || '';
        var arm = d.arm_sdk_active ? ' · arm_sdk OCCUPATO (ferma VR/REC)' : '';
        var count = (d.teaching_count != null) ? (' · ' + d.teaching_count + ' movimenti') : '';
        var localCount = (d.local_count != null && d.local_count > 0) ? (' · ' + d.local_count + ' Jetson') : '';
        var exploreCount = (d.explore_count != null && d.explore_count > 0) ? (' · ' + d.explore_count + ' Explore') : '';
        el.textContent = 'Stato robot: ' + label + count + localCount + exploreCount + arm + (detail ? (' — ' + detail) : '');
        el.style.color = d.arm_sdk_active ? '#f87171' : '#71717a';
      }).catch(function(){ el.textContent = 'Stato robot: non disponibile'; });
    };
    window.g1StopExploreTeaching = function(){
      fetch('/api/explore-teachings/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function(r){ return r.json(); })
        .then(function(d){ if (!d.ok) alert('Stop: ' + (d.message || 'errore')); })
        .catch(function(e){ alert('Stop: ' + (e.message || String(e))); });
    };
    window.g1PopulateExploreTeachingSelect = function(selectEl, selectedRef){
      if (!selectEl) return Promise.resolve();
      return fetch('/api/explore-teachings')
        .then(function(r){ return r.json(); })
        .then(function(d){
          var items = (d && d.ok && d.teachings) ? d.teachings : ((d && d.custom) ? d.custom : []);
          var html = '<option value="">— Movimento —</option>';
          items.forEach(function(t){
            var ref = String(t.ref || '').trim();
            if (!ref && t.source === 'local_arm' && t.slot_id != null) ref = SB_LOCAL_GESTURE_PREFIX + t.slot_id;
            if (!ref) ref = SB_EXPLORE_GESTURE_PREFIX + String(t.name || '').trim();
            var label = String(t.display_name || t.name || ref).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
            var escRef = ref.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
            var tag = (t.source === 'local_arm') ? ' [Jetson]' : ' [Explore]';
            html += '<option value="' + escRef + '">' + label + tag + '</option>';
          });
          selectEl.innerHTML = html;
          if (selectedRef) selectEl.value = sbNormalizeTeachingRef(selectedRef);
        })
        .catch(function(){});
    };
    window._parlaTeachingRefsCache = [];
    window.g1PopulateParlaTeachingPickers = function(selectedGestures, teachingItems){
      var wrap = document.getElementById('parlaTeachGesturesPickers');
      if (!wrap) return;
      var items = teachingItems || window._parlaTeachingRefsCache || [];
      var picked = Array.isArray(selectedGestures) ? selectedGestures : [];
      wrap.innerHTML = [0, 1, 2].map(function(i){
        var val = sbNormalizeTeachingRef(String(picked[i] || '').trim());
        var opts = '<option value="">— nessuno —</option>' + items.map(function(t){
          var ref = String(t.ref || '').trim();
          if (!ref && t.source === 'local_arm' && t.slot_id != null) ref = SB_LOCAL_GESTURE_PREFIX + t.slot_id;
          if (!ref) ref = SB_EXPLORE_GESTURE_PREFIX + String(t.name || '').trim();
          var label = String(t.display_name || t.name || ref);
          var escRef = ref.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
          var escLabel = label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
          var sel = (val && ref === val) ? ' selected' : '';
          return '<option value="' + escRef + '"' + sel + '>' + escLabel + '</option>';
        }).join('');
        return '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#d4d4d8;">'
          + '<span style="min-width:58px;color:#71717a;">Gesto ' + (i + 1) + '</span>'
          + '<select class="parla-teach-gesture-select" data-slot="' + i + '" style="flex:1;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#27272a;color:#fff;font-size:12px;">'
          + opts + '</select></label>';
      }).join('');
    };
    window.g1LoadParlaTeachingGestures = function(){
      return fetch('/api/explore-teachings/parla-gestures')
        .then(function(r){ return r.json(); })
        .then(function(d){
          window.g1PopulateParlaTeachingPickers(d.gestures || [], window._parlaTeachingRefsCache || []);
          return d;
        })
        .catch(function(){ return null; });
    };
    window.g1SaveParlaTeachingGestures = function(){
      var selects = document.querySelectorAll('.parla-teach-gesture-select');
      var gestures = [];
      selects.forEach(function(sel){
        var v = String(sel.value || '').trim();
        if (v) gestures.push(v);
      });
      var status = document.getElementById('parlaTeachGesturesStatus');
      var btn = document.getElementById('parlaTeachGesturesSave');
      if (btn) btn.disabled = true;
      return fetch('/api/explore-teachings/parla-gestures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gestures: gestures })
      }).then(function(r){ return r.json(); }).then(function(d){
        if (status) status.textContent = d.ok ? 'Salvato' : (d.message || 'Errore');
        if (d.ok) window.g1PopulateParlaTeachingPickers(d.gestures || [], window._parlaTeachingRefsCache || []);
        setTimeout(function(){ if (status) status.textContent = ''; }, 2500);
        return d;
      }).catch(function(e){
        if (status) status.textContent = e.message || 'Errore';
        return null;
      }).finally(function(){ if (btn) btn.disabled = false; });
    };
    (function(){
      function bindParlaTeachGesturesSave(){
        var btn = document.getElementById('parlaTeachGesturesSave');
        if (!btn || btn._parlaSaveBound) return;
        btn._parlaSaveBound = true;
        btn.addEventListener('click', function(){
          if (typeof window.g1SaveParlaTeachingGestures === 'function') window.g1SaveParlaTeachingGestures();
        });
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindParlaTeachGesturesSave);
      else bindParlaTeachGesturesSave();
    })();
    (function(){
      function bindExploreTeachListClicks(){
        var list = document.getElementById('exploreTeachList');
        if (!list || list._explorePlayBound) return;
        list._explorePlayBound = true;
        list.addEventListener('click', function(ev){
          var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-teaching-play], button[data-explore-play]') : null;
          if (!btn || !list.contains(btn)) return;
          ev.preventDefault();
          var teachRef = btn.getAttribute('data-teaching-play') || btn.getAttribute('data-explore-play') || '';
          if (typeof window.g1PlayExploreTeaching === 'function') window.g1PlayExploreTeaching(teachRef);
        });
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindExploreTeachListClicks);
      else bindExploreTeachListClicks();
    })();
    window.g1LoadExploreTeachings = function(){
      var list = document.getElementById('exploreTeachList');
      var err = document.getElementById('exploreTeachErr');
      if (!list) return;
      if (typeof window.g1RefreshExploreTeachFsm === 'function') window.g1RefreshExploreTeachFsm();
      list.innerHTML = '<p class="hint" style="margin:0;font-size:12px;color:#52525b;">Caricamento…</p>';
      if (err) { err.style.display = 'none'; err.textContent = ''; }
      fetch('/api/explore-teachings')
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (!d.ok) {
            if (err) { err.style.display = 'block'; err.textContent = d.error || 'Elenco non disponibile'; }
            list.innerHTML = '<p class="hint" style="margin:0;font-size:12px;color:#52525b;">—</p>';
            return;
          }
          var items = d.teachings || [];
          window._parlaTeachingRefsCache = items;
          window.g1PopulateExploreTeachingSelect(document.getElementById('sbModalExploreTeaching'));
          if (typeof window.g1LoadParlaTeachingGestures === 'function') window.g1LoadParlaTeachingGestures();
          if (!items.length) {
            list.innerHTML = '<p class="hint" style="margin:0;font-size:12px;color:#52525b;">Nessun movimento. Registra con Explore sul telefono oppure REC in Robot Control, poi Aggiorna.</p>';
            return;
          }
          list.innerHTML = items.map(function(t){
            var dur = (t.duration_s != null) ? (t.duration_s + 's') : '—';
            var label = String(t.display_name || t.name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
            var ref = String(t.ref || '').trim();
            if (!ref && t.source === 'local_arm' && t.slot_id != null) ref = SB_LOCAL_GESTURE_PREFIX + t.slot_id;
            if (!ref) ref = SB_EXPLORE_GESTURE_PREFIX + String(t.name || '').trim();
            var attrRef = ref.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/'/g,'&#39;');
            var src = (t.source === 'local_arm')
              ? '<span class="et-dur" style="color:#5eead4;">Jetson</span>'
              : '<span class="et-dur">Explore</span>';
            return '<div class="explore-teach-item"><span class="et-name">' + label + '</span>'
              + src + '<span class="et-dur">' + dur + '</span>'
              + '<button type="button" data-teaching-play="' + attrRef + '">Play</button></div>';
          }).join('');
        })
        .catch(function(e){
          if (err) { err.style.display = 'block'; err.textContent = e.message || 'Rete'; }
          list.innerHTML = '';
        });
    };
    window.g1PlayUnitreeTeaching = window.g1PlayExploreTeaching;
    window.g1LoadUnitreeTeachings = window.g1LoadExploreTeachings;
    function updateSbModalStatus(){
      const st = document.getElementById('sbModalAudioStatus');
      if(!st) return;
      const kb = sbEditAudioClean ? Math.round((sbEditAudioClean.length||0)/1024) : 0;
      st.innerHTML = sbEditAudioClean ? '&#128266; <span style="color:#14b8a6;">Audio</span> '+kb+' KB' : '&#128266; <span style="color:#71717a;">Nessun audio</span>';
    }
    function editSoundboard(idx){
      sbEditIdx = idx;
      const s = soundboardSlots[idx] || {};
      document.getElementById('sbModalSlot').textContent = idx+1;
      document.getElementById('sbModalIcon').value = s.icon || sbIconAt(idx);
      document.getElementById('sbModalText').value = s.text || 'Comando '+(idx+1);
      document.getElementById('sbModalText').setAttribute('maxlength', String(sbTextMax));
      sbEditAudioRaw = null;
      sbEditAudioCleared = false;
      function applyFull(full){
        sbEditAudio = null; sbEditFmt = '';
        sbEditAudioClean = full.audio_base64_clean || full.audio_base64 || null;
        sbEditFmtClean = full.format_clean || full.format || 'mp3';
        sbEditAudioCleared = false;
        updateSbModalStatus();
        updateSbCharCount();
      }
      var armSel = document.getElementById('sbModalArm');
      var locoSel = document.getElementById('sbModalLoco');
      var ledSel = document.getElementById('sbModalLed');
      var robotBlock = document.getElementById('sbModalRobotBlock');
      var isRobotZone = idx >= SB_ROBOT_START;
      if (robotBlock) robotBlock.style.display = isRobotZone ? '' : 'none';
      function applyRobotFields(slotData){
        if (!isRobotZone) return;
        sbSetModalGesture(slotData || {});
        if (locoSel) locoSel.value = (slotData && slotData.robot_loco) ? slotData.robot_loco : '';
        if (ledSel) { ledSel.value = (slotData && slotData.led_effect) ? slotData.led_effect : ''; sbUpdateLedPreview(); }
        var adEl = document.getElementById('sbModalAudioDelay');
        var gdEl = document.getElementById('sbModalGestureDelay');
        if (adEl) adEl.value = String((slotData && slotData.audio_delay_ms != null) ? slotData.audio_delay_ms : 0);
        if (gdEl) gdEl.value = String((slotData && slotData.gesture_delay_ms != null) ? slotData.gesture_delay_ms : 0);
      }
      function loadRobotFields(slotData){
        if (!isRobotZone) return Promise.resolve();
        return sbRefreshArmGestureOptions().then(function(){ applyRobotFields(slotData); });
      }
      document.getElementById('sbModal').style.display = 'flex';
      if (s.audio_base64_clean && s.audio_base64_clean.length>50) {
        applyFull(s);
        loadRobotFields(s);
        return;
      }
      var st = document.getElementById('sbModalAudioStatus');
      if (st) st.innerHTML = 'Caricamento audio…';
      sbEditAudio = null; sbEditFmt = 'webm'; sbEditAudioClean = null; sbEditFmtClean = 'mp3';
      fetch('/api/soundboard-slot/'+idx).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }).then(function(full){
        applyFull(full);
        return loadRobotFields(full);
      }).catch(function(e){
        if (st) st.innerHTML = 'Errore: '+(e.message||String(e));
      });
    }
    window.editSoundboard = editSoundboard;
    var _sbLedColorMap = {
      'rainbow':'linear-gradient(90deg,red,orange,yellow,green,blue,violet)','breathe_blue':'#0078ff','breathe_green':'#00ff50',
      'breathe_red':'#ff2828','breathe_purple':'#a855f7','blink_red':'#ff0000','blink_blue':'#0064ff',
      'solid_blue':'#0078ff','solid_green':'#00ff50','solid_red':'#ff0000','solid_amber':'#ffb400',
      'solid_purple':'#a855f7','solid_cyan':'#00dcdc','solid_white':'#ffffff'
    };
    function sbUpdateLedPreview(){
      var sel = document.getElementById('sbModalLed');
      var prev = document.getElementById('sbModalLedPreview');
      if (!sel || !prev) return;
      var c = _sbLedColorMap[sel.value] || '#27272a';
      prev.style.background = c;
    }
    var _sbLedSel = document.getElementById('sbModalLed');
    if (_sbLedSel) _sbLedSel.onchange = sbUpdateLedPreview;
    const sbModalTextEl = document.getElementById('sbModalText');
    if (sbModalTextEl) { sbModalTextEl.oninput = updateSbCharCount; }
    function closeSbModal(){ document.getElementById('sbModal').style.display = 'none'; sbEditIdx = -1; sbEditAudio = null; sbEditAudioClean = null; sbEditFmtClean = 'mp3'; sbEditAudioCleared = false; }
    var sbModalCancelEl = document.getElementById('sbModalCancel');
    if (sbModalCancelEl) sbModalCancelEl.onclick = closeSbModal;
    var sbModalSaveEl = document.getElementById('sbModalSave');
    if (sbModalSaveEl) sbModalSaveEl.onclick = function(){
      if (sbEditIdx < 0) return;
      const icon = (document.getElementById('sbModalIcon').value || '🎤').trim().substring(0,20);
      const text = (document.getElementById('sbModalText').value || 'Comando '+(sbEditIdx+1)).trim().substring(0, sbTextMax);
      let robot_arm = '', robot_loco = '', led_effect = '', teaching_slot = '';
      let audio_delay_ms = 0, gesture_delay_ms = 0;
      if (sbEditIdx >= SB_ROBOT_START) {
        var gesture = sbGestureFieldsForSave();
        robot_arm = gesture.robot_arm;
        teaching_slot = gesture.teaching_slot;
        robot_loco = (document.getElementById('sbModalLoco')||{}).value || '';
        led_effect = (document.getElementById('sbModalLed')||{}).value || '';
        audio_delay_ms = sbParseDelayMs(document.getElementById('sbModalAudioDelay'));
        gesture_delay_ms = sbParseDelayMs(document.getElementById('sbModalGestureDelay'));
      }
      fetch('/api/soundboard', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({slot:sbEditIdx, icon, text, audio_base64: '', format: sbEditFmtClean||'mp3', audio_base64_clean: sbEditAudioClean||'', format_clean: sbEditFmtClean||'mp3', clear_audio: !!sbEditAudioCleared, robot_arm, robot_loco, led_effect, teaching_slot, audio_delay_ms, gesture_delay_ms})}).then(r=>r.json()).then(()=>{ sbLoadLiteSlots(); });
      closeSbModal();
    };
    var sbModalSynthEl = document.getElementById('sbModalSynth');
    if (sbModalSynthEl) sbModalSynthEl.onclick = async function(){
      const text = (document.getElementById('sbModalText').value||'').trim().substring(0, sbTextMax);
      if (!text) { alert('Scrivi il testo da sintetizzare'); return; }
      const btn = document.getElementById('sbModalSynth');
      btn.disabled = true;
      document.getElementById('sbModalAudioStatus').innerHTML = 'Generazione TTS...';
      try {
        const r = await fetch('/api/soundboard-synth', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text})});
        const d = await r.json();
        if (d.ok) {
          sbEditAudio = null; sbEditFmt = '';
          sbEditAudioClean = d.audio_base64_clean || d.audio_base64 || null; sbEditFmtClean = d.format_clean || d.format || 'wav';
          sbEditAudioRaw = null; sbEditAudioCleared = false; updateSbModalStatus();
        }
        else alert(d.error || 'Errore TTS');
      } catch(e) { alert('Errore: '+e.message); }
      btn.disabled = false;
    };
    var sbModalRecordEl = document.getElementById('sbModalRecord');
    if (sbModalRecordEl) sbModalRecordEl.onclick = function(){
      if (!navigator.mediaDevices) { alert('Microfono non disponibile'); return; }
      document.getElementById('sbModalRecord').disabled = true;
      document.getElementById('sbModalAudioStatus').innerHTML = 'Registrazione 3 sec...';
      navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
        const mr = new MediaRecorder(stream, {mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'});
        const chunks = [];
        mr.ondataavailable = e=>{ if(e.data.size) chunks.push(e.data); };
        mr.onstop = ()=>{
          stream.getTracks().forEach(t=>t.stop());
          const blob = new Blob(chunks, {type: mr.mimeType});
          const fr = new FileReader();
          fr.onload = async ()=>{
            const b64 = arrayBufferToBase64(fr.result);
            document.getElementById('sbModalAudioStatus').innerHTML = 'Registrazione pronta';
            sbEditAudio = null; sbEditFmt = '';
            sbEditAudioClean = b64; sbEditFmtClean = 'webm';
            sbEditAudioRaw = null; sbEditAudioCleared = false;
            updateSbModalStatus();
            document.getElementById('sbModalRecord').disabled = false;
          };
          fr.readAsArrayBuffer(blob);
        };
        mr.start(); setTimeout(()=>mr.stop(), 3000);
      }).catch(function(){ alert('Microfono non disponibile'); document.getElementById('sbModalRecord').disabled = false; });
    };
    var _sbModalFile = document.getElementById('sbModalFile');
    if (_sbModalFile) _sbModalFile.onchange = async function(e){
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const ext = (f.name.split('.').pop()||'').toLowerCase();
      const mime = {mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',webm:'audio/webm',m4a:'audio/mp4'}[ext] || f.type || 'audio/mpeg';
      const buf = await f.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      document.getElementById('sbModalAudioStatus').innerHTML = 'File caricato';
      sbEditAudio = b64; sbEditFmt = ext || 'mp3';
      sbEditAudioClean = b64; sbEditFmtClean = ext || 'mp3';
      sbEditAudioRaw = null; sbEditAudioCleared = false;
      updateSbModalStatus();
      e.target.value = '';
    };
    var sbModalClearEl = document.getElementById('sbModalClear');
    if (sbModalClearEl) sbModalClearEl.onclick = function(){ sbEditAudio = null; sbEditFmt = ''; sbEditAudioClean = null; sbEditFmtClean = 'mp3'; sbEditAudioRaw = null; sbEditAudioCleared = true; updateSbModalStatus(); };
    var sbModalTtsEl = document.getElementById('sbModalTts');
    if (sbModalTtsEl) sbModalTtsEl.onclick = async function(){
      if (!sbEditAudioClean || sbEditAudioClean.length < 100) { alert('Serve prima un audio (registra o importa)'); return; }
      const btn = document.getElementById('sbModalTts');
      btn.disabled = true;
      document.getElementById('sbModalAudioStatus').innerHTML = 'Riprocessamento con TTS...';
      try {
        const r = await fetch('/api/audio-to-robot-voice', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({audio_base64: sbEditAudioClean, format: sbEditFmtClean||'wav'})});
        const d = await r.json();
        if (d.ok) {
          sbEditAudio = null; sbEditFmt = '';
          sbEditAudioClean = d.audio_base64;
          sbEditFmtClean = 'mp3';
          sbEditAudioCleared = false;
          updateSbModalStatus();
        } else alert(d.error || 'Errore');
      } catch(e) { alert('Errore: '+e.message); }
      btn.disabled = false;
    };
    var sbOutRef = document.getElementById('sbOutputRefresh');
    if (sbOutRef) sbOutRef.onclick = () => { if (typeof requestAndLoadDevices === 'function') requestAndLoadDevices(); };
    function escAttr(s){ return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/\u003c/g,'&lt;'); }
    var btnTestEl = document.getElementById('btnTest');
    if (btnTestEl) btnTestEl.onclick = async function(){
      const btn = document.getElementById('btnTest');
      const status = document.getElementById('testStatus');
      btn.disabled = true;
      status.textContent = ' Test in corso (attendi 5-10 sec)...';
      status.style.color = '#a1a1aa';
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 60000);
      try {
        const r = await fetch('/api/test-pipeline', { signal: ctrl.signal });
        clearTimeout(t);
        const d = await r.json();
        if (d.ok) {
          const dur = d.duration_ms ? ' ('+d.duration_ms+' ms)' : '';
          status.textContent = ' OK: trascritto "'+d.transcribed+'", risposta: "'+(d.llm_response||'').substring(0,50)+'..."'+dur;
          status.style.color = '#22c55e';
          if (d.audio_base64) {
            const a = new Audio('data:audio/mpeg;base64,'+d.audio_base64);
            a.play();
          }
        } else {
          status.textContent = ' Errore: '+(d.error||'');
          status.style.color = '#dc2626';
        }
      } catch (e) {
        clearTimeout(t);
        if (e.name === 'AbortError') {
          status.textContent = ' Timeout (60s). Il server e lento o non raggiungibile.';
        } else {
          status.textContent = ' Errore: '+(e.message || String(e));
        }
        status.style.color = '#dc2626';
      }
      btn.disabled = false;
    };

    var btnTextEl = document.getElementById('btnText');
    if (btnTextEl) btnTextEl.onclick = async function(){
      const input = document.getElementById('textInput');
      const status = document.getElementById('textStatus');
      const txt = (input.value || '').trim();
      if (!txt) { status.textContent = 'Scrivi qualcosa.'; status.style.color = '#f59e0b'; return; }
      document.getElementById('btnText').disabled = true;
      status.textContent = ' Elaborazione (IA)…';
      status.style.color = '#a1a1aa';
      startThinkingFeedback(false);
      try {
        const r = await fetch('/api/text-chat', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text: txt}) });
        const d = await r.json().catch(function(){ return {}; });
        if (!r.ok) {
          status.textContent = ' Errore: ' + (d.detail || d.error || r.status);
          status.style.color = '#dc2626';
        } else if (d.message && !d.response) {
          status.textContent = ' ' + d.message;
          status.style.color = '#f59e0b';
        } else {
          const dur = d.duration_ms ? d.duration_ms + ' ms' : '';
          status.textContent = dur ? ' Tempo: ' + dur : ' OK';
          status.style.color = '#22c55e';
          document.getElementById('result').innerHTML = '<div><b>Hai scritto:</b> '+(d.text||'')+'</div><div><b>Risposta:</b> '+(d.response||'')+' <span style="color:#71717a;font-size:12px;">('+(d.duration_ms||0)+' ms)</span></div>';
          if (d.audio_base64) {
            const a = new Audio('data:audio/mpeg;base64,'+d.audio_base64);
            applySinkThenPlay(a, resolveBrowserPlaybackSinkIdLikeSoundboard()).catch(function(){});
          }
        }
      } catch (e) {
        status.textContent = ' Errore: ' + (e.message || String(e));
        status.style.color = '#dc2626';
      }
      stopThinkingFeedback();
      document.getElementById('btnText').disabled = false;
    };
    var _textInput = document.getElementById('textInput');
    if (_textInput) _textInput.onkeydown = function(e) { if (e.key === 'Enter') { var b=document.getElementById('btnText'); if(b)b.click(); } };

    var btnSampleEl = document.getElementById('btnSample');
    if (btnSampleEl) btnSampleEl.onclick = async function(){
      const btn = document.getElementById('btnSample');
      const status = document.getElementById('testStatus');
      btn.disabled = true;
      status.textContent = ' Test con ultimo campione...';
      status.style.color = '#a1a1aa';
      try {
        const r = await fetch('/api/test-with-sample');
        const d = await r.json();
        if (d.ok) {
          const dur = d.duration_ms ? ' ('+d.duration_ms+' ms)' : '';
          status.textContent = ' OK: "'+(d.text||'').substring(0,40)+'" -> "'+(d.response||'').substring(0,30)+'..."'+dur;
          status.style.color = '#22c55e';
          document.getElementById('result').innerHTML = '<div><b>Hai detto:</b> '+(d.text||'')+'</div><div><b>Risposta:</b> '+(d.response||'')+'</div>';
          if (d.audio_base64) {
            const a = new Audio('data:audio/mpeg;base64,'+d.audio_base64);
            applySinkThenPlay(a, resolveBrowserPlaybackSinkIdLikeSoundboard()).catch(function(){});
          }
        } else {
          status.textContent = ' '+(d.error||'');
          status.style.color = '#dc2626';
        }
      } catch (e) {
        status.textContent = ' Errore: '+(e.message || String(e));
        status.style.color = '#dc2626';
      }
      btn.disabled = false;
    };

    async function startRec(){
      if(isRecording) return;
      wakeListenPending = false;
      stopWakeRecorder();
      const micSelVal = document.getElementById('mic').value;
      if (micSelVal && micSelVal.indexOf('local_') === 0) {
        await startRecServerPtt();
        return;
      }
      isRecording = true;
      pendingStop = false;
      const spkVal = document.getElementById('speaker').value;
      const td = ttsDestFromUi();
      lastPlayOn = td.playOn;
      if (td.playOn === 'browser') {
        lastSinkId = (spkVal && spkVal.startsWith('browser_') && spkVal !== 'browser_default') ? spkVal.replace('browser_','') : null;
        syncSbOutputFromSpeaker();
      } else {
        lastSinkId = null;
      }
      const deviceId = td.deviceId;
      try {
        stopParlaMicPreview();
        const rawStream = (typeof getUserMediaWithFallback === 'function')
          ? await getUserMediaWithFallback(micForBrowserCapture())
          : await navigator.mediaDevices.getUserMedia(buildAudioCaptureConstraints(micForBrowserCapture()));
        if(pendingStop){ rawStream.getTracks().forEach(t=>t.stop()); isRecording=false; return; }
        currentStream = rawStream;
        let recordStream = rawStream;
        pttInputGainNode = null;
        try {
          const pipeline = createSpeechEnhancedPipeline(rawStream, 256);
          audioCtx = pipeline.ctx;
          analyserNode = pipeline.analyser;
          pttInputGainNode = pipeline.inputGainNode;
          recordStream = pipeline.stream;
        } catch(_) {
          audioCtx = new (window.AudioContext||window.webkitAudioContext)();
          const src = audioCtx.createMediaStreamSource(rawStream);
          analyserNode = audioCtx.createAnalyser();
          analyserNode.fftSize = 256;
          analyserNode.smoothingTimeConstant = 0.5;
          src.connect(analyserNode);
        }
        await new Promise(r => setTimeout(r, 150));
        if(pendingStop){ rawStream.getTracks().forEach(t=>t.stop()); isRecording=false; pttInputGainNode=null; return; }
        const mimeType = preferredRecorderMime();
        mediaRecorder = new MediaRecorder(recordStream, { mimeType: mimeType, audioBitsPerSecond: 128000 });
        chunks = [];
        mediaRecorder.ondataavailable = e => { if(e.data && e.data.size > 0) chunks.push(e.data); };
        mediaRecorder.onstop = () => {
          clearAllIntervals();
          document.getElementById('levelBar').style.width = '0%';
          document.getElementById('levelLabel').textContent = 'Livello: --';
          if (btn) btn.classList.remove('recording');
          isRecording = false;
          if(currentStream){ currentStream.getTracks().forEach(t=>t.stop()); currentStream=null; }
          pttInputGainNode = null;
          if (audioCtx) { try { audioCtx.close(); } catch(_){} audioCtx = null; }
          analyserNode = null;
          const dur = Date.now() - recStartTime;
          if(dur < MIN_REC_MS){
            document.getElementById('recDebug').textContent = 'Troppo breve ('+Math.round(dur/100)+' decimi sec). Tieni premuto 1-2 secondi.';
            document.getElementById('recDebug').style.color = '#f59e0b';
            setTimeout(function(){ if (typeof startParlaMicPreviewIfEligible === 'function') startParlaMicPreviewIfEligible(); }, 200);
            return;
          }
          setTimeout(function(){
            sendAudio(lastPlayOn, deviceId);
            setTimeout(function(){ if (typeof startParlaMicPreviewIfEligible === 'function') startParlaMicPreviewIfEligible(); }, 350);
          }, 80);
        };
        mediaRecorder.onerror = (e) => {
          clearAllIntervals();
          isRecording = false;
          if (btn) btn.classList.remove('recording');
          document.getElementById('recDebug').textContent = 'Errore registrazione: '+e.error;
          document.getElementById('recDebug').style.color = '#dc2626';
        };
        mediaRecorder.start(500);
        recStartTime = Date.now();
        recDurationInterval = setInterval(() => {
          const s = ((Date.now()-recStartTime)/1000).toFixed(1);
          document.getElementById('recDebug').textContent = 'Registrazione: '+s+' sec';
          document.getElementById('recDebug').style.color = '#22c55e';
        }, 200);
        try {
          const data = new Uint8Array(analyserNode.frequencyBinCount);
          levelInterval = setInterval(() => {
            if(!analyserNode) return;
            analyserNode.getByteFrequencyData(data);
            let peak = 0;
            for(let i=0;i<data.length;i++) if (data[i] > peak) peak = data[i];
            const gain = typeof getParlaMonitorGain === 'function' ? getParlaMonitorGain() : 1;
            const pct = Math.min(100, Math.round(peak * gain * (100 / 255)));
            document.getElementById('levelBar').style.width = pct+'%';
            document.getElementById('levelLabel').textContent = peak > 5 ? 'Ti sento! ('+pct+'%)' : 'Livello: '+pct+'%';
          }, 80);
        } catch(_){}
        if (btn) btn.classList.add('recording');
        document.getElementById('recDebug').textContent = 'Registrazione: 0.0 sec';
        recTimeout = setTimeout(() => { stopRec(); }, MAX_REC_SEC * 1000);
      } catch(err) {
        isRecording = false;
        pendingStop = false;
        var micVal = document.getElementById('mic') ? document.getElementById('mic').value : '';
        var hint = (micVal && micVal.indexOf('local_') === 0)
          ? 'Hai selezionato microfono Jetson: per parlare da questo PC/telefono scegli un microfono <strong>Browser</strong> nel menu sopra.'
          : 'Abilita il microfono per questo sito nelle impostazioni browser, poi scegli il device <strong>Browser</strong> nel menu sopra.';
        document.getElementById('result').innerHTML = '<div class="warn">Microfono non disponibile. '+hint+'</div>';
      }
    }
    function clearAllIntervals(){
      if(recTimeout){ clearTimeout(recTimeout); recTimeout = null; }
      if(recDurationInterval){ clearInterval(recDurationInterval); recDurationInterval = null; }
      if(levelInterval){ clearInterval(levelInterval); levelInterval = null; }
      pttInputGainNode = null;
      if (audioCtx) { try { audioCtx.close(); } catch(_){} audioCtx = null; }
      analyserNode = null;
    }
    function stopRec(){
      if(!isRecording) return;
      pendingStop = true;
      if (recordingServerJetson) {
        clearAllIntervals();
        if (btn) btn.classList.remove('recording');
        recordingServerJetson = false;
        isRecording = false;
        if (wsParla && wsParla.readyState === WebSocket.OPEN) {
          try {
            const td = ttsDestFromUi();
            lastPlayOn = td.playOn;
            wsParla.send(JSON.stringify({
              type: 'stop',
              play_on: td.playOn,
              device_id: td.deviceId
            }));
          } catch(_){}
        }
        document.getElementById('recDebug').textContent = 'Elaborazione (audio dal robot)…';
        document.getElementById('recDebug').style.color = '#3b82f6';
        startThinkingFeedback();
        return;
      }
      clearAllIntervals();
      if (btn) btn.classList.remove('recording');
      if(mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')){
        try { mediaRecorder.requestData(); mediaRecorder.stop(); } catch(_){}
      } else if(currentStream){
        currentStream.getTracks().forEach(t=>t.stop());
        currentStream = null;
        isRecording = false;
        document.getElementById('recDebug').textContent = 'Registrazione interrotta.';
      } else {
        isRecording = false;
      }
    }
    function sendAudio(playOn, outDeviceId){
      wakeListenPending = false;
      wakeQueuedBlob = null;
      wakeAudioInFlight = false;
      if(!chunks.length || !ws || ws.readyState !== WebSocket.OPEN){
        document.getElementById('recDebug').textContent = 'Errore: '+(!chunks.length ? 'nessun audio' : 'WebSocket chiuso');
        document.getElementById('recDebug').style.color = '#dc2626';
        return;
      }
      const recMime = mediaRecorder && mediaRecorder.mimeType ? mediaRecorder.mimeType : preferredRecorderMime();
      const blob = new Blob(chunks, {type: recMime});
      if(blob.size < WS_AUDIO_MIN_BYTES){
        document.getElementById('recDebug').textContent = 'Audio troppo corto ('+(blob.size/1024).toFixed(1)+' KB). Tieni premuto 1-2 secondi.';
        document.getElementById('recDebug').style.color = '#f59e0b';
        if (btn) btn.disabled = false;
        return;
      }
      const sizeKb = (blob.size/1024).toFixed(1);
      document.getElementById('recDebug').textContent = 'Invio '+sizeKb+' KB...';
      document.getElementById('recDebug').style.color = '#3b82f6';
      document.getElementById('result').innerHTML = '<div style="color:#3b82f6;">Elaborazione…</div>';
      if (btn) btn.disabled = true;
      startThinkingFeedback();
      const fr = new FileReader();
      fr.onload = () => {
        const b64 = arrayBufferToBase64(fr.result);
        sendAudioOverWs(b64, recMime, { playOn: playOn, skipWake: true, deviceId: outDeviceId });
        chunks = [];
      };
      fr.readAsArrayBuffer(blob);
    }
    /* Disinstalla eventuali SW vecchi: su mobile possono servire HTML/JS in cache e UI che «non clicca». */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function(regs){ regs.forEach(function(r){ r.unregister(); }); }).catch(function(){});
    }

    /* ---- Live Mic Monitor (WebSocket /ws/mic-level) ---- */
    (function(){
      var monWs = null;
      var monActive = false;
      var btnMon = document.getElementById('btnMicMonitor');
      var monBody = document.getElementById('micMonitorBody');
      var monBar = document.getElementById('monLevelBar');
      var monInfo = document.getElementById('monLevelInfo');
      var monName = document.getElementById('monMicName');
      if (!btnMon) return;

      function startMonitor() {
        if (monWs) { try { monWs.close(); } catch(_){} }
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        monWs = new WebSocket(proto + '//' + location.host + '/ws/mic-level');
        monActive = true;
        btnMon.textContent = 'Stop';
        btnMon.style.background = '#ef4444';
        monBody.style.display = 'block';
        monInfo.textContent = 'Connessione...';

        monWs.onmessage = function(ev) {
          try {
            var d = JSON.parse(ev.data);
            if (d.type === 'info') {
              monName.textContent = 'Mic: [' + d.device + '] ' + d.name + '  rate=' + d.rate;
            } else if (d.type === 'level') {
              var pct = Math.max(0, Math.min(100, ((d.db + 60) / 60) * 100));
              monBar.style.width = pct.toFixed(1) + '%';
              if (d.peak > 0.5) {
                monBar.style.background = '#ef4444';
              } else if (d.rms > 0.02) {
                monBar.style.background = '#22c55e';
              } else if (d.rms > 0.005) {
                monBar.style.background = '#eab308';
              } else {
                monBar.style.background = '#52525b';
              }
              monInfo.textContent = 'RMS=' + d.rms.toFixed(4) + '  Peak=' + d.peak.toFixed(4) + '  dB=' + d.db.toFixed(1);
            } else if (d.type === 'error') {
              monInfo.textContent = 'Errore: ' + d.data;
              monBar.style.width = '0%';
            }
          } catch(_){}
        };
        monWs.onclose = function() {
          monActive = false;
          btnMon.textContent = 'Avvia';
          btnMon.style.background = '#3b82f6';
        };
        monWs.onerror = function() {
          monInfo.textContent = 'Errore connessione';
        };
      }

      function stopMonitor() {
        monActive = false;
        if (monWs) { try { monWs.close(); } catch(_){} monWs = null; }
        btnMon.textContent = 'Avvia';
        btnMon.style.background = '#3b82f6';
        monBar.style.width = '0%';
        monInfo.textContent = 'RMS=-- Peak=-- dB=--';
        monBody.style.display = 'none';
      }

      btnMon.onclick = function() {
        if (monActive) stopMonitor();
        else startMonitor();
      };
    })();

    /* ---- Mic level (solo tab Parla: usa levelBar / levelLabel) ---- */
    (function(){
      var _pmWs = null;
      var _pmTimer = null;
      var _pmSource = null;

      function pmParlaActive() {
        var sec = document.getElementById('section-parla');
        return !!(sec && sec.classList.contains('active'));
      }

      function pmBars() {
        return {
          bar: document.getElementById('levelBar'),
          lbl: document.getElementById('levelLabel'),
        };
      }

      function pmUpdateFromBrowser() {
        var ui = pmBars();
        if (!ui.bar) return;
        var an = analyserNode || parlaPreviewAnalyser || wakeAnalyser || null;
        if (!an) {
          ui.bar.style.width = '0%';
          if (ui.lbl) ui.lbl.textContent = 'Livello: --';
          return;
        }
        var buf = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(buf);
        var peak = 0;
        for (var i = 0; i < buf.length; i++) if (buf[i] > peak) peak = buf[i];
        var gain = typeof getParlaMonitorGain === 'function' ? getParlaMonitorGain() : 1;
        var pct = Math.min(100, peak * gain * (100 / 255));
        ui.bar.style.width = pct.toFixed(1) + '%';
        ui.bar.style.background = peak > 128 ? '#ef4444' : peak > 50 ? '#22c55e' : peak > 13 ? '#eab308' : '#52525b';
        if (ui.lbl) ui.lbl.textContent = peak > 5 ? ('Livello: ' + (pct|0) + '%') : 'Livello: --';
      }

      function pmStartServerWs() {
        if (_pmWs && _pmWs.readyState <= 1) return;
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        _pmWs = new WebSocket(proto + '//' + location.host + '/ws/mic-level');
        _pmWs.onmessage = function(ev) {
          try {
            var d = JSON.parse(ev.data);
            if (d.type === 'level') {
              var ui = pmBars();
              var pct = Math.max(0, Math.min(100, ((d.db + 60) / 60) * 100));
              var gain = typeof getParlaMonitorGain === 'function' ? getParlaMonitorGain() : 1;
              var peak255 = Math.min(255, Math.round((Number(d.peak) || 0) * 255 * gain));
              if (typeof window.g1UpdateTalkMicLevel === 'function') {
                window.g1UpdateTalkMicLevel(peak255);
              }
              if (ui.bar) {
                ui.bar.style.width = pct.toFixed(1) + '%';
                ui.bar.style.background = d.peak > 0.5 ? '#ef4444' : d.rms > 0.02 ? '#22c55e' : d.rms > 0.005 ? '#eab308' : '#52525b';
              }
              if (ui.lbl) ui.lbl.textContent = d.rms > 0.01 ? ('Livello: ' + (pct|0) + '%') : 'Livello: --';
            }
          } catch(_){}
        };
        _pmWs.onclose = function() { _pmWs = null; _pmSource = null; };
        _pmWs.onerror = function() { try { _pmWs.close(); } catch(_){} _pmWs = null; _pmSource = null; };
      }

      function pmStopServerWs() {
        if (_pmWs) { try { _pmWs.close(); } catch(_){} _pmWs = null; }
        _pmSource = null;
      }

      _pmTimer = setInterval(function() {
        if (!pmParlaActive()) {
          if (_pmSource === 'server') pmStopServerWs();
          var ui = pmBars();
          if (ui.bar) ui.bar.style.width = '0%';
          if (ui.lbl) ui.lbl.textContent = 'Livello: --';
          return;
        }
        var micEl = document.getElementById('mic');
        var micVal = micEl ? micEl.value : '';
        var isLocal = micVal && micVal.indexOf('local_') === 0;

        if (isLocal) {
          if (_pmSource !== 'server') {
            _pmSource = 'server';
            pmStartServerWs();
          } else if (!_pmWs || _pmWs.readyState > 1) {
            pmStartServerWs();
          }
          return;
        }
        if (_pmSource === 'server') { pmStopServerWs(); }
        _pmSource = 'browser';
        pmUpdateFromBrowser();
      }, 60);
    })();
    (function(){
      var _camStreaming = false, _camPoll = null, _camSessionActive = false;
      function _camEl(id){ return document.getElementById(id); }
      function _camVisionActive(){
        var cb = _camEl('clientCamVisionEnable');
        return !!(cb && cb.checked);
      }
      function _camStreamUrl(){ return location.origin + '/api/camera/stream?_=' + Date.now(); }
      function _camResetIdleUI(){
        _camSetStatus(_camEl('clientCamStatus'), 'Visione disattivata', null);
        _camSetStatus(_camEl('clientCamYolo'), '--', null);
        var fps = _camEl('clientCamFps'); if (fps) fps.textContent = '--';
        var be = _camEl('clientCamBackend'); if (be) be.textContent = '--';
        var detEl = _camEl('clientCamDets');
        if (detEl) detEl.textContent = '—';
        var pickEl = _camEl('clientPickStatus');
        if (pickEl) pickEl.textContent = 'Auto-pick: — (attiva visione)';
      }
      function _camUpdateControls(enabled){
        ['clientCamBtnStart','clientCamBtnStop','clientCamBtnRefresh','clientPickOnBtn','clientPickOffBtn'].forEach(function(id){
          var el = _camEl(id);
          if (el) el.disabled = !enabled;
        });
      }
      function _camShow(on){
        var img = _camEl('clientCamStream'), ph = _camEl('clientCamPlaceholder');
        if (!img) return;
        if (on) {
          if (!_camVisionActive()) return;
          img.onerror = function(){
            _camSetStatus(_camEl('clientCamStatus'), 'Stream non disponibile (camera Jetson?)', false);
            if (ph) { ph.style.display = 'flex'; ph.textContent = 'Stream non disponibile — controlla RealSense / G1_CAMERA_DEVICE'; }
            img.style.display = 'none';
            _camStreaming = false;
          };
          img.onload = function(){ if (ph) ph.style.display = 'none'; };
          img.style.display = 'block';
          img.src = _camStreamUrl();
          if (ph) ph.style.display = 'none';
          _camStreaming = true;
        } else {
          img.onerror = null;
          img.onload = null;
          img.style.display = 'none';
          img.removeAttribute('src');
          if (ph) { ph.style.display = 'flex'; ph.textContent = 'Visione disattivata — spunta la casella sopra per collegare la camera'; }
          _camStreaming = false;
        }
      }
      function _camSetStatus(el, text, ok){
        if (!el) return;
        el.textContent = text;
        el.className = 'val' + (ok === true ? ' ok' : ok === false ? ' err' : '');
      }
      async function _camPollStatus(){
        if (!_camVisionActive() || !_camSessionActive) return;
        try {
          var r = await fetch(location.origin + '/api/camera/status', { credentials: 'same-origin' });
          var s = await r.json();
          _camSetStatus(_camEl('clientCamStatus'), s.open_error ? ('Errore: ' + String(s.open_error).slice(0, 48)) : (s.running && s.has_frame ? (s.backend || 'ok') + ' ' + (s.resolution || '') : (s.running ? 'Avvio…' : 'Ferma')), !s.open_error && s.has_frame);
          if (s.yolo_enabled) {
            _camSetStatus(_camEl('clientCamYolo'), s.yolo_loaded ? (s.yolo_model || 'ok') : (s.yolo_error ? String(s.yolo_error).slice(0, 32) : 'Caricamento…'), s.yolo_loaded);
          } else {
            _camSetStatus(_camEl('clientCamYolo'), 'Disabilitato', null);
          }
          _camEl('clientCamFps').textContent = s.fps ? String(s.fps) : '--';
          _camEl('clientCamBackend').textContent = s.backend || (s.source || '--');
          var dets = s.detections || [];
          var detEl = _camEl('clientCamDets');
          if (detEl) {
            detEl.textContent = dets.length ? dets.map(function(d){
              var t = d.class + ' ' + Math.round((d.confidence || 0) * 100) + '%';
              if (d.depth_m != null) t += ' · ' + d.depth_m + 'm';
              return t;
            }).join(' · ') : 'Nessun oggetto rilevato';
          }
          _camPollPick();
        } catch (e) {
          _camSetStatus(_camEl('clientCamStatus'), 'API non raggiungibile', false);
        }
      }
      function _camStartPoll(){
        if (_camPoll || !_camVisionActive() || !_camSessionActive) return;
        _camPollStatus();
        _camPoll = setInterval(_camPollStatus, 2000);
      }
      function _camStopPoll(){
        if (_camPoll) { clearInterval(_camPoll); _camPoll = null; }
      }
      function _camVisionCheckbox(on){
        var cb = _camEl('clientCamVisionEnable');
        if (cb) cb.checked = !!on;
      }
      async function _camTeardownSession(){
        var hadSession = _camSessionActive;
        _camSessionActive = false;
        _camStopPoll();
        _camShow(false);
        if (hadSession) {
          try { await fetch(location.origin + '/api/camera/stop', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
          try {
            await fetch(location.origin + '/api/pick/enable', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: false }),
            });
          } catch (_) {}
        }
        _camResetIdleUI();
      }
      async function _camOnVisionToggle(){
        if (_camVisionActive()) {
          _camUpdateControls(true);
          await window.g1ClientCameraStart();
        } else {
          _camUpdateControls(false);
          await _camTeardownSession();
        }
      }
      async function _camPollPick(){
        if (!_camVisionActive() || !_camSessionActive) return;
        try {
          var r = await fetch(location.origin + '/api/pick/status', { credentials: 'same-origin' });
          var p = await r.json();
          var el = _camEl('clientPickStatus');
          if (!el) return;
          el.textContent = 'Auto-pick: ' + (p.enabled ? 'ON' : 'OFF')
            + ' · ' + ((p.target_classes || []).join(', ') || '?')
            + ' · slot ' + (p.teaching_slot != null ? p.teaching_slot : '?')
            + ' · trigger ' + (p.trigger_count || 0);
        } catch (_) {}
      }
      window.g1ClientPickSet = async function(on){
        if (!_camVisionActive()) {
          if (!on) return;
          _camVisionCheckbox(true);
          _camUpdateControls(true);
          await window.g1ClientCameraStart();
        }
        if (!_camVisionActive() || !_camSessionActive) {
          var el0 = _camEl('clientPickStatus');
          if (el0) el0.textContent = 'Auto-pick: attiva prima la visione';
          return;
        }
        try {
          await fetch(location.origin + '/api/pick/enable', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!on }),
          });
          _camPollPick();
        } catch (e) {
          var el = _camEl('clientPickStatus');
          if (el) el.textContent = 'Auto-pick errore: ' + (e.message || e);
        }
      };
      window.g1ClientCameraStart = async function(){
        if (!_camVisionActive()) return;
        _camUpdateControls(true);
        try {
          var r = await fetch(location.origin + '/api/camera/start', { method: 'POST', credentials: 'same-origin' });
          var d = await r.json().catch(function(){ return {}; });
          if (!r.ok) {
            var msg = (d && (d.message || d.detail || d.open_error)) ? String(d.message || d.detail || d.open_error) : ('HTTP '+r.status);
            _camSetStatus(_camEl('clientCamStatus'), msg.slice(0, 80), false);
            return;
          }
          _camSessionActive = true;
          _camShow(true);
          _camStartPoll();
        } catch (e) {
          _camSetStatus(_camEl('clientCamStatus'), String(e.message || e), false);
        }
      };
      window.g1ClientCameraStop = async function(){
        _camVisionCheckbox(false);
        _camUpdateControls(false);
        await _camTeardownSession();
      };
      window.g1ClientCameraRefresh = function(){
        if (!_camVisionActive() || !_camSessionActive) return;
        if (_camStreaming) {
          var img = _camEl('clientCamStream');
          if (img) img.src = _camStreamUrl();
        }
        _camPollStatus();
      };
      window.g1ClientCameraOnShow = function(){
        if (_camVisionActive() && !_camSessionActive) {
          _camUpdateControls(true);
          window.g1ClientCameraStart();
        } else {
          _camUpdateControls(_camVisionActive());
          if (!_camVisionActive()) {
            _camShow(false);
            _camResetIdleUI();
          }
        }
      };
      window.g1ClientCameraOnHide = async function(){
        _camVisionCheckbox(false);
        _camUpdateControls(false);
        await _camTeardownSession();
      };
      _camUpdateControls(false);
      _camResetIdleUI();
      var _camBtnStart = _camEl('clientCamBtnStart');
      var _camBtnStop = _camEl('clientCamBtnStop');
      var _camBtnRefresh = _camEl('clientCamBtnRefresh');
      var _camVisionCb = _camEl('clientCamVisionEnable');
      if (_camVisionCb) _camVisionCb.onchange = function(){ _camOnVisionToggle(); };
      if (_camBtnStart) _camBtnStart.onclick = function(){ if (!_camVisionActive()) _camVisionCheckbox(true); window.g1ClientCameraStart(); };
      if (_camBtnStop) _camBtnStop.onclick = function(){ window.g1ClientCameraStop(); };
      if (_camBtnRefresh) _camBtnRefresh.onclick = function(){ window.g1ClientCameraRefresh(); };
    })();
    (function(){
      var _logTimer = null;
      function _logBox(){ return document.getElementById('clientLogBox'); }
      window.g1ClientLogRefresh = async function(){
        var box = _logBox();
        if (!box) return;
        try {
          var r = await fetch(location.origin + '/api/server-log?lines=120', { credentials: 'same-origin' });
          var d = await r.json();
          var text = (d.lines || []).join('\\n') || '(vuoto)';
          box.textContent = text;
          box.scrollTop = box.scrollHeight;
        } catch (e) {
          box.textContent = 'Errore log: ' + (e.message || e);
        }
      };
      window.g1ClientLogOnShow = function(){
        window.g1ClientLogRefresh();
        if (_logTimer) return;
        _logTimer = setInterval(function(){
          var auto = document.getElementById('clientLogAuto');
          if (!auto || auto.checked) window.g1ClientLogRefresh();
        }, 3000);
      };
      window.g1ClientLogOnHide = function(){
        if (_logTimer) { clearInterval(_logTimer); _logTimer = null; }
      };
    })();
    try { connect(); } catch (e) { console.error(e); }
  