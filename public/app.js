(function(){
  "use strict";
  var PALETTE = ["#2F6F5E","#B8863B","#5B7FB0","#A65E8C","#6B8E4E","#B4483F","#3F8FA0","#8C6B3F"];
  var POLL_MS = 4000;
  var FIREWORK_MS = 1700;

  var state = { factorHoldRate:false, sfPullDate:null, aes:[], log:[], effectiveWeights:{}, overallHoldRate:null, nextQueue:[] };
  var booking = false;
  var reelAnimating = false;
  var adminPassword = sessionStorage.getItem("rr_admin_password") || null;
  var pollTimer = null;

  function colorFor(idx){ return PALETTE[idx % PALETTE.length]; }
  function activeAes(){ return state.aes.filter(function(a){ return a.active; }); }
  function findAe(id){ return state.aes.find(function(a){ return a.id===id; }); }
  function findLogEntry(id){ return state.log.find(function(e){ return e.id===id; }); }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c];
    });
  }

  // ---------- API ----------
  function api(path, opts){
    opts = opts || {};
    var headers = Object.assign({ "content-type": "application/json" }, opts.headers || {});
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function(res){
      return res.json().then(function(data){
        if(!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: res.status, data: data });
        return data;
      });
    });
  }
  function adminApi(path, opts){
    opts = opts || {};
    opts.headers = Object.assign({ "x-admin-password": adminPassword || "" }, opts.headers || {});
    return api(path, opts).catch(function(err){
      if(err.status === 401){
        adminPassword = null;
        sessionStorage.removeItem("rr_admin_password");
        document.getElementById("adminBtn").classList.remove("unlocked");
        openGate("Your admin session expired or the password changed — log in again.");
        return; // swallow so the caller's .then(fetchState) just re-syncs the real (unchanged) state
      }
      console.error(err);
      throw err;
    });
  }

  function fetchState(){
    return api("/api/state").then(function(data){
      state = data;
      render();
    }).catch(function(err){
      document.getElementById("quickStat").textContent = "Couldn't reach the server — retrying…";
      console.error(err);
    });
  }

  // ---------- Reel (next-up queue) ----------
  var ROW_STEP = 80; // 70px row + 10px gap — must match .reel-row/.reel-track CSS

  function colorIndexForAe(id){
    var idx = activeAes().findIndex(function(a){ return a.id===id; });
    return idx===-1 ? 0 : idx;
  }

  function renderReel(){
    if(reelAnimating) return;
    var track = document.getElementById("reelTrack");
    var empty = document.getElementById("reelEmpty");
    var fullName = document.getElementById("reelFullName");
    var queue = state.nextQueue || [];
    track.style.transform = "translateY(0)";
    if(queue.length===0){
      track.innerHTML = "";
      empty.style.display = "block";
      fullName.textContent = "";
      return;
    }
    empty.style.display = "none";
    fullName.textContent = queue[0].name;
    track.innerHTML = queue.slice(0,2).map(function(item, i){
      var cls = "reel-row q"+i;
      var color = colorFor(colorIndexForAe(item.id));
      return '<div class="'+cls+'" style="background:'+color+'">'+escapeHtml(item.name.split(" ")[0])+'</div>';
    }).join("");
  }

  // Big multi-burst confetti/fireworks show, full viewport — deliberately not
  // confined to the reel box so it actually reads as a celebration.
  function launchFireworks(originX, originY){
    if(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var canvas = document.getElementById("fireworksCanvas");
    var dpr = window.devicePixelRatio || 1;
    var w = window.innerWidth, h = window.innerHeight;
    canvas.width = w*dpr; canvas.height = h*dpr;
    canvas.style.width = w+"px"; canvas.style.height = h+"px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var bursts = [
      { x: originX, y: originY, delay: 0 },
      { x: originX - w*0.22, y: originY - h*0.08, delay: 140 },
      { x: originX + w*0.22, y: originY - h*0.05, delay: 260 },
      { x: originX - w*0.1, y: originY - h*0.16, delay: 420 }
    ];
    var particles = [];
    function spawnBurst(bx, by){
      var count = 140;
      for(var i=0;i<count;i++){
        var angle = (Math.PI*2*i/count) + (Math.random()*0.5 - 0.25);
        var speed = 4 + Math.random()*7;
        particles.push({
          x:bx, y:by,
          vx: Math.cos(angle)*speed,
          vy: Math.sin(angle)*speed - 1.6,
          size: 3 + Math.random()*3.5,
          color: PALETTE[Math.floor(Math.random()*PALETTE.length)],
          born: null
        });
      }
    }

    var totalMs = FIREWORK_MS;
    var start = null;
    var spawned = bursts.map(function(){ return false; });
    function frame(ts){
      if(start===null) start = ts;
      var elapsed = ts - start;
      bursts.forEach(function(b, i){
        if(!spawned[i] && elapsed >= b.delay){ spawned[i] = true; spawnBurst(b.x, b.y); }
      });
      ctx.clearRect(0,0,w,h);
      particles.forEach(function(p){
        if(p.born===null) p.born = elapsed;
        var age = elapsed - p.born;
        var life = Math.max(0, 1 - age/(totalMs*0.75));
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.14;
        p.vx *= 0.992;
        ctx.globalAlpha = life;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 8;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
        ctx.fill();
      });
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      if(elapsed < totalMs) requestAnimationFrame(frame);
      else ctx.clearRect(0,0,w,h);
    }
    requestAnimationFrame(frame);
  }

  // Spins the reel through a few loops of the roster, landing precisely on
  // `winner` (already the real, server-confirmed pick), then bursts fireworks
  // at the moment it lands. Purely a celebratory reveal — the outcome is
  // already decided, this is just how it's shown.
  // Fireworks celebrate the booking that just happened first, then the reel
  // makes one simple step up to reveal who's next — no roulette-style spin.
  function playReelSpin(winner, done){
    var track = document.getElementById("reelTrack");
    var wrap = document.getElementById("reelWrap");
    var wrapRect = wrap.getBoundingClientRect();
    var landingX = wrapRect.left + wrapRect.width/2;
    var landingY = wrapRect.top + 35; // current row is 70px tall, centered ~35px from window top

    launchFireworks(landingX, landingY);

    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var firstRow = track.children[0];
    if(!firstRow || reduceMotion){
      setTimeout(done, reduceMotion ? 0 : 500);
      return;
    }

    reelAnimating = true;
    var shiftMs = 550;
    var celebrateDelayMs = 450; // let the fireworks land on the just-booked name before advancing

    setTimeout(function(){
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){
          track.style.transition = "transform "+shiftMs+"ms cubic-bezier(0.22, 0.61, 0.36, 1)";
          track.style.transform = "translateY(-"+ROW_STEP+"px)";
        });
      });
    }, celebrateDelayMs);

    var finished = false;
    function onDone(){
      if(finished) return;
      finished = true;
      track.removeEventListener("transitionend", onDone);
      track.style.transition = "none";
      track.style.transform = "translateY(0px)";
      reelAnimating = false;
      requestAnimationFrame(function(){ track.style.transition = ""; });
      done();
    }
    track.addEventListener("transitionend", onDone);
    setTimeout(onDone, celebrateDelayMs + shiftMs + 150);
  }

  // ---------- Book meeting ----------
  function updateSpinReady(){
    var name = (document.getElementById("bdrNameInput").value || "").trim();
    var queue = state.nextQueue || [];
    document.getElementById("spinBtn").disabled = booking || queue.length===0 || name.length===0;
  }

  function doSpin(){
    if(booking) return;
    if((state.nextQueue||[]).length===0){
      document.getElementById("resultSlot").innerHTML = '<div class="result-placeholder">Activate at least one AE in Admin first.</div>';
      return;
    }
    var bdrName = (document.getElementById("bdrNameInput").value || "").trim();
    if(!bdrName){
      document.getElementById("bdrHint").textContent = "Enter your name before booking.";
      document.getElementById("bdrNameInput").focus();
      return;
    }
    document.getElementById("bdrHint").textContent = "";
    booking = true;
    document.getElementById("spinBtn").disabled = true;
    document.getElementById("resultSlot").innerHTML = '<div class="result-placeholder">Booking…</div>';

    localStorage.setItem("rr_bdr_name", bdrName);

    api("/api/spin", { method:"POST", body:{ bdrName: bdrName } }).then(function(res){
      playReelSpin(res.winner, function(){
        fetchState().then(function(){ showResult(res.winner, bdrName, res.entry); });
      });
    }).catch(function(err){
      booking = false;
      document.getElementById("spinBtn").disabled = false;
      document.getElementById("resultSlot").innerHTML = '<div class="result-placeholder">'+escapeHtml(err.message)+'</div>';
    });
  }

  function showResult(winner, bdrName, entry){
    document.getElementById("resultSlot").innerHTML =
      '<div class="result-meta">Booked '+escapeHtml(winner.name)+' via round robin · assigned just now by '+escapeHtml(bdrName)+'</div>' +
      '<div class="result-account-quickadd"><input type="text" id="quickAccountInput" placeholder="Account name (optional)" /></div>';
    var quickInput = document.getElementById("quickAccountInput");
    quickInput.addEventListener("change", function(){
      api("/api/log/account", { method:"POST", body:{ id: entry.id, accountName: quickInput.value.trim() } })
        .then(fetchState);
    });
    quickInput.focus();
    booking = false;
    updateSpinReady();
  }

  // ---------- Log rendering ----------
  function statusPillsHtml(entry){
    var out = "";
    if(!entry.held && !entry.lost) out += '<span class="pill pill-booked">Booked</span>';
    if(entry.held) out += '<span class="pill pill-held">Held</span>';
    if(entry.lost) out += '<span class="pill pill-lost">Lost</span>';
    if(entry.flagged) out += '<span class="pill pill-flagged">Flagged</span>';
    return out;
  }

  function logRowHtml(entry, opts){
    opts = opts || {};
    var oppNote = entry.oppName
      ? '<div class="opp-link-note">↳ '+escapeHtml(entry.oppName)+(entry.oppStage ? ' · '+escapeHtml(entry.oppStage) : '')+'</div>'
      : "";
    var actions =
      '<button class="flag-btn'+(entry.flagged?' active':'')+'" data-action="flag-log" data-id="'+entry.id+'" title="'+(entry.flagged?'Unflag':'Flag as a false click')+'">🚩</button>';
    if(opts.showDelete){
      actions += ' <button class="remove-btn" data-action="delete-log" data-id="'+entry.id+'" title="'+(opts.clearLabel||'Delete assignment')+'">'+(opts.clearLabel?opts.clearLabel:'✕')+'</button>';
    }
    var ts = new Date(entry.ts).toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
    return (
      '<td class="hold-rate">'+escapeHtml(ts)+'</td>' +
      '<td>'+escapeHtml(entry.bdrName || "—")+'</td>' +
      '<td class="log-name" style="font-weight:600;">'+escapeHtml(entry.name)+'</td>' +
      '<td><input type="text" class="num-input account-input" placeholder="Account name" value="'+escapeHtml(entry.accountName || "")+'" data-action="account-name" data-id="'+entry.id+'"/>'+oppNote+'</td>' +
      '<td>'+statusPillsHtml(entry)+'</td>' +
      '<td style="white-space:nowrap;">'+actions+'</td>'
    );
  }

  function attachLogRowHandlers(container){
    container.querySelectorAll('[data-action="account-name"]').forEach(function(el){
      el.addEventListener("change", function(){
        api("/api/log/account", { method:"POST", body:{ id: el.getAttribute("data-id"), accountName: el.value.trim() } })
          .then(fetchState);
      });
    });
    container.querySelectorAll('[data-action="flag-log"]').forEach(function(el){
      el.addEventListener("click", function(){
        api("/api/log/flag", { method:"POST", body:{ id: el.getAttribute("data-id") } }).then(fetchState);
      });
    });
    container.querySelectorAll('[data-action="delete-log"]').forEach(function(el){
      el.addEventListener("click", function(){
        adminApi("/api/log/delete", { method:"POST", body:{ id: el.getAttribute("data-id") } }).then(fetchState);
      });
    });
  }

  // Only guards actual typed-text fields from being yanked mid-edit by a poll.
  // Checkboxes/ranges are one-shot actions, not typing — they must not block
  // re-render, or the whole table freezes right after any toggle click.
  function isEditing(container){
    var active = document.activeElement;
    if(!active || !container.contains(active) || active.tagName !== "INPUT") return false;
    return active.type !== "checkbox" && active.type !== "range";
  }

  function renderLog(){
    var container = document.getElementById("logRows");
    if(isEditing(container)) return; // don't yank focus out from under a typing BDR
    var empty = document.getElementById("emptyLog");
    container.innerHTML = "";
    if(state.log.length===0){ empty.style.display="block"; return; }
    empty.style.display="none";
    state.log.slice(0,20).forEach(function(entry){
      var tr = document.createElement("tr");
      tr.innerHTML = logRowHtml(entry, {showDelete:false});
      container.appendChild(tr);
    });
    attachLogRowHandlers(container);
  }

  function renderAdminLog(){
    var container = document.getElementById("adminLogBody");
    if(!container || isEditing(container)) return;
    var empty = document.getElementById("adminEmptyLog");
    container.innerHTML = "";
    if(state.log.length===0){ empty.style.display = "block"; return; }
    empty.style.display = "none";
    state.log.forEach(function(entry){
      var tr = document.createElement("tr");
      tr.innerHTML = logRowHtml(entry, {showDelete:true});
      container.appendChild(tr);
    });
    attachLogRowHandlers(container);
  }

  function renderFlaggedReview(){
    var container = document.getElementById("flaggedLogBody");
    if(!container || isEditing(container)) return;
    var empty = document.getElementById("flaggedEmptyLog");
    var flagged = state.log.filter(function(e){ return e.flagged; });
    container.innerHTML = "";
    if(flagged.length===0){ empty.style.display = "block"; return; }
    empty.style.display = "none";
    flagged.forEach(function(entry){
      var tr = document.createElement("tr");
      tr.innerHTML = logRowHtml(entry, {showDelete:true, clearLabel:"Clear"});
      container.appendChild(tr);
    });
    attachLogRowHandlers(container);
  }

  function renderBdrSuggestions(){
    var dl = document.getElementById("bdrSuggestions");
    var names = Array.from(new Set(state.log.map(function(e){ return e.bdrName; }).filter(Boolean)));
    dl.innerHTML = names.map(function(n){ return '<option value="'+escapeHtml(n)+'"></option>'; }).join("");
  }

  // ---------- Stat strip ----------
  function renderStats(){
    var strip = document.getElementById("statStrip");
    var list = activeAes();
    strip.innerHTML = "";
    list.forEach(function(a,i){
      var rate = a.bookedRR>0 ? Math.round((a.heldRR/a.bookedRR)*100) : null;
      var tile = document.createElement("div");
      tile.className = "stat-tile";
      tile.innerHTML =
        '<span class="stat-label" style="color:'+colorFor(i)+'">'+escapeHtml(a.name)+'</span>' +
        '<div class="stat-value small">'+a.bookedRR+' booked · '+a.heldRR+' held</div>' +
        '<div style="font-size:12px; color:var(--ink-soft); margin-top:2px;">'+(rate===null?'—':rate+'%')+' hold rate via RR · '+a.totalHeld30d+' held all sources (30d)</div>';
      strip.appendChild(tile);
    });
    var quick = document.getElementById("quickStat");
    quick.textContent = list.length===0 ? "No active AEs configured" : list.length+" AE"+(list.length>1?"s":"")+" active · "+state.log.length+" assigned total · live";
  }

  // ---------- Admin table ----------
  function renderAdmin(){
    var body = document.getElementById("aeTableBody");
    if(!body || isEditing(body)) return;
    body.innerHTML = "";
    var actList = activeAes();
    var overall = state.overallHoldRate;

    var weightSumActive = actList.reduce(function(s,a){ return s + Math.max(0,a.weight); }, 0);
    var warn = document.getElementById("weightWarning");
    if(actList.length>0 && Math.abs(weightSumActive-100) > 0.5){
      warn.style.display = "block";
      warn.textContent = "Active target weights sum to "+Math.round(weightSumActive)+"%, not 100% — the wheel will still normalize proportionally, but consider rebalancing.";
    } else {
      warn.style.display = "none";
    }

    state.aes.forEach(function(a, idx){
      var tr = document.createElement("tr");
      if(!a.active) tr.className = "inactive";
      var rate = a.bookedRR>0 ? (a.heldRR/a.bookedRR) : null;
      var rateClass = "mid";
      if(rate!==null && overall!==null && overall>0){
        if(rate >= overall*1.1) rateClass = "high";
        else if(rate <= overall*0.9) rateClass = "low";
      }
      var effVal = a.active ? state.effectiveWeights[a.id] : null;

      tr.innerHTML =
        '<td><div class="switch"><input type="checkbox" '+(a.active?'checked':'')+' data-action="toggle-active" data-id="'+a.id+'"/><span class="slider-track"></span></div></td>' +
        '<td><div class="ae-name-cell"><span class="swatch" style="background:'+colorFor(idx)+'"></span>'+escapeHtml(a.name)+'</div></td>' +
        '<td><div class="weight-cell">' +
          '<input type="range" min="0" max="100" value="'+a.weight+'" data-action="weight" data-id="'+a.id+'"/>' +
          '<input type="number" min="0" max="100" class="num-input weight-num-input" value="'+a.weight+'" data-action="weight-num" data-id="'+a.id+'"/>' +
          '<span class="weight-val">%</span>' +
        '</div></td>' +
        '<td><input type="number" min="0" class="num-input" value="'+a.bookedRR+'" data-action="bookedRR" data-id="'+a.id+'"/></td>' +
        '<td><input type="number" min="0" class="num-input" value="'+a.heldRR+'" data-action="heldRR" data-id="'+a.id+'"/></td>' +
        '<td class="hold-rate '+rateClass+'">'+(rate===null?'—':Math.round(rate*100)+'%')+'</td>' +
        '<td><input type="number" min="0" class="num-input" value="'+a.totalHeld30d+'" data-action="totalHeld30d" data-id="'+a.id+'"/></td>' +
        '<td class="eff-weight">'+(effVal==null?'—':effVal.toFixed(1)+'%')+'</td>' +
        '<td><button class="remove-btn" data-action="remove" data-id="'+a.id+'" title="Remove AE">✕</button></td>';
      body.appendChild(tr);
    });

    body.querySelectorAll('[data-action="toggle-active"]').forEach(function(el){
      el.addEventListener("change", function(){
        adminApi("/api/admin/ae", { method:"POST", body:{ action:"update", id: el.getAttribute("data-id"), patch:{ active: el.checked } } }).then(fetchState);
      });
    });
    function saveWeight(id, value){
      var v = Math.max(0, Math.min(100, parseInt(value,10) || 0));
      adminApi("/api/admin/ae", { method:"POST", body:{ action:"update", id: id, patch:{ weight: v } } }).then(fetchState);
    }
    body.querySelectorAll('[data-action="weight"]').forEach(function(el){
      var id = el.getAttribute("data-id");
      el.addEventListener("input", function(){
        var numEl = body.querySelector('[data-action="weight-num"][data-id="'+id+'"]');
        if(numEl) numEl.value = el.value;
      });
      el.addEventListener("change", function(){ saveWeight(id, el.value); });
    });
    body.querySelectorAll('[data-action="weight-num"]').forEach(function(el){
      var id = el.getAttribute("data-id");
      el.addEventListener("input", function(){
        var rangeEl = body.querySelector('[data-action="weight"][data-id="'+id+'"]');
        if(rangeEl) rangeEl.value = el.value;
      });
      el.addEventListener("change", function(){ saveWeight(id, el.value); });
    });
    ["bookedRR","heldRR","totalHeld30d"].forEach(function(field){
      body.querySelectorAll('[data-action="'+field+'"]').forEach(function(el){
        el.addEventListener("change", function(){
          var patch = {}; patch[field] = Math.max(0, parseInt(el.value,10) || 0);
          adminApi("/api/admin/ae", { method:"POST", body:{ action:"update", id: el.getAttribute("data-id"), patch: patch } }).then(fetchState);
        });
      });
    });
    body.querySelectorAll('[data-action="remove"]').forEach(function(el){
      el.addEventListener("click", function(){
        adminApi("/api/admin/ae", { method:"POST", body:{ action:"remove", id: el.getAttribute("data-id") } }).then(fetchState);
      });
    });

    document.getElementById("factorHoldToggle").checked = !!state.factorHoldRate;
    var pullLabel = document.getElementById("sfPullDateLabel");
    if(pullLabel) pullLabel.textContent = state.sfPullDate ? new Date(state.sfPullDate).toLocaleString() : "never yet";
  }

  function render(){
    renderReel();
    renderLog();
    renderStats();
    renderAdmin();
    renderAdminLog();
    renderFlaggedReview();
    renderBdrSuggestions();
    updateSpinReady();
  }

  // ---------- View switching ----------
  function setView(name){
    document.querySelectorAll(".tab").forEach(function(t){ t.classList.remove("active"); });
    document.querySelectorAll(".view").forEach(function(v){ v.classList.remove("active"); });
    if(name === "spin"){
      var spinTab = document.querySelector('.tab[data-view="spin"]');
      if(spinTab) spinTab.classList.add("active");
    }
    document.getElementById("view-"+name).classList.add("active");
  }
  document.querySelectorAll(".tab").forEach(function(tab){
    tab.addEventListener("click", function(){ setView(tab.getAttribute("data-view")); });
  });

  // ---------- Admin password gate ----------
  var gateOverlay = document.getElementById("gateOverlay");
  var gatePassword = document.getElementById("gatePassword");
  var gateError = document.getElementById("gateError");

  function openGate(message){
    gateError.textContent = message || "Incorrect password.";
    gateError.classList.toggle("show", !!message);
    gatePassword.value = "";
    gateOverlay.classList.add("open");
    setTimeout(function(){ gatePassword.focus(); }, 0);
  }
  function closeGate(){ gateOverlay.classList.remove("open"); }

  document.getElementById("adminBtn").addEventListener("click", function(){
    if(adminPassword){ setView("admin"); return; }
    openGate();
  });
  document.getElementById("gateCancel").addEventListener("click", closeGate);
  document.getElementById("gateSubmit").addEventListener("click", submitGate);
  gatePassword.addEventListener("keydown", function(e){ if(e.key==="Enter") submitGate(); });
  gateOverlay.addEventListener("click", function(e){ if(e.target===gateOverlay) closeGate(); });

  function submitGate(){
    var candidate = gatePassword.value;
    api("/api/admin/login", { method:"POST", body:{ password: candidate } }).then(function(){
      adminPassword = candidate;
      sessionStorage.setItem("rr_admin_password", candidate);
      document.getElementById("adminBtn").classList.add("unlocked");
      closeGate();
      setView("admin");
      fetchState();
    }).catch(function(){
      gateError.textContent = "Incorrect password.";
      gateError.classList.add("show");
    });
  }

  // ---------- BDR identity (per-device convenience only, not shared state) ----------
  var bdrInput = document.getElementById("bdrNameInput");
  bdrInput.value = localStorage.getItem("rr_bdr_name") || "";
  bdrInput.addEventListener("input", function(){
    document.getElementById("bdrHint").textContent = "";
    updateSpinReady();
  });

  document.getElementById("spinBtn").addEventListener("click", doSpin);

  document.getElementById("addAeBtn").addEventListener("click", function(){
    var input = document.getElementById("newAeName");
    var name = input.value.trim();
    if(!name) return;
    adminApi("/api/admin/ae", { method:"POST", body:{ action:"add", name: name } }).then(function(){
      input.value = "";
      fetchState();
    });
  });
  document.getElementById("newAeName").addEventListener("keydown", function(e){
    if(e.key==="Enter") document.getElementById("addAeBtn").click();
  });

  document.getElementById("factorHoldToggle").addEventListener("change", function(e){
    adminApi("/api/admin/factor-hold", { method:"POST", body:{ value: e.target.checked } }).then(fetchState);
  });

  if(adminPassword) document.getElementById("adminBtn").classList.add("unlocked");

  fetchState();
  pollTimer = setInterval(fetchState, POLL_MS);
})();
