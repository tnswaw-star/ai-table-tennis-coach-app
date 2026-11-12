import { mountRecorder } from './recorder.js';
import { parseYouTubeId } from './logic.js';
import { verifiedVideos } from '../data/curriculum.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const id = () => globalThis.crypto?.randomUUID?.() ?? `clip-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const verifiedIds = new Set(verifiedVideos.map(video => video.id));

/** 示範外連限研究清單內的影片；不直接載入任何外部媒體。 */
export function validateDemoUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error('請輸入完整的影片網址。');
  if (!value.trim()) return '';
  const videoId = parseYouTubeId(value);
  if (!videoId || !verifiedIds.has(videoId)) throw new Error('只接受研究清單內已驗證的 YouTube 影片網址。');
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function frameTime(currentTime, direction, duration = Infinity) {
  const current = Number.isFinite(currentTime) ? currentTime : 0;
  const maximum = Number.isFinite(duration) && duration >= 0 ? duration : Infinity;
  return Math.max(0, Math.min(maximum, current + (direction < 0 ? -1 : 1) / 30));
}

/** A failed member pauses the whole comparison so it cannot silently drift. */
export async function synchronizePlayback(videos, command, value) {
  const playable = videos.filter(video => Boolean(video?.src));
  if (command === 'play') {
    try { await Promise.all(playable.map(video => video.play())); }
    catch (error) { playable.forEach(video => video.pause()); throw error; }
  } else if (command === 'pause') {
    playable.forEach(video => video.pause());
  } else if (command === 'rate') {
    if (![0.25, 0.5, 1].includes(value)) throw new Error('不支援的播放速度。');
    playable.forEach(video => { video.playbackRate = value; });
  } else if (command === 'frame') {
    playable.forEach(video => { video.pause(); video.currentTime = frameTime(video.currentTime, value, video.duration); });
  } else if (command === 'loop') {
    playable.forEach(video => { video.loop = value === true; });
  }
}

/** Videos stay in LocalStore's IndexedDB; student feedback contains text only. */
export function mountVideoReview(container, { store, student, exercise, isCoach = false, onChange, demos = {}, onDemoChange } = {}) {
  let disposed = false;
  let clips = [];
  let selected = null;
  let clipUrl = null;
  let demoUrl = null;
  let localStudent = student;
  let loadVersion = 0;
  let demoVersion = 0;
  let demoConfig = { ...(demos[exercise.id] || {}) };
  let externalDemoUrl = '';
  container.innerHTML = `
    <section aria-label="拍攝練習影片"><h2>錄下練習</h2><div data-camera-panel></div></section>
    <section class="video-library" aria-label="本機練習片段">
      <h2>片段庫 · ${escape(exercise.name || exercise.title || exercise.id)}</h2>
      <p class="muted">每位學員保留最近 20 段，影片不會匯出或同步。請下載重要片段另行備份。</p>
      <label>加入本機練習影片<input type="file" accept="video/*" data-import-clip></label>
      <label>選擇片段<select data-clip-select aria-label="選擇練習片段"><option value="">正在讀取片段…</option></select></label>
      <p class="notice" role="status" data-review-status>正在讀取本機片段…</p>
      <div class="video-compare">
        <figure><figcaption>學員練習</figcaption><video class="video-frame" data-student-video aria-label="學員練習片段" playsinline controls preload="metadata"></video></figure>
        <figure><figcaption>教練示範</figcaption><video class="video-frame" data-demo-video aria-label="教練示範影片" playsinline controls preload="metadata"></video><a class="btn secondary" data-demo-link target="_blank" rel="noopener noreferrer" hidden>開啟已驗證的教學影片</a><p class="muted" data-demo-network hidden>需要網路才能看影片</p><p class="muted" data-demo-empty>尚未設定示範影片，請教練加入本機影片或已驗證的影片連結。</p></figure>
      </div>
      <div class="recorder-actions" aria-label="並排回看控制">
        <button class="btn secondary" data-play type="button" disabled>同步播放</button>
        <button class="btn secondary" data-pause type="button" disabled>同步暫停</button>
        <button class="btn secondary" data-back type="button" disabled>退一格</button>
        <button class="btn secondary" data-forward type="button" disabled>進一格</button>
      </div>
      <div class="form-grid"><label>播放速度<select data-speed><option value="0.25">0.25 倍</option><option value="0.5">0.5 倍</option><option value="1" selected>1 倍</option></select></label>
      <label class="check-row"><input type="checkbox" data-loop>重複播放</label></div>
      <p class="muted">逐格以 1/30 秒前進或後退。影片長度不同時，以學員片段時間對齊示範。</p>
      <form data-note-form><label>片段備註<textarea data-clip-note maxlength="2000" rows="3" disabled></textarea></label>
        <div class="recorder-actions"><button class="btn secondary" type="submit" disabled data-save-note>儲存備註</button><a class="btn secondary" data-clip-download hidden>下載片段</a><button class="btn danger" type="button" data-delete-clip disabled>刪除片段</button></div>
      </form>
      <h3>教練回饋</h3><div data-clip-feedback><p class="muted">尚無教練回饋。</p></div>
      ${isCoach ? '<form data-coach-form><label>給此片段的建議<textarea data-coach-note maxlength="2000" required rows="3"></textarea></label><button class="btn secondary" type="submit" data-save-feedback disabled>送出教練回饋</button></form>' : ''}
    </section>
    ${isCoach ? `<details><summary>設定這個動作的示範影片</summary>
      <p class="muted">請使用有權使用的本機影片。外部連結只接受研究清單內已驗證的教學影片，點擊後另開分頁；本機影片才支援並排同步回看。影片版權屬原頻道；由教練審核是否適用。</p>
      <label>本機示範影片<input type="file" accept="video/*" data-import-demo></label>
      <form data-demo-form><label>已驗證的教學影片連結<input type="url" data-demo-url placeholder="https://www.youtube.com/watch?v=…" value="${escape(demoConfig.url || '')}"></label><button class="btn secondary" type="submit" data-save-demo>儲存影片連結</button></form>
    </details>` : ''}`;
  const $ = selector => container.querySelector(selector);
  const left = $('[data-student-video]');
  const right = $('[data-demo-video]');
  const status = $('[data-review-status]');
  const select = $('[data-clip-select]');
  const note = $('[data-clip-note]');
  const download = $('[data-clip-download]');
  const speed = $('[data-speed]');
  const loop = $('[data-loop]');
  const say = message => { if (!disposed) status.textContent = message; };
  const revoke = url => { if (url) URL.revokeObjectURL(url); };
  const dateLabel = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-TW') : '日期未知';
  const videos = () => [left, right];
  function feedbackList() {
    const feedback = (localStudent.feedback || []).filter(item => item.targetType === 'video' && item.targetId === selected?.id);
    $('[data-clip-feedback]').innerHTML = feedback.length ? feedback.map(item => `<p>${escape(item.text)}<br><small class="muted">${escape(dateLabel(item.createdAt))}</small></p>`).join('') : '<p class="muted">尚無教練回饋。</p>';
  }
  async function run(button, operation) {
    if (disposed) return;
    if (button) button.disabled = true;
    try { await operation(); }
    catch (error) { say(error.message || '無法完成操作，請檢查本機空間或影片格式後重試。'); }
    finally {
      if (!disposed && button) {
        const clipButton = ['[data-save-note]', '[data-delete-clip]', '[data-save-feedback]'].some(selector => $(selector) === button);
        button.disabled = clipButton && !selected;
      }
    }
  }
  function chooseClip(clip) {
    left.pause();
    right.pause();
    revoke(clipUrl);
    clipUrl = null;
    selected = clip || null;
    left.removeAttribute('src');
    if (clip) {
      clipUrl = URL.createObjectURL(clip.blob);
      left.src = clipUrl;
      left.playbackRate = Number(speed.value);
      left.loop = loop.checked;
    }
    left.load();
    note.value = clip?.note || '';
    note.disabled = !clip;
    for (const selector of ['[data-play]', '[data-pause]', '[data-back]', '[data-forward]', '[data-save-note]', '[data-delete-clip]', '[data-save-feedback]']) {
      const element = $(selector);
      if (element) element.disabled = !clip;
    }
    download.hidden = !clip;
    if (clip) { download.href = clipUrl; download.download = `桌球練習-${clip.id}.${clip.blob.type?.includes('mp4') ? 'mp4' : 'webm'}`; }
    else download.removeAttribute('href');
    feedbackList();
  }
  async function refreshClips(preferId = selected?.id) {
    if (disposed) return;
    const revision = ++loadVersion;
    const loaded = await store.listVideos(student.id);
    if (disposed || revision !== loadVersion) return;
    clips = loaded.filter(clip => clip.exerciseId === exercise.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    select.innerHTML = clips.length ? clips.map(clip => `<option value="${escape(clip.id)}">${escape(dateLabel(clip.createdAt))}${clip.note ? ` · ${escape(clip.note.slice(0, 30))}` : ''}</option>`).join('') : '<option value="">此動作尚無片段</option>';
    const preferred = clips.find(clip => clip.id === preferId) || clips[0];
    select.value = preferred?.id || '';
    select.disabled = clips.length === 0;
    chooseClip(preferred);
    say(clips.length ? `此動作共有 ${clips.length} 段本機影片。選擇片段後可慢放與比較。` : '此動作尚無片段。錄影或加入本機影片後，就能回看。');
  }
  async function saveRecording(blob) {
    if (!blob || blob.size === 0 || !blob.type?.startsWith('video/')) throw new Error('請選擇有效的影片檔案。');
    const clip = { id: id(), studentId: student.id, exerciseId: exercise.id, createdAt: new Date().toISOString(), note: '', blob };
    await store.saveVideo(clip);
    if (!disposed) { await refreshClips(clip.id); say('片段已保存到此裝置，重新開啟仍可回看。'); }
  }
  function updateDemoNetwork() {
    const offline = globalThis.navigator?.onLine === false;
    const link = $('[data-demo-link]');
    link.hidden = !externalDemoUrl || offline;
    if (externalDemoUrl && !offline) link.href = externalDemoUrl;
    else link.removeAttribute('href');
    $('[data-demo-network]').hidden = !externalDemoUrl || !offline;
  }
  async function loadDemo(config = demoConfig) {
    if (disposed) return;
    const revision = ++demoVersion;
    right.pause();
    right.removeAttribute('src');
    revoke(demoUrl);
    demoUrl = null;
    externalDemoUrl = '';
    right.hidden = false;
    updateDemoNetwork();
    if (config?.url) {
      // 舊版任意媒體連結也不能觸發外部載入；驗證失敗時保留空白播放器。
      externalDemoUrl = validateDemoUrl(config.url);
      right.hidden = true;
    } else {
      const stored = await store.getDemo(exercise.id);
      if (disposed || revision !== demoVersion) return;
      const blob = stored?.blob || stored;
      if (blob instanceof Blob) { demoUrl = URL.createObjectURL(blob); right.src = demoUrl; }
    }
    if (disposed) return;
    right.load();
    right.playbackRate = Number(speed.value);
    right.loop = loop.checked;
    $('[data-demo-empty]').hidden = Boolean(right.src || externalDemoUrl);
    updateDemoNetwork();
  }
  const cleanupRecorder = mountRecorder($('[data-camera-panel]'), { onRecorded: saveRecording });
  select.addEventListener('change', () => { chooseClip(clips.find(clip => clip.id === select.value)); });
  $('[data-import-clip]').addEventListener('change', event => run(event.target, async () => {
    const file = event.target.files?.[0];
    if (file) await saveRecording(file);
    event.target.value = '';
  }));
  $('[data-note-form]').addEventListener('submit', event => {
    event.preventDefault();
    run($('[data-save-note]'), async () => {
      if (!selected) return;
      await store.saveVideo({ ...selected, note: note.value.trim() });
      await refreshClips(selected.id);
      say('片段備註已儲存。');
    });
  });
  $('[data-delete-clip]').addEventListener('click', () => run($('[data-delete-clip]'), async () => {
    if (!selected || !globalThis.confirm('確定刪除此本機片段？刪除後無法復原。')) return;
    await store.deleteVideo(selected.id);
    await refreshClips();
    say('片段已從此裝置刪除。');
  }));
  $('[data-play]').addEventListener('click', () => run(null, async () => {
    right.currentTime = Math.min(left.currentTime || 0, Number.isFinite(right.duration) ? right.duration : Infinity);
    await synchronizePlayback(videos(), 'play');
  }));
  $('[data-pause]').addEventListener('click', () => synchronizePlayback(videos(), 'pause'));
  $('[data-back]').addEventListener('click', () => run(null, () => synchronizePlayback(videos(), 'frame', -1)));
  $('[data-forward]').addEventListener('click', () => run(null, () => synchronizePlayback(videos(), 'frame', 1)));
  speed.addEventListener('change', () => run(null, () => synchronizePlayback(videos(), 'rate', Number(speed.value))));
  loop.addEventListener('change', () => synchronizePlayback(videos(), 'loop', loop.checked));
  // Native video controls follow the same comparison controls as the toolbar.
  for (const [video, other] of [[left, right], [right, left]]) {
    video.addEventListener('pause', () => { if (!disposed && !other.paused) other.pause(); });
    video.addEventListener('play', () => {
      if (!disposed && other.src && other.paused) other.play().catch(() => {
        video.pause();
        say('比較影片無法播放。請教練檢查影片連結或檔案格式。');
      });
    });
    video.addEventListener('ratechange', () => {
      if (disposed) return;
      const rate = [0.25, 0.5, 1].includes(video.playbackRate) ? video.playbackRate : 1;
      speed.value = String(rate);
      if (other.playbackRate !== rate) other.playbackRate = rate;
      if (video.playbackRate !== rate) video.playbackRate = rate;
    });
    video.addEventListener('seeking', () => {
      if (!disposed && video === left && other.src) {
        const time = Math.min(video.currentTime, Number.isFinite(other.duration) ? other.duration : Infinity);
        if (Math.abs(other.currentTime - time) > 0.005) other.currentTime = time;
      }
    });
  }
  left.addEventListener('timeupdate', () => {
    if (!disposed && right.src && !left.paused && Math.abs(right.currentTime - left.currentTime) > 0.2) {
      right.currentTime = Math.min(left.currentTime, Number.isFinite(right.duration) ? right.duration : Infinity);
    }
  });
  for (const video of videos()) video.addEventListener('error', () => say('本機影片無法播放，請檢查檔案格式，或重新加入有效的影片。'));
  if (isCoach) {
    $('[data-coach-form]').addEventListener('submit', event => {
      event.preventDefault();
      run($('[data-save-feedback]'), async () => {
        const text = $('[data-coach-note]').value.trim();
        if (!selected || !text) return;
        const entry = { id: id(), targetType: 'video', targetId: selected.id, text, createdAt: new Date().toISOString() };
        const next = { ...localStudent, feedback: [...(localStudent.feedback || []), entry] };
        if (await onChange?.(next) === false) throw new Error('教練回饋未儲存，請先處理資料儲存問題後重試。');
        localStudent = next;
        $('[data-coach-note]').value = '';
        feedbackList();
        say('教練回饋已儲存，可隨學員檔交換。');
      });
    });
    $('[data-import-demo]').addEventListener('change', event => run(event.target, async () => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('video/')) throw new Error('請選擇有效的示範影片。');
      await store.saveDemo(exercise.id, file);
      const { url: previousUrl, ...previous } = demoConfig;
      const config = { ...previous, type: 'local' };
      if (await onDemoChange?.(exercise.id, config) === false) throw new Error('本機示範設定未儲存，請處理資料儲存問題後重試。');
      demoConfig = config;
      $('[data-demo-url]').value = '';
      await loadDemo(config);
      say('示範影片已保存到此裝置。');
      event.target.value = '';
    }));
    $('[data-demo-form]').addEventListener('submit', event => {
      event.preventDefault();
      run($('[data-save-demo]'), async () => {
        const url = validateDemoUrl($('[data-demo-url]').value);
        const { url: previousUrl, ...previous } = demoConfig;
        const config = url ? { ...previous, type: 'url', url } : { ...previous, type: 'local' };
        if (await onDemoChange?.(exercise.id, config) === false) throw new Error('示範影片設定未儲存，請處理資料儲存問題後重試。');
        demoConfig = config;
        await loadDemo(config);
        say(url ? '示範影片連結已儲存。' : '影片連結已清除；如有本機示範，會使用本機影片。');
      });
    });
  }
  run(null, refreshClips);
  run(null, loadDemo);
  globalThis.addEventListener?.('online', updateDemoNetwork);
  globalThis.addEventListener?.('offline', updateDemoNetwork);
  return () => {
    disposed = true;
    cleanupRecorder();
    videos().forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
    revoke(clipUrl);
    revoke(demoUrl);
    globalThis.removeEventListener?.('online', updateDemoNetwork);
    globalThis.removeEventListener?.('offline', updateDemoNetwork);
  };
}
