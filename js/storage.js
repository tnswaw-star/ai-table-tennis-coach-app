import { curriculum, exercises, verifiedVideos } from '../data/curriculum.js';
import { canAdvanceStage, getUnlockedStageIds, parseYouTubeId } from './logic.js';

export const STORAGE_KEY = 'table-tennis-coach-v1';
const MAX_BYTES = 2 * 1024 * 1024;
const exerciseMap = new Map(exercises.map(exercise => [exercise.id, exercise]));
const verifiedVideoIds = new Set(verifiedVideos.map(video => video.id));
const faqCategories = ['球拍與裝備', '學習與練習', '合格與晉級', '安全與身體', '程式使用'];

export function createState() {
  return { version: 1, records: [], advancements: [], theme: 'system', feedback: [] };
}

function fail(message) { throw new Error(message); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function string(value, label, max = 2000, optional = false) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    fail(`${label}格式不正確，請檢查內容與長度。`);
  }
  return value;
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label}必須是 ${min} 至 ${max} 的整數。`);
  return value;
}
function date(value, label) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${label}日期格式不正確。`);
  }
  return new Date(value).toISOString();
}
function unique(items, label) {
  if (new Set(items).size !== items.length) fail(`${label}不可重複。`);
}

/** Validate before replacing any existing data. Unknown properties are discarded. */
export function parseState(json, { assessments = [] } = {}) {
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > MAX_BYTES) fail('匯入檔案過大，請使用小於 2 MB 的備份。');
  let input;
  try { input = JSON.parse(json); } catch { fail('檔案不是有效的紀錄備份，請選擇本程式匯出的 JSON 檔。'); }
  if (!object(input) || input.version !== 1 || !Array.isArray(input.records) || !Array.isArray(input.advancements)) {
    fail('備份版本或資料格式不正確，請使用本程式匯出的第 1 版備份。');
  }
  if (input.records.length > 10000 || input.advancements.length > curriculum.length) fail('備份紀錄筆數超出限制。');
  const records = input.records.map(record => {
    if (!object(record) || !exerciseMap.has(record.exerciseId)) fail('練習紀錄含有未知的動作。');
    return {
      id: string(record.id, '紀錄編號', 128),
      exerciseId: record.exerciseId,
      reps: integer(record.reps, 1, 10000, '每組完成次數'),
      sets: integer(record.sets, 1, 100, '完成組數'),
      rating: integer(record.rating, 1, 5, '穩定度自評'),
      note: string(record.note, '練習備註', 2000, true),
      coachFeedback: string(record.coachFeedback, '教練回饋', 2000, true),
      createdAt: date(record.createdAt, '練習'),
    };
  });
  unique(records.map(record => record.id), '紀錄編號');
  const advancements = input.advancements.map(advancement => {
    if (!object(advancement) || advancement.coachConfirmed !== true || !Array.isArray(advancement.checkedIds)) fail('晉級資料必須包含教練確認與檢核項目。');
    const stageId = integer(advancement.stageId, 1, curriculum.length, '階段編號');
    const stage = curriculum.find(item => item.id === stageId);
    unique(advancement.checkedIds, '晉級檢核項目');
    if (advancement.checkedIds.length !== stage.checks.length || advancement.checkedIds.some(id => !stage.checks.some(check => check.id === id))) {
      fail('晉級檢核項目不完整或含有未知項目。');
    }
    if (advancement.standardVersion !== undefined && advancement.standardVersion !== 'task004') fail('晉級標準版本不正確。');
    return { stageId, coachConfirmed: true, checkedIds: [...advancement.checkedIds], confirmedAt: date(advancement.confirmedAt, '教練確認'),
      ...(advancement.standardVersion === 'task004' ? { standardVersion: 'task004' } : {}) };
  }).sort((a, b) => a.stageId - b.stageId);
  unique(advancements.map(advancement => advancement.stageId), '晉級階段');
  for (let index = 0; index < advancements.length; index++) {
    const advancement = advancements[index];
    const stage = curriculum[index];
    if (advancement.stageId !== stage.id || (index > 0 && advancement.confirmedAt < advancements[index - 1].confirmedAt)) fail('晉級紀錄必須依階段順序完成。');
    const earlierRecords = records.filter(record => record.createdAt <= advancement.confirmedAt);
    // 第 1、2 版舊晉級是歷史確認，依當時練習量驗證；新測驗不能回溯取消它。
    const historicalStage = { ...stage, exercises: stage.exercises.filter(item => item.id !== 's3-push').map(({ standards, ...item }) => item) };
    const earlierAssessments = assessments.filter(item => (item.updatedAt ?? item.createdAt) <= advancement.confirmedAt);
    if (!canAdvanceStage(advancement.standardVersion === 'task004' ? stage : historicalStage, earlierRecords, advancement.checkedIds, true, earlierAssessments)) {
      fail('晉級紀錄缺少當時達標的練習、測驗與穩定度，請檢查備份。');
    }
  }
  for (const record of records) {
    const stageId = exerciseMap.get(record.exerciseId).stageId;
    if (stageId > 1) {
      const previous = advancements.find(advancement => advancement.stageId === stageId - 1);
      if (!previous || record.createdAt < previous.confirmedAt) fail('紀錄包含尚未解鎖階段的練習。');
    }
  }
  const theme = input.theme ?? 'system';
  if (!['system', 'light', 'dark'].includes(theme)) fail('外觀設定格式不正確。');
  const rawFeedback = input.feedback ?? [];
  if (!Array.isArray(rawFeedback) || rawFeedback.length > 1000) fail('使用回饋格式或筆數不正確。');
  const feedback = rawFeedback.map(item => {
    if (!object(item)) fail('使用回饋格式不正確。');
    return { id: string(item.id, '回饋編號', 128), message: string(item.message, '回饋內容', 2000), createdAt: date(item.createdAt, '回饋') };
  });
  unique(feedback.map(item => item.id), '回饋編號');
  return { version: 1, records, advancements, theme, feedback };
}

export function loadState() {
  try {
    const saved = globalThis.localStorage.getItem(STORAGE_KEY);
    return { state: saved === null ? createState() : parseState(saved), error: null };
  } catch (error) {
    return { state: createState(), error: `無法讀取本機紀錄：${error.message || '儲存空間無法使用。'} 原有內容已保留，請先匯出原始資料或處理後再儲存。` };
  }
}

export function exportState(state) {
  return JSON.stringify(parseState(JSON.stringify(state)), null, 2);
}

export function saveState(state) {
  const json = exportState(state);
  try { globalThis.localStorage.setItem(STORAGE_KEY, json); }
  catch { fail('無法儲存：本機空間不足或瀏覽器禁止儲存。請先匯出紀錄，調整瀏覽器設定後重試。'); }
}

export function clearState() {
  try { globalThis.localStorage.removeItem(STORAGE_KEY); }
  catch { fail('無法清除本機資料，請檢查瀏覽器的網站儲存設定。'); }
}

// 第 1 版函式保留給既有備份工具；應用一律透過 LocalStore 使用第 2 版。
const SESSION_KEY = 'table-tennis-coach-session';
const VIDEO_DB = 'table-tennis-coach-media';
const newId = () => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function createStudent(name = '我的學習紀錄', id = newId()) {
  return { id, name, records: [], advancements: [], feedback: [], countermeasureResults: [], assignments: [], assessments: [] };
}

export function createAppState() {
  const student = createStudent();
  return { version: 2, role: null, activeStudentId: student.id, students: [student], theme: 'system', feedback: [], demos: {}, faqEntries: [] };
}

function readJSON(json) {
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > MAX_BYTES) fail('匯入檔案過大，請使用小於 2 MB 的備份。');
  try { return JSON.parse(json); } catch { fail('檔案不是有效的紀錄備份。'); }
}

function list(value, label, max = 10000) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}格式或筆數不正確。`);
  return value;
}

function entries(value, label, transform, max) {
  const result = list(value ?? [], label, max).map(transform);
  unique(result.map(item => item.id), `${label}編號`);
  return result;
}

function appFeedback(item) {
  if (!object(item)) fail('使用回饋格式不正確。');
  const result = { id: string(item.id, '回饋編號', 128), message: string(item.message, '回饋內容'), createdAt: date(item.createdAt, '回饋') };
  if (item.type !== undefined) {
    if (!['問題回報', '功能建議', '教學內容錯誤', '提問', 'question', 'bug', 'feature', 'suggestion', 'content'].includes(item.type)) fail('回饋類型不正確。');
    result.type = item.type === '提問' ? 'question' : item.type;
  }
  for (const [key, max] of [['contact', 200], ['page', 200], ['appVersion', 64], ['studentId', 128]]) {
    if (item[key] !== undefined) result[key] = string(item[key], '回饋資訊', max, true);
  }
  if (item.device !== undefined) {
    if (!object(item.device)) fail('裝置資訊格式不正確。');
    result.device = {};
    for (const key of ['platform', 'viewport', 'language']) {
      if (item.device[key] !== undefined) result.device[key] = string(item.device[key], '裝置資訊', 100, true);
    }
    if (item.device.kind !== undefined) {
      if (!['touch', 'desktop'].includes(item.device.kind)) fail('裝置類型不正確。');
      result.device.kind = item.device.kind;
    }
  }
  for (const [key, max] of [['answer', 6000], ['faqId', 128], ['category', 80]]) {
    if (item[key] !== undefined) result[key] = string(item[key], '提問答覆', max, true);
  }
  if (result.category && !faqCategories.includes(result.category)) fail('提問分類不正確。');
  if (item.status !== undefined) {
    if (!['pending', 'answered'].includes(item.status)) fail('提問狀態不正確。');
    result.status = item.status;
  }
  for (const key of ['answeredAt', 'updatedAt']) if (item[key] !== undefined) result[key] = date(item[key], '提問答覆');
  return result;
}

export function validateFaqEntry(item) {
  if (!object(item) || !faqCategories.includes(item.category) || !['builtin', 'coach'].includes(item.source)
    || !['published', 'hidden'].includes(item.status)) fail('常見問題分類、來源或狀態不正確。');
  const result = {
    id: string(item.id, '常見問題編號', 128), question: string(item.question, '常見問題題目', 500),
    answer: string(item.answer, '常見問題答案', 6000), category: item.category, source: item.source,
    status: item.status, author: string(item.author ?? '教練', '常見問題作者', 128),
    createdAt: date(item.createdAt, '常見問題'), updatedAt: date(item.updatedAt ?? item.createdAt, '常見問題更新'),
  };
  if (item.questionId !== undefined) result.questionId = string(item.questionId, '原提問編號', 128);
  if (item.cloudUpdatedAt !== undefined) result.cloudUpdatedAt = date(item.cloudUpdatedAt, '常見問題雲端版本');
  return result;
}

function validateAssessment(item) {
  if (!object(item) || !exerciseMap.has(item.exerciseId) || !object(item.results) || typeof item.coachConfirmed !== 'boolean') fail('測驗紀錄格式不正確。');
  const result = { id: string(item.id, '測驗編號', 128), exerciseId: item.exerciseId, results: {}, coachConfirmed: item.coachConfirmed, createdAt: date(item.createdAt, '測驗') };
  if (item.updatedAt !== undefined) result.updatedAt = date(item.updatedAt, '測驗更新');
  const movement = exerciseMap.get(item.exerciseId);
  for (const [id, value] of Object.entries(item.results)) {
    const standard = movement.standards?.find(candidate => candidate.id === id);
    if (!standard || !object(value)) fail('測驗標準不存在或格式不正確。');
    if (standard.type === 'success-rate') {
      const outcomes = list(value.outcomes, '逐球結果', standard.attempts);
      if (outcomes.some(outcome => typeof outcome !== 'boolean')) fail('逐球結果必須為成功或失誤。');
      result.results[id] = { outcomes: [...outcomes] };
    } else if (standard.type === 'consecutive') {
      result.results[id] = { runs: list(value.runs, '連續板數', standard.maxAttempts ?? 100).map(run => integer(run, 0, 100000, '連續板數')) };
    } else if (standard.type === 'timed-count') {
      if (typeof value.elapsedSeconds !== 'number' || !Number.isFinite(value.elapsedSeconds) || value.elapsedSeconds < 0 || value.elapsedSeconds > standard.seconds) fail('測驗秒數必須是有效範圍內的數字。');
      result.results[id] = { count: integer(value.count, 0, 100000, '限時計數'), elapsedSeconds: value.elapsedSeconds };
    } else if (standard.type === 'quality') {
      if (!object(value.grades)) fail('品質評分格式不正確。');
      const dimensions = standard.dimensions ?? [];
      const grades = {};
      for (const [dimension, grade] of Object.entries(value.grades)) {
        if (!dimensions.includes(dimension) || !['A', 'B', 'C', 'D'].includes(grade)) fail('品質評分維度或等級不正確。');
        grades[dimension] = grade;
      }
      result.results[id] = { grades };
    } else if (standard.type === 'checklist') {
      const ids = list(value.checkedIds, '空拍檢核', 100);
      const allowed = (standard.items ?? []).map(check => typeof check === 'string' ? check : check.id);
      if (ids.some(check => !allowed.includes(check))) fail('空拍檢核含有未知項目。');
      unique(ids, '空拍檢核');
      result.results[id] = { checkedIds: [...ids] };
    } else fail('測驗標準類型不正確。');
  }
  return result;
}

export function validateStudent(input) {
  if (!object(input)) fail('學員檔格式不正確。');
  const assessments = entries(input.assessments, '測驗紀錄', validateAssessment);
  const legacy = parseState(JSON.stringify({ version: 1, records: input.records, advancements: input.advancements, theme: 'system', feedback: [] }), { assessments });
  const records = legacy.records.map((record, index) => {
    const minutes = input.records[index].minutes;
    if (minutes !== undefined) {
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440) fail('練習分鐘數必須是 0 至 1440 的數字。');
      record.minutes = minutes;
    }
    return record;
  });
  const student = {
    id: string(input.id, '學員編號', 128), name: string(input.name, '學員名稱', 80), records, advancements: legacy.advancements,
    feedback: entries(input.feedback, '教練回饋', item => {
      if (!object(item) || !['record', 'video'].includes(item.targetType)) fail('教練回饋對象不正確。');
      return { id: string(item.id, '回饋編號', 256), targetType: item.targetType, targetId: string(item.targetId, '回饋對象', 128), text: string(item.text, '教練回饋'), createdAt: date(item.createdAt, '回饋') };
    }),
    countermeasureResults: entries(input.countermeasureResults, '對策紀錄', item => {
      if (!object(item) || !exerciseMap.has(item.exerciseId) || typeof item.helpful !== 'boolean') fail('對策紀錄格式不正確。');
      return { id: string(item.id, '對策編號', 128), exerciseId: item.exerciseId, problemId: string(item.problemId, '問題編號', 128), strategyId: string(item.strategyId, '對策編號', 128), helpful: item.helpful, createdAt: date(item.createdAt, '對策') };
    }),
    assignments: entries(input.assignments, '指定課表', item => {
      if (!object(item) || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(Date.parse(item.date))) fail('指定課表日期不正確。');
      const ids = list(item.exerciseIds, '課表動作', exercises.length);
      if (ids.some(id => !exerciseMap.has(id))) fail('指定課表含有未知的動作。');
      unique(ids, '課表動作');
      return { id: string(item.id, '課表編號', 128), date: item.date, exerciseIds: [...ids], createdAt: date(item.createdAt, '課表') };
    }, 1000),
    assessments,
  };
  if (input.paddle !== undefined) {
    if (!object(input.paddle)) fail('我的球拍格式不正確。');
    student.paddle = { grip: string(input.paddle.grip, '球拍握法', 80, true), blade: string(input.paddle.blade, '球拍底板', 300, true), rubber: string(input.paddle.rubber, '球拍膠皮', 300, true),
      weight: input.paddle.weight === null || input.paddle.weight === '' || input.paddle.weight === undefined ? null : integer(input.paddle.weight, 60, 300, '球拍重量') };
  }
  if (input.updatedAt !== undefined) student.updatedAt = date(input.updatedAt, '學員更新');
  return student;
}

export function parseAppState(json) {
  const input = readJSON(json);
  if (input?.version === 1) {
    const old = parseState(json);
    const student = { ...createStudent('原有學習紀錄'), records: old.records, advancements: old.advancements };
    return { version: 2, role: null, activeStudentId: student.id, students: [student], theme: old.theme, feedback: old.feedback, demos: {}, faqEntries: [] };
  }
  if (!object(input) || input.version !== 2 || ![null, 'student', 'coach'].includes(input.role)) fail('備份版本或角色格式不正確。');
  const students = list(input.students, '學員名單', 200).map(validateStudent);
  unique(students.map(student => student.id), '學員編號');
  if (!students.length || !students.some(student => student.id === input.activeStudentId)) fail('目前學員不在名單中。');
  if (!['system', 'light', 'dark'].includes(input.theme)) fail('外觀設定格式不正確。');
  const demos = {};
  if (!object(input.demos ?? {})) fail('示範影片設定格式不正確。');
  for (const [id, value] of Object.entries(input.demos ?? {})) {
    if (!exerciseMap.has(id) || !object(value)) fail('示範影片動作不正確。');
    if (value.type === 'local' || value.type === undefined) demos[id] = { type: 'local' };
    else if (value.type === 'url') {
      let url;
      try { url = new URL(value.url); } catch { fail('示範影片連結不正確。'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('示範影片只接受一般網頁影片連結。');
      const videoId = parseYouTubeId(url.href);
      // 舊備份曾允許任意 mp4 網址；安全遷移為本機示範，不發出外部請求。
      if (!videoId) demos[id] = { type: 'local' };
      else {
        if (!verifiedVideoIds.has(videoId)) fail('示範影片必須使用已驗證清單內的影片。');
        demos[id] = { type: 'url', url: `https://www.youtube.com/watch?v=${videoId}` };
      }
    } else fail('示範影片類型不正確。');
    for (const key of ['videoIds', 'hiddenVideoIds']) if (value[key] !== undefined) {
      const ids = list(value[key], '示範影片清單', verifiedVideoIds.size);
      if (ids.some(videoId => !verifiedVideoIds.has(videoId))) fail('示範影片必須使用已驗證清單內的影片。');
      unique(ids, '示範影片');
      demos[id][key] = [...ids];
    }
  }
  return { version: 2, role: input.role, activeStudentId: input.activeStudentId, students, theme: input.theme, feedback: entries(input.feedback, '使用回饋', appFeedback, 1000), demos, faqEntries: entries(input.faqEntries, '常見問題', validateFaqEntry, 1000) };
}

export const exportAppState = state => JSON.stringify(parseAppState(JSON.stringify(state)), null, 2);

export function parseStudentFile(json) {
  const input = readJSON(json);
  if (input?.format !== 'table-tennis-student' || input.version !== 2) fail('請選擇本程式匯出的學員檔。');
  return validateStudent(input.student);
}

export const exportStudentFile = student => JSON.stringify({ format: 'table-tennis-student', version: 2, student: validateStudent(student) }, null, 2);

/** 本機狀態與媒體唯一入口；失敗時不覆寫舊資料。 */
export class LocalStore {
  constructor({ storage, indexedDB } = {}) {
    try { this.storage = storage ?? globalThis.localStorage; } catch { this.storage = null; }
    try { this.indexedDB = indexedDB ?? globalThis.indexedDB; } catch { this.indexedDB = null; }
  }
  load() {
    try {
      const raw = this.getRaw();
      return { state: raw === null ? createAppState() : parseAppState(raw), error: null };
    } catch (error) {
      return { state: createAppState(), error: `無法讀取本機紀錄：${error.message} 原有內容已保留，請匯出原始資料後再處理。` };
    }
  }
  getRaw() {
    if (!this.storage) fail('瀏覽器禁止本機儲存，請調整網站儲存設定。');
    return this.storage.getItem(STORAGE_KEY);
  }
  save(state) {
    const json = exportAppState(state);
    try { this.storage.setItem(STORAGE_KEY, json); }
    catch { fail('無法儲存：本機空間不足或瀏覽器禁止儲存。請先匯出紀錄後重試。'); }
  }
  async clear() {
    // 先清媒體，失敗時保留文字紀錄以利重試。
    await this.media('readwrite', store => store.clear());
    try { this.storage.removeItem(STORAGE_KEY); this.storage.removeItem(SESSION_KEY); }
    catch { fail('無法清除本機資料，請檢查瀏覽器的網站儲存設定。'); }
  }
  readSession() {
    try { return JSON.parse(this.storage?.getItem(SESSION_KEY) ?? 'null'); } catch { return null; }
  }
  writeSession(session) {
    try {
      if (session) this.storage?.setItem(SESSION_KEY, JSON.stringify(session));
      else this.storage?.removeItem(SESSION_KEY);
    } catch { fail('無法保存登入狀態，請允許瀏覽器儲存。'); }
  }
  async openMedia() {
    if (!this.indexedDB) fail('此瀏覽器無法使用本機影片儲存。請改用支援的瀏覽器。');
    return new Promise((resolve, reject) => {
      const request = this.indexedDB.open(VIDEO_DB, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('media')) request.result.createObjectStore('media', { keyPath: 'id' }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('無法開啟本機影片儲存，請檢查網站儲存設定。'));
      request.onblocked = () => reject(new Error('影片儲存正在其他分頁使用，請關閉其他分頁後重試。'));
    });
  }
  async media(mode, action) {
    const db = await this.openMedia();
    return new Promise((resolve, reject) => {
      let result;
      const transaction = db.transaction('media', mode);
      const store = transaction.objectStore('media');
      try {
        const request = action(store);
        if (request) request.onsuccess = () => { result = request.result; };
      } catch (error) { db.close(); reject(error); return; }
      transaction.oncomplete = () => { db.close(); resolve(result); };
      transaction.onerror = transaction.onabort = () => { db.close(); reject(new Error('影片儲存失敗，可能是空間不足；原有影片仍保留。')); };
    });
  }
  async listVideos(studentId) {
    const items = await this.media('readonly', store => store.getAll());
    return items.filter(item => item.kind === 'clip' && item.studentId === studentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async saveVideo(clip) {
    if (!object(clip) || !(clip.blob instanceof Blob) || !clip.blob.size || clip.blob.size > 100 * 1024 * 1024) fail('請選擇 100 MB 以內且有內容的影片。');
    const value = { id: string(clip.id, '片段編號', 128), studentId: string(clip.studentId, '學員編號', 128), exerciseId: clip.exerciseId, createdAt: date(clip.createdAt, '影片'), note: string(clip.note, '影片備註', 2000, true), blob: clip.blob, kind: 'clip' };
    if (!exerciseMap.has(value.exerciseId)) fail('影片動作不正確。');
    const db = await this.openMedia();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readwrite');
      const store = tx.objectStore('media');
      const request = store.getAll();
      let conflict = false;
      request.onsuccess = () => {
        const all = request.result;
        if (all.some(item => item.id === value.id && (item.kind !== 'clip' || item.studentId !== value.studentId))) { conflict = true; tx.abort(); return; }
        const clips = [...all.filter(item => item.kind === 'clip' && item.studentId === value.studentId && item.id !== value.id), value].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        store.put(value);
        clips.slice(20).forEach(item => store.delete(item.id));
      };
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onerror = tx.onabort = () => { db.close(); reject(new Error(conflict ? '影片編號與其他學員衝突，未覆寫任何影片。' : '影片儲存失敗，請檢查剩餘空間。')); };
    });
  }
  deleteVideo(id) { return this.media('readwrite', store => store.delete(id)); }
  async deleteStudentVideos(studentId) {
    const clips = await this.listVideos(studentId);
    await this.media('readwrite', store => { clips.forEach(clip => store.delete(clip.id)); });
  }
  saveDemo(exerciseId, blob) {
    if (!exerciseMap.has(exerciseId) || !(blob instanceof Blob) || !blob.size || blob.size > 100 * 1024 * 1024) fail('示範影片無效或超過 100 MB。');
    return this.media('readwrite', store => store.put({ id: `demo:${exerciseId}`, kind: 'demo', exerciseId, blob }));
  }
  async getDemo(exerciseId) { return (await this.media('readonly', store => store.get(`demo:${exerciseId}`)))?.blob ?? null; }
}

/** 原生 HTTP 介面；未設定不連線、影片永不進入請求。 */
export class SupabaseStore {
  constructor({ url = '', anonKey = '', fetchImpl = globalThis.fetch?.bind(globalThis), storage = new LocalStore() } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
    this.fetch = fetchImpl;
    this.storage = storage;
    this.configured = Boolean(this.url && this.anonKey);
    if (this.configured) {
      let parsed;
      try { parsed = new URL(this.url); } catch { fail('雲端連線網址格式不正確。'); }
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) fail('雲端連線必須使用安全網址。');
      if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') fail('雲端連線請填入專案根網址。');
      if (/^sb_secret_/.test(anonKey)) fail('前端不可使用秘密金鑰，請改用公開金鑰。');
      try {
        const claim = JSON.parse(globalThis.atob(anonKey.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? ''));
        if (claim.role === 'service_role') fail('前端不可使用秘密金鑰，請改用公開金鑰。');
      } catch (error) { if (error.message.includes('秘密金鑰')) throw error; }
    }
    this.session = this.configured ? this.storage.readSession() : null;
  }
  async request(path, { method = 'GET', body, auth = true, token, prefer } = {}) {
    if (!this.configured) fail('雲端同步：未設定');
    if (auth && !token) {
      if (!this.session?.access_token) fail('請先登入雲端帳號。');
      if (this.session.expires_at && this.session.expires_at <= Date.now() / 1000 + 30) await this.refreshSession();
    }
    const headers = { apikey: this.anonKey, 'Content-Type': 'application/json' };
    if (auth || token) headers.Authorization = `Bearer ${token ?? this.session.access_token}`;
    if (prefer) headers.Prefer = prefer;
    let response;
    try { response = await this.fetch(`${this.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { fail('雲端連線失敗，本機紀錄仍保留，請確認網路後重試。'); }
    if (!response.ok) {
      if (response.status === 401) fail('登入已失效，請重新登入；本機紀錄仍保留。');
      if (response.status === 403) fail('沒有此筆資料的操作權限，請確認學員與教練綁定。');
      fail(`雲端請求失敗（${response.status}），本機紀錄仍保留，請稍後重試。`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  async sendMagicLink(email, redirectTo) {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail('請輸入有效的電子郵件。');
    const query = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
    // 不自動註冊新帳號；管理員先在既有服務完成帳號與角色設定。
    return this.request(`/auth/v1/otp${query}`, { method: 'POST', auth: false, body: { email, create_user: false } });
  }
  async handleCallback(url = globalThis.location?.href) {
    if (!this.configured || !url) return false;
    const parsed = new URL(url);
    const values = new URLSearchParams(parsed.hash.slice(1));
    if (!values.has('access_token')) return false;
    const accessToken = values.get('access_token');
    const refreshToken = values.get('refresh_token');
    if (!refreshToken) fail('登入連結不完整，請重新取得登入信件。');
    const user = await this.request('/auth/v1/user', { auth: false, token: accessToken });
    if (!user?.id) fail('無法驗證雲端登入身分。');
    this.session = { access_token: accessToken, refresh_token: refreshToken, expires_at: Date.now() / 1000 + Number(values.get('expires_in') || 3600), user: { id: user.id } };
    this.storage.writeSession(this.session);
    return true;
  }
  async refreshSession() {
    if (!this.session?.refresh_token) fail('請重新登入雲端帳號。');
    const result = await this.request('/auth/v1/token?grant_type=refresh_token', { auth: false, method: 'POST', body: { refresh_token: this.session.refresh_token } });
    if (!result?.access_token || !result?.refresh_token || !result?.user?.id) fail('無法更新登入狀態，請重新登入。');
    this.session = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: result.expires_at ?? Date.now() / 1000 + (result.expires_in ?? 3600), user: { id: result.user.id } };
    this.storage.writeSession(this.session);
    return this.session;
  }
  async signOut() {
    try { if (this.session) await this.request('/auth/v1/logout', { method: 'POST' }); }
    finally { this.session = null; this.storage.writeSession(null); }
  }
  async upsert(table, values) {
    if (!values.length) return;
    await this.request(`/rest/v1/${table}?on_conflict=id`, { method: 'POST', body: values, prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  async pushStudent(input, { role = 'student' } = {}) {
    const student = validateStudent(input);
    if (!this.session?.user?.id) fail('請先登入雲端帳號。');
    const uid = this.session.user.id;
    const existing = await this.request(`/rest/v1/students?id=eq.${encodeURIComponent(student.id)}&select=*`);
    const remote = existing?.[0];
    const confirmed = [...(remote?.advancements ?? [])];
    const profile = { id: student.id, name: student.name };
    if (student.updatedAt) profile.updated_at = student.updatedAt;
    if (student.paddle !== undefined) profile.paddle = student.paddle;
    if (student.assessments.length) {
      const incoming = new Map((remote?.assessments ?? []).map(item => [item.id, item]));
      for (const assessment of student.assessments) {
        const previous = incoming.get(assessment.id);
        const protectedRecord = previous?.coachConfirmed || Object.values(previous?.results ?? {}).some(value => object(value?.grades));
        if (role !== 'coach' && protectedRecord) continue;
        const results = role === 'coach' ? assessment.results : Object.fromEntries(Object.entries(assessment.results).filter(([, value]) => !object(value.grades)));
        const next = { ...assessment, results, coachConfirmed: role === 'coach' && assessment.coachConfirmed };
        if (!previous || Date.parse(next.updatedAt ?? next.createdAt) >= Date.parse(previous.updatedAt ?? previous.createdAt)) incoming.set(next.id, next);
      }
      profile.assessments = [...incoming.values()];
    }
    if (role === 'coach') {
      await this.upsert('coaches', [{ id: uid, name: '教練' }]);
      if (!remote) await this.upsert('students', [{ ...profile, coach_id: uid, advancements: [], assignments: [] }]);
      // 每個可見的中斷點都留下可解析資料：先傳該階段紀錄，再確認該階段。
      // 下一階段紀錄一定等到上一階段確認成功才會送出。
      for (const stage of curriculum) {
        const records = student.records.filter(record => exerciseMap.get(record.exerciseId).stageId === stage.id);
        await this.upsert('practice_logs', records.map(record => ({ id: `${student.id}:${record.id}`, student_id: student.id, payload: { ...record, coachFeedback: '' } })));
        const advancement = student.advancements.find(item => item.stageId === stage.id);
        const previous = confirmed.find(item => item.stageId === stage.id);
        if (advancement && (!previous || advancement.confirmedAt < previous.confirmedAt)) {
          const next = [...confirmed.filter(item => item.stageId !== stage.id), advancement].sort((a, b) => a.stageId - b.stageId);
          await this.request(`/rest/v1/students?id=eq.${encodeURIComponent(student.id)}`, { method: 'PATCH', body: { advancements: next, ...(profile.assessments ? { assessments: profile.assessments } : {}) }, prefer: 'return=minimal' });
          confirmed.splice(0, confirmed.length, ...next);
        }
      }
      await this.request(`/rest/v1/students?id=eq.${encodeURIComponent(student.id)}`, { method: 'PATCH', body: { ...profile, assignments: student.assignments }, prefer: 'return=minimal' });
    } else {
      const unlockedIds = new Set(getUnlockedStageIds(curriculum, confirmed));
      const invalidHistory = student.records.some(record => {
        const stageId = exerciseMap.get(record.exerciseId).stageId;
        const previous = confirmed.find(item => item.stageId === stageId - 1);
        return !unlockedIds.has(stageId) || (stageId > 1 && (!previous || record.createdAt < previous.confirmedAt));
      });
      if (invalidHistory) fail('請先由教練同步晉級並確認綁定，再同步後續階段練習。本機紀錄仍保留。');
      if (remote && remote.auth_user_id !== uid) fail('請先由教練確認學員帳號綁定；目前不會寫入任何資料。');
      if (remote) await this.request(`/rest/v1/students?id=eq.${encodeURIComponent(student.id)}`, { method: 'PATCH', body: profile, prefer: 'return=minimal' });
      else await this.upsert('students', [{ ...profile, auth_user_id: uid }]);
      await this.upsert('practice_logs', student.records.map(record => ({ id: `${student.id}:${record.id}`, student_id: student.id, payload: { ...record, coachFeedback: '' } })));
    }
    await this.upsert('countermeasure_results', student.countermeasureResults.map(item => ({ id: `${student.id}:${item.id}`, student_id: student.id, payload: item })));
    if (role === 'coach') {
      const feedback = [...student.feedback, ...student.records.filter(record => record.coachFeedback).map(record => ({ id: `legacy:${record.id}`, targetType: 'record', targetId: record.id, text: record.coachFeedback, createdAt: record.createdAt }))];
      await this.upsert('coach_feedback', feedback.map(item => ({ id: `${student.id}:${item.id}`, student_id: student.id, coach_id: uid, payload: item })));
    }
    return student;
  }
  async pullStudents({ role } = {}) {
    if (role !== undefined && !['student', 'coach'].includes(role)) fail('雲端同步角色不正確。');
    if (role && !this.session?.user?.id) fail('請先登入雲端帳號。');
    const ownership = role ? `&${role === 'student' ? 'auth_user_id' : 'coach_id'}=eq.${encodeURIComponent(this.session.user.id)}` : '';
    const rows = await this.request(`/rest/v1/students?select=*&order=name.asc${ownership}`);
    const result = [];
    for (const row of rows ?? []) {
      const query = `?student_id=eq.${encodeURIComponent(row.id)}&select=payload`;
      const [records, feedback, strategies] = await Promise.all(['practice_logs', 'coach_feedback', 'countermeasure_results'].map(table => this.request(`/rest/v1/${table}${query}`)));
      result.push(validateStudent({ id: row.id, name: row.name, ...(row.updated_at ? { updatedAt: row.updated_at } : {}), ...(row.paddle ? { paddle: row.paddle } : {}), assessments: row.assessments ?? [], records: (records ?? []).map(item => item.payload), advancements: row.advancements ?? [], assignments: row.assignments ?? [], feedback: (feedback ?? []).map(item => item.payload), countermeasureResults: (strategies ?? []).map(item => item.payload) }));
    }
    return result;
  }
  async submitFeedback(input) {
    const item = appFeedback(input);
    if (!this.session?.user?.id) fail('請先登入雲端帳號；回饋可先存本機。');
    let studentId = null;
    if (item.type === 'question' && item.studentId) {
      const rows = await this.request(`/rest/v1/students?id=eq.${encodeURIComponent(item.studentId)}&select=id,auth_user_id,coach_id`);
      // payload.studentId 不是權限依據；只有資料庫可見且屬於登入者的學員才掛正式外鍵。
      const matched = rows?.find(row => row.id === item.studentId && (row.auth_user_id === this.session.user.id || row.coach_id === this.session.user.id));
      studentId = matched?.id ?? null;
    }
    const { answer, category, faqId, status, answeredAt, updatedAt, ...question } = item;
    const original = item.type === 'question' ? question : item;
    await this.request('/rest/v1/app_feedback?on_conflict=id', { method: 'POST', body: [{ id: item.id, user_id: this.session.user.id, payload: original, ...(studentId ? { student_id: studentId } : {}) }], prefer: 'resolution=ignore-duplicates,return=minimal' });
    if (studentId) {
      // 原題可能在綁定學員前已上傳；只補上空連結，絕不重指向其他學員。
      await this.request(`/rest/v1/app_feedback?id=eq.${encodeURIComponent(item.id)}&student_id=is.null`, {
        method: 'PATCH', body: { student_id: studentId }, prefer: 'return=minimal',
      });
    }
    if (item.type === 'question' && item.answer !== undefined) {
      // 離線提問可能尚未送出就先由本機教練回答。先補送原題，再寫答覆；
      // 已存在的遠端題目忽略衝突，保留原 user_id 與問題原文。
      const updated = await this.request(`/rest/v1/app_feedback?id=eq.${encodeURIComponent(item.id)}`, {
        method: 'PATCH', body: { answer: item.answer, category: item.category || '程式使用', status: 'answered', faq_id: item.faqId || null,
          answered_at: item.answeredAt ?? item.updatedAt ?? new Date().toISOString(), answered_by: this.session.user.id }, prefer: 'return=representation',
      });
      if (!Array.isArray(updated) || !updated.some(row => row.id === item.id)) fail('提問答覆未寫入：請確認雲端教練角色與提問權限。本機回答仍保留。');
      return;
    }
  }
  async pullQuestions() {
    const rows = await this.request('/rest/v1/app_feedback?payload->>type=eq.question&select=*&order=created_at.asc');
    return (rows ?? []).map(row => {
      const { answer, category, faqId, answeredAt, updatedAt, status, ...question } = row.payload ?? {};
      return appFeedback({ ...question, ...(row.answer === null || row.answer === undefined ? {} : { answer: row.answer }),
        ...(row.category ? { category: row.category } : {}), ...(row.faq_id ? { faqId: row.faq_id } : {}),
        status: row.status ?? 'pending', ...(row.answered_at ? { answeredAt: row.answered_at, updatedAt: row.answered_at } : {}) });
    });
  }
  async pushFaqEntries(items) {
    if (!this.session?.user?.id) fail('請先登入雲端帳號。');
    const values = entries(items, '常見問題', validateFaqEntry, 1000).filter(item => item.source === 'coach');
    await this.upsert('faq_entries', values.map(item => ({ id: item.id, question: item.question, answer: item.answer, category: item.category,
      source: item.source, status: item.status, author: item.author, author_id: this.session.user.id, question_id: item.questionId ?? null,
      created_at: item.createdAt, updated_at: item.updatedAt })));
  }
  async pullFaqEntries() {
    const rows = await this.request('/rest/v1/faq_entries?select=*&order=created_at.asc');
    return (rows ?? []).map(row => validateFaqEntry({ id: row.id, question: row.question, answer: row.answer, category: row.category,
      source: row.source, status: row.status, author: row.author, createdAt: row.created_at, updatedAt: row.updated_at, cloudUpdatedAt: row.updated_at,
      ...(row.question_id ? { questionId: row.question_id } : {}) }));
  }
}
