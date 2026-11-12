/**
 * 可離線重算的訓練規則；不讀寫儲存空間、不依賴畫面或目前時間。
 * 次數與自評門檻均為建議範例，待教練審核；完成度不代表已學會動作。
 */

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const array = value => Array.isArray(value) ? value : [];
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function validRecord(record, exerciseId) {
  return record && record.exerciseId === exerciseId
    && positiveInteger(record.reps) && positiveInteger(record.sets)
    && Number.isSafeInteger(record.reps * record.sets)
    && Number.isInteger(record.rating) && record.rating >= 1 && record.rating <= 5
    && validDate(record.createdAt);
}

function targetFor(exercise) {
  const plan = exercise?.prescription;
  if (positiveInteger(plan?.total)) return plan.total;
  const product = plan?.reps * plan?.sets;
  return positiveInteger(plan?.reps) && positiveInteger(plan?.sets) && positiveInteger(product)
    ? product : 0;
}

/** 每筆 reps 是每組次數，累積量為 reps × sets。最新低分會取消完成狀態。 */
export function exerciseProgress(exercise, records = []) {
  const matches = exercise?.id
    ? array(records).filter(record => validRecord(record, exercise.id)) : [];
  let totalReps = 0;
  let latest = null;
  for (const record of matches) {
    totalReps = Math.min(Number.MAX_SAFE_INTEGER, totalReps + record.reps * record.sets);
    if (!latest || Date.parse(record.createdAt) >= Date.parse(latest.createdAt)) latest = record;
  }
  const targetReps = targetFor(exercise);
  const latestRating = latest?.rating ?? null;
  return {
    percent: targetReps > 0 ? Math.min(100, Math.floor(totalReps / targetReps * 100)) : 0,
    totalReps,
    targetReps,
    latestRating,
    complete: targetReps > 0 && totalReps >= targetReps && latestRating >= 3,
  };
}

/** 優先安排需要修正與未完成的動作；不足時補入複習，限制每日 2–4 項。 */
export function recommendToday(stage, records = [], limit = 3) {
  const count = Number.isInteger(limit) ? Math.max(2, Math.min(4, limit)) : 3;
  return array(stage?.exercises)
    .map((exercise, index) => ({ exercise, index, progress: exerciseProgress(exercise, records) }))
    .sort((a, b) => {
      const priority = item => item.progress.complete ? 2
        : item.progress.latestRating !== null && item.progress.latestRating <= 2 ? 0 : 1;
      return priority(a) - priority(b)
        || a.progress.percent - b.progress.percent
        || a.index - b.index;
    })
    .slice(0, count)
    .map(item => item.exercise);
}

function checksComplete(stage, checkedIds) {
  const checks = array(stage?.checks);
  const selected = new Set(array(checkedIds));
  return checks.length > 0 && checks.every(check => typeof check?.id === 'string' && selected.has(check.id));
}

/** ready 僅代表可請教練確認，真正晉級仍必須通過 canAdvanceStage。 */
export function evaluateStage(stage, records = [], checkedIds = [], assessments = []) {
  const movements = array(stage?.exercises);
  const progressItems = movements.map(exercise => exerciseProgress(exercise, records));
  const qualifications = movements.map(exercise => {
    const latest = array(assessments).filter(item => item?.exerciseId === exercise.id && validDate(item.createdAt))
      .reduce((chosen, item) => !chosen || timestamp(item) >= timestamp(chosen) ? item : chosen, null);
    return { exerciseId: exercise.id, ...evaluateExerciseQualification(exercise, latest) };
  });
  const progress = progressItems.length
    ? Math.floor(progressItems.reduce((sum, item) => sum + item.percent, 0) / progressItems.length) : 0;
  if (progressItems.some((item, index) => item.latestRating !== null && item.latestRating <= 2
    && (!array(movements[index].standards).length || !qualifications[index].qualified))) {
    return {
      status: 'correct', label: '修正動作',
      message: '有動作最近的穩定度自評偏低。先查看錯誤對策，請教練協助修正，再重新記錄練習。',
      canAdvance: false, progress, qualifications,
    };
  }
  const allQualified = movements.every((exercise, index) => array(exercise.standards).length
    ? qualifications[index].qualified : progressItems[index].complete);
  if (!movements.length || !allQualified || !checksComplete(stage, checkedIds)) {
    return {
      status: 'continue', label: '繼續練習',
      message: '請完成各動作的合格測驗、品質評分與教練確認，再完成階段檢核。練滿次數不代表動作合格。',
      canAdvance: false, progress, qualifications,
    };
  }
  return {
    status: 'ready', label: '可進入下一階段',
    message: '已達本階段的範例練習與檢核條件；仍須由教練確認動作品質，勾選確認後才能晉級。',
    canAdvance: true, progress, qualifications,
  };
}

export function canAdvanceStage(stage, records = [], checkedIds = [], coachConfirmed = false, assessments = []) {
  return coachConfirmed === true && evaluateStage(stage, records, checkedIds, assessments).status === 'ready';
}

/** 僅接受連續階段且含完整檢核的教練確認紀錄，不因次數或自評自動解鎖。 */
export function getUnlockedStageIds(curriculum, advancements = []) {
  const stages = array(curriculum);
  if (!stages.length || !positiveInteger(stages[0]?.id)) return [];
  const unlocked = [stages[0].id];
  for (let index = 0; index < stages.length - 1; index += 1) {
    const stage = stages[index];
    const confirmed = array(advancements).some(item => item
      && item.stageId === stage.id && item.coachConfirmed === true
      && validDate(item.confirmedAt) && checksComplete(stage, item.checkedIds));
    const nextId = stages[index + 1]?.id;
    if (!confirmed || !positiveInteger(nextId) || unlocked.includes(nextId)) break;
    unlocked.push(nextId);
  }
  return unlocked;
}

export function currentStageId(curriculum, advancements = []) {
  return getUnlockedStageIds(curriculum, advancements).at(-1) ?? null;
}

function timestamp(item) {
  const value = Date.parse(item?.updatedAt ?? item?.createdAt ?? item?.confirmedAt ?? '');
  return Number.isFinite(value) ? value : 0;
}

function mergeById(existing, incoming, key = item => item?.id, preferNewest = true) {
  const result = new Map();
  for (const item of [...array(existing), ...array(incoming)]) {
    if (!item || key(item) === undefined || key(item) === null) continue;
    const previous = result.get(key(item));
    if (!previous) { result.set(key(item), structuredClone(item)); continue; }
    const incomingWins = preferNewest ? timestamp(item) >= timestamp(previous) : timestamp(item) <= timestamp(previous);
    const newer = incomingWins ? item : previous;
    const older = newer === item ? previous : item;
    const merged = { ...structuredClone(older), ...structuredClone(newer) };
    // Older student exports do not erase feedback that a coach has already added.
    if (!merged.coachFeedback && older.coachFeedback) merged.coachFeedback = older.coachFeedback;
    result.set(key(item), merged);
  }
  return [...result.values()];
}

/** Merge validated files; updatedAt governs profile changes independently of list merges. */
export function mergeStudent(existing, incoming) {
  if (!incoming || typeof incoming !== 'object' || !incoming.id) throw new Error('學員檔缺少學員編號。');
  if (existing && existing.id !== incoming.id) throw new Error('不同學員的資料不能合併。');
  if (!existing) return structuredClone(incoming);
  const newer = timestamp(incoming) >= timestamp(existing) ? incoming : existing;
  const older = newer === incoming ? existing : incoming;
  return {
    ...structuredClone(older), ...structuredClone(newer),
    records: mergeById(existing.records, incoming.records),
    // Preserve the first confirmation: later re-approval must not retroactively
    // move the unlock date past already valid practices in following stages.
    advancements: mergeById(existing.advancements, incoming.advancements, item => item.stageId, false)
      .sort((a, b) => a.stageId - b.stageId),
    feedback: mergeById(existing.feedback, incoming.feedback).sort((a, b) => timestamp(a) - timestamp(b)),
    assignments: mergeById(existing.assignments, incoming.assignments).sort((a, b) => timestamp(a) - timestamp(b)),
    countermeasureResults: mergeById(existing.countermeasureResults, incoming.countermeasureResults),
    assessments: mergeById(existing.assessments, incoming.assessments),
  };
}

/** Positive experience comes first, untried strategies next, ineffective ones last. */
export function rankCountermeasures(strategies, results = [], exerciseId, problemId) {
  return array(strategies).map((strategy, index) => {
    const item = typeof strategy === 'string' ? { id: String(index), text: strategy } : { ...strategy };
    const matches = array(results).filter(result => result?.exerciseId === exerciseId
      && String(result.problemId) === String(problemId) && String(result.strategyId) === String(item.id));
    const helpfulCount = matches.filter(result => result.helpful === true).length;
    const unhelpfulCount = matches.filter(result => result.helpful === false).length;
    return { ...item, helpfulCount, unhelpfulCount, index };
  }).sort((a, b) => (b.helpfulCount - b.unhelpfulCount) - (a.helpfulCount - a.unhelpfulCount)
    || b.helpfulCount - a.helpfulCount || a.index - b.index)
    .map(({ index, ...item }) => item);
}

function dayNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? Math.floor(date.getTime() / 86400000) : null;
}

function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function recordDay(record) {
  if (typeof record?.date === 'string' && dayNumber(record.date) !== null) return dayNumber(record.date);
  if (typeof record?.createdAt !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(record.createdAt)) return dayNumber(record.createdAt);
  const date = new Date(record.createdAt);
  return Number.isFinite(date.getTime()) ? dayNumber(localDay(date)) : null;
}

/** Today's unfinished day does not break a streak that was active yesterday. */
export function practiceStreak(records = [], today = localDay(new Date())) {
  const end = dayNumber(today);
  if (end === null) return 0;
  const days = new Set(array(records).map(recordDay).filter(day => day !== null && day <= end));
  let cursor = days.has(end) ? end : end - 1;
  let count = 0;
  while (days.has(cursor)) { count += 1; cursor -= 1; }
  return count;
}

/** Calendar week starts Monday; only explicitly recorded minutes are counted. */
export function weeklyStats(records = [], today = localDay(new Date())) {
  const end = dayNumber(today);
  if (end === null) return [];
  const weekday = new Date(end * 86400000).getUTCDay();
  const monday = end - ((weekday + 6) % 7);
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: new Date((monday + index) * 86400000).toISOString().slice(0, 10), count: 0, minutes: 0,
  }));
  for (const record of array(records)) {
    const day = recordDay(record);
    if (day === null || day < monday || day > monday + 6 || day > end) continue;
    const item = days[day - monday];
    item.count += 1;
    if (Number.isFinite(record.minutes) && record.minutes >= 0) item.minutes += record.minutes;
  }
  return days.map(item => ({ ...item, minutes: Math.round(item.minutes * 100) / 100 }));
}

/** 五題問卷的規則建議；年齡／手掌為同題，所有數字仍須教練試握審核。 */
export function recommendPaddle(answers = {}) {
  const small = answers.ageGroup === 'child' || answers.handSize === 'small';
  const coached = answers.hasCoach === true;
  const owns = answers.hasPaddle === true;
  const notes = ['建議範例，待教練審核', '先重視控制、容錯與舒適，不用追求速度。'];
  if (owns) notes.push('先帶現有球拍給教練看，確認握柄、膠皮與重量合適，再決定是否更換。');
  if (answers.budget === 'low') notes.push('預算有限時先選品質可靠、好控制的成品拍，避免塑膠玩具拍。');
  if (answers.budget === 'high') notes.push('預算充裕也不必一開始就選快速碳纖維底板。');
  if (answers.style === 'attack') notes.push('偏進攻也先用穩定落點練基本功，再由教練調整速度。');
  if (answers.style === 'defense') notes.push('偏防守先重視回球穩定，初學仍以兩面平面反膠為主。');
  if (!coached) notes.push('沒有固定教練時，先尋求現場試握與基本動作確認。');
  if (small) notes.push('兒童或手掌較小者先確認握柄合手；成人整拍重量範例不能直接套用。');
  return {
    grip: '橫拍（刀板）；若已習慣直拍，請教練確認後再決定，不必急著改握法。',
    construction: coached && answers.budget === 'high'
      ? '以好控制的成品拍起步；了解打法後，可請教練協助選配純木底板與膠皮。'
      : '先選好控制的成品拍，熟悉打法後再考慮自組。',
    blade: '純木 5 層或 7 層、速度偏慢且好控制，避免一開始就用快速碳纖維底板。',
    rubber: '兩面平面反膠；覺得太彈時，請教練協助選較薄、較軟的膠皮。',
    weight: small ? '以能放鬆握拍、不痠痛為先，選較輕且合手的整拍，由教練確認。'
      : '成人整拍約 160–185 克作為試握起點；太重或手腕不舒服就調整。',
    handle: small ? '先試合手的較小握柄，確認手指自然放鬆、不滑手。'
      : '可先試喇叭柄；直柄也可，選握起來舒適、不滑手的握柄。',
    notes, reminder: '先請教練試握確認',
  };
}

export const STANDARD_TYPES = Object.freeze({
  'success-rate': '成功率', consecutive: '連續板數', 'timed-count': '限時計數',
  quality: '品質評分', checklist: '動作檢核清單',
});
export const QUALIFICATION_LEVELS = Object.freeze({ none: '尚未達入門', entry: '入門', qualified: '合格', proficient: '熟練' });
const gradeValues = Object.freeze({ A: 1, B: 0.75, C: 0.5, D: 0.25 });
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const objectValue = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function thresholdsFor(standard) {
  const fallback = standard.type === 'quality'
    ? { entry: 0.5, qualified: standard.threshold ?? 0.75, proficient: 1 }
    : { entry: standard.required ?? standard.target, qualified: standard.required ?? standard.target, proficient: standard.required ?? standard.target };
  const thresholds = standard.levels ?? fallback;
  if (!objectValue(thresholds)) return null;
  const values = ['entry', 'qualified', 'proficient'].map(level => thresholds[level]);
  if (!values.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
    || values[0] > values[1] || values[1] > values[2]) return null;
  if (standard.type === 'success-rate' && values[2] > standard.attempts) return null;
  if (standard.type === 'quality' && values[2] > 1) return null;
  return thresholds;
}

/** 單次測驗按原始資料重新計算；未完成或非法輸入不會取得合格狀態。 */
export function evaluateStandard(standard, result) {
  let value = null;
  let valid = false;
  let thresholds = null;
  const type = standard?.type;
  if (Object.hasOwn(STANDARD_TYPES, type) && objectValue(result)) {
    if (type === 'checklist') {
      const ids = array(standard.items).map(item => typeof item === 'string' ? item : item?.id);
      const checks = result.checkedIds;
      valid = ids.length > 0 && ids.every(id => typeof id === 'string' && id.length)
        && new Set(ids).size === ids.length && Array.isArray(checks)
        && new Set(checks).size === checks.length && checks.every(id => ids.includes(id));
      value = valid ? checks.length : null;
      const complete = valid && ids.every(id => checks.includes(id));
      return { valid, value, passed: complete, level: complete ? 'qualified' : 'none', label: complete ? '合格' : '尚未全部達成' };
    }
    thresholds = thresholdsFor(standard);
    if (type === 'success-rate') {
      const outcomes = result.outcomes;
      valid = positiveInteger(standard.attempts) && positiveInteger(standard.required)
        && standard.required <= standard.attempts && Array.isArray(outcomes)
        && outcomes.length === standard.attempts && outcomes.every(item => typeof item === 'boolean');
      value = Array.isArray(outcomes) && outcomes.every(item => typeof item === 'boolean')
        ? outcomes.filter(Boolean).length : null;
    } else if (type === 'consecutive') {
      const runs = result.runs;
      valid = positiveInteger(standard.target) && positiveInteger(standard.maxAttempts) && Array.isArray(runs)
        && runs.length > 0 && runs.length <= standard.maxAttempts && runs.every(nonnegativeInteger);
      value = valid ? Math.max(...runs) : null;
    } else if (type === 'timed-count') {
      valid = positiveInteger(standard.target) && positiveInteger(standard.seconds) && result.elapsedSeconds === standard.seconds
        && nonnegativeInteger(result.count);
      value = nonnegativeInteger(result.count) ? result.count : null;
    } else if (type === 'quality') {
      const dimensions = array(standard.dimensions);
      const grades = result.grades;
      valid = dimensions.length > 0 && new Set(dimensions).size === dimensions.length
        && dimensions.every(item => typeof item === 'string' && item.length)
        && objectValue(grades) && dimensions.every(item => Object.hasOwn(gradeValues, grades[item]));
      value = valid ? dimensions.reduce((sum, item) => sum + gradeValues[grades[item]], 0) / dimensions.length : null;
    }
  }
  valid = valid && thresholds !== null;
  const level = valid ? ['proficient', 'qualified', 'entry'].find(key => value >= thresholds[key]) ?? 'none' : 'none';
  return { valid, value, level, label: valid ? QUALIFICATION_LEVELS[level] : '尚未完成有效測驗', passed: level === 'qualified' || level === 'proficient' };
}

/** 數量（或空拍檢核）＋品質至少 B＋教練確認，三者缺一不可。 */
export function evaluateExerciseQualification(exercise, assessment) {
  const standards = array(exercise?.standards);
  const matching = assessment?.exerciseId === exercise?.id && objectValue(assessment?.results);
  const results = standards.map(standard => ({ standardId: standard.id, type: standard.type,
    ...evaluateStandard(standard, matching ? assessment.results[standard.id] : null) }));
  const quantities = results.filter(item => ['success-rate', 'consecutive', 'timed-count'].includes(item.type));
  const checks = results.filter(item => item.type === 'checklist');
  const quality = results.filter(item => item.type === 'quality');
  const performancePassed = quantities.length > 0
    ? exercise.quantityMode === 'any' ? quantities.some(item => item.passed) : quantities.every(item => item.passed)
    : checks.length > 0 && checks.every(item => item.passed);
  const qualityPassed = quality.length > 0 && quality.every(item => item.passed && item.value >= 0.75);
  const coachConfirmed = matching && assessment.coachConfirmed === true;
  const qualified = standards.length > 0 && performancePassed && qualityPassed && coachConfirmed;
  return { qualified, performancePassed, qualityPassed, coachConfirmed: Boolean(coachConfirmed), results,
    label: qualified ? '合格' : !performancePassed ? '待完成合格測驗' : !qualityPassed ? '待教練評品質' : '待教練確認' };
}

/** 只解析明確的影片頁網址，不接受任意主機、憑證或非網頁協定。 */
export function parseYouTubeId(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be') {
    const match = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
    id = match?.[1] ?? null;
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.getAll('v').length === 1 ? url.searchParams.get('v') : null;
    else id = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

const normalizeSearch = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().trim() : '';

/** 搜尋所有關鍵字，與分類同時篩選；隱藏／草稿不會出現在學員清單。 */
export function filterFaq(entries, query = '', category = 'all') {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
  return array(entries).filter(entry => entry && (!entry.status || entry.status === 'published')
    && (!category || category === 'all' || entry.category === category)
    && words.every(word => normalizeSearch(`${entry.question ?? ''} ${entry.answer ?? ''}`).includes(word)));
}

/**
 * 教練同步依編號保留新版；學員遠端清單只移除未修改的已同步題目。
 * 切換角色不會清掉此裝置尚未上傳的新增、編輯或隱藏設定。
 */
export function mergeFaqEntries(existing, incoming, role = 'coach') {
  const byId = entries => {
    const map = new Map();
    for (const entry of array(entries)) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
      const previous = map.get(entry.id);
      if (!previous || timestamp(entry) >= timestamp(previous)) map.set(entry.id, entry);
    }
    return map;
  };
  const local = byId(existing);
  const remote = byId(incoming);
  const merged = new Map();
  for (const [id, entry] of local) {
    const pending = !validDate(entry.cloudUpdatedAt) || entry.cloudUpdatedAt !== entry.updatedAt;
    const received = remote.get(id);
    if (!received) {
      if (role !== 'student' || pending) merged.set(id, entry);
      continue;
    }
    // 同時戳的待傳編輯優先留在此裝置；遠端更新較新時仍採用遠端。
    const keepLocal = timestamp(entry) > timestamp(received)
      || (role === 'student' && pending && timestamp(entry) === timestamp(received));
    merged.set(id, keepLocal ? entry : received);
  }
  for (const [id, entry] of remote) if (!merged.has(id)) merged.set(id, entry);
  return [...merged.values()].map(entry => structuredClone(entry));
}

/** 由已回答提問建立可儲存的常見問題，呼叫者提供時間與編號以保持純函式。 */
export function questionToFaq(question, details = {}) {
  const text = typeof question === 'string' ? question : question?.text ?? question?.question ?? question?.message;
  const questionId = typeof question === 'object' && question ? question.id : undefined;
  const trimmed = value => typeof value === 'string' ? value.trim() : '';
  if (!trimmed(text) || !trimmed(details.id) || !trimmed(details.answer)
    || !trimmed(details.category) || !trimmed(details.author) || !validDate(details.createdAt)) {
    throw new Error('請填寫提問、答案、分類、作者、編號與有效日期。');
  }
  return { id: trimmed(details.id), question: trimmed(text), answer: trimmed(details.answer),
    category: trimmed(details.category), source: 'coach', status: details.publish === false ? 'hidden' : 'published',
    author: trimmed(details.author), createdAt: details.createdAt, updatedAt: details.createdAt,
    ...(typeof questionId === 'string' && questionId ? { questionId } : {}) };
}
