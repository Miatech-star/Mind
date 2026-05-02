// addiction-v2/intro-voice.js
//
// Plays a short Mia greeting on the first screen of v2.
//
// Architecture:
//   - Orb runs in its own iframe (./orb.html). Non-interactive.
//   - Text container has a fixed height; phrases overlap each other
//     (absolute positioning) so the layout never shifts as new
//     phrases come in.
//   - Word reveal is driven from audio.currentTime — a brief stall in
//     decoding never desyncs the captions from the voice.
//   - Audio cannot autoplay on a cold page load (browsers block it).
//     We try once; if blocked, an italic "tap when you're ready"
//     prompt fades in over the text spot, and the WHOLE STAGE
//     becomes the tap target.
//   - On end-of-audio + brief pause, the orb morphs into the rose
//     radial: a "morphing" body bg-state instantly places the radial
//     at the orb's exact position, the orb fades out, then the body
//     state changes to "welcome" — sliding the radial down to its
//     bottom-anchored resting place.

(function () {
  'use strict';

  // ----- Configuration -----
  const AUDIO_SRC = '../audio/mia_voice.mp3';
  const PHRASES = [
    { text: "Hi, I'm Mia.",                                                        start:     0, end:  1250 },
    { text: "I'll help you take a closer look at what's been hard to change.",     start:  1750, end:  4500 },
    { text: "Not to judge you. Not to rush you.",                                  start:  5000, end:  7333 },
    { text: "Just to understand the pattern a little better.",                     start:  8000, end: 10250 },
    { text: "We'll start with a few simple questions.",                            start: 10750, end: 12500 },
    { text: "You don't have to have it all figured out.",                          start: 12900, end: 14000 },
  ];
  // After audio ends, hold the last phrase for this long before
  // starting the orb-to-radial morph. Keeps the closing line from
  // feeling abrupt and gives the user time to read it.
  const HOLD_AFTER_END_MS   = 1400;
  // The captions fade out FIRST (independent of the orb), with this
  // much lead time before the orb starts moving. So the user reads
  // the last line, the captions dissolve, and only then does the
  // orb begin its descent.
  const CAPTIONS_FADE_LEAD  = 550;
  // Total morph duration — must match the CSS transitions on
  // .iv-orb (.is-leaving) and body[data-bg-state="welcome"] .hero-glow.
  const MORPH_DURATION_MS   = 1400;
  // Prompt copy when autoplay is blocked. Capitalized and placed
  // below the orb (see .iv-prompt CSS for positioning).
  const PROMPT_TEXT         = 'Tap when you’re ready';

  // ----- DOM -----
  const screen   = document.querySelector('.screen[data-screen="intro-voice"]');
  if (!screen) return;
  const stage    = screen.querySelector('.iv-stage');
  const textEl   = document.getElementById('ivText');
  const orbFrame = document.getElementById('orbFrame');
  if (!stage || !textEl) return;

  // Build the DOM ahead of time: one .iv-phrase per phrase, each
  // overlapping in the same spot; word-spans inside each. All
  // phrases stay in the DOM; only one is .is-active at a time.
  const phraseEls = PHRASES.map((p) => {
    const container = document.createElement('span');
    container.className = 'iv-phrase';
    const words = p.text.split(/\s+/);
    const wordEls = [];
    words.forEach((w, i) => {
      const span = document.createElement('span');
      span.className = 'iv-word';
      span.textContent = w;
      container.appendChild(span);
      wordEls.push(span);
      if (i < words.length - 1) {
        container.appendChild(document.createTextNode(' '));
      }
    });
    textEl.appendChild(container);
    return { el: container, words: wordEls, def: p };
  });

  // Pre-compute reveal offsets (ms from audio start) for each word.
  phraseEls.forEach((ph) => {
    const span = ph.def.end - ph.def.start;
    const interval = ph.words.length > 1 ? span / ph.words.length : span;
    ph.wordOffsets = ph.words.map((_, i) => ph.def.start + i * interval);
  });

  // ----- Audio -----
  const audio = new Audio(AUDIO_SRC);
  audio.preload = 'auto';

  // ----- Sync loop -----
  let activePhraseIdx = -1;
  const revealed = new Set();
  let raf = 0;
  let endHandled = false;

  function tick() {
    raf = requestAnimationFrame(tick);
    if (audio.paused && !audio.ended) return;
    const tMs = audio.currentTime * 1000;

    // The active phrase is the most recent one whose start has passed.
    // We do NOT fade phrases out before their `end` — instead we let
    // each phrase stay visible until the next phrase becomes active,
    // which gives the user the entire silent gap between phrases as
    // read time. The last phrase stays visible until the end-of-audio
    // handler fires the morph.
    let nextActive = -1;
    for (let i = phraseEls.length - 1; i >= 0; i--) {
      if (tMs >= phraseEls[i].def.start - 80) { nextActive = i; break; }
    }
    if (nextActive !== activePhraseIdx) {
      if (activePhraseIdx >= 0) {
        phraseEls[activePhraseIdx].el.classList.remove('is-active');
      }
      activePhraseIdx = nextActive;
      if (activePhraseIdx >= 0) {
        phraseEls[activePhraseIdx].el.classList.add('is-active');
      }
    }

    // Reveal each word inside the active phrase at its scheduled time.
    if (activePhraseIdx >= 0) {
      const cur = phraseEls[activePhraseIdx];
      for (let i = 0; i < cur.words.length; i++) {
        const key = activePhraseIdx + ':' + i;
        if (revealed.has(key)) continue;
        if (tMs >= cur.wordOffsets[i]) {
          cur.words[i].classList.add('is-revealed');
          revealed.add(key);
        }
      }
    }

    if (!endHandled && audio.ended) {
      endHandled = true;
      cancelAnimationFrame(raf);
      // Reveal any remaining words instantly so nothing's left
      // half-visible during the morph-out.
      phraseEls.forEach((ph, pi) => {
        ph.words.forEach((w, wi) => {
          const key = pi + ':' + wi;
          if (!revealed.has(key)) { w.classList.add('is-revealed'); revealed.add(key); }
        });
      });
      setTimeout(beginMorph, HOLD_AFTER_END_MS);
    }
  }

  // ----- Orb-to-radial morph -----
  // Single coordinated transition. The radial coexists with the orb
  // during the morph: it starts at the orb's position, scaled to
  // match the orb's visible size, fully transparent. The orb starts
  // at its current position, full size, fully opaque.
  //
  // Then both elements run the same 1400 ms transition with the same
  // easing curve:
  //   - top:        orb-position → welcome-position (~95%)
  //   - opacity:    radial 0→1, orb 1→0
  //   - scale:      radial 0.565→1 (radial grows; orb stays its size
  //                 since scaling an iframe blurs its three.js canvas)
  //
  // Because both are animated from the same starting position with
  // the same easing, the eye reads them as a single element changing
  // shape mid-flight. Once the transition lands, the radial is at
  // the welcome position and the orb is invisible — we drop the
  // intro-voice screen and reveal welcome.
  function beginMorph() {
    // Step 0. Fade the captions FIRST so they're gone before the
    // orb starts moving. If we let them fade together, the user
    // sees a phrase still drifting on screen as the orb slides
    // down and that reads as messy.
    if (textEl) textEl.classList.add('is-leaving');

    setTimeout(() => {
      // 1. Snap the radial to the morphing state (no transition, so it
      //    appears at the orb's spot scaled-to-orb-size, transparent).
      document.body.setAttribute('data-bg-state', 'morphing');

      // 2. Force the morphing styles to commit before triggering the
      //    welcome transition. Two rAFs is the standard belt-and-braces
      //    way to make sure the previous state was painted.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        // 3. Trigger the unified transition: radial → welcome state,
        //    orb → .is-leaving. Same duration/easing in CSS.
        document.body.setAttribute('data-bg-state', 'welcome');
        screen.classList.add('is-leaving');

        // 4. After the transition completes, swap which screen is
        //    .active and free orb GPU resources.
        setTimeout(() => {
          screen.classList.remove('active');
          const welcome = document.querySelector('.screen[data-screen="welcome"]');
          if (welcome) welcome.classList.add('active');
          if (orbFrame && orbFrame.parentNode) orbFrame.parentNode.removeChild(orbFrame);
        }, MORPH_DURATION_MS + 60);
      }));
    }, CAPTIONS_FADE_LEAD);
  }

  // ----- Intriguing prompt fallback -----
  // If autoplay is blocked, surface a soft italic invitation in the
  // same spot where the script will appear. The whole stage becomes
  // tappable. On tap, the prompt fades and audio starts.
  let promptEl = null;
  function showPrompt() {
    if (promptEl) return;
    promptEl = document.createElement('div');
    promptEl.className = 'iv-prompt';
    promptEl.textContent = PROMPT_TEXT;
    textEl.parentNode.insertBefore(promptEl, textEl);
    // Whole stage is tappable while prompt is shown.
    stage.dataset.tappable = 'true';
    // Fade-in on the next frame — instant for the user, but still
    // a smooth opacity transition.
    requestAnimationFrame(() => promptEl.classList.add('is-shown'));

    function dismiss() {
      stage.removeEventListener('click', dismiss);
      stage.removeEventListener('touchend', dismiss);
      promptEl.classList.remove('is-shown');
      stage.dataset.tappable = '';
      // Wake the orb: scales down from screen-filling 2.5× to its
      // natural size and ramps opacity to full. CSS handles the
      // transition (~1.1s).
      stage.classList.remove('is-asleep');
      // Try to play; on success, kick the sync loop. We DO NOT
      // surface a second fallback if this also fails — at this
      // point the user has tapped, so it should always work.
      audio.play().catch(() => {});
      raf = requestAnimationFrame(tick);
    }
    stage.addEventListener('click', dismiss);
    stage.addEventListener('touchend', dismiss);
  }

  // ----- Kickoff -----
  // Try audio playback as soon as the file is buffered. We don't
  // wait for the orb's grow-in to finish — if autoplay is blocked
  // (the usual case), we want the prompt to surface immediately
  // so the user has a clear cue from the very first second.
  function startWhenReady() {
    tryStart();
  }
  function tryStart() {
    const p = audio.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        // Autoplay worked. Wake the orb (CSS scales it down) and
        // run the caption sync loop alongside the audio.
        stage.classList.remove('is-asleep');
        raf = requestAnimationFrame(tick);
      }).catch(() => {
        // Autoplay blocked — show the prompt and keep the orb
        // asleep until the user taps. dismiss() handles the rest.
        showPrompt();
      });
    } else {
      // Older browser without play()-returns-promise. Best-effort:
      // assume it played, wake the orb, run captions.
      stage.classList.remove('is-asleep');
      raf = requestAnimationFrame(tick);
    }
  }

  if (audio.readyState >= 2) {
    startWhenReady();
  } else {
    audio.addEventListener('canplaythrough', startWhenReady, { once: true });
    // Hard fallback: if loading takes too long, start anyway after
    // 2.5s so we don't sit forever waiting for an asset that
    // never arrives.
    setTimeout(() => { if (!raf && !audio.paused === false) startWhenReady(); }, 2500);
  }
})();
