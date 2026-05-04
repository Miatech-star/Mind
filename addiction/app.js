// addiction/app.js
//
// Client logic for /addiction/. Single-file IIFE, no modules, no deps.
// State is in-memory only — nothing is persisted (no localStorage, no
// cookies). Refresh wipes the session by design.

(function () {
  'use strict';

  // =====================================================================
  // Config
  // =====================================================================
  const SCREENS = [
    'welcome',     // 0
    'name',        // 1
    'substance',   // 2
    'when',        // 3
    'cost',        // 4
    'savings',     // 5
    'consent',     // 6
    'intro',       // 7
    'assessment',  // 8
    'building',    // 9
    'dashboard',   // 10  (unified result: risk + pattern + triggers + projection + insights + plan)
    'trial',       // 11
    'crisis',      // 12  — branched from substance pick (selfharm) or safety redirect
  ];

  // The loading micro-text rotated per question while next-question is in flight.
  // All phrases describe what Mia is actually doing (analyzing prior answers
  // + generating the next question) — no "listening" since nothing the user
  // says is being heard at this moment.
  const LOADING_MESSAGES = [
    'Reading the pattern…',
    'Finding the next signal…',
    'Building the next question…',
    'Following the thread…',
    'Looking deeper…',
  ];

  const SIGNAL_LABELS = {
    loss_of_control: 'Loss of control',
    cravings: 'Cravings',
    emotional_triggers: 'Emotional triggers',
    social_impact: 'Social impact',
    financial_impact: 'Financial impact',
    relapse_risk: 'Relapse risk',
    avoidance_patterns: 'Avoidance patterns',
    motivation_to_change: 'Motivation to change',
  };

  // Topbar progress: only data-collection screens show the bar.
  const PROGRESS_PIPS = ['name', 'substance', 'when', 'cost', 'savings', 'consent', 'intro', 'assessment'];

  const SUBSTANCES = [
    { id: 'alcohol',     label: 'Alcohol',         icon: '🥃' },
    { id: 'nicotine',    label: 'Nicotine',        icon: '🚬' },
    { id: 'cannabis',    label: 'Cannabis',        icon: '🌿' },
    { id: 'gambling',    label: 'Gambling',        icon: '🎰' },
    { id: 'cocaine',     label: 'Cocaine',         icon: '❄️' },
    { id: 'opioids',     label: 'Opioids',         icon: '💊' },
    { id: 'meth',        label: 'Meth',            icon: '💎' },
    { id: 'mdma',        label: 'MDMA',            icon: '🌈' },
    { id: 'selfharm',    label: 'Self-harm',       icon: '🩹' },
    { id: 'sex',         label: 'Sex',             icon: '💋' },
    { id: 'pornography', label: 'Pornography',     icon: '🔞' },
    { id: 'other',       label: 'Something else',  icon: '✨' },
  ];

  const SCALE = [
    { value: 0, label: 'Never' },
    { value: 1, label: 'Once or twice' },
    { value: 2, label: 'Sometimes' },
    { value: 3, label: 'Frequently' },
    { value: 4, label: 'Very frequently' },
  ];

  // Used when the API fails. Keeps the user moving on warm fallback copy.
  const FALLBACK_QUESTIONS = [
    'Have you ended up engaging with this more than you meant to?',
    'Have you wanted to cut back, but found it hard to follow through?',
    'Do you spend a lot of time on this, thinking about it, or recovering from it?',
    'Do you sometimes feel a strong urge or craving for it?',
    'Has it gotten in the way of work, school, or things at home?',
    'Has it caused tension or distance with people who matter to you?',
    'Have you stepped back from things you used to enjoy because of it?',
    'Have you been in risky situations because of it?',
    'Have you kept going even when it was making things worse?',
    'Do you find you need more of it now to feel the same effect as before?',
    'Have you felt off when you haven’t engaged with it for a while?',
  ];

  const MAX_QUESTIONS = 12;
  const MIN_BEFORE_DONE = 5;

  // =====================================================================
  // State
  // =====================================================================
  const STATE = {
    session_id: makeSessionId(),
    name: '',
    substance: null,         // {id, label, icon}
    started_at: null,        // ISO string
    havent_started: false,
    weekly_cost: 0,
    consent: false,
    history: [],             // [{id, text, answer_value, answer_label}]
    current_question: null,  // {id, text, options}
    result: null,            // {snapshot, dashboard, plan}
    fallback_used: false,
  };
  let currentIndex = 0;

  // =====================================================================
  // Utils
  // =====================================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmt = (n) => new Intl.NumberFormat('en-US').format(Math.round(n));

  function makeSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    let s = '';
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // =====================================================================
  // Navigation
  // =====================================================================
  const screensEl = () => $('#screens');
  const progressEl = () => $('#progress');
  const backBtn = () => $('#backBtn');

  // Map each screen to a bg-state. The radial moves smoothly between
  // these via CSS transitions on body[data-bg-state].
  //   welcome  → radial bottom, full
  //   top      → radial top, full
  //   top-dim  → radial top, dim (substance list is long & scrollable)
  //   hidden   → radial faded out (results + crisis)
  const BG_STATE = {
    welcome:    'welcome',
    name:       'top',
    substance:  'top',     // full strength — same as other questionnaire screens
    crisis:     'hidden',
    when:       'top',
    // From cost-analysis onward the radial parks slightly higher so the
    // amount + savings text sit on the lighter part of the frame.
    cost:       'top-high',
    savings:    'top-high',
    consent:    'top-high',
    intro:      'top-high',
    assessment: 'top-high',
    // The building screen centers the radial and then animates it
    // outward + fading via JS as the loading bar progresses to 100%.
    building:   'building',
    snapshot:   'hidden',
    dashboard:  'hidden',
    plan:       'hidden',
    trial:      'hidden',
  };
  function setBgState(screen) {
    const state = BG_STATE[screen] || 'top';
    document.body.setAttribute('data-bg-state', state);
    // When we leave the building screen, drop the burst class and
    // reset the scale knob so future screens render the radial cleanly.
    if (state !== 'building') {
      document.body.classList.remove('hero-bursting');
      document.documentElement.style.setProperty('--hero-scale', '1');
    }
  }

  function indexOf(name) {
    return SCREENS.indexOf(name);
  }

  function goTo(name, opts) {
    opts = opts || {};
    const idx = indexOf(name);
    if (idx < 0) return;
    const prev = $$('.screen', screensEl()).find((s) => s.classList.contains('active'));
    const nextEl = $('.screen[data-screen="' + name + '"]', screensEl());
    if (!nextEl) return;
    if (prev) prev.classList.remove('active');
    nextEl.classList.remove('active');
    void nextEl.offsetWidth;
    nextEl.classList.add('active');
    currentIndex = idx;
    setBgState(name);
    updateChrome();
    const body = $('.screen-body', nextEl);
    if (body) body.scrollTop = 0;
    onEnter(name);
    if (opts.focusInput) {
      if (name === 'name') setTimeout(() => $('#nameInput').focus(), 280);
    }
  }

  function next() {
    const cur = SCREENS[currentIndex];
    const order = ['welcome', 'name', 'substance', 'when', 'cost', 'savings', 'consent', 'intro', 'assessment'];
    const i = order.indexOf(cur);
    if (i >= 0 && i < order.length - 1) goTo(order[i + 1]);
  }

  function back() {
    const cur = SCREENS[currentIndex];
    if (cur === 'crisis') {
      goTo('substance');
      return;
    }
    if (cur === 'assessment' && STATE.history.length > 0) {
      const popped = STATE.history.pop();
      STATE.current_question = {
        id: popped.id,
        text: popped.text,
        options: SCALE,
        prev_value: popped.answer_value,
        signal_being_checked: popped.signal_being_checked || null,
      };
      // Skip loading state — we already have the question content.
      revealQuestion({ skipLoading: true });
      updateChrome();
      return;
    }
    const order = ['welcome', 'name', 'substance', 'when', 'cost', 'savings', 'consent', 'intro', 'assessment'];
    const i = order.indexOf(cur);
    if (i > 0) goTo(order[i - 1]);
  }

  function updateChrome() {
    const screen = SCREENS[currentIndex];
    const noBackOn = ['welcome', 'building', 'dashboard', 'trial'];
    backBtn().hidden = noBackOn.indexOf(screen) >= 0;

    const showBar = PROGRESS_PIPS.indexOf(screen) >= 0;
    progressEl().style.visibility = showBar ? 'visible' : 'hidden';
    if (!showBar) return;

    const idx = PROGRESS_PIPS.indexOf(screen);
    $$('.pip', progressEl()).forEach((pip, i) => {
      pip.style.removeProperty('--fill');
      pip.classList.remove('done', 'active');
      if (screen === 'assessment' && i === idx) {
        pip.classList.add('active');
        const denom = Math.max(MAX_QUESTIONS, STATE.history.length + 1);
        const frac = Math.min(1, STATE.history.length / denom);
        pip.style.setProperty('--fill', String(Math.max(0.05, frac)));
      } else if (i < idx) {
        pip.classList.add('done');
      } else if (i === idx) {
        pip.classList.add('active');
        pip.style.setProperty('--fill', '1');
      }
    });
  }

  function buildProgress() {
    const el = progressEl();
    clearChildren(el);
    for (let i = 0; i < PROGRESS_PIPS.length; i++) {
      const p = document.createElement('div');
      p.className = 'pip';
      el.appendChild(p);
    }
  }

  // Map screen-enter side effects.
  function onEnter(screen) {
    if (screen === 'substance') updateSubstanceTitle();
    if (screen === 'savings') updateSavings();
    if (screen === 'intro') updateIntroTitle();
    if (screen === 'consent') updateConsentTitle();
    if (screen === 'assessment') startAssessment();
    if (screen === 'building') startBuilding();
    if (screen === 'dashboard') renderDashboard();
    if (screen === 'trial') { updateTrialTitle(); startCounter(); }
    else stopCounter();
    if (screen === 'crisis') updateCrisisTitle();
  }

  // =====================================================================
  // Welcome → Name (+ substance carousel)
  // =====================================================================
  function bindWelcome() {
    $('#welcomeNext').addEventListener('click', () => goTo('name', { focusInput: true }));
    initSubstanceCarousel();
  }

  // Infinite vertical carousel — top→bottom flow.
  //
  // Smoothness comes from keeping the DOM stable: we render the pool
  // multiple times so we always have items above and below the visible
  // window, and we just animate the track translateY + swap which item
  // owns the `.is-mid` class each tick. CSS transitions handle the
  // crossfade of color, font-size, opacity, and the emoji grow-in.
  //
  // When the cursor approaches an end of the rendered stack, we jump
  // back to an equivalent position in another cycle — same item, no
  // visible change — so the loop is genuinely infinite.
  const CAROUSEL_TICK_MS = 1900;
  const CAROUSEL_TRANSITION_MS = 800;
  const CAROUSEL_ITEM_HEIGHT = 36;     // matches CSS
  const CAROUSEL_GAP = 20;              // matches CSS
  const CAROUSEL_CONTAINER_H = 188;    // matches CSS
  const CAROUSEL_CYCLES = 3;           // pool repeated this many times in DOM

  function initSubstanceCarousel() {
    const trackEl = $('#welcomeCarousel');
    if (!trackEl) return;
    // 'selfharm' is never decorative; 'other' is the catch-all picker
    // option and isn't a meaningful preview either.
    const pool = SUBSTANCES.filter((s) => s.id !== 'selfharm' && s.id !== 'other');
    if (!pool.length) return;

    const STEP = CAROUSEL_ITEM_HEIGHT + CAROUSEL_GAP;

    // Render the pool CAROUSEL_CYCLES times in a single track. We never
    // mutate this DOM — only translate it and toggle .is-mid.
    clearChildren(trackEl);
    const itemEls = [];
    for (let c = 0; c < CAROUSEL_CYCLES; c++) {
      pool.forEach((s) => {
        const el = document.createElement('div');
        el.className = 'welcome-carousel-item';
        el.innerHTML =
          '<span class="icon" aria-hidden="true">' + s.icon + '</span>' +
          '<span class="label"></span>';
        $('.label', el).textContent = s.label;
        trackEl.appendChild(el);
        itemEls.push(el);
      });
    }

    // Position the track so item at midIndex sits in the visual center.
    function transformFor(index) {
      const y = (CAROUSEL_CONTAINER_H / 2) - (CAROUSEL_ITEM_HEIGHT / 2) - (index * STEP);
      return 'translateY(' + y + 'px)';
    }
    function applyMid(index) {
      itemEls.forEach((el, i) => el.classList.toggle('is-mid', i === index));
    }

    // Start somewhere in the middle cycle, randomized for variety.
    let midIndex = pool.length + Math.floor(Math.random() * pool.length);

    // Initial state: no transition.
    trackEl.style.transition = 'none';
    trackEl.style.transform = transformFor(midIndex);
    applyMid(midIndex);
    // Force reflow before re-enabling transitions.
    void trackEl.offsetHeight;
    trackEl.style.transition = '';

    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    function tick() {
      // Top-to-bottom flow: items move down each tick. Visually, the
      // item currently above the middle becomes the new middle.
      // That means midIndex DECREASES each tick.
      midIndex -= 1;
      trackEl.style.transform = transformFor(midIndex);
      applyMid(midIndex);

      // Loop seam: when we approach the start of the rendered stack,
      // jump forward by one cycle (same item visually) without animation.
      if (midIndex <= 1) {
        setTimeout(() => {
          midIndex += pool.length;
          trackEl.style.transition = 'none';
          trackEl.style.transform = transformFor(midIndex);
          applyMid(midIndex);
          void trackEl.offsetHeight;
          trackEl.style.transition = '';
        }, CAROUSEL_TRANSITION_MS + 50);
      }
    }

    setInterval(tick, CAROUSEL_TICK_MS);
  }

  function bindName() {
    const input = $('#nameInput');
    const btn = $('#nameNext');
    input.addEventListener('input', (e) => {
      STATE.name = (e.target.value || '').trim().slice(0, 60);
      btn.disabled = STATE.name.length < 1;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !btn.disabled) { e.preventDefault(); next(); }
    });
    btn.addEventListener('click', next);
  }

  // =====================================================================
  // Substance
  // =====================================================================
  function buildSubstanceList() {
    const list = $('#substanceList');
    clearChildren(list);
    SUBSTANCES.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.id = opt.id;
      btn.innerHTML =
        '<span class="dot" aria-hidden="true"></span>' +
        '<span class="icon" aria-hidden="true">' + opt.icon + '</span>' +
        '<span class="label-text"></span>';
      $('.label-text', btn).textContent = opt.label;
      btn.addEventListener('click', () => onSubstancePick(opt, btn, list));
      list.appendChild(btn);
    });
  }

  function onSubstancePick(opt, btn, list) {
    $$('.choice', list).forEach((c) => {
      c.classList.remove('selected');
      c.setAttribute('aria-checked', 'false');
    });
    btn.classList.add('selected');
    btn.setAttribute('aria-checked', 'true');
    STATE.substance = opt;

    if (opt.id === 'selfharm') {
      // Hard branch: do not run the addiction assessment.
      goTo('crisis');
      return;
    }
    $('#substanceNext').disabled = false;
  }

  function updateSubstanceTitle() {
    const el = $('#substanceTitle');
    el.textContent = STATE.name
      ? STATE.name + ', what are you working to overcome?'
      : 'What are you working to overcome?';
  }

  function bindSubstance() {
    $('#substanceNext').addEventListener('click', next);
  }

  // =====================================================================
  // Crisis screen
  // =====================================================================
  function updateCrisisTitle() {
    const el = $('#crisisTitle');
    el.textContent = STATE.name
      ? STATE.name + ', we want to make sure you’re safe.'
      : 'We want to make sure you’re safe.';
  }

  function bindCrisis() {
    const back = $('#crisisBack');
    if (back) back.addEventListener('click', () => goTo('substance'));
  }

  // =====================================================================
  // When
  // =====================================================================
  function setDateToNow() {
    const now = new Date();
    $('#quitDate').value =
      now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    $('#quitTime').value = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    updateDateStatus();
  }

  function updateDateStatus() {
    const dEl = $('#quitDate');
    const tEl = $('#quitTime');
    const status = $('#dateStatus');
    if (!dEl.value) { status.textContent = '—'; return; }
    const dt = new Date(dEl.value + 'T' + (tEl.value || '00:00'));
    if (isNaN(dt)) { status.textContent = '—'; return; }
    STATE.started_at = dt.toISOString();
    STATE.havent_started = false;
    const now = new Date();
    const diffMs = now - dt;
    const diffMin = Math.round(diffMs / 60000);
    const diffH = Math.round(diffMs / 3600000);
    const diffD = Math.round(diffMs / 86400000);
    if (Math.abs(diffMin) < 5) status.textContent = 'Just now';
    else if (Math.abs(diffH) < 1) status.textContent = diffMin + ' min ' + (diffMin >= 0 ? 'ago' : 'from now');
    else if (Math.abs(diffD) < 1) status.textContent = diffH + ' hour' + (Math.abs(diffH) === 1 ? '' : 's') + ' ' + (diffH >= 0 ? 'ago' : 'from now');
    else status.textContent = Math.abs(diffD) + ' day' + (Math.abs(diffD) === 1 ? '' : 's') + ' ' + (diffD >= 0 ? 'ago' : 'from now');
  }

  function bindWhen() {
    $('#quitDate').addEventListener('change', updateDateStatus);
    $('#quitTime').addEventListener('change', updateDateStatus);
    $('#whenNext').addEventListener('click', next);
    $('#haventStarted').addEventListener('click', () => {
      STATE.havent_started = true;
      setDateToNow();
      next();
    });
  }

  // =====================================================================
  // Cost
  // =====================================================================
  function autosizeCost() {
    const input = $('#costInput');
    const measure = $('#costMeasure');
    measure.textContent = input.value || '0';
    const w = measure.offsetWidth;
    input.style.width = Math.max(w, 28) + 'px';
  }

  function setCost(amount, opts) {
    opts = opts || {};
    let n = Number(amount);
    if (!isFinite(n) || n < 0) n = 0;
    if (n > 100000) n = 100000;
    STATE.weekly_cost = n;
    const input = $('#costInput');
    if (!opts.fromInput) input.value = n > 0 ? String(n) : '0';
    $('#costDisplay').classList.toggle('has-value', n > 0);
    $('#costNext').disabled = n <= 0;
    autosizeCost();
    $$('.preset', $('#presetRow')).forEach((p) => {
      p.classList.toggle('active', Number(p.dataset.amount) === n);
    });
  }

  function bindCost() {
    const input = $('#costInput');
    const display = $('#costDisplay');
    const hint = $('#costHint');
    const presets = $('#presetRow');
    const btn = $('#costNext');

    input.addEventListener('input', (e) => {
      let v = (e.target.value || '').replace(/[^\d.]/g, '');
      const firstDot = v.indexOf('.');
      if (firstDot !== -1) v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
      e.target.value = v;
      setCost(v || 0, { fromInput: true });
    });
    input.addEventListener('focus', () => {
      display.classList.add('is-focused');
      hint.classList.add('is-hidden');
      if (input.value === '0') { input.value = ''; autosizeCost(); }
      setTimeout(() => {
        const len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (e) {}
      }, 0);
    });
    input.addEventListener('blur', () => {
      display.classList.remove('is-focused');
      if (input.value === '' || input.value === '.') { input.value = '0'; setCost(0); }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !btn.disabled) { e.preventDefault(); input.blur(); next(); }
    });
    display.addEventListener('click', () => input.focus());
    $$('.preset', presets).forEach((p) => {
      p.addEventListener('click', () => setCost(Number(p.dataset.amount)));
    });
    btn.addEventListener('click', next);
  }

  // =====================================================================
  // Savings
  // =====================================================================
  function updateSavings() {
    const monthly = STATE.weekly_cost * 4; // simple weekly × 4 per spec
    $('#savingsAmount').textContent = '$' + fmt(monthly);
    const tail = $('#savingsTail');
    if (STATE.havent_started) {
      tail.textContent = 'a month, once you start. Money back in your pocket, and a future you’ll feel.';
    } else {
      tail.textContent = 'a month by stepping back. Money back in your pocket, and a future you’ll feel.';
    }
  }

  function bindSavings() {
    $('#savingsNext').addEventListener('click', next);
  }

  // =====================================================================
  // Consent
  // =====================================================================
  function updateConsentTitle() {
    const el = $('#consentTitle');
    el.textContent = STATE.name
      ? 'One quick thing, ' + STATE.name + '.'
      : 'One quick thing.';
  }

  function bindConsent() {
    const box = $('#consentBox');
    const btn = $('#consentNext');
    box.addEventListener('click', () => {
      STATE.consent = !STATE.consent;
      box.classList.toggle('checked', STATE.consent);
      box.setAttribute('aria-checked', STATE.consent ? 'true' : 'false');
      btn.disabled = !STATE.consent;
    });
    btn.addEventListener('click', next);
  }

  // =====================================================================
  // Intro
  // =====================================================================
  function bindIntro() {
    $('#introNext').addEventListener('click', next);
  }

  function updateIntroTitle() {
    const profile = STATE.substance || { id: null, label: 'this' };
    const noun =
      profile.id === 'gambling' ? 'gambling' :
      profile.id === 'sex' ? 'sexual behavior' :
      profile.id === 'pornography' ? 'porn use' :
      profile.id === 'other' ? 'this' :
      (profile.label.toLowerCase() + ' use');
    const tail = profile.id === 'other' ? '' : '';
    $('#introTitle').textContent = 'Let’s understand the pattern behind your ' + noun + '.';
    $('#introEmoji').textContent = STATE.substance ? STATE.substance.icon : '🎯';
  }

  // =====================================================================
  // Assessment
  // =====================================================================
  function startAssessment() {
    if (STATE.history.length === 0 && !STATE.current_question) {
      // First question — fetch from API
      fetchAndShowNextQuestion();
    } else {
      renderQuestion();
    }
  }

  function bindAssessment() {
    const opts = $('#qOptions');
    SCALE.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'q-option';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.value = String(s.value);
      btn.innerHTML = '<span class="dot"></span><span class="label-text"></span>';
      $('.label-text', btn).textContent = s.label;
      btn.addEventListener('click', () => onAnswer(s));
      opts.appendChild(btn);
    });
  }

  let advanceTimer = null;

  // Wall-clock timestamp set by revealQuestion(); read by onAnswer to
  // estimate how long the user spent on the question. Hesitation
  // patterns are passed to /api/addiction/analyze so the model can
  // optionally weave one observation about it into the insights.
  let questionShownAt = 0;

  function onAnswer(scaleItem) {
    if (advanceTimer) return;
    if (!STATE.current_question) return;
    const stage = $('#qStage');
    if (stage.classList.contains('is-loading')) return; // can't tap during load
    const q = STATE.current_question;
    // Visual selection
    $$('.q-option', $('#qOptions')).forEach((b) => {
      const sel = Number(b.dataset.value) === scaleItem.value;
      b.classList.toggle('selected', sel);
      b.setAttribute('aria-checked', sel ? 'true' : 'false');
      b.disabled = true;
    });
    // Compute time-on-question. Cap at 10 minutes to avoid tagging
    // AFK sessions as "deep deliberation".
    let timeMs = 0;
    if (questionShownAt > 0) {
      const elapsed = Date.now() - questionShownAt;
      if (elapsed > 0 && elapsed < 600000) timeMs = elapsed;
    }
    questionShownAt = 0;
    // Push to history (carrying the signal the model was checking)
    STATE.history.push({
      id: q.id,
      text: q.text,
      answer_value: scaleItem.value,
      answer_label: scaleItem.label,
      signal_being_checked: q.signal_being_checked || null,
      time_ms: timeMs,
    });
    STATE.current_question = null;
    updateChrome();
    advanceTimer = setTimeout(() => {
      advanceTimer = null;
      if (STATE.history.length >= MAX_QUESTIONS) {
        goTo('building');
      } else {
        fetchAndShowNextQuestion();
      }
    }, 220);
  }

  // Set up the loading state visuals: rotate a loading message, hide options.
  function showQuestionLoading() {
    const stage = $('#qStage');
    stage.classList.add('is-loading');
    const txt = $('#qLoadingText');
    if (txt) txt.textContent = LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];
    // Keep the eyebrow current (Question N being prepared)
    $('#qProgressLabel').textContent = 'Question ' + (STATE.history.length + 1);
  }

  // Reveal the question + options. The CSS handles the staggered timing:
  // question fades in immediately, options stagger in starting at ~550ms.
  function revealQuestion(opts) {
    opts = opts || {};
    const q = STATE.current_question;
    if (!q) return;
    const stage = $('#qStage');
    const text = $('#qText');
    text.textContent = q.text;
    $('#qProgressLabel').textContent = 'Question ' + (STATE.history.length + 1);

    const optionItems = q.options || SCALE;
    $$('.q-option', $('#qOptions')).forEach((b, i) => {
      const item = optionItems[i];
      if (!item) return;
      $('.label-text', b).textContent = item.label;
      b.dataset.value = String(item.value);
      const preselected = q.prev_value !== undefined && Number(q.prev_value) === item.value;
      b.classList.toggle('selected', !!preselected);
      b.setAttribute('aria-checked', preselected ? 'true' : 'false');
      b.disabled = false;
    });

    // Mark the moment the user can actually see and interact with the
    // question. Used by onAnswer() to capture time-on-question.
    questionShownAt = Date.now();

    // If we want to skip the loading→reveal animation (e.g., on back nav),
    // just remove is-loading. Otherwise the CSS transition handles the reveal.
    if (opts.skipLoading) {
      stage.classList.remove('is-loading');
    } else {
      // Tiny rAF defer so the new text is committed before the class flips.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          stage.classList.remove('is-loading');
        });
      });
    }
  }

  async function fetchAndShowNextQuestion() {
    showQuestionLoading();

    let data = null;
    try {
      data = await postJSON('/api/addiction/next-question', basePayload());
    } catch (e) {
      data = null;
    }
    if (data && data.ok && data.data) {
      if (data.data.done) {
        const reason = data.data.completion_reason || data.data.reason;
        if (reason === 'safety_redirect') {
          goTo('crisis');
          return;
        }
        goTo('building');
        return;
      }
      STATE.current_question = {
        id: data.data.question.id,
        text: data.data.question.text,
        options: data.data.question.options,
        signal_being_checked: data.data.signal_being_checked || null,
      };
    } else {
      // Fallback path: deterministic question, kept short.
      STATE.fallback_used = true;
      const idx = STATE.history.length;
      if (idx >= FALLBACK_QUESTIONS.length || idx >= MAX_QUESTIONS) {
        goTo('building');
        return;
      }
      STATE.current_question = {
        id: 'fb-' + (idx + 1),
        text: FALLBACK_QUESTIONS[idx],
        options: SCALE,
        signal_being_checked: null,
      };
    }
    revealQuestion();
  }

  // Compatibility shim: prior code called renderQuestion(); new flow uses revealQuestion().
  function renderQuestion() { revealQuestion(); }

  // =====================================================================
  // Building / Loading
  // =====================================================================
  let loadingTimer = null;
  let loadingPct = 0;
  let analyzePromise = null;

  function startBuilding() {
    const stages = [
      'Looking at your answers…',
      'Spotting the patterns…',
      'Shaping your snapshot…',
      'Almost ready…',
    ];
    const stepEl = $('#loadingStep');
    const pctEl = $('#loadingPct');
    const fillEl = $('#loadingFill');
    const checks = $$('#loadingChecks li');
    checks.forEach((c) => c.classList.remove('done'));
    fillEl.style.strokeDashoffset = '377';
    pctEl.textContent = '0%';
    stepEl.textContent = stages[0];
    loadingPct = 0;
    let stage = 0;

    // Reset the radial scale knob in case we re-entered this screen.
    document.body.classList.remove('hero-bursting');
    document.documentElement.style.setProperty('--hero-scale', '1');

    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }

    // Soft progress: advance toward 88, then hold until the API resolves.
    loadingTimer = setInterval(() => {
      const target = analyzePromise && analyzePromise._resolved ? 100 : 88;
      const inc = analyzePromise && analyzePromise._resolved ? 4 : 0.9;
      loadingPct = Math.min(target, loadingPct + inc);
      pctEl.textContent = Math.round(loadingPct) + '%';
      fillEl.style.strokeDashoffset = String(377 - (loadingPct / 100) * 377);

      // Grow the radial 1× → 2× as percentage advances 0 → 100.
      // Centered growth comes "for free" because transform-origin is
      // the radial's own center (translate(-50%,-50%) scale(N)).
      const heroScale = 1 + (loadingPct / 100);
      document.documentElement.style.setProperty('--hero-scale', String(heroScale));

      const ts = loadingPct >= 75 ? 3 : loadingPct >= 50 ? 2 : loadingPct >= 25 ? 1 : 0;
      if (ts !== stage) {
        if (checks[stage]) checks[stage].classList.add('done');
        stage = ts;
        stepEl.classList.add('swapping');
        setTimeout(() => {
          stepEl.textContent = stages[stage];
          stepEl.classList.remove('swapping');
        }, 200);
      }

      if (loadingPct >= 100) {
        clearInterval(loadingTimer);
        loadingTimer = null;
        if (checks[3]) checks[3].classList.add('done');
        // Burst out: radial accelerates to scale 3 and fades fast,
        // so it doesn't appear on the dashboard. CSS handles the
        // motion via the `.hero-bursting` class.
        document.body.classList.add('hero-bursting');
        setTimeout(() => {
          if (SCREENS[currentIndex] === 'building') goTo('dashboard');
        }, 500);  // matches the 480ms transform burst + a tiny buffer
      }
    }, 80);

    // Kick off the real call.
    analyzePromise = (async () => {
      try {
        const data = await postJSON('/api/addiction/analyze', basePayload());
        if (data && data.ok && data.data) {
          STATE.result = data.data;
        } else {
          STATE.result = buildFallbackResult();
          STATE.fallback_used = true;
        }
      } catch (e) {
        STATE.result = buildFallbackResult();
        STATE.fallback_used = true;
      }
    })();
    // mark resolution flag without awaiting in caller
    analyzePromise._resolved = false;
    analyzePromise.then(() => { analyzePromise._resolved = true; });
  }

  // =====================================================================
  // Fallback result (no API)
  // =====================================================================
  function computeRiskLocal() {
    const symptoms = STATE.history.filter((h) => h.answer_value >= 2).length;
    let level;
    if (symptoms >= 6) level = 'severe';
    else if (symptoms >= 4) level = 'moderate';
    else if (symptoms >= 2) level = 'mild';
    else level = 'minimal';
    return { level, symptoms, pct: Math.min(1, symptoms / 11) };
  }

  // Build a complete fallback result in the new unified shape.
  // Used when /api/addiction/analyze fails; still feels personal because
  // every value is derived from the user's actual answers + substance.
  function buildFallbackResult() {
    const r = computeRiskLocal();
    return buildFallbackDashboardPayload(r);
  }

  // =====================================================================
  // Fallback dashboard payload (new unified shape).
  // Used when /api/addiction/analyze fails. Every value is derived from
  // the user's actual data — substance, answers, weekly cost — so even
  // the safety net feels personal. Does NOT claim AI generation.
  // =====================================================================
  function buildFallbackDashboardPayload(r) {
    const symptoms = r.symptoms;
    const score = Math.round(r.pct * 100);
    const name = STATE.name || 'You';
    const sub = STATE.substance ? STATE.substance.id : 'other';

    const labelByLevel = {
      minimal: 'Light signal',
      mild:    'Mild signal',
      moderate:'Moderate signal',
      severe:  'Strong signal',
    };
    const summaryByLevel = {
      minimal: 'No strong patterns are showing up — a good place to stay aware and protect what is working.',
      mild:    'A few early patterns are showing up. This is a good window to build steadier habits before they deepen.',
      moderate:'Real patterns are showing up across your answers. Naming them is the move you just made.',
      severe:  'Strong patterns are surfacing across multiple areas. Acknowledging this takes courage — and pairs best with a person.',
    };
    const heroSubByLevel = {
      minimal: 'A clear-eyed snapshot. Keep what works.',
      mild:    'Catching it early — that already shifts the path.',
      moderate:'Honest awareness is half the work.',
      severe:  'Brave to look. Don’t carry it alone.',
    };

    // Metric values, derived from r and history
    const patternIntensity = Math.max(8, Math.min(96, score + (Math.floor(Math.random() * 7) - 3)));
    const triggerSensitivity = clamp01to100(Math.round(score * 0.9 + 12 + (Math.random() * 10 - 5)));
    const recoveryLeverage = clamp01to100(Math.round(94 - score * 0.6 + (Math.random() * 8 - 4)));

    const metricInsights = {
      patternIntensity:
        score >= 60 ? 'Strong consistency across categories.' :
        score >= 30 ? 'Showing up, not yet dominant.' :
        'Light footprint — protect this.',
      triggerSensitivity:
        score >= 60 ? 'A few moments reliably set this off.' :
        score >= 30 ? 'Specific cues do most of the work.' :
        'You read your own cues well.',
      recoveryLeverage:
        score >= 60 ? 'Workable — needs structure and a person.' :
        score >= 30 ? 'You have real footing here.' :
        'A solid base — the lift you have is real.',
    };

    return {
      risk: {
        level: r.level,
        score,
        label: labelByLevel[r.level],
        summary: summaryByLevel[r.level],
      },
      primaryPattern: derivePatternFallback(STATE.history),
      metrics: [
        { label: 'Pattern intensity',   value: patternIntensity, unit: '%', insight: metricInsights.patternIntensity },
        { label: 'Trigger sensitivity', value: triggerSensitivity, unit: '%', insight: metricInsights.triggerSensitivity },
        { label: 'Recovery leverage',   value: recoveryLeverage, unit: '%', insight: metricInsights.recoveryLeverage },
      ],
      triggerMap: deriveTriggerMapFallback(sub, score),
      projection: deriveProjectionFallback(r.level),
      insights: [
        { title: 'What this means', body: heroSubByLevel[r.level] + ' ' + insightExtraByLevel(r.level) },
      ],
      plan: derivePlanFallback(name, r.level, sub),
      crisis_resources_recommended: r.level === 'severe',
    };
  }

  function clamp01to100(n) { return Math.max(0, Math.min(100, n)); }

  function insightExtraByLevel(level) {
    if (level === 'severe') return 'Pair Mia with a clinician or trusted person — that combination is the strongest support.';
    if (level === 'moderate') return 'A few specific routines, plus somewhere to talk through urges, will move this.';
    if (level === 'mild') return 'Small, consistent steps now make a steeper change than they will later.';
    return 'A light touch is enough. Quick check-ins help you notice if anything starts to shift.';
  }

  // Pattern card derived from highest-scoring answer + signal context.
  function derivePatternFallback(history) {
    if (!history || !history.length) {
      return {
        title: 'No strong pattern yet',
        description: 'Nothing stood out — a good place to stay aware.',
        signal: 'motivation_to_change',
      };
    }
    const sorted = history.slice().sort((a, b) => b.answer_value - a.answer_value);
    const top = sorted[0];
    if (top.answer_value < 2) {
      return {
        title: 'No strong pattern yet',
        description: 'What you shared doesn’t show a strong pull right now. Worth protecting.',
        signal: 'motivation_to_change',
      };
    }

    const sig = top.signal_being_checked;
    if (sig === 'cravings') return {
      title: 'The pull comes in waves', signal: sig,
      description: 'Cravings are showing up. They feel huge in the moment and pass faster than they seem.',
    };
    if (sig === 'loss_of_control') return {
      title: 'Control slips quietly', signal: sig,
      description: 'You meant to stop, and somewhere the line moved. That gap is where the pattern lives.',
    };
    if (sig === 'social_impact') return {
      title: 'It’s leaking into the rest of life', signal: sig,
      description: 'Work, home, or the people closest to you are starting to feel the cost.',
    };
    if (sig === 'emotional_triggers') return {
      title: 'It runs on emotion', signal: sig,
      description: 'Stress, low moods, or anxiety reliably turn the dial up.',
    };
    if (sig === 'avoidance_patterns') return {
      title: 'Avoidance is doing real work', signal: sig,
      description: 'It’s a way to get distance from feelings or situations — and the cost is showing.',
    };
    if (sig === 'relapse_risk') return {
      title: 'Specific moments hold weight', signal: sig,
      description: 'Certain places, people, or hours of the day pull harder than others.',
    };
    if (sig === 'financial_impact') return {
      title: 'It’s costing more than you wanted', signal: sig,
      description: 'The financial line is real — and tracking it is one of the clearest wins.',
    };
    if (sig === 'motivation_to_change') return {
      title: 'You’re ready for a different shape', signal: sig,
      description: 'You named what you want to change. That readiness is half the work.',
    };

    // Fallback: keyword-based
    const t = (top.text || '').toLowerCase();
    if (t.indexOf('craving') >= 0 || t.indexOf('urge') >= 0) return {
      title: 'The pull comes in waves', signal: 'cravings',
      description: 'Cravings are showing up. They feel huge in the moment and pass faster than they seem.',
    };
    return {
      title: 'A pattern is taking shape', signal: 'loss_of_control',
      description: 'Something is showing up across your answers. The clearer it gets, the more workable it is.',
    };
  }

  // Trigger-map fallback by substance, scaled to risk score.
  function deriveTriggerMapFallback(sub, score) {
    const baseBySubstance = {
      alcohol:     [['Stress', 78], ['Social pressure', 62], ['Boredom', 48], ['Emotional relief', 55], ['Late nights', 50]],
      nicotine:    [['Stress', 84], ['Habit loop', 70], ['Boredom', 50], ['Social cues', 44], ['Coffee / mornings', 60]],
      cannabis:    [['Wind-down', 76], ['Boredom', 55], ['Sleep aid', 60], ['Stress', 50], ['Social', 38]],
      gambling:    [['Boredom', 72], ['Big emotion', 65], ['Screens', 55], ['Stress', 48], ['Payday', 45]],
      cocaine:     [['Social peaks', 68], ['Late nights', 70], ['Energy', 50], ['Stress', 45]],
      opioids:     [['Pain', 82], ['Low mood', 60], ['Isolation', 55], ['Stress', 48]],
      meth:        [['Energy lows', 70], ['Long nights', 64], ['Crash', 60], ['Stress', 48]],
      mdma:        [['Weekends', 70], ['Group events', 64], ['Music', 50], ['Stress', 40]],
      sex:         [['Boredom', 70], ['Low moods', 62], ['Idle phone', 55], ['Stress', 50]],
      pornography: [['Late nights', 76], ['Idle scrolling', 70], ['Stress relief', 55], ['Sleep', 48]],
      other:       [['Stress', 70], ['Boredom', 55], ['Low moods', 52], ['Idle time', 48]],
    };
    const base = baseBySubstance[sub] || baseBySubstance.other;
    const scaler = 0.6 + (score / 100) * 0.7; // 0.6 → 1.3 across 0..100
    const scaled = base.map(([label, v]) => ({ label, value: clamp01to100(Math.round(v * scaler + (Math.random() * 6 - 3))) }));
    scaled.sort((a, b) => b.value - a.value);
    return scaled;
  }

  // 4-point projection (days 1, 7, 30, 90). Stability rises, pressure falls.
  function deriveProjectionFallback(level) {
    const curves = {
      minimal: [
        { day: 1,  stability: 28, pressure: 60 },
        { day: 7,  stability: 46, pressure: 48 },
        { day: 30, stability: 70, pressure: 32 },
        { day: 90, stability: 88, pressure: 18 },
      ],
      mild: [
        { day: 1,  stability: 22, pressure: 72 },
        { day: 7,  stability: 38, pressure: 58 },
        { day: 30, stability: 62, pressure: 40 },
        { day: 90, stability: 82, pressure: 24 },
      ],
      moderate: [
        { day: 1,  stability: 18, pressure: 80 },
        { day: 7,  stability: 32, pressure: 66 },
        { day: 30, stability: 56, pressure: 46 },
        { day: 90, stability: 78, pressure: 30 },
      ],
      severe: [
        { day: 1,  stability: 14, pressure: 86 },
        { day: 7,  stability: 26, pressure: 72 },
        { day: 30, stability: 48, pressure: 54 },
        { day: 90, stability: 72, pressure: 38 },
      ],
    };
    return curves[level] || curves.moderate;
  }

  // Plan steps fallback — grounded by level and substance.
  function derivePlanFallback(name, level, sub) {
    const opener = name && name !== 'You' ? `${name}, here’s the first move` : 'Here’s the first move';
    if (level === 'severe') return {
      title: opener,
      steps: [
        { title: 'Name a person, today', body: 'Tell one trusted person — friend, family, or clinician — what you just looked at. The hardest step is talking out loud.' },
        { title: 'Build a 24-hour plan', body: 'Decide what tonight and tomorrow look like. Hour by hour beats willpower every time.' },
        { title: 'Bring Mia along', body: 'In the moments between calls and check-ins, Mia is here. Not a replacement for a person — a companion.' },
      ],
    };
    if (level === 'moderate') return {
      title: opener,
      steps: [
        { title: 'Name your two highest triggers', body: 'You’ll see them in the trigger map above. Knowing the moment is half the work.' },
        { title: 'Build one small daily anchor', body: 'A morning walk, a journaling line, an evening check-in. Pick one. Repeat.' },
        { title: 'Bring Mia in for the urge moments', body: 'When the pull hits, having somewhere to put the thought makes it shrink faster.' },
      ],
    };
    if (level === 'mild') return {
      title: opener,
      steps: [
        { title: 'Pick a 7-day experiment', body: 'Define what a quieter week looks like. Keep it concrete — not perfect.' },
        { title: 'Track when the pull spikes', body: 'A note on your phone is enough. Patterns surface fast once you start watching.' },
        { title: 'Use Mia as a sanity check', body: 'Quick conversations make small wobbles easier to walk through.' },
      ],
    };
    return {
      title: opener,
      steps: [
        { title: 'Stay aware, not anxious', body: 'You have a foundation. Light check-ins keep it that way.' },
        { title: 'Note what works for you', body: 'When the pull is quiet, write down why. Future-you will thank past-you.' },
        { title: 'Talk to Mia when something shifts', body: 'If anything starts to feel different, name it early. Easier now than later.' },
      ],
    };
  }

  // =====================================================================
  // Dashboard rendering — unified result screen
  // =====================================================================
  function renderDashboard() {
    if (!STATE.result) return;
    const d = STATE.result;
    const name = STATE.name;

    // Header — centered.
    $('#dashEyebrow').textContent = name ? (name + '’s reflection').toUpperCase() : 'YOUR REFLECTION';
    $('#dashTitle').textContent = name ? name + ', here’s what surfaced.' : 'Here’s what surfaced.';

    // Hero: gauge + badge + summary, all centered.
    const risk = d.risk || {};
    const pill = $('#riskPill');
    pill.classList.remove('is-minimal', 'is-mild', 'is-moderate', 'is-severe');
    pill.classList.add('is-' + (risk.level || 'mild'));
    const riskTextLabels = { minimal: 'Low', mild: 'Mild', moderate: 'Moderate', severe: 'Strong' };
    pill.textContent = riskTextLabels[risk.level] || 'Signal';
    $('#riskLabel').textContent = risk.label || 'Pattern signal';
    // Summary now lives inside the hero, below the badge.
    $('#dashSummary').textContent = (d.risk && d.risk.summary) || '';

    drawGauge($('#dashGauge'), Number(risk.score) || 0);

    // Metrics
    const metricsEl = $('#dashMetrics');
    clearChildren(metricsEl);
    (d.metrics || []).slice(0, 3).forEach((m) => {
      const card = document.createElement('div');
      card.className = 'dash-metric';
      card.innerHTML =
        '<div class="dash-metric-label"></div>' +
        '<div class="dash-metric-value-row"><span class="dash-metric-value"></span><span class="dash-metric-unit"></span></div>' +
        '<div class="dash-metric-bar"><div class="dash-metric-bar-fill"></div></div>' +
        '<p class="dash-metric-insight"></p>';
      $('.dash-metric-label', card).textContent = m.label || '';
      $('.dash-metric-value', card).textContent = String(Math.round(Number(m.value) || 0));
      $('.dash-metric-unit', card).textContent = m.unit || '';
      $('.dash-metric-insight', card).textContent = m.insight || '';
      metricsEl.appendChild(card);
      const fill = $('.dash-metric-bar-fill', card);
      const v = Math.max(0, Math.min(100, Number(m.value) || 0));
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = v + '%'; }));
    });

    // Primary pattern
    const pp = d.primaryPattern || {};
    $('#patternTitle').textContent = pp.title || '—';
    $('#patternBody').textContent = pp.description || '';

    // Trigger map
    const bars = $('#triggerBars');
    clearChildren(bars);
    (d.triggerMap || []).slice(0, 7).forEach((t) => {
      const row = document.createElement('div');
      row.className = 'trigger-row';
      row.innerHTML =
        '<span class="trigger-label"></span>' +
        '<div class="trigger-bar"><div class="trigger-bar-fill"></div></div>' +
        '<span class="trigger-value"></span>';
      $('.trigger-label', row).textContent = t.label || '—';
      $('.trigger-value', row).textContent = String(Math.round(Number(t.value) || 0));
      bars.appendChild(row);
      const fill = $('.trigger-bar-fill', row);
      const v = Math.max(0, Math.min(100, Number(t.value) || 0));
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = v + '%'; }));
    });

    // Theme breakdown — derived purely from the user's actual answers
    // grouped by signal_being_checked. No API call. Hidden if there's
    // not enough variation across themes for the chart to be meaningful.
    renderThemeBreakdown(STATE.history);

    // Projection chart
    drawProjection($('#dashChart'), d.projection || []);

    // Insights
    const insightsEl = $('#dashInsights');
    clearChildren(insightsEl);
    (d.insights || []).slice(0, 2).forEach((i) => {
      const card = document.createElement('article');
      card.className = 'dash-insight';
      card.innerHTML =
        '<div class="dash-insight-eyebrow">WHAT THIS MEANS</div>' +
        '<h3 class="dash-insight-title"></h3>' +
        '<p class="dash-insight-body"></p>';
      $('.dash-insight-title', card).textContent = i.title || '';
      $('.dash-insight-body', card).textContent = i.body || '';
      insightsEl.appendChild(card);
    });

    // Crisis banner
    const banner = $('#crisisBanner');
    if (d.crisis_resources_recommended) banner.hidden = false;
    else banner.hidden = true;

    // Plan
    const plan = d.plan || {};
    $('#planTitle').textContent = plan.title || 'Your first move';
    const stepsEl = $('#planSteps');
    clearChildren(stepsEl);
    (plan.steps || []).slice(0, 3).forEach((s, idx) => {
      const step = document.createElement('article');
      step.className = 'plan-step';
      step.innerHTML =
        '<div class="plan-step-num"></div>' +
        '<div class="plan-step-text"><h4 class="plan-step-title"></h4><p class="plan-step-body"></p></div>';
      $('.plan-step-num', step).textContent = String(idx + 1);
      $('.plan-step-title', step).textContent = s.title || '';
      $('.plan-step-body', step).textContent = s.body || '';
      stepsEl.appendChild(step);
    });
  }

  function bindDashboard() {
    $('#dashNext').addEventListener('click', () => goTo('trial'));
  }

  // Half-circle gauge (speedometer style). Input is a 0–100 score.
  // Theme breakdown — averages each user's answers grouped by the
  // signal_being_checked tag and renders a horizontal bar per theme.
  // The card is hidden if fewer than 2 distinct themes are present, or
  // if the spread is too flat to read anything from. No API call —
  // this is computed entirely from the user's actual answer history.
  function renderThemeBreakdown(history) {
    const card = $('#themeCard');
    const container = $('#themeBars');
    if (!card || !container) return;
    const buckets = {};
    (history || []).forEach((h) => {
      const sig = h.signal_being_checked;
      if (!sig || !SIGNAL_LABELS[sig]) return;
      if (!buckets[sig]) buckets[sig] = { sum: 0, count: 0 };
      buckets[sig].sum += Number(h.answer_value) || 0;
      buckets[sig].count += 1;
    });
    const rows = Object.keys(buckets).map((sig) => {
      const avg = buckets[sig].sum / buckets[sig].count;
      return {
        sig,
        label: SIGNAL_LABELS[sig],
        avg,
        // Map the 0–4 Likert average to a 0–100 scale for the bar.
        value: Math.round((avg / 4) * 100),
      };
    });
    rows.sort((a, b) => b.avg - a.avg);

    const enoughThemes = rows.length >= 2;
    const hasSpread = rows.length >= 2 && (rows[0].avg - rows[rows.length - 1].avg) >= 1;
    if (!enoughThemes || !hasSpread) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    clearChildren(container);
    rows.slice(0, 6).forEach((r) => {
      const row = document.createElement('div');
      row.className = 'theme-row';
      row.innerHTML =
        '<span class="theme-label"></span>' +
        '<div class="theme-bar"><div class="theme-bar-fill"></div></div>' +
        '<span class="theme-value"></span>';
      $('.theme-label', row).textContent = r.label;
      $('.theme-value', row).textContent = String(r.value);
      container.appendChild(row);
      const fill = $('.theme-bar-fill', row);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        fill.style.width = r.value + '%';
      }));
    });
  }

  function drawGauge(container, score) {
    if (!container) return;
    const W = 200, H = 110;
    const cx = 100, cy = 92, r = 80;
    const sNum = Number(score) || 0;
    const p = Math.max(0.02, Math.min(1, sNum / 100));
    const angle = (1 - p) * Math.PI; // 180° → 0°
    const ex = cx + r * Math.cos(angle);
    const ey = cy - r * Math.sin(angle);

    // The gradient's END color matches the badge for this score's
    // level. So the last visible segment of the arc reads the same
    // hue as the colored pill below it — the eye instantly couples
    // the two. We always start green and progress through warmer
    // colors only as needed, so a "minimal" gauge stays solid green
    // and a "severe" gauge actually shows the green→yellow→red
    // spectrum across the rendered arc.
    //
    // Server-side level boundaries (from safety.js):
    //   minimal < 18, mild 18–35, moderate 36–54, severe 55+.
    const COLORS = {
      green:  '#16A34A',
      amber:  '#FFB546',
      orange: '#FF7A3D',
      red:    '#DC4040',
    };
    const endColor =
      sNum < 18 ? COLORS.green
      : sNum < 36 ? COLORS.amber
      : sNum < 55 ? COLORS.orange
      : COLORS.red;

    // Build stops. The last visible position of the arc is at
    // p × 100 % of the gradient (because the gradient spans the
    // full half-circle in user-space coords). Place the badge color
    // there. Repeat it past the arc end so any overshoot stays the
    // same hue rather than bleeding into a different color.
    const endStop = Math.max(3, p * 100);
    let stops;
    if (sNum < 18) {
      // minimal — solid green; no transitions needed.
      stops = '<stop offset="0%" stop-color="' + COLORS.green + '" />' +
              '<stop offset="100%" stop-color="' + COLORS.green + '" />';
    } else if (sNum < 36) {
      // mild — green → amber. End color = amber at p%.
      stops = '<stop offset="0%" stop-color="' + COLORS.green + '" />' +
              '<stop offset="' + endStop.toFixed(2) + '%" stop-color="' + COLORS.amber + '" />' +
              '<stop offset="100%" stop-color="' + COLORS.amber + '" />';
    } else if (sNum < 55) {
      // moderate — green → amber midpoint → orange. End at p%.
      stops = '<stop offset="0%" stop-color="' + COLORS.green + '" />' +
              '<stop offset="' + (endStop * 0.55).toFixed(2) + '%" stop-color="' + COLORS.amber + '" />' +
              '<stop offset="' + endStop.toFixed(2) + '%" stop-color="' + COLORS.orange + '" />' +
              '<stop offset="100%" stop-color="' + COLORS.orange + '" />';
    } else {
      // severe — full green → amber → orange → red.
      stops = '<stop offset="0%" stop-color="' + COLORS.green + '" />' +
              '<stop offset="' + (endStop * 0.40).toFixed(2) + '%" stop-color="' + COLORS.amber + '" />' +
              '<stop offset="' + (endStop * 0.72).toFixed(2) + '%" stop-color="' + COLORS.orange + '" />' +
              '<stop offset="' + endStop.toFixed(2) + '%" stop-color="' + COLORS.red + '" />' +
              '<stop offset="100%" stop-color="' + COLORS.red + '" />';
    }

    container.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pattern intensity gauge">' +
        '<defs>' +
          '<linearGradient id="gaugeGrad" gradientUnits="userSpaceOnUse" x1="' + (cx - r) + '" y1="' + cy + '" x2="' + (cx + r) + '" y2="' + cy + '">' +
            stops +
          '</linearGradient>' +
        '</defs>' +
        '<path d="M ' + (cx - r) + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx + r) + ' ' + cy + '" fill="none" stroke="#E7E7EC" stroke-width="11" stroke-linecap="round" />' +
        '<path d="M ' + (cx - r) + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + ex + ' ' + ey + '" fill="none" stroke="url(#gaugeGrad)" stroke-width="11" stroke-linecap="round" />' +
        '<text x="' + cx + '" y="' + (cy - 16) + '" text-anchor="middle" font-family="\'Utopia Std Display\', \'Source Serif 4\', Georgia, serif" font-size="34" font-weight="600" fill="#0E0E12">' + Math.round(sNum) + '</text>' +
        '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="700" letter-spacing="1.2" fill="#8A8A94">INTENSITY</text>' +
      '</svg>';
  }

  // Two-line projection chart (stability rising, pressure falling).
  function drawProjection(container, points) {
    if (!container) return;
    if (!Array.isArray(points) || points.length === 0) { container.innerHTML = ''; return; }
    const W = 320, H = 130;
    const padX = 12, padTop = 16, padBot = 22;
    const xRange = W - 2 * padX;
    const yRange = H - padTop - padBot;
    const baseY = H - padBot;
    const maxDay = points[points.length - 1].day;
    const xs = points.map((p) => padX + (Math.max(1, p.day) / maxDay) * xRange);
    const yStability = points.map((p) => H - padBot - (Math.max(0, Math.min(100, p.stability)) / 100) * yRange);
    const yPressure  = points.map((p) => H - padBot - (Math.max(0, Math.min(100, p.pressure )) / 100) * yRange);

    function smoothPath(xs, ys) {
      let d = 'M ' + xs[0] + ' ' + ys[0];
      for (let i = 1; i < xs.length; i++) {
        const dx = (xs[i] - xs[i - 1]) * 0.5;
        const c1x = xs[i - 1] + dx, c1y = ys[i - 1];
        const c2x = xs[i] - dx,     c2y = ys[i];
        d += ' C ' + c1x + ' ' + c1y + ', ' + c2x + ' ' + c2y + ', ' + xs[i] + ' ' + ys[i];
      }
      return d;
    }

    const stabPath = smoothPath(xs, yStability);
    const pressPath = smoothPath(xs, yPressure);
    const stabArea = stabPath + ' L ' + xs[xs.length - 1] + ' ' + baseY + ' L ' + xs[0] + ' ' + baseY + ' Z';

    const lastIdx = points.length - 1;
    const stabDot = '<circle cx="' + xs[lastIdx] + '" cy="' + yStability[lastIdx] + '" r="9" fill="#0054FF" fill-opacity="0.18" />' +
                    '<circle cx="' + xs[lastIdx] + '" cy="' + yStability[lastIdx] + '" r="5" fill="#0054FF" />';
    const pressDot = '<circle cx="' + xs[lastIdx] + '" cy="' + yPressure[lastIdx] + '" r="4" fill="#CC1060" />';

    container.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="90-day projection">' +
        '<defs>' +
          '<linearGradient id="stabGrad" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#0054FF" stop-opacity="0.22" />' +
            '<stop offset="100%" stop-color="#0054FF" stop-opacity="0" />' +
          '</linearGradient>' +
        '</defs>' +
        '<line x1="' + padX + '" y1="' + baseY + '" x2="' + (W - padX) + '" y2="' + baseY + '" stroke="#E7E7EC" stroke-width="1" />' +
        '<path d="' + stabArea + '" fill="url(#stabGrad)" />' +
        '<path d="' + pressPath + '" fill="none" stroke="#CC1060" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="3 4" opacity="0.65" />' +
        '<path d="' + stabPath + '" fill="none" stroke="#0054FF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />' +
        stabDot + pressDot +
      '</svg>';
  }

  // =====================================================================
  // Trial / counter
  // =====================================================================
  let counterInterval = null;
  let counterStart = null;

  function startCounter() {
    stopCounter();
    counterStart = STATE.started_at ? new Date(STATE.started_at).getTime() : Date.now();
    tickCounter();
    counterInterval = setInterval(tickCounter, 1000);
  }
  function stopCounter() {
    if (counterInterval) { clearInterval(counterInterval); counterInterval = null; }
  }
  function tickCounter() {
    const ms = Math.max(0, Date.now() - counterStart);
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    $('#cDays').textContent = pad2(days);
    $('#cHours').textContent = pad2(hours);
    $('#cMins').textContent = pad2(mins);
    $('#cSecs').textContent = pad2(secs);
  }
  function updateTrialTitle() {
    const t = $('#trialTitle');
    t.textContent = STATE.name
      ? STATE.name + ', Mia has already a plan for you.'
      : 'Mia has already a plan for you.';
  }

  // =====================================================================
  // API helpers
  // =====================================================================
  function basePayload() {
    return {
      session_id: STATE.session_id,
      name: STATE.name || '',
      substance: STATE.substance ? STATE.substance.id : 'other',
      started_at: STATE.started_at,
      havent_started: !!STATE.havent_started,
      weekly_cost: Number(STATE.weekly_cost) || 0,
      history: STATE.history.map((h) => ({
        id: h.id,
        text: h.text,
        answer_value: h.answer_value,
        answer_label: h.answer_label,
        signal_being_checked: h.signal_being_checked || null,
        // Time spent on this question, in ms. Optional — server tolerates
        // missing/zero. Used to surface hesitation patterns in insights.
        time_ms: typeof h.time_ms === 'number' ? Math.round(h.time_ms) : 0,
      })),
    };
  }

  async function postJSON(url, body, timeoutMs) {
    timeoutMs = timeoutMs || 28000;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      return data;
    } catch (e) {
      clearTimeout(t);
      return null;
    }
  }

  // =====================================================================
  // Keyboard handling — keep input in view above keyboard
  // =====================================================================
  function bindFocusScroll() {
    document.addEventListener('focusin', (e) => {
      if (e.target.matches('input, textarea')) {
        setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
      }
    });
  }

  // =====================================================================
  // Init
  // =====================================================================
  function init() {
    buildProgress();
    buildSubstanceList();
    bindWelcome();
    bindName();
    bindSubstance();
    bindWhen();
    bindCost();
    bindSavings();
    bindConsent();
    bindIntro();
    bindAssessment();
    bindDashboard();
    bindCrisis();
    bindFocusScroll();

    setDateToNow();
    setCost(0);
    autosizeCost();
    updateChrome();

    backBtn().addEventListener('click', back);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
