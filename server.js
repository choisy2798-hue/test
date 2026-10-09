/* =========================================================
   복약 알리미 - 푸시 알림 서버
   - 정적 파일(./public) 서빙 + Web Push 구독 관리 + 시간대별 알림 발송
========================================================= */
try { require('dotenv').config(); } catch (e) { /* dotenv 없으면 무시 - 호스팅 환경변수 사용 */ }

const path = require('path');
const fs = require('fs');
const express = require('express');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'subscriptions.json');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('[오류] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 환경변수가 설정되지 않았어요. .env.example을 참고해 .env를 만들어 주세요.');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/* ---------- 아주 단순한 파일 기반 저장소 ----------
   실사용자가 많아지면(다인용 구조 작업 때) 진짜 데이터베이스로 교체하는 것을 권장합니다.
--------------------------------------------------- */
function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
}
function loadSubscriptions() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}
function saveSubscriptions(list) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

let subscriptions = loadSubscriptions();

/* ---------- 한국 시간 기준 유틸 ---------- */
function seoulNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  const dateKey = `${map.year}-${map.month}-${map.day}`;
  const minutes = Number(map.hour) * 60 + Number(map.minute);
  return { dateKey, hh: map.hour, mm: map.minute, minutes };
}
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

const SLOT_KEYS = ['morning', 'noon', 'evening', 'night'];
const SLOT_LABELS = { morning: '아침', noon: '점심', evening: '저녁', night: '취침전' };
const AUTO_CLOSE_MINUTES = 120; // 복용 예정 시간 이후 2시간이 지나면 알림을 끝내고 미복용 처리 (앱 쪽과 동일한 값)
const REMINDER_ACTIONS = [
  { action: 'taken', title: '복용함' },
  { action: 'skip', title: '건너뜀' },
  { action: 'later', title: '나중에 복용' },
];

/* ---------- Express 앱 ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/subscribe', (req, res) => {
  const { subscription, times, labels, activeSlotKeys, preReminderEnabled, preReminderOffset, repeatAlarmEnabled, name } = req.body || {};
  if (!subscription || !subscription.endpoint || !Array.isArray(times) || times.length !== 4) {
    return res.status(400).json({ ok: false, error: 'invalid payload' });
  }
  const idx = subscriptions.findIndex((s) => s.subscription.endpoint === subscription.endpoint);
  const safeLabels = Array.isArray(labels) && labels.length === 4
    ? labels.map((l, i) => (typeof l === 'string' && l.trim() ? l.slice(0, 12) : SLOT_LABELS[SLOT_KEYS[i]]))
    : SLOT_KEYS.map((k) => SLOT_LABELS[k]);
  // 약이 등록된 시간대만 알림을 보내기 위한 목록. 안 보내주면(구버전 앱) 기존처럼 4개 전부로 간주.
  const safeActiveSlotKeys = Array.isArray(activeSlotKeys)
    ? activeSlotKeys.filter((k) => SLOT_KEYS.includes(k))
    : SLOT_KEYS.slice();
  const record = {
    subscription,
    times,
    labels: safeLabels,
    activeSlotKeys: safeActiveSlotKeys,
    preReminderEnabled: !!preReminderEnabled,
    preReminderOffset: Number(preReminderOffset) || 10,
    repeatAlarmEnabled: !!repeatAlarmEnabled,
    name: (name || '어르신').slice(0, 10),
    checkins: idx >= 0 ? subscriptions[idx].checkins || {} : {},   // { "YYYY-MM-DD": { slotKey: 'taken'|'skip' } }
    snoozeUntil: idx >= 0 ? subscriptions[idx].snoozeUntil || {} : {}, // { slotKey: 분(0~1439) }
    sentLog: idx >= 0 ? subscriptions[idx].sentLog || {} : {},
    lastSeenDate: idx >= 0 ? subscriptions[idx].lastSeenDate : null,
  };
  if (idx >= 0) subscriptions[idx] = record;
  else subscriptions.push(record);
  saveSubscriptions(subscriptions);
  res.json({ ok: true });
});

app.post('/api/checkin', (req, res) => {
  const { endpoint, slotKey, date, status } = req.body || {};
  if (!endpoint || !slotKey || !date) return res.status(400).json({ ok: false });
  const rec = subscriptions.find((s) => s.subscription.endpoint === endpoint);
  if (!rec) return res.status(404).json({ ok: false });
  if (!rec.checkins[date]) rec.checkins[date] = {};
  // 구버전 데이터가 배열이었을 수도 있으니 방어적으로 처리
  if (Array.isArray(rec.checkins[date])) rec.checkins[date] = {};
  rec.checkins[date][slotKey] = status === 'skip' ? 'skip' : 'taken';
  if (rec.snoozeUntil) delete rec.snoozeUntil[slotKey];
  saveSubscriptions(subscriptions);
  res.json({ ok: true });
});

/* "나중에 복용" - 서버가 SNOOZE_MINUTES 뒤에 한 번 더 알림을 보내도록 예약한다.
   앱이 완전히 닫혀 있어도(클라이언트 타이머가 없어도) 동작해야 하므로 서버가 직접 스케줄링한다. */
app.post('/api/snooze', (req, res) => {
  const { endpoint, slotKey, minutes } = req.body || {};
  if (!endpoint || !slotKey) return res.status(400).json({ ok: false });
  const rec = subscriptions.find((s) => s.subscription.endpoint === endpoint);
  if (!rec) return res.status(404).json({ ok: false });
  const { minutes: nowMin } = seoulNow();
  const slotIdx = SLOT_KEYS.indexOf(slotKey);
  const slotMin = slotIdx >= 0 && rec.times[slotIdx] ? timeToMinutes(rec.times[slotIdx]) : nowMin;
  const snoozeMinutes = Number(minutes) > 0 ? Number(minutes) : 20;
  const target = Math.min(nowMin + snoozeMinutes, slotMin + AUTO_CLOSE_MINUTES - 1);
  if (!rec.snoozeUntil) rec.snoozeUntil = {};
  rec.snoozeUntil[slotKey] = target;
  saveSubscriptions(subscriptions);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  subscriptions = subscriptions.filter((s) => s.subscription.endpoint !== endpoint);
  saveSubscriptions(subscriptions);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, subscriberCount: subscriptions.length, time: seoulNow() });
});

/* ---------- 알림 발송 ----------
   slotKey/kind/hh/mm을 함께 보내서, 클라이언트(app.js)의 알림 중복 방지 키
   (`${kind}_${slotKey}_${hh}:${mm}`, 예: on_morning_08:00)와 정확히 맞춰준다.
   이렇게 해야 "로컬 타이머로 이미 음성을 재생함" + "서버 푸시로 또 재생함"처럼
   같은 복약 시간에 음성이 중복 재생되는 것을 막을 수 있다. */
function sendPush(rec, { title, body, tag, slotKey, kind, hh, mm, voiceText, actions }) {
  const payload = JSON.stringify({ title, body, tag, slotKey, kind, hh, mm, voiceText, actions });
  webpush.sendNotification(rec.subscription, payload).catch((err) => {
    if (err.statusCode === 404 || err.statusCode === 410) {
      subscriptions = subscriptions.filter((s) => s.subscription.endpoint !== rec.subscription.endpoint);
      saveSubscriptions(subscriptions);
    } else {
      console.error('푸시 발송 실패:', err.statusCode, err.body || err.message);
    }
  });
}

function tick() {
  const { dateKey, hh, mm, minutes } = seoulNow();
  let changed = false;

  subscriptions.forEach((rec) => {
    if (rec.lastSeenDate !== dateKey) {
      rec.sentLog = {};
      rec.lastSeenDate = dateKey;
      changed = true;
    }
    const checkinsToday = (rec.checkins[dateKey] && !Array.isArray(rec.checkins[dateKey])) ? rec.checkins[dateKey] : {};
    const activeKeys = Array.isArray(rec.activeSlotKeys) ? rec.activeSlotKeys : SLOT_KEYS;

    SLOT_KEYS.forEach((slotKey, i) => {
      if (!activeKeys.includes(slotKey)) return; // 약이 등록되지 않은 시간대는 알림 대상에서 제외
      const label = (Array.isArray(rec.labels) && rec.labels[i]) || SLOT_LABELS[slotKey];
      const slotMin = timeToMinutes(rec.times[i]);
      const resolved = !!checkinsToday[slotKey]; // 'taken' 또는 'skip'으로 이미 결정됨
      if (resolved) return;

      // 사전 알림 (선택지 없이 안내만)
      if (rec.preReminderEnabled) {
        const preKey = `${slotKey}_pre`;
        if (minutes === slotMin - rec.preReminderOffset && !rec.sentLog[preKey]) {
          rec.sentLog[preKey] = true; changed = true;
          sendPush(rec, {
            title: '복약 알리미',
            body: `${label} 약 먹을 시간이 곧 다가와요. 미리 준비해 주세요.`,
            tag: `${slotKey}-pre`, slotKey, kind: 'pre', hh, mm,
            voiceText: `${label} 약 먹을 시간이 곧 다가와요. 미리 준비해 주세요.`,
          });
        }
      }
      // 정시 알림 - 복용함/건너뜀/나중에 버튼 포함 (지원 브라우저에 한함)
      const onKey = `${slotKey}_on`;
      if (minutes === slotMin && !rec.sentLog[onKey]) {
        rec.sentLog[onKey] = true; changed = true;
        sendPush(rec, {
          title: '복약 알리미',
          body: `${label} 약 먹을 시간입니다.`,
          tag: `${slotKey}-on`, slotKey, kind: 'on', hh, mm,
          voiceText: '약 먹을 시간입니다.',
          actions: REMINDER_ACTIONS,
        });
      }

      const elapsed = minutes - slotMin;

      // "나중에 복용" 눌러서 예약된 시각이 되면 한 번 더 (무한반복 아님 - 한 번 울리고 스스로 정리)
      if (rec.snoozeUntil && rec.snoozeUntil[slotKey] !== undefined) {
        if (minutes >= rec.snoozeUntil[slotKey] && elapsed <= AUTO_CLOSE_MINUTES) {
          const snoozeKey = `${slotKey}_snooze_${hh}:${mm}`;
          if (!rec.sentLog[snoozeKey]) {
            rec.sentLog[snoozeKey] = true; changed = true;
            delete rec.snoozeUntil[slotKey];
            sendPush(rec, {
              title: '복약 알리미',
              body: `${label} 약 드셨나요? 아직이면 지금 챙겨보세요.`,
              tag: `${slotKey}-on`, slotKey, kind: 'on', hh, mm,
              voiceText: `${label} 약 드셨나요? 아직이면 지금 챙겨보세요.`,
              actions: REMINDER_ACTIONS,
            });
          }
        } else if (elapsed > AUTO_CLOSE_MINUTES) {
          delete rec.snoozeUntil[slotKey]; changed = true;
        }
      }

      // (선택) 자동 반복 알림 - 설정한 경우에만, 2시간 안에서 5분 간격·최대 3회로 제한
      if (rec.repeatAlarmEnabled && elapsed > 0 && elapsed < AUTO_CLOSE_MINUTES) {
        if (elapsed % 5 === 0) {
          const repCount = rec.sentLog[`${slotKey}_repCount`] || 0;
          const repKey = `${slotKey}_rep_${elapsed}`;
          if (repCount < 3 && !rec.sentLog[repKey]) {
            rec.sentLog[repKey] = true;
            rec.sentLog[`${slotKey}_repCount`] = repCount + 1;
            changed = true;
            sendPush(rec, {
              title: '복약 알리미',
              body: `${label} 약을 아직 못 드셨어요. 지금 챙겨보세요.`,
              tag: `${slotKey}-rep`, slotKey, kind: 'rep', hh, mm,
              voiceText: `${label} 약을 아직 못 드셨어요. 지금 챙겨보세요.`,
              actions: REMINDER_ACTIONS,
            });
          }
        }
      }
      // 2시간이 지나도 결정이 없으면 서버는 더 이상 알림을 보내지 않는다(= 자동 종료).
      // "미복용으로 기록"은 앱(app.js)이 가지고 있는 실제 복약 기록(localStorage)에 기준해 처리되고,
      // 서버는 단지 더 이상 푸시를 보내지 않는 역할만 한다 (서버는 기록 저장소가 아니라 알림 스케줄러이기 때문).
    });
  });

  if (changed) saveSubscriptions(subscriptions);
}

setInterval(tick, 30 * 1000);

app.listen(PORT, () => {
  console.log(`복약 알리미 서버가 ${PORT}번 포트에서 실행 중이에요.`);
});
