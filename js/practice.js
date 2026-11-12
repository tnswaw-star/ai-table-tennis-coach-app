/** A small deterministic session model shared by the guided screen and its tests. */
export function createPracticeSession({ reps, sets, restSeconds = 30 }) {
  if (!Number.isInteger(reps) || reps < 1 || reps > 10000
    || !Number.isInteger(sets) || sets < 1 || sets > 100
    || !Number.isInteger(restSeconds) || restSeconds < 0 || restSeconds > 600) {
    throw new Error('請設定有效的次數、組數與休息秒數。');
  }
  let currentSet = 1;
  let count = 0;
  let remaining = 0;
  let status = 'ready';
  const snapshot = () => ({ reps, sets, currentSet, count, remaining, status });
  return {
    snapshot,
    start() { if (status === 'ready') status = 'active'; return snapshot(); },
    hit() {
      if (status !== 'active') return snapshot();
      count += 1;
      if (count === reps) {
        if (currentSet === sets) status = 'done';
        else if (restSeconds > 0) { status = 'rest'; remaining = restSeconds; }
        else { currentSet += 1; count = 0; }
      }
      return snapshot();
    },
    tick(seconds = 1) {
      if (status !== 'rest' || !Number.isFinite(seconds) || seconds <= 0) return snapshot();
      remaining = Math.max(0, remaining - seconds);
      if (remaining === 0) { currentSet += 1; count = 0; status = 'active'; }
      return snapshot();
    },
    skipRest() {
      if (status === 'rest') { remaining = 0; currentSet += 1; count = 0; status = 'active'; }
      return snapshot();
    },
  };
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** Every mount owns its timers and speech; returning cleanup never records a session. */
export function mountGuidedPractice(container, { exercise, onFinish }) {
  let disposed = false;
  let timer = null;
  let session = null;
  let startedAt = 0;
  let lastTick = 0;
  let nextBeat = 0;
  let paused = false;
  let pauseStarted = 0;
  let pausedDuration = 0;
  let finished = false;
  container.innerHTML = `
    <div class="guided-practice">
      <h2>${escape(exercise.name)}・引導練習</h2>
      <p class="muted">先設定練習量，再點大按鈕計數；也可讓自動節拍帶著練。</p>
      <form data-guided-settings class="form-grid">
        <label>每組次數<input name="reps" type="number" min="1" max="10000" required value="${exercise.prescription.reps}"></label>
        <label>總組數<input name="sets" type="number" min="1" max="100" required value="${exercise.prescription.sets}"></label>
        <label>組間休息（秒）<input name="rest" type="number" min="0" max="600" required value="30"></label>
        <label>每下秒數<input name="tempo" type="number" min="0.5" max="10" step="0.1" required value="2"></label>
        <label class="check-row"><input name="voice" type="checkbox" checked>語音口令</label>
        <label class="check-row"><input name="auto" type="checkbox">自動節拍</label>
        <button class="btn" type="submit">開始引導練習</button>
      </form>
      <div class="recorder-actions">
        <button class="btn secondary" type="button" data-guided-listen>聽分解步驟</button>
        <button class="btn secondary" type="button" data-guided-fullscreen>全螢幕練習</button>
      </div>
      <p class="notice" role="status" aria-live="polite" data-guided-status>準備好後再開始。語音不支援時仍可正常計數。</p>
      <p class="guided-sets" data-guided-sets>尚未開始</p>
      <button class="btn guided-counter" style="width:100%;min-height:180px;font-size:2rem" type="button" data-guided-count disabled>點一下，計一次</button>
      <div class="recorder-actions">
        <button class="btn secondary" type="button" data-guided-pause disabled>暫停練習</button>
        <button class="btn secondary" type="button" data-guided-skip hidden>略過休息</button>
      </div>
    </div>`;
  const find = selector => container.querySelector(selector);
  const form = find('[data-guided-settings]');
  const status = find('[data-guided-status]');
  const sets = find('[data-guided-sets]');
  const counter = find('[data-guided-count]');
  const pauseButton = find('[data-guided-pause]');
  const skipButton = find('[data-guided-skip]');
  const input = name => form.elements.namedItem(name);

  function speak(text) {
    if (disposed || !input('voice').checked || !globalThis.speechSynthesis
      || typeof globalThis.SpeechSynthesisUtterance !== 'function') return;
    try {
      globalThis.speechSynthesis.cancel();
      const utterance = new globalThis.SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-TW';
      utterance.rate = 1.3;
      globalThis.speechSynthesis.speak(utterance);
    } catch { /* Speech is optional on devices without a usable voice. */ }
  }
  function render() {
    if (disposed || !session) return;
    const current = session.snapshot();
    sets.textContent = `第 ${current.currentSet} 組／共 ${current.sets} 組 · ${current.count}／${current.reps} 次`;
    counter.textContent = current.status === 'rest' ? `休息 ${Math.ceil(current.remaining)} 秒`
      : current.status === 'done' ? '已完成練習' : `${current.count}／${current.reps} 次 · 點一下計一次`;
    counter.disabled = paused || current.status !== 'active' || input('auto').checked;
    skipButton.hidden = current.status !== 'rest';
    skipButton.disabled = paused;
    pauseButton.disabled = current.status === 'done';
    status.textContent = paused ? '練習已暫停，按「繼續練習」恢復。'
      : current.status === 'rest' ? `本組完成，休息 ${Math.ceil(current.remaining)} 秒後開始下一組。`
        : current.status === 'done' ? '練習完成，正在帶入紀錄表單。'
          : input('auto').checked ? '自動節拍中，跟著口令練習即可。' : '每完成一個動作，點一下大按鈕。';
  }
  function complete() {
    if (finished || disposed || session.snapshot().status !== 'done') return;
    finished = true;
    clearInterval(timer);
    timer = null;
    speak('全部練習完成，請記錄今天的穩定度。');
    const current = session.snapshot();
    onFinish?.({ reps: current.reps, sets: current.sets,
      minutes: Math.max(0.01, Math.round((Date.now() - startedAt - pausedDuration) / 600) / 100) });
  }
  function hit() {
    if (disposed || paused || !session || session.snapshot().status !== 'active') return;
    const before = session.snapshot();
    const current = session.hit();
    if (current.status === 'done') speak('全部練習完成。');
    else if (current.status === 'rest') speak(`第 ${before.currentSet} 組完成，休息 ${Math.ceil(current.remaining)} 秒。`);
    else if (current.currentSet !== before.currentSet) speak(`第 ${before.currentSet} 組完成，開始第 ${current.currentSet} 組。`);
    else speak(`一、二、三。${current.count % 5 === 0 ? `已完成 ${current.count} 次。` : ''}`);
    render();
    complete();
  }
  function tick() {
    if (disposed || paused || !session) return;
    const now = Date.now();
    const before = session.snapshot();
    if (before.status === 'rest') {
      const current = session.tick(Math.max(0, now - lastTick) / 1000);
      if (current.status === 'active') {
        speak(`休息結束，開始第 ${current.currentSet} 組。一、二、三。`);
        nextBeat = now + Number(input('tempo').value) * 1000;
      }
      render();
    } else if (before.status === 'active' && input('auto').checked && now >= nextBeat) {
      hit();
      // Never create a burst of fictitious repetitions after a suspended browser tab.
      nextBeat = now + Number(input('tempo').value) * 1000;
    }
    lastTick = now;
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (session || disposed || !form.reportValidity()) return;
    try {
      session = createPracticeSession({ reps: Number(input('reps').value), sets: Number(input('sets').value), restSeconds: Number(input('rest').value) });
      const tempo = Number(input('tempo').value);
      if (!Number.isFinite(tempo) || tempo < 0.5 || tempo > 10) { session = null; throw new Error('每下秒數請設定在 0.5 至 10 秒。'); }
      session.start();
      startedAt = lastTick = Date.now();
      nextBeat = startedAt + tempo * 1000;
      for (const name of ['reps', 'sets', 'rest', 'tempo', 'auto']) input(name).disabled = true;
      form.querySelector('button[type="submit"]').disabled = true;
      speak('開始練習，一、二、三。');
      timer = setInterval(tick, 100);
      render();
    } catch (error) { status.textContent = error.message; }
  });
  counter.addEventListener('click', hit);
  pauseButton.addEventListener('click', () => {
    if (!session || disposed || finished) return;
    paused = !paused;
    if (paused) {
      pauseStarted = Date.now();
      try { globalThis.speechSynthesis?.cancel(); } catch { /* Optional voice. */ }
    } else {
      pausedDuration += Date.now() - pauseStarted;
      lastTick = Date.now();
      nextBeat = lastTick + Number(input('tempo').value) * 1000;
      speak('繼續練習，一、二、三。');
    }
    pauseButton.textContent = paused ? '繼續練習' : '暫停練習';
    render();
  });
  skipButton.addEventListener('click', () => {
    if (!session || paused || disposed) return;
    session.skipRest();
    lastTick = Date.now();
    nextBeat = lastTick + Number(input('tempo').value) * 1000;
    speak('休息結束，一、二、三。');
    render();
  });
  input('voice').addEventListener('change', () => {
    if (!input('voice').checked) {
      try { globalThis.speechSynthesis?.cancel(); } catch { /* Optional voice. */ }
    }
  });
  find('[data-guided-listen]').addEventListener('click', () => speak(exercise.steps.join('。')));
  find('[data-guided-fullscreen]').addEventListener('click', async () => {
    try {
      if (container.requestFullscreen) await container.requestFullscreen();
      else status.textContent = '此瀏覽器不支援全螢幕，仍可使用下方大按鈕練習。';
    } catch { status.textContent = '目前無法進入全螢幕，仍可照常練習。'; }
  });
  return () => {
    disposed = true;
    clearInterval(timer);
    try { globalThis.speechSynthesis?.cancel(); } catch { /* Optional voice. */ }
    if (globalThis.document?.fullscreenElement === container) {
      try { Promise.resolve(document.exitFullscreen()).catch(() => {}); } catch { /* The page may already be leaving fullscreen. */ }
    }
  };
}
