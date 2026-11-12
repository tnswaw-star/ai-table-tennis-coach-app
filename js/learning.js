import { exercises, equipmentGuide, equipmentVideos, verifiedVideos, movementCategories, REVIEW_NOTICE } from '../data/curriculum.js';
import { faqEntries, faqCategories } from '../data/faq.js';
import { recommendPaddle, evaluateStandard, evaluateExerciseQualification, parseYouTubeId, filterFaq, questionToFaq } from './logic.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const list = items => `<ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
const videoMap = () => new Map(verifiedVideos.map(video => [video.id, video]));
const typeLabels = {'success-rate':'成功率','consecutive':'連續板數','timed-count':'限時計數','quality':'動作品質','checklist':'空拍檢核'};

export function teachingVideos(exercise, demos = {}) {
  const config = demos[exercise.id] || {};
  const hidden = new Set(config.hiddenVideoIds || []);
  const ids = [...(exercise.videos || []).map(video => video.id), ...(config.videoIds || [])];
  const linked = parseYouTubeId(config.url);
  if (linked) ids.push(linked);
  const map = videoMap();
  return [...new Set(ids)].filter(id => map.has(id) && !hidden.has(id)).map(id => map.get(id));
}

export function videoCards(videos) {
  return `<p class="caption muted">影片版權屬原頻道；由教練審核是否適用。${REVIEW_NOTICE}。</p><p class="notice video-offline" ${globalThis.navigator?.onLine === false ? '' : 'hidden'}>需要網路才能看影片</p><div class="teaching-videos">${videos.map(video => `<a class="teaching-video" href="https://www.youtube.com/watch?v=${esc(video.id)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"><img ${globalThis.navigator?.onLine === false ? 'data-src' : 'src'}="https://i.ytimg.com/vi/${esc(video.id)}/mqdefault.jpg" loading="lazy" width="320" height="180" alt="" referrerpolicy="no-referrer"><span><strong>${esc(video.title)}</strong><small>${esc(video.channel)} · ${video.lang === 'zh' ? '中文' : '英文'} · 開新分頁 ↗</small></span></a>`).join('') || '<p class="muted">教練已隱藏此動作的影片，可請教練重新顯示。</p>'}</div>`;
}

export function bindVideoConnectivity(container) {
  const update = () => {
    container.querySelectorAll('.video-offline').forEach(node => { node.hidden = navigator.onLine; });
    if (navigator.onLine) container.querySelectorAll('img[data-src]').forEach(node => { node.src = node.dataset.src; node.removeAttribute('data-src'); });
  };
  const click = event => { if (!navigator.onLine && event.target.closest('.teaching-video')) { event.preventDefault(); update(); } };
  container.addEventListener('click', click);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
  return () => { container.removeEventListener('click', click); window.removeEventListener('online', update); window.removeEventListener('offline', update); };
}

export function standardDescription(standard) {
  const levels = standard.levels || {};
  const values = `入門 ${levels.entry ?? '—'}／合格 ${levels.qualified ?? '—'}／熟練 ${levels.proficient ?? '—'}`;
  if (standard.type === 'success-rate') return `${standard.attempts} 球；${values} 顆成功。${standard.description || ''}`;
  if (standard.type === 'consecutive') return `最多 ${standard.maxAttempts} 次；${values} ${standard.unit || '板'}。${standard.description || ''}`;
  if (standard.type === 'timed-count') return `${standard.seconds} 秒內；${values} 板。`;
  if (standard.type === 'quality') return `教練評各維度 A–D（1／0.75／0.5／0.25），平均至少 ${standard.threshold ?? 0.75}（B）。`;
  return '對鏡或錄影逐項檢核，全部達成後仍需動作品質評分與教練確認。';
}

export function learningSections(exercise, coach, demos) {
  const shadow = exercise.shadowDrill;
  const guide = exercise.coachGuide;
  const guideBody = `<p class="notice">${esc(guide.cue)}</p><h3>怎麼示範</h3>${list(guide.demonstration)}<h3>演練：空拍 → 多球 → 單球</h3>${list(guide.practice)}<h3>教練餵球方式</h3><p>${esc(guide.feeding)}</p><h3>觀察重點</h3>${list(guide.observe)}<h3>一次只改一個錯誤</h3>${list(guide.feedback)}<h3>學不會時，換一個方法</h3>${list(guide.alternatives)}`;
  return {
    shadow: `<section class="detail-section"><h2>空拍練法</h2><ol class="steps">${shadow.beats.map(beat => `<li><span><strong>${esc(beat.cue)}</strong><br>${esc(beat.detail)}</span></li>`).join('')}</ol><h3>對鏡／錄影檢核</h3>${list(shadow.checks)}<h3>從原地到步法</h3>${list(shadow.progression)}</section>`,
    videos: `<section class="detail-section"><h2>教學影片</h2>${videoCards(teachingVideos(exercise, demos))}<div id="teaching-video-settings"></div></section>`,
    coach: `<section class="detail-section">${coach ? `<h2>教練指導</h2>${guideBody}` : `<details><summary>教練怎麼指導（展開查看）</summary>${guideBody}</details>`}</section>`,
    standards: `<section class="detail-section" id="standards"><h2>合格標準</h2><p class="notice">${REVIEW_NOTICE}。${exercise.standards.some(item => ['success-rate','consecutive','timed-count'].includes(item.type)) ? '數量標準擇一達到合格，' : '空拍檢核全部達成，'}動作品質至少 B，並由教練確認。練滿次數不等於合格。</p>${exercise.standards.map(standard => `<article class="standard-row"><h3>${esc(standard.label || typeLabels[standard.type])}</h3><p>${esc(standardDescription(standard))}</p><details><summary>門檻依據</summary><p>${esc(standard.sourceNote)}</p></details></article>`).join('')}<a class="btn secondary" href="#test/${exercise.id}">記錄動作測驗 →</a></section>`,
  };
}

export function createLearningPages({main, getState, getStudent, isCoach, persist, updateStudent, notify, heading, id, cloud, appVersion}) {
  function mountVideoSettings(exercise, container) {
    if (!isCoach() || !container) return () => {};
    const config = () => getState().demos[exercise.id] || {};
    const ids = [...new Set([...(exercise.videos || []).map(video => video.id), ...(config().videoIds || []), parseYouTubeId(config().url)].filter(Boolean))];
    container.innerHTML = `<details><summary>教練：管理這個動作的影片</summary><p class="caption muted">只接受已驗證清單內的影片。隱藏後仍可在這裡重新顯示。</p><form id="verified-video-form"><label class="field"><span>已驗證影片網址</span><input type="url" name="url" required placeholder="https://www.youtube.com/watch?v=…"></label><button class="btn secondary">加入影片</button></form>${ids.map(videoId => { const video = videoMap().get(videoId); return video ? `<label class="check-row"><input type="checkbox" data-visible-video="${videoId}" ${config().hiddenVideoIds?.includes(videoId) ? '' : 'checked'}><span>顯示：${esc(video.title)}</span></label>` : ''; }).join('')}<p id="video-setting-result" role="status"></p></details>`;
    const save = next => persist({...getState(), demos:{...getState().demos, [exercise.id]:{...config(), ...next}}});
    container.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      const videoId = parseYouTubeId(new FormData(event.target).get('url'));
      if (!videoMap().has(videoId)) return notify('請使用已驗證清單內的影片網址；目前無法加入這支影片。', true);
      if (save({videoIds:[...new Set([...(config().videoIds || []), videoId])], hiddenVideoIds:(config().hiddenVideoIds || []).filter(item => item !== videoId)})) {
        location.hash = `#exercise/${exercise.id}`;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        notify('已加入影片。');
      }
    });
    container.querySelectorAll('[data-visible-video]').forEach(input => input.addEventListener('change', () => {
      const hidden = new Set(config().hiddenVideoIds || []);
      if (input.checked) hidden.delete(input.dataset.visibleVideo); else hidden.add(input.dataset.visibleVideo);
      if (save({hiddenVideoIds:[...hidden]})) {
        const cards = main.querySelector('.teaching-videos');
        cards.outerHTML = new DOMParser().parseFromString(videoCards(teachingVideos(exercise, getState().demos)), 'text/html').querySelector('.teaching-videos').outerHTML;
        container.querySelector('#video-setting-result').textContent = '影片顯示設定已儲存。';
      } else input.checked = !input.checked;
    }));
    return () => {};
  }

  function equipment() {
    const paddle = getStudent().paddle || {};
    main.innerHTML = `${heading('第 0 課', '選一支適合的球拍', '先選好控制、握得舒服的球拍。', '#stages')}<p class="notice">${REVIEW_NOTICE}。不推薦品牌或商品，先請教練試握確認。</p><details><summary>先看選拍與保養重點</summary>${equipmentGuide.map(item => `<h3>${esc(item.title)}</h3><p>${esc(item.text)}</p>`).join('')}</details><section class="detail-section"><h2>回答五題，看看建議規格</h2><form id="paddle-quiz"><fieldset><legend>① 年齡與手掌大小</legend><div class="field-grid"><label class="field"><span>年齡</span><select name="ageGroup"><option value="adult">成人／青少年</option><option value="child">兒童</option></select></label><label class="field"><span>手掌大小</span><select name="handSize"><option value="medium">中等</option><option value="small">較小</option><option value="large">較大</option></select></label></div></fieldset><label class="field"><span>② 是否已有球拍？</span><select name="hasPaddle"><option value="false">還沒有</option><option value="true">已經有</option></select></label><label class="field"><span>③ 預算取向</span><select name="budget"><option value="low">先用基本預算入門</option><option value="medium">中等預算</option><option value="high">預算較充裕</option></select></label><label class="field"><span>④ 偏好打法</span><select name="style"><option value="control">先求控制與穩定</option><option value="attack">喜歡進攻</option><option value="defense">喜歡防守</option></select></label><label class="field"><span>⑤ 是否有教練協助？</span><select name="hasCoach"><option value="false">目前沒有</option><option value="true">有</option></select></label><button class="btn">查看建議規格</button></form><div id="paddle-recommendation" role="status"></div></section><section class="detail-section"><h2>我的球拍</h2><p class="caption muted">跟著學員檔保存，教練也能查看。</p><form id="my-paddle"><label class="field"><span>握法</span><select name="grip"><option value="橫拍">橫拍（刀板）</option><option value="直拍">直拍</option><option value="未確認">還沒確認</option></select></label><label class="field"><span>底板</span><input name="blade" maxlength="200" value="${esc(paddle.blade)}" placeholder="例如：純木底板"></label><label class="field"><span>膠皮</span><input name="rubber" maxlength="200" value="${esc(paddle.rubber)}" placeholder="例如：兩面平面反膠"></label><label class="field"><span>整拍重量（克，未量可留空）</span><input type="number" min="60" max="300" name="weight" value="${esc(paddle.weight)}"></label><button class="btn secondary">儲存我的球拍</button></form></section><section class="detail-section"><h2>握柄與版型教學影片</h2>${videoCards(equipmentVideos)}</section>`;
    main.querySelector('#my-paddle [name=grip]').value = paddle.grip || '未確認';
    main.querySelector('#paddle-quiz').addEventListener('submit', event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target));
      values.hasPaddle = values.hasPaddle === 'true'; values.hasCoach = values.hasCoach === 'true';
      const result = recommendPaddle(values);
      main.querySelector('#paddle-recommendation').innerHTML = `<h3>適合你的起步規格</h3><dl class="spec-list">${[['握法',result.grip],['成品／自組',result.construction],['底板',result.blade],['膠皮',result.rubber],['整拍重量',result.weight],['握柄',result.handle]].map(([label,value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${list(result.notes)}<p class="notice">${esc(result.reminder)}。${REVIEW_NOTICE}。</p>`;
    });
    main.querySelector('#my-paddle').addEventListener('submit', event => {
      event.preventDefault(); const values = Object.fromEntries(new FormData(event.target));
      values.weight = values.weight === '' ? null : Number(values.weight);
      if (updateStudent({...getStudent(), paddle:values, updatedAt:new Date().toISOString()})) notify('我的球拍已儲存，教練可在選拍頁查看。');
    });
    return bindVideoConnectivity(main);
  }

  function movements() {
    main.innerHTML = `${heading('動作總覽', '桌球基本動作有幾種', '先把基本功練穩，再由教練安排進階技術。', '#stages')}<p class="notice">初學內容分為準備、步法、正手、反手、下旋處理與發接發。進階內容保留為後續版本。</p>${movementCategories.map(category => `<section class="detail-section"><h2>${esc(category.name)} <span class="badge">${category.inScope ? 'V1.0 範圍' : 'V1.1 以後（後續版本）'}</span></h2><p>${esc(Array.isArray(category.movements) ? category.movements.join('、') : category.movements)}</p><p class="muted">${esc(category.description)}</p><div class="actions">${(category.exerciseIds || []).map(exerciseId => `<a class="text-link" href="#exercise/${exerciseId}">${esc(exercises.find(item => item.id === exerciseId)?.name)} →</a>`).join('')}</div></section>`).join('')}`;
  }

  function faq() {
    main.innerHTML = `${heading('有問題，隨時查', '常見問題', '先找答案，找不到就留下提問。')}<label class="field"><span>關鍵字搜尋</span><input id="faq-search" type="search" placeholder="例如：空拍、晉級、球拍"></label><label class="field"><span>問題分類</span><select id="faq-category"><option value="all">全部分類</option>${faqCategories.map(category => `<option>${esc(category)}</option>`).join('')}</select></label><p id="faq-count" role="status"></p><div id="faq-results"></div><section class="detail-section"><h2>找不到答案？我要提問</h2><form id="question-form"><label class="field"><span>想問什麼？</span><textarea name="message" maxlength="2000" required></textarea></label><button class="btn">送出提問</button></form><p class="caption muted">先存於本機；設定並登入雲端後可同步。也可透過完整備份交給教練。</p></section><section class="detail-section"><h2>${isCoach() ? '待回答提問與回答紀錄' : '此裝置的提問與回答'}</h2><div id="question-list"></div></section>${isCoach() ? '<section class="detail-section"><h2>管理教練新增的問題</h2><div id="faq-management"></div></section>' : ''}`;
    const allEntries = () => [...faqEntries, ...(getState().faqEntries || [])];
    const draw = () => {
      const entries = filterFaq(allEntries(), main.querySelector('#faq-search').value, main.querySelector('#faq-category').value);
      main.querySelector('#faq-count').textContent = `找到 ${entries.length} 題`;
      main.querySelector('#faq-results').innerHTML = entries.map(item => `<details class="faq-entry"><summary>${esc(item.question)}</summary><p>${esc(item.answer)}</p><p class="caption muted">${esc(item.category)}${item.source === 'coach' ? ` · 教練新增 · ${esc(item.updatedAt.slice(0,10))}` : ''}</p>${item.relatedExerciseId ? `<a class="text-link" href="#exercise/${esc(item.relatedExerciseId)}">查看相關動作、影片與合格標準 →</a>` : item.relatedRoute ? `<a class="text-link" href="#${esc(item.relatedRoute.replace(/^#/,''))}">查看相關說明 →</a>` : ''}</details>`).join('') || '<p class="notice">沒有找到答案，換個關鍵字或在下方提問。</p>';
    };
    main.querySelector('#faq-search').addEventListener('input', draw);
    main.querySelector('#faq-category').addEventListener('change', draw);
    main.querySelector('#question-form').addEventListener('submit', async event => {
      event.preventDefault(); const message = new FormData(event.target).get('message').trim(); if (!message) return;
      const item = {id:id(),type:'question',studentId:getStudent().id,message,contact:'',page:'#faq',appVersion,device:{platform:matchMedia('(pointer: coarse)').matches?'touch':'desktop',viewport:`${innerWidth}×${innerHeight}`},createdAt:new Date().toISOString()};
      if (!persist({...getState(),feedback:[...getState().feedback,item]})) return;
      event.target.reset(); drawQuestions(); notify('提問已存本機，教練可在常見問題頁回答。');
      if (cloud.configured && cloud.session) try { await cloud.submitFeedback(item); notify('提問已儲存並同步。'); } catch (error) { notify(`提問已存本機，同步未完成：${error.message}`, true); }
    });
    const categories = selected => faqCategories.map(category => `<option ${category === selected ? 'selected' : ''}>${esc(category)}</option>`).join('');
    function drawQuestions() {
      const questions = getState().feedback.filter(item => item.type === 'question');
      main.querySelector('#question-list').innerHTML = questions.map(item => `<article class="question-entry"><h3>${esc(item.message)}</h3><p class="caption muted">${esc(item.createdAt.slice(0,10))} · ${item.answer ? '已回答' : '待回答'}</p>${isCoach() ? `<form data-answer-question="${esc(item.id)}"><label class="field"><span>常見問題題目（發布時使用）</span><input name="question" required maxlength="500" value="${esc(item.message.slice(0,500))}"></label><label class="field"><span>教練回答</span><textarea name="answer" required maxlength="6000">${esc(item.answer)}</textarea></label><label class="field"><span>分類</span><select name="category">${categories(item.category)}</select></label><label class="check-row"><input type="checkbox" name="publish" ${item.faqId ? 'checked' : ''}><span>加入常見問題（所有本機學員可讀）</span></label><button class="btn secondary">儲存回答</button></form>` : `<p>${esc(item.answer || '教練尚未回答。')}</p>`}</article>`).join('') || '<p class="muted">目前沒有提問。</p>';
      main.querySelectorAll('[data-answer-question]').forEach(form => form.addEventListener('submit', event => {
        event.preventDefault(); if (!isCoach()) return;
        const question = getState().feedback.find(item => item.id === form.dataset.answerQuestion);
        const data = new FormData(form); const now = new Date().toISOString(); const answer = data.get('answer').trim(); if (!answer) return notify('請先輸入回答內容。',true);
        const publish = data.has('publish'); const faqId = question.faqId || (publish ? id() : '');
        let custom = [...getState().faqEntries];
        if (faqId) {
          if (!data.get('question')?.trim()) return notify('請填寫常見問題題目。',true);
          const entry = questionToFaq({...question,message:data.get('question')},{id:faqId,answer,category:data.get('category'),author:'本機教練',createdAt:now,publish});
          const previous = custom.find(item => item.id === faqId);
          if (previous) entry.createdAt = previous.createdAt;
          custom = [...custom.filter(item => item.id !== faqId), entry];
        }
        const feedback = getState().feedback.map(item => item.id === question.id ? {...item,answer,category:data.get('category'),status:'answered',faqId,answeredAt:now,updatedAt:now} : item);
        if (persist({...getState(), feedback, faqEntries:custom})) { draw(); drawQuestions(); drawManagement(); notify('教練回答已儲存，可在設定同步文字資料。'); }
      }));
    }
    function drawManagement() {
      if (!isCoach()) return;
      main.querySelector('#faq-management').innerHTML = getState().faqEntries.map(item => `<details><summary>${esc(item.question)} · ${item.status === 'hidden' ? '已隱藏' : '已發布'}</summary><form data-edit-faq="${esc(item.id)}"><label class="field"><span>題目</span><input name="question" required maxlength="500" value="${esc(item.question)}"></label><label class="field"><span>答案</span><textarea name="answer" required maxlength="6000">${esc(item.answer)}</textarea></label><label class="field"><span>分類</span><select name="category">${categories(item.category)}</select></label><label class="check-row"><input type="checkbox" name="publish" ${item.status === 'published' ? 'checked' : ''}><span>顯示於常見問題</span></label><button class="btn secondary">儲存編輯</button></form></details>`).join('') || '<p class="muted">回答提問時勾選「加入常見問題」，就會出現在這裡。</p>';
      main.querySelectorAll('[data-edit-faq]').forEach(form => form.addEventListener('submit', event => {
        event.preventDefault(); if (!isCoach()) return; const data = new FormData(form);
        const entries = getState().faqEntries.map(item => item.id === form.dataset.editFaq ? {...item,question:data.get('question').trim(),answer:data.get('answer').trim(),category:data.get('category'),status:data.has('publish')?'published':'hidden',updatedAt:new Date().toISOString()} : item);
        if (persist({...getState(),faqEntries:entries})) { draw(); drawManagement(); notify('常見問題已更新。'); }
      }));
    }
    draw(); drawQuestions(); drawManagement();
  }

  function test(exercise) {
    const previous = (getStudent().assessments || []).filter(item => item.exerciseId === exercise.id).sort((a,b) => Date.parse(a.updatedAt || a.createdAt)-Date.parse(b.updatedAt || b.createdAt)).at(-1);
    const results = structuredClone(previous?.results || {});
    let confirmed = previous?.coachConfirmed === true;
    let timer = null; let activeTimed = null; let startedAt = 0; const currentRuns = {};
    const initial = standard => standard.type === 'success-rate' ? {outcomes:[]} : standard.type === 'consecutive' ? {runs:[]} : standard.type === 'timed-count' ? {count:0,elapsedSeconds:0} : standard.type === 'quality' ? {grades:{}} : {checkedIds:[]};
    exercise.standards.forEach(standard => { results[standard.id] ||= initial(standard); });
    main.innerHTML = `${heading('動作測驗', exercise.name, '數量與動作品質分開看，教練確認後才算合格。', `#exercise/${exercise.id}`)}<p class="notice">${REVIEW_NOTICE}。${exercise.standards.some(item => ['success-rate','consecutive','timed-count'].includes(item.type)) ? '數量標準擇一達到合格。' : '空拍檢核必須全部達成。'}重新計數會取消之前的教練確認。</p><form id="movement-test">${exercise.standards.map(standard => {
      const result = results[standard.id]; const key = esc(standard.id);
      let controls = '';
      if (standard.type === 'success-rate') controls = `<div class="test-counter" data-count="${key}"></div><div class="actions"><button type="button" class="btn secondary count-button" data-success="${key}">✔ 成功</button><button type="button" class="btn secondary count-button" data-miss="${key}">✘ 失誤</button><button type="button" class="btn secondary" data-undo="${key}">復原上一筆</button></div>`;
      if (standard.type === 'consecutive') controls = `<div class="test-counter" data-count="${key}"></div><p data-runs="${key}"></p><div class="actions"><button type="button" class="btn secondary count-button" data-rally="${key}">＋ 成功一板／輪</button><button type="button" class="btn secondary" data-end-run="${key}">失誤／結束本次</button></div>`;
      if (standard.type === 'timed-count') controls = `<div class="test-counter" data-count="${key}"></div><div class="actions"><button type="button" class="btn secondary" data-start-timer="${key}">開始 ${standard.seconds} 秒測驗</button><button type="button" class="btn secondary count-button" data-timed-count="${key}" disabled>＋ 有效一板</button><button type="button" class="btn secondary" data-stop-timer="${key}" disabled>停止本次</button></div>`;
      if (standard.type === 'quality') controls = `<p class="caption muted">${isCoach() ? '請依親自觀察的表現評分。' : '只有教練模式能填寫。學員可先保存數量紀錄，再交給教練。'}</p>${standard.dimensions.map(dimension => `<label class="field"><span>${esc(dimension)}</span><select data-grade="${key}" data-dimension="${esc(dimension)}" ${isCoach() ? '' : 'disabled'}><option value="">尚未評分</option>${['A','B','C','D'].map(grade => `<option ${result.grades?.[dimension] === grade ? 'selected' : ''}>${grade}</option>`).join('')}</select></label>`).join('')}`;
      if (standard.type === 'checklist') controls = standard.items.map(item => `<label class="check-row"><input type="checkbox" data-item="${key}" value="${esc(item.id)}" ${result.checkedIds?.includes(item.id) ? 'checked' : ''}><span>${esc(item.text)}</span></label>`).join('');
      return `<section class="detail-section" data-standard="${key}"><h2>${esc(standard.label || typeLabels[standard.type])}</h2><p>${esc(standardDescription(standard))}</p>${controls}<p class="test-level" data-level="${key}" role="status"></p><button type="button" class="btn secondary" data-reset-standard="${key}">重設這項測驗</button></section>`;
    }).join('')}<div id="movement-result" class="notice" role="status"></div>${isCoach() ? `<label class="check-row"><input type="checkbox" id="movement-coach" ${confirmed ? 'checked' : ''}><span>教練已觀察本次測驗並確認動作品質</span></label>` : '<p class="notice">尚需教練評分與確認，學員不能自行通過。</p>'}<button class="btn full-width" type="submit">儲存測驗紀錄</button></form><section class="detail-section"><h2>已保存的測驗紀錄</h2><div id="test-history"></div></section>`;
    const standardById = key => exercise.standards.find(item => item.id === key);
    const button = (attr,key) => main.querySelector(`[${attr}="${key}"]`);
    const changed = () => { confirmed = false; const box = main.querySelector('#movement-coach'); if (box) box.checked = false; if (!isCoach()) exercise.standards.filter(item => item.type === 'quality').forEach(item => { results[item.id] = {grades:{}}; main.querySelectorAll(`[data-grade="${item.id}"]`).forEach(select => { select.value = ''; }); }); };
    const assessment = () => ({exerciseId:exercise.id,results,coachConfirmed:confirmed});
    const draw = () => {
      exercise.standards.forEach(standard => {
        const result = results[standard.id]; const key = standard.id;
        button('data-level',key).textContent = `目前等級：${evaluateStandard(standard,result).label}`;
        if (standard.type === 'success-rate') {
          button('data-count',key).textContent = `${result.outcomes.filter(Boolean).length} 成功 / ${result.outcomes.length} 已打 / ${standard.attempts} 球`;
          button('data-success',key).disabled = button('data-miss',key).disabled = result.outcomes.length >= standard.attempts;
          button('data-undo',key).disabled = !result.outcomes.length;
        }
        if (standard.type === 'consecutive') {
          button('data-count',key).textContent = `本次 ${currentRuns[key] || 0} · 最佳 ${Math.max(0,...result.runs)}`;
          button('data-runs',key).textContent = `各次：${result.runs.join('、') || '尚未結束任何一次'}（${result.runs.length}/${standard.maxAttempts} 次）`;
          button('data-rally',key).disabled = button('data-end-run',key).disabled = result.runs.length >= standard.maxAttempts;
        }
        if (standard.type === 'timed-count') button('data-count',key).textContent = `${result.count} 板 · 剩餘 ${Math.max(0,standard.seconds - Math.floor(result.elapsedSeconds))} 秒`;
      });
      const result = evaluateExerciseQualification(exercise, assessment());
      main.querySelector('#movement-result').textContent = result.qualified ? '合格：測驗、動作品質與教練確認皆已達成。' : '尚未合格：請完成指定測驗、品質至少 B，並取得教練確認。';
    };
    const history = () => { main.querySelector('#test-history').innerHTML = (getStudent().assessments || []).filter(item => item.exerciseId === exercise.id).slice().reverse().map(item => `<article class="standard-row"><p>${esc(new Date(item.createdAt).toLocaleString('zh-TW'))} · ${evaluateExerciseQualification(exercise,item).qualified ? '合格（教練已確認）' : '尚未合格／待教練確認'}</p>${exercise.standards.map(standard => `<p class="caption">${esc(standard.label || typeLabels[standard.type])}：${esc(evaluateStandard(standard,item.results[standard.id]).label)}</p>`).join('')}</article>`).join('') || '<p class="muted">儲存後會在這裡留下本次結果。</p>'; };
    main.addEventListener('click', handleClick);
    function handleClick(event) {
      const target = event.target.closest('button[type=button]'); if (!target) return;
      const key = Object.values(target.dataset)[0]; const standard = standardById(key); if (!standard) return;
      if (target.hasAttribute('data-reset-standard')) { if (activeTimed === key) stopTimer(); results[key] = initial(standard); currentRuns[key] = 0; if (standard.type === 'quality') main.querySelectorAll(`[data-grade="${key}"]`).forEach(select => { select.value = ''; }); if (standard.type === 'checklist') main.querySelectorAll(`[data-item="${key}"]`).forEach(input => { input.checked = false; }); }
      if (target.hasAttribute('data-success') && results[key].outcomes.length < standard.attempts) results[key].outcomes.push(true);
      if (target.hasAttribute('data-miss') && results[key].outcomes.length < standard.attempts) results[key].outcomes.push(false);
      if (target.hasAttribute('data-undo')) results[key].outcomes.pop();
      if (target.hasAttribute('data-rally') && results[key].runs.length < standard.maxAttempts) currentRuns[key] = (currentRuns[key] || 0) + 1;
      if (target.hasAttribute('data-end-run') && results[key].runs.length < standard.maxAttempts) { results[key].runs.push(currentRuns[key] || 0); currentRuns[key] = 0; }
      if (target.hasAttribute('data-start-timer')) {
        stopTimer(); activeTimed = key; results[key] = initial(standard); startedAt = performance.now();
        button('data-start-timer',key).disabled = true; button('data-timed-count',key).disabled = false; button('data-stop-timer',key).disabled = false;
        timer = setInterval(() => { results[key].elapsedSeconds = Math.min(standard.seconds,(performance.now()-startedAt)/1000); if (results[key].elapsedSeconds >= standard.seconds) stopTimer(); draw(); },100);
      }
      if (target.hasAttribute('data-timed-count') && activeTimed === key) { results[key].elapsedSeconds = Math.min(standard.seconds,(performance.now()-startedAt)/1000); if (results[key].elapsedSeconds >= standard.seconds) stopTimer(); else results[key].count++; }
      if (target.hasAttribute('data-stop-timer')) { results[key].elapsedSeconds = Math.min(standard.seconds,(performance.now()-startedAt)/1000); stopTimer(); }
      changed(); draw();
    }
    function stopTimer() {
      clearInterval(timer); timer = null;
      if (activeTimed) { button('data-start-timer',activeTimed).disabled = false; button('data-timed-count',activeTimed).disabled = true; button('data-stop-timer',activeTimed).disabled = true; }
      activeTimed = null;
    }
    main.querySelectorAll('[data-item]').forEach(input => input.addEventListener('change', () => { results[input.dataset.item].checkedIds = [...main.querySelectorAll(`[data-item="${input.dataset.item}"]:checked`)].map(item => item.value); changed(); draw(); }));
    main.querySelectorAll('[data-grade]').forEach(select => select.addEventListener('change', () => { if (!isCoach()) return; if (select.value) results[select.dataset.grade].grades[select.dataset.dimension] = select.value; else delete results[select.dataset.grade].grades[select.dataset.dimension]; changed(); draw(); }));
    main.querySelector('#movement-coach')?.addEventListener('change', event => { confirmed = isCoach() && event.target.checked; draw(); });
    main.querySelector('#movement-test').addEventListener('submit', event => {
      event.preventDefault(); if (activeTimed) return notify('請先完成或停止限時測驗，再儲存紀錄。',true);
      if (Object.values(currentRuns).some(value => value > 0)) return notify('請先按「失誤／結束本次」，再保存連續板數。',true);
      const now = new Date().toISOString(); const item = {...assessment(),id:id(),createdAt:now,updatedAt:now};
      if (updateStudent({...getStudent(),assessments:[...(getStudent().assessments || []),item]})) { history(); notify('測驗紀錄已儲存，階段評估已採用最新結果。'); }
    });
    draw(); history();
    return () => { stopTimer(); main.removeEventListener('click',handleClick); };
  }
  return {equipment,movements,faq,test,mountVideoSettings};
}
