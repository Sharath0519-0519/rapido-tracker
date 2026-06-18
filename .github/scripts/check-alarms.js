// check-alarms.js
// Runs every minute via GitHub Actions.
// Reads every user's alarms/reminders from Firestore, finds anything due
// in the current minute, and sends a real FCM push notification for it.
// Marks items as "fired" so they don't repeat (except daily/weekday/weekend repeats).

const admin = require('firebase-admin');

// ── Load service account from GitHub Secret ──────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

// ── Time helpers ──────────────────────────────────────────────
function nowIST() {
  // Server runs in UTC; convert to IST (UTC+5:30) since this app is for an India-based user
  const utc = new Date();
  const ist = new Date(utc.getTime() + (5 * 60 + 30) * 60000);
  return ist;
}

function hhmm(date) {
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function dateStr(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

async function sendPush(token, title, body, tag) {
  if (!token) return false;
  try {
    await messaging.send({
      token,
      notification: { title, body },
      data: { tag: tag || 'alarm', click_action: 'FLUTTER_NOTIFICATION_CLICK' },
      webpush: {
        headers: { Urgency: 'high' },
        notification: {
          icon: 'https://sharath0519-0519.github.io/rapido-tracker/icon-192.png',
          badge: 'https://sharath0519-0519.github.io/rapido-tracker/icon-192.png',
          vibrate: [400, 100, 400],
          requireInteraction: true,
        },
      },
    });
    return true;
  } catch (e) {
    console.error('Push failed for token', token.slice(0, 12) + '...', e.message);
    return false;
  }
}

async function main() {
  const now = nowIST();
  const currentTime = hhmm(now); // "HH:MM" in IST
  const today = dateStr(now);
  const weekday = now.getUTCDay(); // 0=Sun ... 6=Sat (after IST shift)

  console.log(`Checking alarms at IST ${currentTime} on ${today} (weekday=${weekday})`);

  const usersSnap = await db.collection('users').get();
  let firedCount = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;

    // get this user's FCM token
    let token = null;
    try {
      const tokenDoc = await db.doc(`users/${uid}/meta/fcmToken`).get();
      if (tokenDoc.exists) token = tokenDoc.data().token;
    } catch (e) { /* no token saved yet */ }
    if (!token) continue;

    // ── ALARMS ──────────────────────────────────────────────
    const alarmsSnap = await db.collection(`users/${uid}/alarms`).get();
    for (const a of alarmsSnap.docs) {
      const alarm = a.data();
      if (!alarm.on) continue;
      if (alarm.time !== currentTime) continue;
      if (alarm.lastFiredOn === today) continue; // already fired today, skip

      // check repeat rules
      let shouldFire = false;
      if (alarm.forDate) {
        shouldFire = alarm.forDate === today; // night-plan pinned alarm
      } else if (alarm.repeat === 'once') {
        shouldFire = !alarm.lastFiredOn; // only fire once ever
      } else if (alarm.repeat === 'daily') {
        shouldFire = true;
      } else if (alarm.repeat === 'weekdays') {
        shouldFire = weekday >= 1 && weekday <= 5;
      } else if (alarm.repeat === 'weekends') {
        shouldFire = weekday === 0 || weekday === 6;
      }

      if (shouldFire) {
        const sent = await sendPush(token, '⏰ ' + alarm.label, `${alarm.time} · ${alarm.repeat}`, 'alarm-' + a.id);
        if (sent) {
          firedCount++;
          await a.ref.update({ lastFiredOn: today });
          // turn off one-time/date-pinned alarms after firing
          if (alarm.repeat === 'once' || alarm.forDate) {
            await a.ref.update({ on: false });
          }
        }
      }
    }

    // ── REMINDERS ───────────────────────────────────────────
    const remindersSnap = await db.collection(`users/${uid}/reminders`).get();
    for (const r of remindersSnap.docs) {
      const rem = r.data();
      if (rem.fired) continue;
      if (rem.time === currentTime && rem.date === today) {
        const sent = await sendPush(token, '🔔 ' + rem.txt, '', 'rem-' + r.id);
        if (sent) {
          firedCount++;
          await r.ref.update({ fired: true });
        }
      }
    }

    // ── NIGHTLY PLANNING PROMPT (9:55 PM IST) ──────────────
    if (currentTime === '21:55') {
      const promptKey = `nightprompt_${today}`;
      const flagDoc = await db.doc(`users/${uid}/meta/lastNightPrompt`).get();
      const alreadySent = flagDoc.exists && flagDoc.data().date === today;
      const metaDoc = await db.doc(`users/${uid}/meta/settings`).get();
      const nightPlanEnabled = !metaDoc.exists || metaDoc.data().nightPlanEnabled !== false;

      if (!alreadySent && nightPlanEnabled) {
        const sent = await sendPush(
          token,
          '🌙 Plan Tomorrow',
          "What's your schedule for tomorrow? Open the app to set wake up, workout & ride times.",
          'night-plan-prompt'
        );
        if (sent) {
          firedCount++;
          await db.doc(`users/${uid}/meta/lastNightPrompt`).set({ date: today });
        }
      }
    }

    // ── MISSED NIGHT-PLAN FOLLOW-UP (10:25 PM IST = 30 min later) ──
    if (currentTime === '22:25') {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60000);
      const tomorrowStr = dateStr(tomorrow);
      const plansSnap = await db.collection(`users/${uid}/nightPlans`).where('date', '==', tomorrowStr).get();
      const flagDoc = await db.doc(`users/${uid}/meta/lastFollowup`).get();
      const alreadySent = flagDoc.exists && flagDoc.data().date === today;

      if (plansSnap.empty && !alreadySent) {
        const sent = await sendPush(
          token,
          "🌙 Still need tomorrow's plan",
          "You haven't planned tomorrow yet — open the app to set your alarms now.",
          'night-plan-followup'
        );
        if (sent) {
          firedCount++;
          await db.doc(`users/${uid}/meta/lastFollowup`).set({ date: today });
        }
      }
    }
  }

  console.log(`Done. Sent ${firedCount} notification(s).`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
