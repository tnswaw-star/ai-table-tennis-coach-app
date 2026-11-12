import { curriculum, exercises, REVIEW_NOTICE } from '../data/curriculum.js';
import { exerciseProgress, recommendToday, evaluateStage, getUnlockedStageIds, canAdvanceStage, currentStageId, mergeStudent, rankCountermeasures, practiceStreak, weeklyStats } from './logic.js';
import { LocalStore, SupabaseStore, createAppState, parseAppState, exportAppState, parseStudentFile, exportStudentFile } from './storage.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { mountVideoReview } from './video-review.js';
import { mountGuidedPractice } from './practice.js';
import { createLearningPages, learningSections, bindVideoConnectivity } from './learning.js';
import { evaluateExerciseQualification, evaluateStandard, mergeFaqEntries } from './logic.js';

const main = document.querySelector('#main');
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  main.focus();
  window.scrollTo({top:0,behavior:'instant'});
});
const APP_VERSION = '1.2.0';
const store = new LocalStore();
const cloud = new SupabaseStore({url:SUPABASE_URL,anonKey:SUPABASE_ANON_KEY});
const loaded = store.load();
let state = loaded.state;
let storageBlocked = Boolean(loaded.error);
let recorderCleanup = null;
let importPending = false;
let routeVersion = 0;
let guidedDraft = null;
let feedbackOrigin = '#home';
let syncing = false;
let lastRoute = '#home';
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const dateLabel = value => new Date(value).toLocaleString('zh-TW', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const currentStage = () => curriculum.find(stage => stage.id === currentStageId(curriculum, student().advancements));
const unlocked = stageId => getUnlockedStageIds(curriculum, student().advancements).includes(stageId);
const stageProgress = stage => Math.round(stage.exercises.reduce((sum, exercise) => sum + exerciseProgress(exercise, student().records).percent, 0) / stage.exercises.length);
const completedStage = stage => student().advancements.some(item => item.stageId === stage.id);
const student = () => state.students.find(item => item.id === state.activeStudentId) || state.students[0];
const isCoach = () => state.role === 'coach';
const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;

function updateStudent(next) {
  return persist({...state,students:state.students.map(item => item.id === next.id ? next : item)});
}

function renderContext() {
  const box = document.querySelector('#role-context');
  box.hidden = !state.role;
  box.innerHTML = state.role ? `<span class="badge">${isCoach() ? '教練模式' : '學員模式'}</span><strong>${escape(student().name)}</strong>${isCoach() ? '<a class="text-link" href="#coach">管理學員 →</a>' : '<a class="text-link" href="#settings">學員檔與設定 →</a>'}` : '';
  document.querySelector('#cloud-status').textContent = cloud.configured ? (cloud.session ? '雲端同步：已登入，手動同步' : '雲端同步：尚未登入') : '雲端同步：未設定';
}

function renderWelcome() {
  main.innerHTML = `${pageHeading('歡迎來到練習場', '今天，你是哪個角色？', '選擇後即可開始，也能隨時在設定切換。')}<div class="role-options"><button class="btn" data-role="student">我是學員</button><button class="btn secondary" data-role="coach">我是教練</button></div><p class="notice">本機角色切換方便共同教學，沒有身分認證。晉級由教練模式確認；影片保存在此裝置。</p>`;
  main.querySelectorAll('[data-role]').forEach(button => button.addEventListener('click', () => {
    if (persist({...state,role:button.dataset.role})) { if (isCoach()) location.hash = '#coach'; render(); }
  }));
}

function renderHome() {
  const stage = currentStage();
  const assignment = student().assignments.filter(item => item.date === localDay()).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)).at(-1);
  const assigned = assignment?.exerciseIds.map(exerciseId => exercises.find(item => item.id === exerciseId)).filter(item => item && unlocked(item.stageId));
  const today = assigned?.length ? assigned : recommendToday(stage,student().records);
  const week = weeklyStats(student().records,localDay());
  const maxCount = Math.max(1,...week.map(item => item.count));
  const maxMinutes = Math.max(1,...week.map(item => item.minutes));
  main.innerHTML = `${pageHeading(escape(student().name), '今天，練好每一拍。', '先看動作、慢慢練，再留下今天的進步。')}
    <div class="learning-entry"><a class="text-link" href="#equipment">第 0 課：選一支適合的球拍 →</a><a class="text-link" href="#movements">桌球基本動作有幾種 →</a></div><section class="stage-focus"><div class="court" aria-hidden="true"></div><span class="caption">目前進度 · 階段 ${stage.id} / 5</span><h2>${stage.name}</h2><p>${escape(stage.goal)}</p><div class="focus-progress">本階段練習量 ${stageProgress(stage)}%<progress value="${stageProgress(stage)}" max="100" aria-label="目前階段練習量完成度"></progress></div><a class="btn" href="#guided/${today[0].id}">開始今天的練習 →</a></section>
    <div class="stats-strip"><div><strong>${practiceStreak(student().records,localDay())}<small> 天</small></strong><span>連續練習</span></div><div><strong>${week.reduce((sum,item)=>sum+item.count,0)}<small> 筆</small></strong><span>本週練習</span></div><div><strong>${Math.round(week.reduce((sum,item)=>sum+item.minutes,0))}<small> 分</small></strong><span>本週練習時間</span></div></div>
    <div class="section-heading"><h2>${assigned?.length ? '教練指定今日課表' : '你的今日練習'}</h2><a class="text-link" href="#stage/${stage.id}">本階段全部 →</a></div><div class="exercise-list">${today.map(exerciseRow).join('')}</div>
    <section class="detail-section"><h2>這週，每天一點進步</h2><p class="caption muted">週一至週日 · 每筆紀錄算一次，分鐘依實際填寫；舊紀錄未填時間以 0 計。</p><div class="week-chart" role="img" aria-label="本週每日練習次數與分鐘數">${week.map(item=>`<div class="week-day"><div class="bar-pair"><span style="height:${Math.round(item.count/maxCount*100)}%" class="count-bar"></span><span style="height:${Math.round(item.minutes/maxMinutes*100)}%" class="minutes-bar"></span></div><small>${item.date.slice(5)}</small><span>${item.count} 次<br>${Math.round(item.minutes)} 分</span></div>`).join('')}</div></section>
    <div class="stage-badges" aria-label="階段完成徽章">${curriculum.map(item=>`<span class="badge ${completedStage(item)?'earned':''}">${completedStage(item)?'✓':'○'} 階段 ${item.id}${completedStage(item)?' 已完成':''}</span>`).join('')}</div>
    ${renderFeedbackList(student().feedback.slice(-3),'最近的教練回饋')}<div class="section-heading"><h2>練習之後</h2><a class="text-link" href="#assessment/${stage.id}">階段評估 →</a></div>${sample()}`;
}

function renderFeedbackList(items,title = '教練回饋') {
  return items.length ? `<section class="detail-section"><h2>${title}</h2>${items.map(item=>`<p class="notice"><small>${dateLabel(item.createdAt)} · ${item.targetType==='video'?'影片片段':'練習紀錄'}</small><br>${escape(item.text)}</p>`).join('')}</section>` : '';
}

function renderExercise(exercise) {
  const teaching = learningSections(exercise,isCoach(),state.demos);
  main.innerHTML = `${pageHeading(`階段 ${exercise.stageId} · 動作教學`,escape(exercise.name),'先讀要領，再跟著口令慢慢練。',`#stage/${exercise.stageId}`)}
    <div class="teaching-volume"><div><span>建議練習量</span><strong>${escape(exercise.prescription.label)}</strong></div><span>${REVIEW_NOTICE}</span></div>
    <section class="detail-section"><h2>記住這幾個要領</h2><ul>${exercise.essentials.map(text=>`<li>${escape(text)}</li>`).join('')}</ul></section>
    ${teaching.shadow}${teaching.videos}
    <section class="detail-section"><h2>我做不出來</h2><label class="field"><span>我遇到的問題</span><select id="problem-select">${exercise.errors.map((error,index)=>`<option value="${index}">${escape(error.mistake)}</option>`).join('')}</select></label><p class="caption muted">曾對你有幫助的方法會優先顯示。</p><div id="strategies"></div></section>
    ${teaching.standards}${teaching.coach}${sample()}<div class="actions"><a class="btn full-width" href="#guided/${exercise.id}">開始引導練習 →</a><a class="btn secondary" href="#practice/${exercise.id}">直接記錄練習</a><a class="btn secondary" href="#recorder/${exercise.id}">示範與錄影比較</a></div>`;
  const draw = () => {
    const problemId = `${exercise.id}-error-${document.querySelector('#problem-select').value}`;
    const error = exercise.errors[Number(document.querySelector('#problem-select').value)];
    const methods = [...error.corrections,'對鏡慢練，觀察站姿與還原。','看教練示範慢放，再分解練習。','請教練手把手帶領，並降低速度。'].map((text,index)=>({id:`${problemId}-${index}`,text}));
    const ranked = rankCountermeasures(methods,student().countermeasureResults,exercise.id,problemId);
    const target = document.querySelector('#strategies');
    target.innerHTML = ranked.map(method=>`<article class="strategy"><p>${escape(method.text)}</p><small class="muted">有幫助 ${method.helpfulCount} 次 · 沒幫助 ${method.unhelpfulCount} 次</small><div class="actions"><button class="btn secondary" data-strategy="${method.id}" data-helpful="true">有幫助</button><button class="btn secondary" data-strategy="${method.id}" data-helpful="false">沒幫助</button></div></article>`).join('');
    target.querySelectorAll('[data-strategy]').forEach(button=>button.addEventListener('click',()=>{
      const result = {id:id(),exerciseId:exercise.id,problemId,strategyId:button.dataset.strategy,helpful:button.dataset.helpful==='true',createdAt:new Date().toISOString()};
      if (updateStudent({...student(),countermeasureResults:[...student().countermeasureResults,result]})) { draw(); notify('已記下這個方法對你的幫助。'); }
    }));
  };
  document.querySelector('#problem-select').addEventListener('change',draw);
  draw();
  pages.mountVideoSettings(exercise,main.querySelector('#teaching-video-settings'));
  recorderCleanup = bindVideoConnectivity(main);
}

function renderGuided(exercise) {
  main.innerHTML = `${pageHeading('跟著口令，專心練習',escape(exercise.name),'次數是練習提示，完成後請填寫實際成果。',`#exercise/${exercise.id}`)}<div id="guided-practice"></div>`;
  const learnerId = student().id;
  recorderCleanup = mountGuidedPractice(document.querySelector('#guided-practice'),{exercise,onFinish:result=>{
    guidedDraft = {...result,exerciseId:exercise.id,studentId:learnerId};
    location.hash = `#practice/${exercise.id}`;
  }});
}

function renderPractice(exercise) {
  const draft = guidedDraft?.exerciseId===exercise.id && guidedDraft?.studentId===student().id ? guidedDraft : null;
  main.innerHTML = `${pageHeading('練習紀錄',escape(exercise.name),draft?'引導練習已完成，請確認次數與穩定度。':'練完再填寫，留下一次進步。',`#exercise/${exercise.id}`)}
    <form id="practice-form"><div class="field-grid"><label class="field"><span>每組完成次數</span><input name="reps" type="number" min="1" max="10000" value="${draft?.reps||exercise.prescription.reps}" required></label><label class="field"><span>完成組數</span><input name="sets" type="number" min="1" max="100" value="${draft?.sets||exercise.prescription.sets}" required></label></div>
    <label class="field"><span>實際練習分鐘</span><input name="minutes" type="number" min="0" max="1440" step="0.1" value="${draft?Math.round(draft.minutes*10)/10:0}" required></label>
    <fieldset class="rating"><legend>動作穩定度自評（必填）</legend><div class="rating-options">${[1,2,3,4,5].map(n=>`<label><input type="radio" name="rating" value="${n}" required><span>${n}</span></label>`).join('')}</div><small>1＝常失誤，3＝大致穩定，5＝穩定完成。仍須教練確認。</small></fieldset>
    <label class="field"><span>練習備註（選填）</span><textarea name="note" maxlength="2000"></textarea></label><button class="btn full-width" type="submit">儲存這次練習</button></form>
    <section class="detail-section"><h2>這個動作的練習歷程</h2>${student().records.filter(record=>record.exerciseId===exercise.id).slice().reverse().map(recordCard).join('')||'<p class="muted">還沒有紀錄，從這次開始。</p>'}</section>`;
  document.querySelector('#practice-form').addEventListener('submit',event=>{
    event.preventDefault(); const values = new FormData(event.currentTarget);
    const record = {id:id(),exerciseId:exercise.id,reps:Number(values.get('reps')),sets:Number(values.get('sets')),minutes:Number(values.get('minutes')),rating:Number(values.get('rating')),note:values.get('note').trim(),coachFeedback:'',createdAt:new Date().toISOString()};
    if (updateStudent({...student(),records:[...student().records,record]})) { guidedDraft=null; location.hash=`#assessment/${exercise.stageId}`; notify('已儲存這次練習。'); }
  });
}

function renderVideo(exercise) {
  main.innerHTML = `${pageHeading('把動作留給自己看','錄影與示範比較','片段只保存在此裝置，不上傳。')}<label class="field"><span>選擇動作</span><select id="video-exercise">${exercises.filter(item=>unlocked(item.stageId)).map(item=>`<option value="${item.id}">${escape(item.name)}</option>`).join('')}</select></label><div id="video-review"></div>`;
  const select = document.querySelector('#video-exercise'); select.value=exercise.id;
  select.addEventListener('change',()=>{location.hash=`#recorder/${select.value}`;});
  const learnerId=student().id;
  recorderCleanup=mountVideoReview(document.querySelector('#video-review'),{store,student:student(),exercise,isCoach:isCoach(),demos:state.demos,onChange:next=>{
    if (student().id!==learnerId) return false;
    return updateStudent(next);
  },onDemoChange:(exerciseId,config)=>persist({...state,demos:{...state.demos,[exerciseId]:config}})});
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : state.theme;
}
systemTheme.addEventListener('change', applyTheme);
applyTheme();
if (loaded.error) {
  const box = document.querySelector('#storage-error');
  box.hidden = false;
  box.textContent = `${loaded.error} 為保留原始內容，暫停寫入。請到設定匯入有效備份，或確認清除資料後再使用。`;
}

function notify(message, error = false) {
  const box = document.querySelector('#message');
  box.className = `notice ${error ? 'error' : 'success'}`;
  box.textContent = message;
  box.hidden = false;
  if (error) box.scrollIntoView({block:'center'});
}

function persist(next, recovery = false) {
  if (storageBlocked && !recovery) {
    notify('目前暫停寫入，以免覆蓋原始資料。請先在設定處理資料問題。', true);
    return false;
  }
  try {
    store.save(next);
    state = parseAppState(JSON.stringify(next));
    storageBlocked = false;
    document.querySelector('#storage-error').hidden = true;
    applyTheme();
    return true;
  } catch (error) {
    notify(error.message, true);
    return false;
  }
}

function confirmation(title, body, buttonText = '確認', danger = false) {
  const dialog = document.querySelector('#confirm-dialog');
  document.querySelector('#dialog-title').textContent = title;
  document.querySelector('#dialog-body').textContent = body;
  const button = document.querySelector('#dialog-confirm');
  button.textContent = buttonText;
  button.className = `btn${danger ? ' danger' : ''}`;
  dialog.returnValue = '';
  const trigger = document.activeElement;
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      trigger?.focus();
      resolve(dialog.returnValue === 'confirm');
    }, {once:true});
    dialog.showModal();
  });
}

const pageHeading = (eyebrow, title, lead = '', back = '') => `<div class="page-heading">${back ? `<a class="back" href="${escape(back)}">← 返回</a>` : ''}<p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}</div>`;
const sample = () => `<p class="notice">${REVIEW_NOTICE}。練習量達標只代表紀錄進度，動作品質仍需教練確認。</p>`;
const pages = createLearningPages({main,getState:()=>state,getStudent:student,isCoach,persist,updateStudent,notify,heading:pageHeading,id,cloud,appVersion:APP_VERSION});
function exerciseRow(exercise, index) {
  const progress = exerciseProgress(exercise, student().records);
  return `<article class="exercise-row"><span class="number" aria-hidden="true">${String(index + 1).padStart(2,'0')}</span><div class="row-body"><h3>${escape(exercise.name)}</h3><p>${escape(exercise.prescription.label)} · ${progress.complete ? '已完成範例量' : `${progress.percent}% 已記錄`}</p><div class="mini-progress" aria-hidden="true"><span style="width:${progress.percent}%"></span></div></div><a class="row-link" href="#exercise/${exercise.id}" aria-label="查看${escape(exercise.name)}教學">↗</a></article>`;
}

function renderStages() {
  main.innerHTML = `${pageHeading('五階段訓練', '一步一步，打好基礎。', '先建立動作，再把步伐與擊球連起來。')}
    <div class="learning-entry"><a class="text-link" href="#equipment">第 0 課：選一支適合的球拍 →</a><a class="text-link" href="#movements">桌球基本動作有幾種 →</a></div><div class="stage-grid">${curriculum.map(stage => {
      const open = unlocked(stage.id);
      return `<article class="stage-card ${open ? '' : 'locked'}"><div class="stage-card-top"><span class="stage-index">0${stage.id}</span><span class="badge">${completedStage(stage) ? '教練已確認' : open ? '已解鎖' : '尚未解鎖'}</span></div><h2>${stage.name}</h2><p>${stage.duration} · ${stage.exercises.length} 個動作</p><p>${escape(stage.goal)}</p><p class="caption">${REVIEW_NOTICE}</p><progress value="${stageProgress(stage)}" max="100" aria-label="階段${stage.id}練習量完成度"></progress><p>練習量 ${stageProgress(stage)}%</p>${open ? `<a class="text-link" href="#stage/${stage.id}">查看本階段 →</a>` : `<p class="caption">完成前階段評估並取得教練確認後解鎖。</p>`}</article>`;
    }).join('')}</div>`;
}

function renderStage(stage) {
  main.innerHTML = `${pageHeading(`階段 ${stage.id} · ${stage.duration}`, stage.name, escape(stage.goal), '#stages')}${sample()}<div class="section-heading"><h2>本階段動作</h2><span class="caption muted">${stage.exercises.length} 項</span></div><div class="exercise-list">${stage.exercises.map(exerciseRow).join('')}</div><div class="actions"><a class="btn full-width" href="#assessment/${stage.id}">進行階段評估 →</a></div>`;
}

function recordCard(record) {
  const exercise = exercises.find(item => item.id === record.exerciseId);
  const feedback = student().feedback.filter(item=>item.targetType==='record' && item.targetId===record.id);
  return `<article class="record-entry"><div class="record-top"><h3>${escape(exercise.name)}</h3><time datetime="${escape(record.createdAt)}">${dateLabel(record.createdAt)}</time></div><p>${record.reps} 次 × ${record.sets} 組 · 共 ${record.reps * record.sets} 次 · 穩定度 ${record.rating} / 5 · ${record.minutes||0} 分鐘</p>${record.note ? `<p class="muted">練習備註：${escape(record.note)}</p>` : ''}${record.coachFeedback ? `<p>教練回饋：${escape(record.coachFeedback)}</p>` : ''}${feedback.map(item=>`<p class="notice">教練回饋：${escape(item.text)}</p>`).join('')}${isCoach()?`<form class="coach-feedback-form" data-record-id="${escape(record.id)}"><label class="field"><span>給這筆練習回饋</span><textarea name="text" maxlength="2000" required></textarea></label><button class="btn secondary">儲存教練回饋</button></form>`:''}</article>`;
}

main.addEventListener('submit',event=>{
  if (!event.target.matches('.coach-feedback-form')) return;
  event.preventDefault();
  if (!isCoach()) return;
  const text = new FormData(event.target).get('text').trim();
  if (!text) return notify('請先輸入回饋內容。',true);
  const feedback={id:id(),targetType:'record',targetId:event.target.dataset.recordId,text,createdAt:new Date().toISOString()};
  if (updateStudent({...student(),feedback:[...student().feedback,feedback]})) { render(); notify('教練回饋已儲存。'); }
});

function renderRecords() {
  main.innerHTML = `${pageHeading('練習手帳', '看見累積的進步。', `已保存 ${student().records.length} 筆練習與 ${student().assessments.length} 筆測驗；雲端同步狀態請見設定。`)}
    <label class="field"><span>依訓練階段篩選</span><select id="record-filter"><option value="all">全部階段</option>${curriculum.map(stage => `<option value="${stage.id}">階段 ${stage.id}：${stage.name}</option>`).join('')}</select></label><div id="record-list"></div>`;
  const update = () => {
    const filter = document.querySelector('#record-filter').value;
    const records = student().records.filter(record => filter === 'all' || exercises.find(exercise => exercise.id === record.exerciseId).stageId === Number(filter)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    document.querySelector('#record-list').innerHTML = records.length ? records.map(recordCard).join('') : `<div class="empty-state"><h2>你的練習故事，正要開始。</h2><p>完成一次練習後，在這裡回顧次數、穩定度與教練回饋。</p><div class="actions"><a class="btn full-width" href="#home">前往今天練習 →</a></div></div>`;
    const assessments=student().assessments.filter(item=>filter==='all'||exercises.find(exercise=>exercise.id===item.exerciseId).stageId===Number(filter)).slice().sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
    document.querySelector('#record-list').insertAdjacentHTML('afterbegin',`<section class="detail-section"><h2>動作測驗紀錄</h2>${assessments.map(item=>{const exercise=exercises.find(exercise=>exercise.id===item.exerciseId);return `<article class="standard-row"><h3>${escape(exercise.name)}</h3><p>${dateLabel(item.createdAt)} · ${escape(evaluateExerciseQualification(exercise,item).label)}</p>${exercise.standards.map(standard=>`<p class="caption">${escape(standard.label)}：${escape(evaluateStandard(standard,item.results[standard.id]).label)}</p>`).join('')}<a class="text-link" href="#test/${exercise.id}">查看測驗與原始計數 →</a></article>`;}).join('')||'<p class="muted">還沒有測驗，請到動作頁的合格標準開始。</p>'}</section>`);
  };
  document.querySelector('#record-filter').addEventListener('change', update);
  update();
}

function renderAssessment(stage) {
  const confirmed = student().advancements.find(item => item.stageId === stage.id);
  main.innerHTML = `${pageHeading(`階段 ${stage.id} · 階段評估`, '準備好下一步了嗎？', '先對照動作檢核，再請教練確認。', `#stage/${stage.id}`)}${sample()}
    <section><h2>先看看練習進度</h2><div class="exercise-list">${stage.exercises.map(exerciseRow).join('')}</div></section>
    <form id="assessment-form"><div class="section-heading"><h2>動作檢核清單</h2></div><p class="muted caption">請依實際表現勾選；此處的自評不等於教練確認。</p><div class="checklist">${stage.checks.map(check => `<label class="check-row"><input type="checkbox" name="check" value="${check.id}" ${confirmed ? 'checked disabled' : ''}><span>${escape(check.text)}</span></label>`).join('')}</div>
    <div id="assessment-result" class="assessment-result" role="status"></div>
    ${confirmed ? `<p class="notice success">教練已於 ${dateLabel(confirmed.confirmedAt)} 確認本階段。${stage.id === 5 ? '繼續保持練習，逐步提升實戰表現。' : '下一階段已解鎖。'}</p><a class="btn full-width" href="${stage.id === 5 ? '#home' : `#stage/${stage.id+1}`}">${stage.id === 5 ? '繼續今日練習' : '前往下一階段 →'}</a>` : !isCoach() ? '<p class="notice">學員可自我檢核，請將學員檔交給教練確認晉級。</p>' : `<label class="check-row coach-check"><input id="coach-confirmed" type="checkbox" name="coachConfirmed"><span><strong>教練確認</strong><br>我已觀察這位學員的動作並確認，可以${stage.id === 5 ? '完成本輪五階段檢核' : '進入下一階段'}。</span></label><p id="advance-hint" class="muted caption" style="margin:12px 0"></p><button id="advance-button" class="btn full-width" type="submit" disabled>${stage.id === 5 ? '完成五階段檢核' : '確認晉級，解鎖下一階段'}</button>`}</form>`;
  const form = document.querySelector('#assessment-form');
  form.insertAdjacentHTML('beforebegin',`<section class="detail-section"><h2>每個動作的合格狀態</h2>${stage.exercises.map(exercise=>{
    const latest=(student().assessments||[]).filter(item=>item.exerciseId===exercise.id).sort((a,b)=>Date.parse(a.updatedAt||a.createdAt)-Date.parse(b.updatedAt||b.createdAt)).at(-1);
    const result=evaluateExerciseQualification(exercise,latest);
    return `<article class="qualification-row"><div><strong>${escape(exercise.name)}</strong><p>${result.qualified?'合格 · 教練已確認':latest?'尚未合格／待教練確認':'尚未測驗'}</p></div><a class="text-link" href="#test/${exercise.id}">測驗紀錄 →</a></article>`;
  }).join('')}</section>`);
  const checkedIds = () => [...form.querySelectorAll('[name=check]:checked')].map(input => input.value);
  const update = () => {
    const result = evaluateStage(stage, student().records, checkedIds(), student().assessments);
    document.querySelector('#assessment-result').innerHTML = `<strong>${escape(result.label)}</strong><p>${escape(result.message)}</p>`;
    if (!confirmed && isCoach()) {
      const coach = document.querySelector('#coach-confirmed').checked;
      document.querySelector('#advance-button').disabled = !canAdvanceStage(stage,student().records,checkedIds(),coach,student().assessments);
      document.querySelector('#advance-hint').textContent = result.status !== 'ready' ? '請先完成每個動作的合格測驗、品質評分與本階段檢核，再請教練確認。' : !coach ? '動作檢核已齊全，仍需勾選教練確認才能晉級。' : '已取得教練確認，可按下按鈕完成本階段。';
    }
  };
  form.addEventListener('change', update);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const checks = checkedIds();
    if (!isCoach() || confirmed || !canAdvanceStage(stage,student().records,checks,document.querySelector('#coach-confirmed').checked,student().assessments)) return;
    const accepted = await confirmation('確認教練已完成評估', '請確認教練已實際觀察動作並同意通過。練習次數與自評僅作參考。', stage.id === 5 ? '完成本輪檢核' : '確認並解鎖');
    if (!accepted) return;
    const advancement = {stageId:stage.id,coachConfirmed:true,checkedIds:checks,confirmedAt:new Date().toISOString(),standardVersion:'task004'};
    if (updateStudent({...student(),advancements:[...student().advancements,advancement]})) {
      render();
      notify(stage.id === 5 ? '已完成五階段檢核，接下來持續練習與回顧。' : `階段 ${stage.id+1} 已解鎖，繼續累積下一步的進步。`);
    }
  });
  update();
}

function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderCoach() {
  if (!isCoach()) { main.innerHTML=`${pageHeading('教練工作區','請先切換教練模式','請到設定切換角色，再管理學員。')}<a class="btn" href="#settings">前往設定</a>`; return; }
  const current=student();
  main.innerHTML=`${pageHeading('教練工作區','照顧每一位學員。','選擇學員後，教學、紀錄與影片都會切換為該學員。')}
    <form id="add-student"><label class="field"><span>新增學員姓名或暱稱</span><input name="name" maxlength="80" required></label><button class="btn">新增學員</button></form>
    <section class="detail-section"><h2>學員名單</h2><div class="student-list">${state.students.map(item=>{const stage=curriculum.find(s=>s.id===currentStageId(curriculum,item.advancements));const progress=evaluateStage(stage,item.records,[]).progress;return `<article class="student-row"><div><h3>${escape(item.name)} ${item.id===current.id?'<span class="badge">目前學員</span>':''}</h3><p class="muted caption">階段 ${stage.id} · ${stage.name} · 練習量 ${progress}% · ${item.records.length} 筆</p></div><button class="btn secondary" data-select-student="${escape(item.id)}" ${item.id===current.id?'disabled':''}>切換學員</button></article>`;}).join('')}</div></section>
    <section class="detail-section"><h2>${escape(current.name)}的教練安排</h2><p>我的球拍：${current.paddle?escape([current.paddle.grip,current.paddle.blade,current.paddle.rubber,current.paddle.weight?`${current.paddle.weight} 克`:'未量重量'].filter(Boolean).join(' · ')):'尚未記錄'}</p><div class="actions"><a class="btn secondary" href="#equipment">查看我的球拍</a><a class="btn secondary" href="#faq">回答學員提問</a><a class="btn secondary" href="#records">查看紀錄與回饋</a><a class="btn secondary" href="#assessment/${currentStage().id}">確認階段晉級</a><a class="btn secondary" href="#recorder">查看影片片段</a></div>
    <form id="assign-plan"><label class="field"><span>指定課表日期</span><input type="date" name="date" value="${localDay()}" required></label><fieldset class="plan-checks"><legend>指定練習動作（覆蓋當日自動推薦）</legend>${exercises.filter(item=>unlocked(item.stageId)).map(item=>`<label class="check-row"><input name="exerciseId" type="checkbox" value="${item.id}"><span>${escape(item.name)}</span></label>`).join('')}</fieldset><div class="actions"><button class="btn secondary">儲存指定課表</button><button class="btn secondary" type="button" id="reset-plan">恢復今日自動推薦</button></div></form></section>
    <details><summary>學員名稱與移除</summary><form id="rename-student"><label class="field"><span>目前學員姓名或暱稱</span><input name="name" maxlength="80" value="${escape(current.name)}" required></label><button class="btn secondary">儲存名稱</button></form><div class="actions"><button class="btn secondary" id="delete-student" ${state.students.length===1?'disabled':''}>刪除目前學員</button></div><p class="caption muted">至少保留一位學員；刪除會一併移除本機影片，請先備份。</p></details><div class="actions"><a class="text-link" href="#settings">匯入或匯出學員檔 →</a></div>`;
  document.querySelector('#add-student').addEventListener('submit',event=>{event.preventDefault();const name=new FormData(event.target).get('name').trim();if(!name)return;const next={id:id(),name,records:[],advancements:[],feedback:[],countermeasureResults:[],assignments:[]};if(persist({...state,students:[...state.students,next],activeStudentId:next.id})){render();notify('已新增學員。');}});
  main.querySelectorAll('[data-select-student]').forEach(button=>button.addEventListener('click',()=>{if(persist({...state,activeStudentId:button.dataset.selectStudent})){guidedDraft=null;render();}}));
  document.querySelector('#rename-student').addEventListener('submit',event=>{event.preventDefault();const name=new FormData(event.target).get('name').trim();if(name && updateStudent({...student(),name,updatedAt:new Date().toISOString()})){render();notify('學員名稱已更新。');}});
  document.querySelector('#assign-plan').addEventListener('submit',event=>{event.preventDefault();const values=new FormData(event.target);const exerciseIds=values.getAll('exerciseId');if(!exerciseIds.length)return notify('請至少選擇一個動作。',true);const date=values.get('date');const assignment={id:id(),date,exerciseIds,createdAt:new Date().toISOString()};if(updateStudent({...student(),assignments:[...student().assignments.filter(item=>item.date!==date),assignment]}))notify('已儲存教練指定課表。');});
  document.querySelector('#reset-plan').addEventListener('click',()=>{if(updateStudent({...student(),assignments:[...student().assignments.filter(item=>item.date!==localDay()),{id:id(),date:localDay(),exerciseIds:[],createdAt:new Date().toISOString()}]}))notify('已恢復今日自動推薦。');});
  document.querySelector('#delete-student').addEventListener('click',async()=>{
    const removingId=student().id;
    if(state.students.length<=1 || !await confirmation('刪除這位學員？','這會刪除該學員的本機紀錄、回饋與影片。雲端資料不會隨之刪除。','確定刪除',true))return;
    const students=state.students.filter(item=>item.id!==removingId);
    if(!persist({...state,students,activeStudentId:students[0].id}))return;
    render();
    try {await store.deleteStudentVideos(removingId);notify('學員與本機影片已刪除。');}
    catch(error){notify(`學員文字資料已刪除，影片清理尚未完成：${error.message} 如需移除殘留影片，可在備份後清除所有本機資料。`,true);}
  });
}

function renderSettings() {
  main.innerHTML=`${pageHeading('你的練習空間','設定與資料備份','定期匯出學員檔，與教練交換練習成果。')}
    <section class="settings-section"><h2>角色與畫面</h2><label class="field"><span>目前角色</span><select id="role-select"><option value="student">我是學員</option><option value="coach">我是教練</option></select></label><p>本機切換沒有身分認證。雲端操作仍依登入者的資料權限。</p>${state.students.length>1?`<label class="field"><span>目前學員</span><select id="student-select">${state.students.map(item=>`<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('')}</select></label>`:''}<label class="field"><span>顯示模式</span><select id="theme-select"><option value="system">跟隨裝置</option><option value="light">淺色模式</option><option value="dark">深色模式</option></select></label>${isCoach()?'<a class="text-link" href="#coach">管理學員與課表 →</a>':''}</section>
    <section class="settings-section"><h2>學員檔與完整備份</h2><p>學員檔包含這位學員的練習、晉級、教練回饋、課表及對策紀錄。相同編號會合併，影片檔案不在其中。</p><div class="actions"><button id="export-student" class="btn secondary">匯出${isCoach()?'目前':'我的'}學員檔</button><button id="export-button" class="btn secondary">匯出完整備份</button></div><label class="field"><span>匯入學員檔（合併，不重複）</span><input id="student-file" type="file" accept=".json,application/json"></label><details><summary>從完整備份還原</summary><p>還原會取代目前全部學員與設定，請先備份。也接受舊版單一學員備份。</p><label class="field"><span>選擇完整備份</span><input id="import-file" type="file" accept=".json,application/json"></label></details><p id="import-result" role="status"></p>${storageBlocked?'<button class="btn secondary" id="export-raw">匯出未解析原始資料</button>':''}</section>
    <section class="settings-section"><h2>雲端同步</h2><p>${cloud.configured?(cloud.session?'已登入。按下同步後才交換文字資料，影片留在本機。':'已設定服務，請透過電子郵件登入。'):'雲端同步：未設定。現在完全以本機運作；設定方式請見使用說明。'}</p>${cloud.configured?cloud.session?'<div class="actions"><button class="btn secondary" id="sync-cloud">同步文字資料</button><button class="btn secondary" id="sign-out">登出雲端</button></div>':'<form id="sign-in"><label class="field"><span>登入電子郵件</span><input name="email" type="email" required autocomplete="email"></label><button class="btn secondary">寄送登入連結</button></form>':''}<p class="caption muted">雲端帳號、教練關係及學員綁定需由服務管理者事先設定，切換角色不會取得更多權限。</p></section>
    <section class="settings-section"><h2>常見問題與意見回饋</h2><p>先搜尋答案，找不到時可留下提問；問題回報、功能建議與教學錯誤也可告訴我們。</p><div class="actions"><a class="btn secondary" href="#faq">常見問題與提問</a><a class="btn secondary" href="#feedback">填寫意見回饋</a><button class="btn secondary" id="export-feedback">匯出意見回饋</button></div><p class="caption muted">已儲存 ${state.feedback.length} 筆回饋。</p></section>
    <section class="settings-section"><h2>重新開始</h2><p>清除本機全部學員、練習、影片與設定。清除前請先匯出備份。</p><div class="actions"><button id="clear-button" class="btn secondary">清除所有本機資料</button></div></section>`;
  for (const [selector,key] of [['#theme-select','theme'],['#role-select','role']]){const select=document.querySelector(selector);select.value=state[key];select.addEventListener('change',()=>{if(persist({...state,[key]:select.value})){render();}else select.value=state[key];});}
  const studentSelect=document.querySelector('#student-select');
  if(studentSelect){studentSelect.value=state.activeStudentId;studentSelect.addEventListener('change',()=>{if(persist({...state,activeStudentId:studentSelect.value})){guidedDraft=null;render();}});}
  document.querySelector('#export-student').addEventListener('click',()=>{if(storageBlocked)return notify('請先匯出未解析原始資料。',true);download(exportStudentFile(student()),'桌球學員檔.json','application/json');});
  document.querySelector('#export-button').addEventListener('click',()=>{if(storageBlocked)return notify('請先匯出未解析原始資料。',true);download(exportAppState(state),'桌球完整備份.json','application/json');});
  document.querySelector('#export-feedback').addEventListener('click',()=>download(JSON.stringify(state.feedback,null,2),'桌球意見回饋.json','application/json'));
  document.querySelector('#export-raw')?.addEventListener('click',()=>download(store.getRaw()||'','桌球原始儲存資料.txt','text/plain'));
  for(const [selector,restore] of [['#student-file',false],['#import-file',true]])document.querySelector(selector).addEventListener('change',event=>importFile(event,restore));
  document.querySelector('#clear-button').addEventListener('click',async()=>{if(!await confirmation('清除所有本機資料？','所有學員與影片將從此瀏覽器移除，沒有備份便無法還原。雲端資料不會刪除。','確定清除',true))return;try{await store.clear();cloud.session=null;state=createAppState();storageBlocked=false;document.querySelector('#storage-error').hidden=true;applyTheme();render();notify('本機資料已清除。');}catch(error){notify(error.message,true);}});
  document.querySelector('#sign-in')?.addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{await cloud.sendMagicLink(new FormData(event.target).get('email'),`${location.origin}${location.pathname}`);notify('登入連結已寄出，請查看電子郵件。');}catch(error){notify(error.message,true);}finally{button.disabled=false;}});
  document.querySelector('#sign-out')?.addEventListener('click',async()=>{try{await cloud.signOut();render();notify('已登出雲端，本機紀錄保留。');}catch(error){notify(error.message,true);}});
  document.querySelector('#sync-cloud')?.addEventListener('click',syncCloud);
}

async function importFile(event,restore) {
  const input=event.currentTarget;const file=input.files[0];if(!file||importPending)return;
  const version=routeVersion;const role=state.role;const selectedId=student().id;importPending=true;input.disabled=true;
  const result=document.querySelector('#import-result');result.textContent='正在檢查檔案…';
  try{
    if(file.size>2*1024*1024)throw new Error('檔案超過 2 MB，請改用較小的有效備份。');
    const text=await file.text();const incoming=restore?parseAppState(text):parseStudentFile(text);
    if(version!==routeVersion)return;
    if(!restore && role==='student' && incoming.id!==selectedId && (student().records.length || student().advancements.length))throw new Error('這是不同學員的檔案，請切換教練模式加入名單；如為你的舊學員檔，請先備份目前資料再操作。');
    if(!await confirmation(restore?'取代全部本機文字資料？':'合併這份學員檔？',restore?`包含 ${incoming.students.length} 位學員。請確認已備份目前資料。`:`學員：${incoming.name}，練習 ${incoming.records.length} 筆。相同編號不重複。`,'確認匯入')){result.textContent='已取消，原資料保留。';return;}
    if(version!==routeVersion || state.role!==role || student().id!==selectedId)return;
    let next=incoming;
    if(!restore){const existing=state.students.find(item=>item.id===incoming.id);const merged=existing?mergeStudent(existing,incoming):incoming;const students=existing?state.students.map(item=>item.id===merged.id?merged:item):[...state.students,merged];next={...state,students,activeStudentId:merged.id};}
    if(persist(next,true)){render();notify(restore?'備份已還原。':'學員檔已合併。');}
  }catch(error){result.textContent=error.message;result.className='notice error';}
  finally{importPending=false;input.disabled=false;input.value='';}
}

async function syncCloud() {
  if(syncing)return;
  const button=document.querySelector('#sync-cloud');syncing=true;if(button)button.disabled=true;
  const role=state.role;
  try{
    const incoming=await cloud.pullStudents({role});
    const faqIncoming=await cloud.pullFaqEntries();
    const questionIncoming=await cloud.pullQuestions();
    if(state.role!==role)throw new Error('角色已變更，請在目前角色重新同步。');
    let students=[...state.students];
    for(const item of incoming){const existing=students.find(s=>s.id===item.id);students=existing?students.map(s=>s.id===item.id?mergeStudent(s,item):s):[...students,item];}
    // 其他裝置可能已把此帳號綁到不同編號。保留本機原資料，改開啟帳號的雲端學員。
    const activeStudentId=role==='student' && incoming.length ? incoming[0].id : state.activeStudentId;
    const switched=activeStudentId!==state.activeStudentId;
    const newest=(existing,incoming)=>{const map=new Map(existing.map(item=>[item.id,item]));for(const item of incoming){const old=map.get(item.id);if(!old||Date.parse(item.updatedAt||item.createdAt)>=Date.parse(old.updatedAt||old.createdAt))map.set(item.id,item);}return [...map.values()];};
    const faqEntries=mergeFaqEntries(state.faqEntries,faqIncoming,role);
    if(!persist({...state,students,activeStudentId,faqEntries,feedback:newest(state.feedback,questionIncoming)}))return;
    const targets=role==='student' ? students.filter(item=>item.id===activeStudentId) : students;
    for(const item of targets)await cloud.pushStudent(item,{role});
    if(role==='coach'){
      const sentFaq=state.faqEntries.map(item=>({...item}));
      await cloud.pushFaqEntries(sentFaq);
      if(!persist({...state,faqEntries:state.faqEntries.map(item=>sentFaq.some(sent=>sent.id===item.id&&sent.updatedAt===item.updatedAt)?{...item,cloudUpdatedAt:item.updatedAt}:item)}))return;
    }
    for(const item of state.feedback){if(role==='student'&&item.type==='question'&&item.answer!==undefined)continue;await cloud.submitFeedback(item);}
    render();notify(`文字資料與意見回饋已同步；影片保留在本機。${switched?'已開啟登入帳號的雲端學員，原本的本機學員資料仍保留，可在設定切換。':''}`);
  }catch(error){notify(`同步未完成：${error.message} 本機資料保留，可修正設定後重試。`,true);}
  finally{syncing=false;if(button)button.disabled=false;}
}

function renderFeedback() {
  main.innerHTML=`${pageHeading('讓練習更順手','意見回饋','請描述發生什麼事，以及希望如何改善。',feedbackOrigin)}<form id="app-feedback-form"><label class="field"><span>回饋類型</span><select name="type"><option value="bug">問題回報</option><option value="feature">功能建議</option><option value="content">教學內容錯誤</option><option value="question">提問</option></select></label><label class="field"><span>說明</span><textarea name="message" maxlength="2000" required></textarea></label><label class="field"><span>聯絡方式（選填）</span><input name="contact" maxlength="200"></label><p class="notice">自動附上頁面、版本 ${APP_VERSION} 與裝置類型、視窗大小；提問另附本機學員編號作對應，不附上姓名、錄影或登入資訊。請勿在說明內填寫密碼等敏感資料。</p><button class="btn full-width">送出意見回饋</button></form>`;
  document.querySelector('#app-feedback-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.target;const values=new FormData(form);const message=values.get('message').trim();if(!message)return notify('請先輸入說明。',true);
    const item={id:id(),type:values.get('type'),...(values.get('type')==='question'?{studentId:student().id}:{}),message,contact:values.get('contact').trim(),page:feedbackOrigin,appVersion:APP_VERSION,device:{platform:matchMedia('(pointer: coarse)').matches?'touch':'desktop',viewport:`${innerWidth}×${innerHeight}`},createdAt:new Date().toISOString()};
    if(!persist({...state,feedback:[...state.feedback,item]}))return;
    form.reset();const button=form.querySelector('button');button.disabled=true;
    try{if(cloud.configured && cloud.session){await cloud.submitFeedback(item);notify('意見回饋已儲存並同步。');}else notify('意見回饋已存本機，可在設定匯出。');}
    catch(error){notify(`回饋已存本機，雲端尚未送達：${error.message}`,true);}
    finally{button.disabled=false;}
  });
}

async function initAuth() {
  if(!cloud.configured)return;
  try{
    const params=new URLSearchParams(location.hash.slice(1));
    if(params.has('error'))throw new Error('登入連結已失效或被拒絕，請重新取得登入信件。');
    await cloud.handleCallback(location.href);
  }catch(error){return `雲端登入未完成：${error.message}`;}
  finally{if(location.hash.includes('access_token')||location.hash.includes('error='))history.replaceState(null,'',`${location.pathname}#settings`);}
}

function render() {
  recorderCleanup?.();
  recorderCleanup = null;
  routeVersion++;
  if (location.hash === '#feedback') feedbackOrigin = lastRoute;
  else lastRoute = location.hash || '#home';
  const [route = 'home', parameter] = location.hash.slice(1).split('/');
  const section = ['stage','exercise','practice','guided','assessment','equipment','movements','test'].includes(route) ? 'stages' : route;
  document.querySelectorAll('[data-nav]').forEach(link => {
    if (link.dataset.nav === section) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  });
  document.querySelector('#message').hidden = true;
  renderContext();
  if (!state.role && !['settings','feedback'].includes(route)) { renderWelcome(); return; }
  if (route === 'stages') renderStages();
  else if (route === 'records') renderRecords();
  else if (route === 'settings') renderSettings();
  else if (route === 'coach') renderCoach();
  else if (route === 'feedback') renderFeedback();
  else if (route === 'equipment') recorderCleanup = pages.equipment();
  else if (route === 'movements') pages.movements();
  else if (route === 'faq') pages.faq();
  else if (route === 'recorder') {
    renderVideo(exercises.find(item => item.id === parameter) || currentStage().exercises[0]);
  } else if (['stage','exercise','practice','guided','assessment','test'].includes(route)) {
    const exercise = exercises.find(item => item.id === parameter);
    const stage = curriculum.find(item => item.id === (exercise ? exercise.stageId : Number(parameter)));
    if (!stage || (['exercise','practice','guided','test'].includes(route) && !exercise)) {
      main.innerHTML = `${pageHeading('找不到這一頁', '回到你的練習路線。', '這個動作或階段不存在。')}<a class="btn" href="#stages">查看訓練階段</a>`;
    } else if (!unlocked(stage.id)) {
      main.innerHTML = `${pageHeading('階段尚未解鎖', '先把前一步練穩。', '完成前階段練習與評估，並取得教練確認後，即可解鎖。')}<a class="btn" href="#stages">返回訓練階段</a>`;
    } else if (route === 'stage') renderStage(stage);
    else if (route === 'exercise') renderExercise(exercise);
    else if (route === 'practice') renderPractice(exercise);
    else if (route === 'guided') renderGuided(exercise);
    else if (route === 'test') recorderCleanup = pages.test(exercise);
    else renderAssessment(stage);
  } else renderHome();
  document.title = `${main.querySelector('h1')?.textContent || '今天練什麼'}｜智慧桌球教練`;
  main.focus({preventScroll:true});
  window.scrollTo({top:0,behavior:'instant'});
}

window.addEventListener('hashchange', render);
window.addEventListener('pagehide', () => recorderCleanup?.());
function connectionStatus() {
  document.querySelector('#connection-status').textContent = navigator.onLine ? '紀錄儲存於本機' : '離線練習中';
}
window.addEventListener('online', connectionStatus);
window.addEventListener('offline', connectionStatus);
connectionStatus();
const authError = await initAuth();
render();
if(authError)notify(authError,true);
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    document.querySelector('#connection-status').textContent = '離線快取未啟用';
  });
}
