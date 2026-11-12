/** Each mount owns its camera tracks and object URL; persistence is delegated. */
export function mountRecorder(container, { onRecorded } = {}) {
  let disposed = false;
  let stream = null;
  let recorder = null;
  let clipUrl = null;
  let timeout = null;
  let chunks = [];
  let opening = false;
  const supported = globalThis.isSecureContext && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  if (!supported) {
    container.innerHTML = '<p class="notice">此瀏覽器或網址無法錄影。請使用支援相機錄影的新版瀏覽器，並以安全網址或本機 localhost 開啟。你仍可照常練習與記錄。</p>';
    return () => { disposed = true; };
  }
  container.innerHTML = `
    <p class="muted">${onRecorded ? '錄影完成後自動存入此裝置，可重新開啟回看。' : '影片只暫存在這個頁面，可回放或自行下載。離開本頁即刪除。'}不上傳、不分析，也不錄製聲音。每段最長 2 分鐘。</p>
    <video class="video-frame" aria-label="相機預覽與練習片段回放" playsinline muted></video>
    <p class="notice" role="status" data-recorder-status>先啟用相機，再開始錄影。請讓全身與球拍都入鏡。</p>
    <div class="recorder-actions">
      <button class="btn secondary" type="button" data-camera>啟用相機</button>
      <button class="btn" type="button" data-record disabled>開始錄影</button>
      <button class="btn secondary" type="button" data-stop disabled>停止錄影</button>
      <a class="btn secondary" data-download hidden>下載片段</a>
      <button class="btn secondary" type="button" data-delete hidden>${onRecorded ? '關閉上方回放' : '刪除此片段'}</button>
    </div>`;
  const video = container.querySelector('video');
  const status = container.querySelector('[data-recorder-status]');
  const cameraButton = container.querySelector('[data-camera]');
  const recordButton = container.querySelector('[data-record]');
  const stopButton = container.querySelector('[data-stop]');
  const download = container.querySelector('[data-download]');
  const deleteButton = container.querySelector('[data-delete]');

  function releaseCamera() {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
  }
  function releaseClip() {
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = null;
    download.hidden = true;
    download.removeAttribute('href');
    deleteButton.hidden = true;
    video.removeAttribute('src');
    video.controls = false;
  }
  function idleButtons() {
    cameraButton.disabled = opening || Boolean(stream);
    recordButton.disabled = !stream;
    stopButton.disabled = true;
  }
  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') {
      stopButton.disabled = true;
      status.textContent = '正在整理本機片段…';
      recorder.stop();
    }
  }
  async function openCamera() {
    if (opening || stream || disposed) return;
    opening = true;
    cameraButton.disabled = true;
    status.textContent = '正在等候相機權限…';
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
      if (disposed) { acquired.getTracks().forEach(track => track.stop()); return; }
      releaseClip();
      stream = acquired;
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      if (!disposed) status.textContent = '相機已就緒，可以開始錄影。';
    } catch (error) {
      if (!disposed) {
        releaseCamera();
        status.textContent = error.name === 'NotAllowedError' || error.name === 'SecurityError'
          ? '未取得相機權限。請允許此網站使用相機後，再按「啟用相機」。'
          : error.name === 'NotFoundError'
            ? '找不到可用相機。請確認裝置已連接，或改用有相機的手機。'
            : '無法啟用相機。相機可能被其他程式使用，請關閉後重試。';
      }
    } finally {
      opening = false;
      if (!disposed) idleButtons();
    }
  }
  function startRecording() {
    if (!stream || disposed || recorder?.state === 'recording') return;
    releaseClip();
    chunks = [];
    let failed = false;
    try {
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorder.ondataavailable = event => { if (!disposed && !failed && event.data.size > 0) chunks.push(event.data); };
      recorder.onerror = () => {
        failed = true;
        clearTimeout(timeout);
        chunks = [];
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch { /* The browser may already be stopping after an error. */ }
        }
        if (!disposed) {
          releaseCamera();
          idleButtons();
          status.textContent = '錄影中斷，片段可能未完成。請重新啟用相機再試一次。';
        }
      };
      recorder.onstop = () => {
        clearTimeout(timeout);
        if (disposed || failed) { chunks = []; return; }
        try {
          const type = recorder.mimeType || chunks[0]?.type || 'video/webm';
          const blob = new Blob(chunks, { type });
          chunks = [];
          releaseCamera();
          idleButtons();
          if (blob.size === 0) { status.textContent = '沒有錄到可播放的內容，請重新錄影。'; return; }
          clipUrl = URL.createObjectURL(blob);
          video.src = clipUrl;
          video.controls = true;
          video.muted = false;
          video.load();
          download.href = clipUrl;
          download.download = `桌球練習-${new Date().toISOString().replace(/[:.]/g, '-')}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
          download.hidden = false;
          deleteButton.hidden = false;
          status.textContent = '錄影完成，可在上方回放或下載。離開此頁會刪除這段暫存影片。';
          if (onRecorded) {
            status.textContent = '錄影完成，正在保存到此裝置…';
            Promise.resolve().then(() => onRecorded(blob)).then(() => {
              if (!disposed) status.textContent = '片段已保存到此裝置，可在下方片段庫回看。';
            }).catch(error => {
              if (!disposed) status.textContent = `錄影完成，但保存失敗：${error.message || '請檢查本機空間。'} 請先下載保留片段，再重試。`;
            });
          }
        } catch {
          failed = true;
          chunks = [];
          releaseCamera();
          releaseClip();
          idleButtons();
          status.textContent = '無法在此裝置建立回放片段，暫存已清除。請重新錄影，或改用其他新版瀏覽器。';
        }
      };
      recorder.start(1000);
      recordButton.disabled = true;
      cameraButton.disabled = true;
      stopButton.disabled = false;
      status.textContent = '錄影中。完成動作後按「停止錄影」，最多錄製 2 分鐘。';
      timeout = setTimeout(stopRecording, 120000);
    } catch {
      releaseCamera();
      idleButtons();
      status.textContent = '此裝置無法建立錄影。請改用其他新版瀏覽器；練習紀錄仍可正常使用。';
    }
  }
  cameraButton.addEventListener('click', openCamera);
  recordButton.addEventListener('click', startRecording);
  stopButton.addEventListener('click', stopRecording);
  deleteButton.addEventListener('click', () => {
    video.pause();
    releaseClip();
    video.load();
    status.textContent = onRecorded ? '已關閉上方暫存回放。已保存影片請到下方片段庫刪除。' : '片段已從本頁刪除。可重新啟用相機錄影。';
  });
  return () => {
    disposed = true;
    clearTimeout(timeout);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    releaseCamera();
    releaseClip();
    chunks = [];
  };
}
