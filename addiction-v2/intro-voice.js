// addiction-v2/intro-voice.js
//
// Plays a short Mia greeting on the second screen of v2 — entered when
// the user taps "Start the test" on the welcome screen.
//
// Architecture:
//   - Orb runs in its own iframe (./orb.html), mounted globally inside
//     .bg-stage so it can morph between bg-state positions in lockstep
//     with the .hero-glow radial. The pair reads as one element
//     transforming through the flow (welcome → voice → top).
//   - Caption text container has a fixed height; phrases overlap each
//     other (absolute positioning) so the layout never shifts as new
//     phrases come in. Word reveal is driven from audio.currentTime —
//     a brief decode stall never desyncs captions from the voice.
//   - Audio kickoff is bound to the welcome-button tap, which is a
//     user gesture, so autoplay should always succeed. A "tap to see
//     it clearly" prompt remains as a defensive fallback for the
//     unlikely case the play() promise still rejects.
//   - On end-of-audio + brief pause, the captions fade and we hand
//     off to the name screen by re-clicking #welcomeNext. App.js's
//     bound handler runs goTo('name'), which sets bg-state='top' —
//     CSS picks that up and morphs the orb upward + fades it out
//     while the radial morphs upward + fades in at the top.

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
  // beginning the fade-out. Keeps the closing line from feeling abrupt.
  const HOLD_AFTER_END_MS   = 1400;
  // Captions fade out before we trigger goTo('name'), so the user sees
  // the phrase dissolve and then the orb morph upward into the radial.
  const CAPTIONS_FADE_LEAD  = 550;
  // Welcome content fade — matches the CSS transition on
  // .screen[data-screen="welcome"].is-leaving > .screen-body.
  const WELCOME_FADE_MS     = 350;
  // Orb ↔ radial morph duration — matches the CSS transition
  // (top/opacity/transform on .iv-orb and .hero-glow, both 900 ms).
  const MORPH_MS            = 900;
  // Defensive fallback prompt copy if audio.play() rejects despite the
  // user gesture. Never expected to surface in the normal flow.
  const PROMPT_TEXT         = 'Tap to see it clearly';

  // ----- DOM -----
  const screen        = document.querySelector('.screen[data-screen="intro-voice"]');
  if (!screen) return;
  const stage         = screen.querySelector('.iv-stage');
  const textEl        = document.getElementById('ivText');
  const orbFrame      = document.getElementById('orbFrame');
  const welcomeBtn    = document.getElementById('welcomeNext');
  const welcomeScreen = document.querySelector('.screen[data-screen="welcome"]');
  if (!stage || !textEl || !welcomeBtn || !welcomeScreen) return;

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
    // read time. The last phrase stays visible until end-of-audio
    // triggers the exit.
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
      // half-visible during the fade-out.
      phraseEls.forEach((ph, pi) => {
        ph.words.forEach((w, wi) => {
          const key = pi + ':' + wi;
          if (!revealed.has(key)) { w.classList.add('is-revealed'); revealed.add(key); }
        });
      });
      setTimeout(exitToName, HOLD_AFTER_END_MS);
    }
  }

  // ----- Exit handoff -----
  // Fade captions, then re-click #welcomeNext so app.js's existing
  // bound handler runs goTo('name'). goTo sets bg-state='top', which
  // triggers the orb ↔ radial upward morph (CSS, 900 ms). The
  // voiceComplete flag tells our capture-phase interceptor below to
  // stay out of the way for that synthetic click.
  let voiceStarted  = false;
  let voiceComplete = false;

  function exitToName() {
    if (textEl) textEl.classList.add('is-leaving');
    setTimeout(() => {
      voiceComplete = true;
      // Hand off to app.js. goTo('name') swaps active screens, sets
      // bg-state='top' (which triggers the upward morph: orb floats
      // up + scales + fades, radial floats up + scales in + fades in),
      // shows progress + back chrome, and focuses the name input.
      welcomeBtn.click();
      // After the morph completes, free the orb's three.js context.
      // The orb is opacity:0 by then, so removing it is invisible.
      setTimeout(() => {
        if (orbFrame && orbFrame.parentNode) {
          orbFrame.parentNode.removeChild(orbFrame);
        }
      }, MORPH_MS + 60);
    }, CAPTIONS_FADE_LEAD);
  }

  // ----- Welcome → intro-voice handoff -----
  // Capture-phase listener intercepts the welcome button tap before
  // app.js's bubble-phase handler (which would otherwise navigate
  // straight to 'name'). We start the morph + voice here; once it
  // ends, exitToName() re-clicks the button with voiceComplete=true
  // so app.js can run normally.
  function startIntroVoice() {
    voiceStarted = true;
    // Fade welcome content out (CSS handles the 350 ms transition).
    welcomeScreen.classList.add('is-leaving');
    // Trigger the morph: bg-state='voice' makes the radial shrink down
    // to the orb's footprint at center and fade out, while the orb
    // (which sat at the radial position, transparent) moves to center
    // at its natural size and fades in. Both run for 900 ms in lockstep.
    document.body.setAttribute('data-bg-state', 'voice');

    // Once welcome content has dimmed, swap which screen is .active
    // and start the audio. The orb is still mid-morph at this point —
    // the voice begins and the orb settles into place around the same
    // moment, which feels natural.
    setTimeout(() => {
      welcomeScreen.classList.remove('active', 'is-leaving');
      screen.classList.add('active');

      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          raf = requestAnimationFrame(tick);
        }).catch(() => {
          showPrompt();
        });
      } else {
        raf = requestAnimationFrame(tick);
      }
    }, WELCOME_FADE_MS);
  }

  welcomeBtn.addEventListener('click', (e) => {
    // The synthetic click we fire after the voice ends — defer to
    // app.js so goTo('name') runs normally.
    if (voiceComplete) return;
    // Any other click during voice playback (welcome is hidden so
    // this shouldn't happen, but be defensive): block app.js.
    e.stopImmediatePropagation();
    e.preventDefault();
    if (voiceStarted) return;
    startIntroVoice();
  }, { capture: true });

  // ----- Defensive prompt fallback -----
  // Only reached if audio.play() rejects despite the user gesture
  // (e.g. an exotic autoplay policy). Surfaces a tap target so the
  // user can retry.
  let promptEl = null;
  function showPrompt() {
    if (promptEl) return;
    stage.classList.add('is-asleep');
    promptEl = document.createElement('div');
    promptEl.className = 'iv-prompt';
    promptEl.textContent = PROMPT_TEXT;
    textEl.parentNode.insertBefore(promptEl, textEl);
    stage.dataset.tappable = 'true';
    requestAnimationFrame(() => promptEl.classList.add('is-shown'));

    function dismiss() {
      stage.removeEventListener('click', dismiss);
      stage.removeEventListener('touchend', dismiss);
      promptEl.classList.remove('is-shown');
      stage.dataset.tappable = '';
      stage.classList.remove('is-asleep');
      audio.play().catch(() => {});
      raf = requestAnimationFrame(tick);
    }
    stage.addEventListener('click', dismiss);
    stage.addEventListener('touchend', dismiss);
  }
})();
