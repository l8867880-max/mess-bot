const db = require("./db");  
const { reply } = require("./util");  
const triviaManager = require("./trivia-manager");  
const riddleManager = require("./riddle-manager");  
  
// ============================================================  
// CONFIG  
// ============================================================  
  
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;  
  
const EDIT_MIN_MS = 900;  
const EDIT_MAX_MS = 1400;  
const EDIT_TIMEOUT_MS = 5000;  
  
const EDIT_MAX_RETRIES = 2;  
const EDIT_RETRY_DELAY_MS = 400;  
  
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;  
const WORK_COOLDOWN_MS = 60 * 60 * 1000;  
  
const MAX_BET = 1_000_000;  
  
// ============================================================  
// STATE  
// ============================================================  
  
const sessions = new Map();  
const sessionTimers = new Map();  
const activeGames = new Set();  
  
// ============================================================  
// RANDOM / TIME HELPERS  
// ============================================================  
  
function randInt(min, max) {  
  return Math.floor(Math.random() * (max - min + 1)) + min;  
}  
  
function sleep(ms) {  
  return new Promise((resolve) => setTimeout(resolve, ms));  
}  
  
function editDelay() {  
  return randInt(EDIT_MIN_MS, EDIT_MAX_MS);  
}  
  
function formatNumber(value) {  
  return Number(value || 0).toLocaleString("en-US");  
}  
  
function sessionKey(threadID, userID) {  
  return `${threadID}:${userID}`;  
}  
  
function normalizeArgs(args) {  
  if (Array.isArray(args)) {  
    return args  
      .map((x) => String(x))  
      .filter(Boolean);  
  }  
  
  return String(args || "")  
    .trim()  
    .split(/\s+/)  
    .filter(Boolean);  
}  
  
function parseBet(value) {  
  const bet = Number(  
    String(value || "")  
      .replace(/,/g, "")  
      .trim()  
  );  
  
  if (!Number.isInteger(bet)) {  
    return NaN;  
  }  
  
  return bet;  
}  
  
function validBet(bet) {  
  return (  
    Number.isInteger(bet) &&  
    bet >= 1 &&  
    bet <= MAX_BET  
  );  
}  
  
// ============================================================  
// THE VEIL — VISUAL SYSTEM  
// ============================================================  
  
const GAME_STYLE = {  
  trivia: {  
    icon: "🧠",  
    name: "THE VEIL • TRIVIA",  
  },  
  
  rps: {  
    icon: "⚔️",  
    name: "THE VEIL • DUEL",  
  },  
  
  roll: {  
    icon: "🎲",  
    name: "THE VEIL • DICE",  
  },  
  
  guess: {  
    icon: "🎯",  
    name: "THE VEIL • GUESS",  
  },  
  
  coinflip: {  
    icon: "🪙",  
    name: "THE VEIL • FATE",  
  },  
  
  blackjack: {  
    icon: "♠️",  
    name: "THE VEIL • BLACKJACK",  
  },  
  
  slots: {  
    icon: "🎰",  
    name: "THE VEIL • REELS",  
  },  
  
  math: {  
    icon: "🧮",  
    name: "THE VEIL • PRECISION",  
  },  
  
  riddle: {  
    icon: "🧩",  
    name: "THE VEIL • RIDDLE",  
  },  
  
  "8ball": {  
    icon: "🔮",  
    name: "THE VEIL • ORACLE",  
  },  
  
  daily: {  
    icon: "✦",  
    name: "THE VEIL • OFFERING",  
  },  
  
  work: {  
    icon: "**◈**",  
    name: "THE VEIL • CONTRACT",  
  },  
};  
  
function gameHeader(type, subtitle = "") {  
  const style = GAME_STYLE[type] || {  
    icon: "🌑",  
    name: "THE VEIL",  
  };  
  
  return [  
    `**╭────────────────────────────╮**`,  
    `       ${style.icon} ${style.name}`,  
    `**╰────────────────────────────╯**`,  
    subtitle ? `**♙** ${subtitle}` : "",  
  ]  
    .filter(Boolean)  
    .join("\n");  
}  
  
function divider() {  
  return "**────────────────────────────**";  
}  
  
function thinDivider() {  
  return "**┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄**";  
}  
  
function playerLine(event) {  
  return getPlayerName(event);  
}  
  
function rewardLine(reward, balanceText, won = true) {  
  const xpSign = won ? "+" : "-";  
  
  const xpValue = Math.abs(  
    Number(reward?.xp || 0)  
  );  
  
  const coinValue = Number(  
    reward?.coins || 0  
  );  
  
  const coinText =  
    won && coinValue > 0  
      ? `+${formatNumber(coinValue)}`  
      : "0";  
  
  return [  
    divider(),  
    `⭐ XP       ${xpSign}${formatNumber(xpValue)}`,  
    `💰 Coins    ${coinText}`,  
    "",  
    balanceText,  
  ].join("\n");  
}  
  
// ============================================================  
// REWARDS  
// ============================================================  
  
function xpForGame(type) {  
  const rewards = {  
    rps: 40,  
    roll: 30,  
    guess: 50,  
    coinflip: 35,  
    slots: 45,  
    blackjack: 60,  
    trivia: 50,  
    math: 50,  
    riddle: 50,  
    "8ball": 10,  
  };  
  
  return rewards[type] || 25;  
}  
  
function coinReward(type) {  
  const rewards = {  
    rps: 100,  
    roll: 75,  
    guess: 150,  
    coinflip: 100,  
    slots: 125,  
    blackjack: 175,  
    trivia: 150,  
    math: 175,  
    riddle: 150,  
    "8ball": 25,  
  };  
  
  return rewards[type] || 50;  
}  
  
async function awardPlayer(  
  threadID,  
  userID,  
  gameType,  
  won = false  
) {  
  const xp = xpForGame(gameType);  
  const baseCoins = coinReward(gameType);  
  
  const xpAmount = won  
    ? xp  
    : Math.floor(xp * 0.5);  
  
  await db.addXP(  
    threadID,  
    userID,  
    won ? xpAmount : -xpAmount  
  );  
  
  if (won) {  
    await db.addBalance(  
      threadID,  
      userID,  
      baseCoins  
    );  
  }  
  
  return {  
    xp: xpAmount,  
    coins: won ? baseCoins : 0,  
    won,  
  };  
}  
  
async function getFinalBalanceText(  
  threadID,  
  userID  
) {  
  const user = await db.getUser(  
    threadID,  
    userID  
  );  
  
  const coins = formatNumber(  
    user?.balance ?? 0  
  );  
  
  const xp = formatNumber(  
    user?.xp ?? 0  
  );  
  
  return `💰 ${coins} coins   •   ⭐ ${xp} XP`;  
}  
  
// ============================================================  
// PLAYER  
// ============================================================  
  
function getPlayerName(event) {  
  if (event && event.senderName) {  
    return String(event.senderName);  
  }  
  
  if (event && event.userName) {  
    return String(event.userName);  
  }  
  
  const id =  
    event && event.senderID  
      ? String(event.senderID)  
      : "Player";  
  
  return `Player ${id.slice(-4)}`;  
}  
  
// ============================================================  
// MESSAGE HELPERS  
// ============================================================  
  
function getMessengerErrorCode(error) {
  if (error == null) return null;
  if (typeof error === "number") return error;
  if (typeof error === "string") return error.includes("1545012") ? 1545012 : null;
  if (typeof error === "object") {
    for (const value of [error.code, error.error, error.errorCode, error.error_code, error.status, error.statusCode]) {
      if (Number(value) === 1545012) return 1545012;
    }
    try {
      if (JSON.stringify(error)?.includes("1545012")) return 1545012;
    } catch (_) {}
  }
  return null;
}

function is1545012Error(error) {
  if (getMessengerErrorCode(error) === 1545012) return true;
  const message = error?.message || String(error || "");
  const stack = error?.stack || "";
  return message === "[object Object]" && stack.includes("sendMessage.js");
}

function formatMessengerError(error) {
  if (error == null) return "Unknown Messenger error.";
  if (error instanceof Error) return error.stack || error.message || String(error);
  try { return JSON.stringify(error); } catch (_) { return String(error); }
}

const GAME_SEND_RETRY_DELAYS_MS = [1500, 4000, 8000];
const GAME_THREAD_COOLDOWN_MS = 5 * 60 * 1000;
const gameThreadSendCooldowns = new Map();

function gameThreadOnCooldown(threadID) {
  const key = String(threadID);
  const until = gameThreadSendCooldowns.get(key) || 0;
  if (until > Date.now()) return true;
  if (until) gameThreadSendCooldowns.delete(key);
  return false;
}

function setGameThreadCooldown(threadID, reason) {
  const key = String(threadID);
  gameThreadSendCooldowns.set(key, Date.now() + GAME_THREAD_COOLDOWN_MS);
  console.warn(`[GAMES] Thread ${key} placed on send cooldown for 5 minutes.${reason ? ` Reason: ${reason}` : ""}`);
}

function verifyGameThread(api, threadID) {
  return new Promise((resolve) => {
    if (!api || typeof api.getThreadInfo !== "function") {
      console.warn("[GAMES] getThreadInfo() unavailable; retrying without verification.");
      resolve(null);
      return;
    }
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      resolve(value);
    };
    try {
      const result = api.getThreadInfo(String(threadID), (error, info) => {
        if (error) {
          console.warn(`[GAMES] getThreadInfo(${threadID}) failed:`, formatMessengerError(error));
          finish(false);
          return;
        }
        finish(Boolean(info));
      });
      if (result && typeof result.then === "function") {
        result.then((info) => finish(Boolean(info))).catch((error) => {
          console.warn(`[GAMES] getThreadInfo(${threadID}) Promise failed:`, formatMessengerError(error));
          finish(false);
        });
      }
    } catch (error) {
      console.warn(`[GAMES] getThreadInfo(${threadID}) threw:`, formatMessengerError(error));
      finish(false);
    }
  });
}

function sendMessageOnce(api, threadID, text) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, messageInfo) => {
      if (finished) return;
      finished = true;
      if (error) {
        reject(error);
        return;
      }
      resolve(messageInfo || null);
    };
    try {
      if (!api || typeof api.sendMessage !== "function") {
        finish(new Error("Messenger sendMessage is unavailable."));
        return;
      }
      const result = api.sendMessage(text, String(threadID), null, (error, messageInfo) => {
        finish(error, messageInfo);
      });
      if (result && typeof result.then === "function") {
        result.then((messageInfo) => finish(null, messageInfo)).catch((error) => finish(error));
      }
    } catch (error) {
      finish(error);
    }
  });
}

async function sendMessageAsync(api, threadID, text) {
  const key = String(threadID);
  if (gameThreadOnCooldown(key)) {
    console.warn(`[GAMES] Skipping send to ${key}: 1545012 thread cooldown is active.`);
    return null;
  }
  const totalAttempts = GAME_SEND_RETRY_DELAYS_MS.length + 1;
  let lastError = null;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      const result = await sendMessageOnce(api, key, text);
      gameThreadSendCooldowns.delete(key);
      return result;
    } catch (error) {
      lastError = error;
      if (!is1545012Error(error)) {
        console.error("[GAMES] sendMessage failed:", formatMessengerError(error));
        throw error;
      }
      console.warn(`[GAMES] Facebook 1545012/send failure for thread ${key} (attempt ${attempt + 1}/${totalAttempts}).`);
      const verification = await verifyGameThread(api, key);
      if (verification === false) {
        setGameThreadCooldown(key, "getThreadInfo could not access the thread");
        console.warn(`[GAMES] Thread ${key} appears inaccessible. Stopping retries.`);
        return null;
      }
      if (attempt >= GAME_SEND_RETRY_DELAYS_MS.length) break;
      const delay = GAME_SEND_RETRY_DELAYS_MS[attempt];
      console.warn(`[GAMES] Retrying send to ${key} in ${delay}ms...`);
      await sleep(delay);
    }
  }
  setGameThreadCooldown(key, "1545012/send failure persisted after retries");
  console.error(`[GAMES] Giving up on thread ${key} after ${totalAttempts} attempts.`);
  console.error("[GAMES] Last send error:", formatMessengerError(lastError));
  return null;
}


async function editMessageWithRetry(  
  api,  
  newText,  
  messageID  
) {  
  let lastError = null;  
  
  for (  
    let attempt = 0;  
    attempt <= EDIT_MAX_RETRIES;  
    attempt++  
  ) {  
    const success =  
      await editMessageSafe(  
        api,  
        newText,  
        messageID  
      );  
  
    if (success) {  
      return true;  
    }  
  
    lastError =  
      `attempt ${attempt + 1} failed`;  
  
    if (  
      attempt < EDIT_MAX_RETRIES  
    ) {  
      await sleep(  
        EDIT_RETRY_DELAY_MS  
      );  
    }  
  }  
  
  console.warn(  
    `[games] edit failed after retries for message ${messageID}: ${lastError}`  
  );  
  
  return false;  
}  
  
// ============================================================  
// DUPLICATE MESSAGE PROTECTION  
// ============================================================  
  
async function updateGameMessage(  
  api,  
  threadID,  
  messageID,  
  text  
) {  
  if (!messageID) {  
    console.warn(  
      "[games] Cannot edit game message: missing messageID"  
    );  
  
    return false;  
  }  
  
  const edited =  
    await editMessageWithRetry(  
      api,  
      text,  
      messageID  
    );  
  
  if (!edited) {  
    console.warn(  
      `[games] Could not edit message ${messageID}. No duplicate message will be sent.`  
    );  
  }  
  
  return edited;  
}  
  
async function createAnimator(  
  api,  
  threadID,  
  initialText,  
  gameType = ""  
) {  
  const result = {  
    messageID: null,  
    stopEdit: null,  
    editCount: 0,  
  };  
  
  try {  
    const msgInfo =  
      await sendMessageAsync(  
        api,  
        threadID,  
        initialText  
      );  
  
    if (  
      !msgInfo ||  
      !msgInfo.messageID  
    ) {  
      console.error(  
        `[games] failed to send initial ${gameType} message`  
      );  
  
      return result;  
    }  
  
    result.messageID =  
      msgInfo.messageID;  
  
    result.stopEdit = () => {};  
  } catch (error) {  
    console.error(  
      `[games] animator init (${gameType}):`,  
      error  
    );  
  }  
  
  return result;  
}  
  
// ============================================================  
// SESSION MANAGEMENT  
// ============================================================  
  
function setSession(  
  threadID,  
  userID,  
  data  
) {  
  const key =  
    sessionKey(  
      threadID,  
      userID  
    );  
  
  sessions.set(  
    key,  
    data  
  );  
  
  clearTimeout(  
    sessionTimers.get(key)  
  );  
  
  sessionTimers.set(  
    key,  
    setTimeout(() => {  
      sessions.delete(key);  
      sessionTimers.delete(key);  
      activeGames.delete(key);  
    }, SESSION_TIMEOUT_MS)  
  );  
}  
  
function getSession(  
  threadID,  
  userID  
) {  
  return (  
    sessions.get(  
      sessionKey(  
        threadID,  
        userID  
      )  
    ) || null  
  );  
}  
  
function clearSession(  
  threadID,  
  userID  
) {  
  const key =  
    sessionKey(  
      threadID,  
      userID  
    );  
  
  clearTimeout(  
    sessionTimers.get(key)  
  );  
  
  sessions.delete(key);  
  sessionTimers.delete(key);  
}  
  
// ============================================================  
// GAME LOCK  
// ============================================================  
  
function lockGame(  
  threadID,  
  userID  
) {  
  const key =  
    `${threadID}:${userID}`;  
  
  if (  
    activeGames.has(key)  
  ) {  
    return false;  
  }  
  
  activeGames.add(key);  
  
  return true;  
}  
  
function unlockGame(  
  threadID,  
  userID  
) {  
  activeGames.delete(  
    `${threadID}:${userID}`  
  );  
}  
  
// ============================================================  
// DAILY  
// ============================================================  
  
async function handleDaily(  
  api,  
  event  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  try {  
    const user =  
      await db.getUser(  
        threadID,  
        userID  
      );  
  
    const now = Date.now();  
  
    const lastDaily =  
      Number(  
        user?.last_daily || 0  
      );  
  
    const elapsed =  
      now - lastDaily;  
  
    if (  
      elapsed <  
      DAILY_COOLDOWN_MS  
    ) {  
      const remaining =  
        DAILY_COOLDOWN_MS -  
        elapsed;  
  
      const hours =  
        Math.floor(  
          remaining /  
            (60 * 60 * 1000)  
        );  
  
      const minutes =  
        Math.floor(  
          (remaining %  
            (60 * 60 * 1000)) /  
            (60 * 1000)  
        );  
  
      await safeReply(  
        api,  
        event,  
        [  
          "**╭────────────────────────────╮**",  
          "       ✦ THE VEIL",  
          "       DAILY OFFERING",  
          "**╰────────────────────────────╯**",  
          "",  
          "🌑 The offering has already been claimed.",  
          "",  
          `⏳ Return in ${hours}h ${minutes}m.`,  
        ].join("\n")  
      );  
  
      return true;  
    }  
  
    const previousStreak =  
      Number(  
        user?.daily_streak || 0  
      );  
  
    const withinGrace =  
      elapsed <=  
      48 * 60 * 60 * 1000;  
  
    const streak =  
      withinGrace  
        ? previousStreak + 1  
        : 1;  
  
    const baseReward = 200;  
  
    const streakBonus =  
      Math.min(  
        streak * 25,  
        500  
      );  
  
    const totalReward =  
      baseReward +  
      streakBonus;  
  
    await db.addBalance(  
      threadID,  
      userID,  
      totalReward  
    );  
  
    await db.addXP(  
      threadID,  
      userID,  
      50  
    );  
  
    await db.updateUser(  
      threadID,  
      userID,  
      {  
        last_daily: now,  
        daily_streak: streak,  
      }  
    );  
  
    const balanceText =  
      await getFinalBalanceText(  
        threadID,  
        userID  
      );  
  
    await sendMessageAsync(  
      api,  
      threadID,  
      [  
        gameHeader(  
          "daily",  
          playerLine(event)  
        ),  
        "",  
        "The Veil opens its hand.",  
        "",  
        `💰 Base        +${formatNumber(baseReward)}`,  
        `🔥 Streak      +${formatNumber(streakBonus)}`,  
        `✦ Total        +${formatNumber(totalReward)}`,  
        `⭐ XP           +50`,  
        "",  
        `🔥 Daily streak: ${streak}`,  
        "",  
        balanceText,  
      ].join("\n")  
    );  
  
    return true;  
  } catch (error) {  
    console.error(  
      "[games] daily:",  
      error  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil could not release today's offering."  
    );  
  
    return true;  
  }  
}  
  
// ============================================================  
// WORK  
// ============================================================  
  
const WORK_JOBS = [  
  {  
    job: "Software Developer",  
    min: 100,  
    max: 300,  
    xp: 25,  
  },  
  {  
    job: "Graphic Designer",  
    min: 90,  
    max: 260,  
    xp: 22,  
  },  
  {  
    job: "Bartender",  
    min: 70,  
    max: 220,  
    xp: 18,  
  },  
  {  
    job: "Freelancer",  
    min: 120,  
    max: 350,  
    xp: 30,  
  },  
  {  
    job: "Delivery Rider",  
    min: 60,  
    max: 180,  
    xp: 15,  
  },  
  {  
    job: "Musician",  
    min: 80,  
    max: 280,  
    xp: 20,  
  },  
  {  
    job: "Detective",  
    min: 110,  
    max: 320,  
    xp: 27,  
  },  
  {  
    job: "Chef",  
    min: 90,  
    max: 250,  
    xp: 21,  
  },  
];  
  
async function handleWork(  
  api,  
  event  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  try {  
    const user =  
      await db.getUser(  
        threadID,  
        userID  
      );  
  
    const now = Date.now();  
  
    const lastWork =  
      Number(  
        user?.last_work || 0  
      );  
  
    const elapsed =  
      now - lastWork;  
  
    if (  
      elapsed <  
      WORK_COOLDOWN_MS  
    ) {  
      const remaining =  
        WORK_COOLDOWN_MS -  
        elapsed;  
  
      const minutes =  
        Math.floor(  
          remaining /  
            (60 * 1000)  
        );  
  
      const seconds =  
        Math.floor(  
          (remaining %  
            (60 * 1000)) /  
            1000  
        );  
  
      await safeReply(  
        api,  
        event,  
        [  
          "**╭────────────────────────────╮**",  
          "       **◈** THE VEIL",  
          "          CONTRACT",  
          "**╰────────────────────────────╯**",  
          "",  
          "⏳ Your current contract is still cooling down.",  
          "",  
          `Return in ${minutes}m ${seconds}s.`,  
        ].join("\n")  
      );  
  
      return true;  
    }  
  
    const job =  
      WORK_JOBS[  
        randInt(  
          0,  
          WORK_JOBS.length - 1  
        )  
      ];  
  
    const earned =  
      randInt(  
        job.min,  
        job.max  
      );  
  
    await db.addBalance(  
      threadID,  
      userID,  
      earned  
    );  
  
    await db.addXP(  
      threadID,  
      userID,  
      job.xp  
    );  
  
    await db.updateUser(  
      threadID,  
      userID,  
      {  
        last_work: now,  
      }  
    );  
  
    const balanceText =  
      await getFinalBalanceText(  
        threadID,  
        userID  
      );  
  
    await sendMessageAsync(  
      api,  
      threadID,  
      [  
        gameHeader(  
          "work",  
          playerLine(event)  
        ),  
        "",  
        "A contract has found you.",  
        "",  
        `💼 ${job.job}`,  
        `💰 Earned: +${formatNumber(earned)} coins`,  
        `⭐ XP: +${formatNumber(job.xp)}`,  
        "",  
        "The shift is complete.",  
        "",  
        balanceText,  
      ].join("\n")  
    );  
  
    return true;  
  } catch (error) {  
    console.error(  
      "[games] work:",  
      error  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil could not assign a contract."  
    );  
  
    return true;  
  }  
}  
  
// ============================================================  
// TRIVIA  
// ============================================================  
  
async function handleTrivia(  
  api,  
  event  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  if (  
    !lockGame(  
      threadID,  
      userID  
    )  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil is already occupied.\n\nFinish your current challenge first."  
    );  
  
    return;  
  }  
  
  try {  
    const q =  
      await triviaManager.getNextQuestion({  
        threadID,  
      });  
  
    if (!q) {  
      unlockGame(  
        threadID,  
        userID  
      );  
  
      await safeReply(  
        api,  
        event,  
        "🌑 The Veil has no unanswered questions available."  
      );  
  
      return;  
    }  
  
    const text = [  
      gameHeader(  
        "trivia",  
        playerLine(event)  
      ),  
      "",  
      "KNOWLEDGE IS POWER",  
      "",  
      `❓ ${q.question}`,  
      "",  
      `**〔** A **〕** ${q.options[0]}`,  
      `**〔** B **〕** ${q.options[1]}`,  
      `**〔** C **〕** ${q.options[2]}`,  
      `**〔** D **〕** ${q.options[3]}`,  
      "",  
      thinDivider(),  
      "✦ Correct  +50 XP  •  +150 coins",  
      "",  
      "**↳** Reply with A, B, C or D",  
    ].join("\n");  
  
    const animator =  
      await createAnimator(  
        api,  
        threadID,  
        text,  
        "trivia"  
      );  
  
    setSession(  
      threadID,  
      userID,  
      {  
        type: "trivia",  
        qdata: q,  
        messageID:  
          animator.messageID,  
      }  
    );  
  } catch (error) {  
    unlockGame(  
      threadID,  
      userID  
    );  
  
    console.error(  
      "[games] trivia:",  
      error  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil could not reveal a question."  
    );  
  }  
}  
  
function normalizeAnswerText(  
  value  
) {  
  return String(value || "")  
    .normalize("NFKC")  
    .trim()  
    .toLowerCase()  
    .replace(  
      /^(?:the\s+)?answer\s*(?:is|:)?\s*/i,  
      ""  
    )  
    .replace(  
      /[.!?,;:]+$/g,  
      ""  
    )  
    .replace(  
      /\s+/g,  
      " "  
    );  
}  
  
function parseNumericAnswer(  
  value  
) {  
  const match =  
    String(value || "").match(  
      /[-+]?\d+(?:\.\d+)*/  
    );  
  
  return match  
    ? Number(match[0])  
    : NaN;  
}  
  
function getTriviaAnswerIndex(  
  answer,  
  qdata  
) {  
  const normalized =  
    normalizeAnswerText(  
      answer  
    );  
  
  const letter =  
    normalized.match(  
      /^(?:option|choice)?\s*([abcd])(?:[).]\s*)?$/i  
    );  
  
  if (letter) {  
    return [  
      "a",  
      "b",  
      "c",  
      "d",  
    ].indexOf(  
      letter[1].toLowerCase()  
    );  
  }  
  
  return (  
    qdata.options || []  
  ).findIndex(  
    (option) =>  
      normalizeAnswerText(  
        option  
      ) === normalized  
  );  
}  
  
async function resolveTrivia(  
  api,  
  event,  
  answer  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  const session =  
    getSession(  
      threadID,  
      userID  
    );  
  
  if (  
    !session ||  
    session.type !== "trivia"  
  ) {  
    return false;  
  }  
  
  clearSession(  
    threadID,  
    userID  
  );  
  
  const letters = [  
    "A",  
    "B",  
    "C",  
    "D",  
  ];  
  
  const chosenIndex =  
    getTriviaAnswerIndex(  
      answer,  
      session.qdata  
    );  
  
  const correctIndex =  
    session.qdata.answer;  
  
  const correct =  
    chosenIndex ===  
    correctIndex;  
  
  const correctLetter =  
    letters[correctIndex] || "?";  
  
  try {  
    const reward =  
      await awardPlayer(  
        threadID,  
        userID,  
        "trivia",  
        correct  
      );  
  
    const balanceText =  
      await getFinalBalanceText(  
        threadID,  
        userID  
      );  
  
    const finalText = [  
      gameHeader("trivia"),  
      "",  
      correct  
        ? "🏆 KNOWLEDGE PREVAILS"  
        : "❌ THE VEIL REMAINS",  
      "",  
      `✓ Correct answer: ${correctLetter}`,  
      "",  
      correct  
        ? "✦ Your answer pierced the Veil."  
        : "✦ The answer remains beyond your grasp.",  
      "",  
      rewardLine(  
        reward,  
        balanceText,  
        correct  
      ),  
    ].join("\n");  
  
    await updateGameMessage(  
      api,  
      threadID,  
      session.messageID,  
      finalText  
    );  
  } catch (error) {  
    console.error(  
      "[games] trivia reward:",  
      error  
    );  
  }  
  
  unlockGame(  
    threadID,  
    userID  
  );  
  
  return true;  
}  
  
// ============================================================  
// ROCK PAPER SCISSORS  
// ============================================================  
  
async function handleRPS(  
  api,  
  event,  
  args  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  if (  
    !lockGame(  
      threadID,  
      userID  
    )  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil is already occupied.\n\nFinish your current challenge first."  
    );  
  
    return;  
  }  
  
  try {  
    const playerChoice =  
      String(  
        args?.[0] || ""  
      ).toLowerCase();  
  
    const aliases = {  
      r: "rock",  
      p: "paper",  
      s: "scissors",  
    };  
  
    const normalizedChoice =  
      aliases[playerChoice] ||  
      playerChoice;  
  
    if (  
      ![  
        "rock",  
        "paper",  
        "scissors",  
      ].includes(  
        normalizedChoice  
      )  
    ) {  
      unlockGame(  
        threadID,  
        userID  
      );  
  
      await safeReply(  
        api,  
        event,  
        "⚔️ Choose rock, paper, or scissors."  
      );  
  
      return;  
    }  
  
    const choices = [  
      "rock",  
      "paper",  
      "scissors",  
    ];  
  
    const botChoice =  
      choices[  
        randInt(0, 2)  
      ];  
  
    let result = "draw";  
  
    if (  
      (  
        normalizedChoice === "rock" &&  
        botChoice === "scissors"  
      ) ||  
      (  
        normalizedChoice === "scissors" &&  
        botChoice === "paper"  
      ) ||  
      (  
        normalizedChoice === "paper" &&  
        botChoice === "rock"  
      )  
    ) {  
      result = "win";  
    } else if (  
      normalizedChoice !==  
      botChoice  
    ) {  
      result = "loss";  
    }  
  
    const animator =  
      await createAnimator(  
        api,  
        threadID,  
        [  
          gameHeader(  
            "rps",  
            playerLine(event)  
          ),  
          "",  
          "CHALLENGE ACCEPTED",  
          "",  
          "⚔️ The opponent is choosing...",  
          "",  
          "      ⟡  ⟡  ⟡",  
          "",  
          "       FATE DECIDES",  
        ].join("\n"),  
        "rps"  
      );  
  
    await sleep(  
      editDelay()  
    );  
  
    const reward =  
      await awardPlayer(  
        threadID,  
        userID,  
        "rps",  
        result === "win"  
      );  
  
    const balanceText =  
      await getFinalBalanceText(  
        threadID,  
        userID  
      );  
  
    const resultEmoji =  
      result === "win"  
        ? "🏆"  
        : result === "loss"  
          ? "❌"  
          : "🤝";  
  
    const resultText =  
      result === "win"  
        ? "VICTORY"  
        : result === "loss"  
          ? "DEFEAT"  
          : "DRAW";  
  
    const finalText = [  
      gameHeader("rps"),  
      "",  
      `${resultEmoji} ${resultText}`,  
      "",  
      thinDivider(),  
      "",  
      `**♙** YOU       ${normalizedChoice.toUpperCase()}`,  
      `♟ OPPONENT  ${botChoice.toUpperCase()}`,  
      "",  
      result === "win"  
        ? "✦ The Veil favors you."  
        : result === "loss"  
          ? "✦ The Veil favors your opponent."  
          : "✦ Neither warrior prevails.",  
      "",  
      rewardLine(  
        reward,  
        balanceText,  
        result === "win"  
      ),  
    ].join("\n");  
  
    await updateGameMessage(  
      api,  
      threadID,  
      animator.messageID,  
      finalText  
    );  
  } catch (error) {  
    console.error(  
      "[games] rps:",  
      error  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The duel was interrupted."  
    );  
  } finally {  
    unlockGame(  
      threadID,  
      userID  
    );  
  }  
}  
  
// ============================================================  
// DICE ROLL  
// ============================================================  
  
async function handleRoll(  
  api,  
  event,  
  args  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  if (  
    !lockGame(  
      threadID,  
      userID  
    )  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil is already occupied.\n\nFinish your current challenge first."  
    );  
  
    return;  
  }  
  
  let betCharged = false;  
  let settled = false;  
  
  try {  
    const bet =  
      parseBet(args?.[0]);  
  
    const sides =  
      parseInt(  
        args?.[1],  
        10  
      ) || 100;  
  
    if (!validBet(bet)) {  
      unlockGame(  
        threadID,  
        userID  
      );  
  
      await safeReply(  
        api,  
        event,  
        `🎲 Invalid wager.\n\nMinimum: 1\nMaximum: ${formatNumber(MAX_BET)} coins`  
      );  
  
      return;  
    }  
  
    if (  
      sides < 2 ||  
      sides > 1000  
    ) {  
      unlockGame(  
        threadID,  
        userID  
      );  
  
      await safeReply(  
        api,  
        event,  
        "🎲 Die sides must be between 2 and 1000."  
      );  
  
      return;  
    }  
  
    const animator =  
      await createAnimator(  
        api,  
        threadID,  
        [  
          gameHeader(  
            "roll",  
            playerLine(event)  
          ),  
          "",  
          "THE DIE HAS BEEN CAST",  
          "",  
          `🎲 Rolling a ${sides}-sided die...`,  
          `💰 Wager: ${formatNumber(bet)} coins`,  
          "",  
          "       **⚄**",  
          "",  
          "       ROLLING...",  
        ].join("\n"),  
        "roll"  
      );  
  
    try {  
      await db.spendBalance(  
        threadID,  
        userID,  
        bet,  
        `Roll bet: ${bet}`  
      );  
  
      betCharged = true;  
    } catch (error) {  
      await updateGameMessage(  
        api,  
        threadID,  
        animator.messageID,  
        [  
          gameHeader("roll"),  
          "",  
          "🌑 WAGER REJECTED",  
          "",  
          error.message ||  
            "Not enough wallet coins.",  
        ].join("\n")  
      );  
  
      return;  
    }  
  
    await sleep(  
      editDelay()  
    );  
  
    const result =  
      randInt(  
        1,  
        sides  
      );  
  
    const highThreshold =  
      Math.floor(  
        sides * 0.55  
      );  
  
    const won =  
      result >=  
      highThreshold;  
  
    const payout =  
      won  
        ? bet * 2  
        : 0;  
  
    if (payout > 0) {  
      await db.addBalance(  
        threadID,  
        userID,  
        payout  
      );  
    }  
  
    settled = true;  
  
    const balanceText =  
      await getFinalBalanceText(  
        threadID,  
        userID  
      );  
  
    const finalText = [  
      gameHeader("roll"),  
      "",  
      won  
        ? "🏆 HIGH HIT"  
        : "❌ LOW ROLL",  
      "",  
      `🎲 Result: ${result} / ${sides}`,  
      `✦ High starts at: ${highThreshold}+`,  
      "",  
      won  
        ? `💰 Payout: +${formatNumber(payout)} coins`  
        : `💸 Lost wager: -${formatNumber(bet)} coins`,  
      "",  
      balanceText,  
    ].join("\n");  
  
    await updateGameMessage(  
      api,  
      threadID,  
      animator.messageID,  
      finalText  
    );  
  } catch (error) {  
    console.error(  
      "[games] roll:",  
      error  
    );  
  
    if (  
      betCharged &&  
      !settled  
    ) {  
      const bet =  
        parseBet(args?.[0]);  
  
      if (validBet(bet)) {  
        await db  
          .addBalance(  
            threadID,  
            userID,  
            bet  
          )  
          .catch(() => {});  
      }  
    }  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The die could not complete its judgment."  
    );  
  } finally {  
    unlockGame(  
      threadID,  
      userID  
    );  
  }  
}  
  
// ============================================================  
// NUMBER GUESS  
// ============================================================  
  
async function handleGuess(  
  api,  
  event,  
  args  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  if (  
    !lockGame(  
      threadID,  
      userID  
    )  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil is already occupied.\n\nFinish your current challenge first."  
    );  
  
    return;  
  }  
  
  try {  
    const min =  
      parseInt(  
        args?.[0],  
        10  
      ) || 1;  
  
    const max =  
      parseInt(  
        args?.[1],  
        10  
      ) || 100;  
  
    if (  
      min >= max  
    ) {  
      unlockGame(  
        threadID,  
        userID  
      );  
  
      await safeReply(  
        api,  
        event,  
        "🎯 Minimum must be lower than maximum."  
      );  
  
      return;  
    }  
  
    const secretNumber =  
      randInt(  
        min,  
        max  
      );  
  
    const animator =  
      await createAnimator(  
        api,  
        threadID,  
        [  
          gameHeader(  
            "guess",  
            playerLine(event)  
          ),  
          "",  
          "THE NUMBER IS HIDDEN",  
          "",  
          `Range: ${min} **─────────** ${max}`,  
          "",  
          "Attempt: 0 / 3",  
          "",  
          "✦ Trust your intuition.",  
          "",  
          "**↳** Send your first guess.",  
        ].join("\n"),  
        "guess"  
      );  
  
    setSession(  
      threadID,  
      userID,  
      {  
        type: "guess",  
        secretNumber,  
        min,  
        max,  
        tries: 0,  
        messageID:  
          animator.messageID,  
      }  
    );  
  } catch (error) {  
    unlockGame(  
      threadID,  
      userID  
    );  
  
    console.error(  
      "[games] guess:",  
      error  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil could not hide a number."  
    );  
  }  
}  
  
async function resolveGuess(  
  api,  
  event,  
  guessText  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  const session =  
    getSession(  
      threadID,  
      userID  
    );  
  
  if (  
    !session ||  
    session.type !== "guess"  
  ) {  
    return false;  
  }  
  
  const guess =  
    parseNumericAnswer(  
      guessText  
    );  
  
  if (  
    Number.isNaN(guess)  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🎯 Enter a number."  
    );  
  
    return true;  
  }  
  
  const tries =  
    session.tries + 1;  
  
  let resultMessage = "";  
  let isCorrect = false;  
  
  if (  
    guess ===  
    session.secretNumber  
  ) {  
    isCorrect = true;  
  
    resultMessage =  
      `🏆 Correct. You found ${session.secretNumber} in ${tries} attempt${tries === 1 ? "" : "s"}.`;  
  } else if (  
    tries >= 3  
  ) {  
    resultMessage =  
      `❌ The hidden number was ${session.secretNumber}.`;  
  } else if (  
    guess <  
    session.secretNumber  
  ) {  
    resultMessage =  
      `📈 Too low. The number is higher. • ${3 - tries} attempt${3 - tries === 1 ? "" : "s"} left`;  
  } else {  
    resultMessage =  
      `📉 Too high. The number is lower. • ${3 - tries} attempt${3 - tries === 1 ? "" : "s"} left`;  
  }  
  
  const terminal =  
    isCorrect ||  
    tries >= 3;  
  
  if (terminal) {  
    clearSession(  
      threadID,  
      userID  
    );  
  
    try {  
      const reward =  
        await awardPlayer(  
          threadID,  
          userID,  
          "guess",  
          isCorrect  
        );  
  
      const balanceText =  
        await getFinalBalanceText(  
          threadID,  
          userID  
        );  
  
      const finalText = [  
        gameHeader("guess"),  
        "",  
        resultMessage,  
        "",  
        isCorrect  
          ? "✦ Your intuition pierced the Veil."  
          : "✦ The hidden number remains victorious.",  
        "",  
        rewardLine(  
          reward,  
          balanceText,  
          isCorrect  
        ),  
      ].join("\n");  
  
      await updateGameMessage(  
        api,  
        threadID,  
        session.messageID,  
        finalText  
      );  
    } catch (error) {  
      console.error(  
        "[games] guess reward:",  
        error  
      );  
  
      await safeReply(  
        api,  
        event,  
        "🌑 Guess ended, but the reward update failed."  
      );  
    } finally {  
      unlockGame(  
        threadID,  
        userID  
      );  
    }  
  } else {  
    setSession(  
      threadID,  
      userID,  
      {  
        ...session,  
        tries,  
      }  
    );  
  
    const text = [  
      gameHeader("guess"),  
      "",  
      resultMessage,  
      "",  
      `Attempt ${tries}/3`,  
      "",  
      "**↳** Try again.",  
    ].join("\n");  
  
    await updateGameMessage(  
      api,  
      threadID,  
      session.messageID,  
      text  
    );  
  }  
  
  return true;  
}  
  
// ============================================================  
// COIN FLIP  
// ============================================================  
  
async function handleCoinFlip(  
  api,  
  event,  
  args  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  if (  
    !lockGame(  
      threadID,  
      userID  
    )  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil is already occupied.\n\nFinish your current challenge first."  
    );  
  
    return;  
  }  
  
  let betCharged = false;  
  let settled = false;  
  
  try {  
    const first =  
      String(  
        args?.[0] || ""  
      )  
        .trim()  
        .toLowerCase();  
  
    const second =  
      String(  
        args?.[1] || ""  
      )  
        .trim()  
        .toLowerCase();  
  
    const aliases = {  
      h: "heads",  
      t: "tails",  
    };  
  
    const firstChoice =  
      aliases[first] ||  
      first;  
  
    const secondChoice =  
      aliases[second] ||  
      second;  
  
    let choice;  
    let betText;  
  
    if (  
      ["heads", "tails"].includes(  
        firstChoice  
      )  
    ) {  
      choice = firstChoice;  
      betText = second;  
    } else {  
      choice = secondChoice;  
      betText = first;  
    }  
  
    const bet =  
      parseBet(betText);  
  
    if (  
      !validBet(bet) ||  
      !["heads", "tails"].includes(  
        choice  
      )  
    ) {  
      unlockGame(  
        threadID,  
        userID  
      );  
  
      await safeReply(  
        api,  
        event,  
        "🪙 Usage: !coinflip <bet> <heads|tails>\nExample: !coinflip 100 heads"  
      );  
  
      return;  
    }  
  
    const animator =  
      await createAnimator(  
        api,  
        threadID,  
        [  
          gameHeader(  
            "coinflip",  
            playerLine(event)  
          ),  
          "",  
          "FATE CHOOSES",  
          "",  
          `🪙 Your call: ${choice.toUpperCase()}`,  
          `💰 Wager: ${formatNumber(bet)} coins`,  
          "",  
          "       **◉**",  
          "",  
          "       FLIPPING...",  
        ].join("\n"),  
        "coinflip"  
      );  
  
    try {  
      await db.spendBalance(  
        threadID,  
        userID,  
        bet,  
        `Coinflip bet: ${bet}`  
      );  
  
      betCharged = true;  
    } catch (error) {  
      await updateGameMessage(  
        api,  
        threadID,  
        animator.messageID,  
        [  
          gameHeader(  
            "coinflip"  
          ),  
          "",  
          "🌑 WAGER REJECTED",  
          "",  
          error.message ||  
            "Not enough wallet coins.",  
        ].join("\n")  
      );  
  
      return;  
    }  
  
    await sleep(  
      editDelay()  
    );  
  
    const result =  
      randInt(0, 1) === 0  
        ? "heads"  
        : "tails";  
  
    const won =  
      choice === result;  
  
    const payout =  
      won  
        ? bet * 2  
        : 0;  
  
    if (won) {  
      await db.addBalance(  
        threadID,  
        userID,  
        payout  
      );  
    }  
  
    settled = true;  
  
    const balanceText =  
      await getFinalBalanceText(  
        threadID,  
        userID  
      );  
  
    const finalText = [  
      gameHeader(  
        "coinflip"  
      ),  
      "",  
      won  
        ? "🏆 THE CALL WAS CORRECT"  
        : "❌ THE CALL FAILED",  
      "",  
      `Your call  •  ${choice.toUpperCase()}`,  
      `Result     •  ${result.toUpperCase()}`,  
      `Wager      •  ${formatNumber(bet)} coins`,  
      "",  
      won  
        ? `💰 Payout: +${formatNumber(payout)} coins`  
        : `💸 Lost wager: -${formatNumber(bet)} coins`,  
      "",  
      balanceText,  
    ].join("\n");  
  
    await updateGameMessage(  
      api,  
      threadID,  
      animator.messageID,  
      finalText  
    );  
  } catch (error) {  
    console.error(  
      "[games] coinflip:",  
      error  
    );  
  
    if (  
      betCharged &&  
      !settled  
    ) {  
      const argsArray =  
        normalizeArgs(args);  
  
      const numericArg =  
        argsArray.find(  
          (value) =>  
            /^\d[\d,]*$/.test(  
              value  
            )  
        );  
  
      const bet =  
        parseBet(  
          numericArg  
        );  
  
      if (validBet(bet)) {  
        await db  
          .addBalance(  
            threadID,  
            userID,  
            bet  
          )  
          .catch(() => {});  
      }  
    }  
  
    await safeReply(  
      api,  
      event,  
      "🌑 Fate could not complete the coin toss."  
    );  
  } finally {  
    unlockGame(  
      threadID,  
      userID  
    );  
  }  
}  
  
// ============================================================  
// BLACKJACK  
// ============================================================  
  
const CARD_VALUES = {  
  "2": 2,  
  "3": 3,  
  "4": 4,  
  "5": 5,  
  "6": 6,  
  "7": 7,  
  "8": 8,  
  "9": 9,  
  "10": 10,  
  J: 10,  
  Q: 10,  
  K: 10,  
  A: 11,  
};  
  
const SUITS = [  
  "♠️",  
  "♥️",  
  "♦️",  
  "♣️",  
];  
  
function createDeck() {  
  const deck = [];  
  
  for (  
    const suit of SUITS  
  ) {  
    for (  
      const value of Object.keys(  
        CARD_VALUES  
      )  
    ) {  
      deck.push(  
        `${value}${suit}`  
      );  
    }  
  }  
  
  return deck;  
}  
  
function drawCard(deck) {  
  if (  
    deck.length === 0  
  ) {  
    deck.push(  
      ...createDeck()  
    );  
  }  
  
  const idx =  
    Math.floor(  
      Math.random() *  
        deck.length  
    );  
  
  const card =  
    deck[idx];  
  
  deck.splice(  
    idx,  
    1  
  );  
  
  return card;  
}  
  
function getCardValue(card) {  
  const value =  
    String(card)  
      .replace(  
        /[♠️♥️♦️♣️]+$/u,  
        ""  
      );  
  
  return (  
    CARD_VALUES[value] ||  
    0  
  );  
}  
  
function calcHandValue(hand) {  
  let value =  
    hand.reduce(  
      (sum, card) =>  
        sum +  
        getCardValue(card),  
      0  
    );  
  
  let aces =  
    hand.filter(  
      (card) =>  
        String(card).startsWith(  
          "A"  
        )  
    ).length;  
  
  while (  
    value > 21 &&  
    aces > 0  
  ) {  
    value -= 10;  
    aces--;  
  }  
  
  return value;  
}  
  
async function handleBlackjack(  
  api,  
  event  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  if (  
    !lockGame(  
      threadID,  
      userID  
    )  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil is already occupied.\n\nFinish your current challenge first."  
    );  
  
    return;  
  }  
  
  try {  
    const deck =  
      createDeck();  
  
    const playerHand = [  
      drawCard(deck),  
      drawCard(deck),  
    ];  
  
    const botHand = [  
      drawCard(deck),  
      drawCard(deck),  
    ];  
  
    const playerValue =  
      calcHandValue(  
        playerHand  
      );  
  
    const animator =  
      await createAnimator(  
        api,  
        threadID,  
        [  
          gameHeader(  
            "blackjack",  
            playerLine(event)  
          ),  
          "",  
          "THE TABLE IS OPEN",  
          "",  
          `**♙** YOU     ${playerHand.join("  ")}`,  
          `          Total: ${playerValue}`,  
          "",  
          `♟ DEALER  ${botHand[0]}  **▣**`,  
          "          Total: ?",  
          "",  
          thinDivider(),  
          "",  
          "**↳** !hit   Draw another card",  
          "**↳** !stand Hold your hand",  
        ].join("\n"),  
        "blackjack"  
      );  
  
    setSession(  
      threadID,  
      userID,  
      {  
        type: "blackjack",  
        playerHand,  
        botHand,  
        deck,  
        messageID:  
          animator.messageID,  
      }  
    );  
  } catch (error) {  
    unlockGame(  
      threadID,  
      userID  
    );  
  
    console.error(  
      "[games] blackjack:",  
      error  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The blackjack table could not open."  
    );  
  }  
}  
  
async function resolveBlackjack(  
  api,  
  event,  
  action  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  const session =  
    getSession(  
      threadID,  
      userID  
    );  
  
  if (  
    !session ||  
    session.type !==  
      "blackjack"  
  ) {  
    return false;  
  }  
  
  const cmd =  
    String(action)  
      .trim()  
      .toLowerCase()  
      .replace(  
        /^!/,  
        ""  
      );  
  
  if (  
    cmd !== "hit" &&  
    cmd !== "stand"  
  ) {  
    await safeReply(  
      api,  
      event,  
      "♠️ Use !hit or !stand."  
    );  
  
    return true;  
  }  
  
  try {  
    if (cmd === "hit") {  
      const card =  
        drawCard(  
          session.deck  
        );  
  
      session.playerHand.push(  
        card  
      );  
  
      const playerValue =  
        calcHandValue(  
          session.playerHand  
        );  
  
      if (  
        playerValue > 21  
      ) {  
        clearSession(  
          threadID,  
          userID  
        );  
  
        try {  
          const reward =  
            await awardPlayer(  
              threadID,  
              userID,  
              "blackjack",  
              false  
            );  
  
          const balanceText =  
            await getFinalBalanceText(  
              threadID,  
              userID  
            );  
  
          const finalText = [  
            gameHeader(  
              "blackjack"  
            ),  
            "",  
            "❌ BUST",  
            "",  
            `**♙** ${session.playerHand.join("  ")}`,  
            `Total: ${playerValue}`,  
            "",  
            "The hand crossed 21.",  
            "",  
            rewardLine(  
              reward,  
              balanceText,  
              false  
            ),  
          ].join("\n");  
  
          await updateGameMessage(  
            api,  
            threadID,  
            session.messageID,  
            finalText  
          );  
        } finally {  
          unlockGame(  
            threadID,  
            userID  
          );  
        }  
  
        return true;  
      }  
  
      setSession(  
        threadID,  
        userID,  
        session  
      );  
  
      const text = [  
        gameHeader(  
          "blackjack"  
        ),  
        "",  
        `**♙** YOU     ${session.playerHand.join("  ")}`,  
        `          Total: ${playerValue}`,  
        "",  
        `♟ DEALER  ${session.botHand[0]}  **▣**`,  
        "          Total: ?",  
        "",  
        thinDivider(),  
        "",  
        "**↳** !hit   Draw another card",  
        "**↳** !stand Hold your hand",  
      ].join("\n");  
  
      await updateGameMessage(  
        api,  
        threadID,  
        session.messageID,  
        text  
      );  
  
      return true;  
    }  
  
    clearSession(  
      threadID,  
      userID  
    );  
  
    let botValue =  
      calcHandValue(  
        session.botHand  
      );  
  
    while (  
      botValue < 17  
    ) {  
      session.botHand.push(  
        drawCard(  
          session.deck  
        )  
      );  
  
      botValue =  
        calcHandValue(  
          session.botHand  
        );  
    }  
  
    const playerValue =  
      calcHandValue(  
        session.playerHand  
      );  
  
    let result = "loss";  
    let resultText =  
      "The dealer wins.";  
  
    if (  
      botValue > 21  
    ) {  
      result = "win";  
      resultText =  
        "The dealer busted. You win!";  
    } else if (  
      playerValue > botValue  
    ) {  
      result = "win";  
      resultText =  
        "Your hand prevails.";  
    } else if (  
      playerValue ===  
      botValue  
    ) {  
      result = "draw";  
      resultText =  
        "Push — neither hand prevails.";  
    }  
  
    try {  
      const reward =  
        await awardPlayer(  
          threadID,  
          userID,  
          "blackjack",  
          result === "win"  
        );  
  
      const balanceText =  
        await getFinalBalanceText(  
          threadID,  
          userID  
        );  
  
      const finalText = [  
        gameHeader(  
          "blackjack"  
        ),  
        "",  
        result === "win"  
          ? "🏆 YOU WIN"  
          : result === "draw"  
            ? "🤝 PUSH"  
            : "❌ DEALER WINS",  
        "",  
        `**♙** YOU     ${session.playerHand.join("  ")}`,  
        `          Total: ${playerValue}`,  
        "",  
        `♟ DEALER  ${session.botHand.join("  ")}`,  
        `          Total: ${botValue}`,  
        "",  
        resultText,  
        "",  
        rewardLine(  
          reward,  
          balanceText,  
          result === "win"  
        ),  
      ].join("\n");  
  
      await updateGameMessage(  
        api,  
        threadID,  
        session.messageID,  
        finalText  
      );  
    } finally {  
      unlockGame(  
        threadID,  
        userID  
      );  
    }  
  
    return true;  
  } catch (error) {  
    console.error(  
      "[games] blackjack resolve:",  
      error  
    );  
  
    clearSession(  
      threadID,  
      userID  
    );  
  
    unlockGame(  
      threadID,  
      userID  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The blackjack hand ended unexpectedly."  
    );  
  
    return true;  
  }  
}  
  
// ============================================================  
// SLOTS  
// ============================================================  
  
const SLOT_SYMBOLS = [  
  "🍒",  
  "🍋",  
  "🍊",  
  "🍉",  
  "⭐",  
  "💎",  
];  
  
function slotMultiplier(  
  reels  
) {  
  const [a, b, c] = reels;  
  
  if (  
    a === b &&  
    b === c  
  ) {  
    if (a === "💎") {  
      return 20;  
    }  
  
    if (a === "⭐") {  
      return 15;  
    }  
  
    return 10;  
  }  
  
  if (  
    a === b ||  
    b === c ||  
    a === c  
  ) {  
    return 2;  
  }  
  
  return 0;  
}  
  
async function handleSlots(  
  api,  
  event,  
  args  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  if (  
    !lockGame(  
      threadID,  
      userID  
    )  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil is already occupied.\n\nFinish your current challenge first."  
    );  
  
    return;  
  }  
  
  let betCharged = false;  
  let settled = false;  
  
  try {  
    const bet =  
      parseBet(args?.[0]);  
  
    if (  
      !validBet(bet)  
    ) {  
      unlockGame(  
        threadID,  
        userID  
      );  
  
      await safeReply(  
        api,  
        event,  
        `🎰 Invalid wager.\n\nMinimum: 1\nMaximum: ${formatNumber(MAX_BET)} coins`  
      );  
  
      return;  
    }  
  
    const animator =  
      await createAnimator(  
        api,  
        threadID,  
        [  
          gameHeader(  
            "slots",  
            playerLine(event)  
          ),  
          "",  
          "THE REELS AWAKEN",  
          "",  
          "│     🍒   │   🍋   │   ⭐     │",  
          "",  
          `💰 Wager: ${formatNumber(bet)} coins`,  
          "",  
          "             SPINNING",  
        ].join("\n"),  
        "slots"  
      );  
  
    try {  
      await db.spendBalance(  
        threadID,  
        userID,  
        bet,  
        `Slots bet: ${bet}`  
      );  
  
      betCharged = true;  
    } catch (error) {  
      await updateGameMessage(  
        api,  
        threadID,  
        animator.messageID,  
        [  
          gameHeader(  
            "slots"  
          ),  
          "",  
          "🌑 WAGER REJECTED",  
          "",  
          error.message ||  
            "Not enough wallet coins.",  
        ].join("\n")  
      );  
  
      return;  
    }  
  
    const randomReels =  
      () => [  
        SLOT_SYMBOLS[  
          randInt(  
            0,  
            SLOT_SYMBOLS.length - 1  
          )  
        ],  
        SLOT_SYMBOLS[  
          randInt(  
            0,  
            SLOT_SYMBOLS.length - 1  
          )  
        ],  
        SLOT_SYMBOLS[  
          randInt(  
            0,  
            SLOT_SYMBOLS.length - 1  
          )  
        ],  
      ];  
  
    const reelText =  
      (reels) =>  
        `│     ${reels.join(  
          "   │   "  
        )}     │`;  
  
    await sleep(700);  
  
    for (  
      let i = 0;  
      i < 2;  
      i++  
    ) {  
      const rolling =  
        randomReels();  
  
      await updateGameMessage(  
        api,  
        threadID,  
        animator.messageID,  
        [  
          gameHeader(  
            "slots"  
          ),  
          "",  
          thinDivider(),  
          "",  
          reelText(  
            rolling  
          ),  
          "",  
          "             SPINNING...",  
        ].join("\n")  
      );  
  
      await sleep(  
        editDelay()  
      );  
    }  
  
    const reels =  
      randomReels();  
  
    const multiplier =  
      slotMultiplier(  
        reels  
      );  
  
    const won =  
      multiplier > 0;  
  
    const payout =  
      won  
        ? bet * multiplier  
        : 0;  
  
    if (payout > 0) {  
      await db.addBalance(  
        threadID,  
        userID,  
        payout  
      );  
    }  
  
    settled = true;  
  
    const net =  
      payout - bet;  
  
    const balanceText =  
      await getFinalBalanceText(  
        threadID,  
        userID  
      );  
  
    const finalText = [  
      gameHeader("slots"),  
      "",  
      thinDivider(),  
      "",  
      reelText(reels),  
      "",  
      won  
        ? `🏆 ${multiplier}× MATCH`  
        : "❌ NO MATCH",  
      "",  
      won  
        ? `💰 Payout: +${formatNumber(payout)} coins`  
        : `💸 Lost wager: -${formatNumber(bet)} coins`,  
      won  
        ? `📈 Net profit: +${formatNumber(net)} coins`  
        : "",  
      "",  
      balanceText,  
    ].filter(Boolean).join("\n");  
  
    await updateGameMessage(  
      api,  
      threadID,  
      animator.messageID,  
      finalText  
    );  
  } catch (error) {  
    console.error(  
      "[games] slots:",  
      error  
    );  
  
    if (  
      betCharged &&  
      !settled  
    ) {  
      const bet =  
        parseBet(args?.[0]);  
  
      if (validBet(bet)) {  
        await db  
          .addBalance(  
            threadID,  
            userID,  
            bet  
          )  
          .catch(() => {});  
      }  
    }  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The reels could not complete their judgment."  
    );  
  } finally {  
    unlockGame(  
      threadID,  
      userID  
    );  
  }  
}  
  
// ============================================================  
// MATH  
// ============================================================  
  
async function handleMath(  
  api,  
  event  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  if (  
    !lockGame(  
      threadID,  
      userID  
    )  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil is already occupied.\n\nFinish your current challenge first."  
    );  
  
    return;  
  }  
  
  try {  
    const a =  
      randInt(1, 100);  
  
    const b =  
      randInt(1, 100);  
  
    const ops = [  
      "+",  
      "-",  
      "*",  
    ];  
  
    const op =  
      ops[  
        randInt(0, 2)  
      ];  
  
    let correctAnswer;  
  
    if (  
      op === "+"  
    ) {  
      correctAnswer =  
        a + b;  
    } else if (  
      op === "-"  
    ) {  
      correctAnswer =  
        a - b;  
    } else {  
      correctAnswer =  
        a * b;  
    }  
  
    const animator =  
      await createAnimator(  
        api,  
        threadID,  
        [  
          gameHeader(  
            "math",  
            playerLine(event)  
          ),  
          "",  
          "PRECISION REQUIRED",  
          "",  
          "🧮 Solve:",  
          "",  
          `        ${a} ${op} ${b}`,  
          "",  
          thinDivider(),  
          "",  
          "**↳** Reply with your answer.",  
        ].join("\n"),  
        "math"  
      );  
  
    setSession(  
      threadID,  
      userID,  
      {  
        type: "math",  
        correctAnswer,  
        messageID:  
          animator.messageID,  
      }  
    );  
  } catch (error) {  
    unlockGame(  
      threadID,  
      userID  
    );  
  
    console.error(  
      "[games] math:",  
      error  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil could not generate an equation."  
    );  
  }  
}  
  
async function resolveMath(  
  api,  
  event,  
  answerText  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  const session =  
    getSession(  
      threadID,  
      userID  
    );  
  
  if (  
    !session ||  
    session.type !== "math"  
  ) {  
    return false;  
  }  
  
  clearSession(  
    threadID,  
    userID  
  );  
  
  const userAnswer =  
    parseNumericAnswer(  
      answerText  
    );  
  
  const correct =  
    !Number.isNaN(  
      userAnswer  
    ) &&  
    userAnswer ===  
      session.correctAnswer;  
  
  try {  
    const reward =  
      await awardPlayer(  
        threadID,  
        userID,  
        "math",  
        correct  
      );  
  
    const balanceText =  
      await getFinalBalanceText(  
        threadID,  
        userID  
      );  
  
    const finalText = [  
      gameHeader("math"),  
      "",  
      correct  
        ? "🏆 CALCULATION COMPLETE"  
        : "❌ CALCULATION FAILED",  
      "",  
      `Your answer: ${Number.isNaN(userAnswer) ? "Invalid" : userAnswer}`,  
      `Correct: ${session.correctAnswer}`,  
      "",  
      correct  
        ? "✦ Precision wins."  
        : "✦ The equation wins this round.",  
      "",  
      rewardLine(  
        reward,  
        balanceText,  
        correct  
      ),  
    ].join("\n");  
  
    await updateGameMessage(  
      api,  
      threadID,  
      session.messageID,  
      finalText  
    );  
  } catch (error) {  
    console.error(  
      "[games] math reward:",  
      error  
    );  
  }  
  
  unlockGame(  
    threadID,  
    userID  
  );  
  
  return true;  
}  
  
// ============================================================  
// RIDDLES  
// ============================================================  
  
async function handleRiddle(  
  api,  
  event  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  if (  
    !lockGame(  
      threadID,  
      userID  
    )  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil is already occupied.\n\nFinish your current challenge first."  
    );  
  
    return;  
  }  
  
  try {  
    const riddle =  
      await riddleManager.getNextRiddle({  
        threadID,  
      });  
  
    if (!riddle) {  
      unlockGame(  
        threadID,  
        userID  
      );  
  
      await safeReply(  
        api,  
        event,  
        "🌑 The Veil has no riddles available."  
      );  
  
      return;  
    }  
  
    const animator =  
      await createAnimator(  
        api,  
        threadID,  
        [  
          gameHeader(  
            "riddle",  
            playerLine(event)  
          ),  
          "",  
          "THE VEIL SPEAKS IN QUESTIONS",  
          "",  
          `❝ ${riddle.question} ❞`,  
          "",  
          "🧠 Think carefully.",  
          "",  
          thinDivider(),  
          "",  
          "**↳** Reply with your answer.",  
        ].join("\n"),  
        "riddle"  
      );  
  
    setSession(  
      threadID,  
      userID,  
      {  
        type: "riddle",  
        question:  
          riddle.question,  
        answers:  
          riddle.answers,  
        messageID:  
          animator.messageID,  
      }  
    );  
  } catch (error) {  
    unlockGame(  
      threadID,  
      userID  
    );  
  
    console.error(  
      "[games] riddle:",  
      error  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil could not reveal a riddle."  
    );  
  }  
}  
  
async function resolveRiddle(  
  api,  
  event,  
  answerText  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  const session =  
    getSession(  
      threadID,  
      userID  
    );  
  
  if (  
    !session ||  
    session.type !== "riddle"  
  ) {  
    return false;  
  }  
  
  clearSession(  
    threadID,  
    userID  
  );  
  
  const normalized =  
    normalizeAnswerText(  
      answerText  
    );  
  
  const correct =  
    session.answers.some(  
      (answer) =>  
        normalizeAnswerText(  
          answer  
        ) === normalized  
    );  
  
  try {  
    const reward =  
      await awardPlayer(  
        threadID,  
        userID,  
        "riddle",  
        correct  
      );  
  
    const balanceText =  
      await getFinalBalanceText(  
        threadID,  
        userID  
      );  
  
    const finalText = [  
      gameHeader("riddle"),  
      "",  
      correct  
        ? "🏆 MYSTERY SOLVED"  
        : "❌ THE VEIL ENDURES",  
      "",  
      `Your answer: ${answerText}`,  
      `Correct: ${session.answers[0]}`,  
      "",  
      correct  
        ? "✦ Your mind pierced the mystery."  
        : "✦ The riddle remains undefeated.",  
      "",  
      rewardLine(  
        reward,  
        balanceText,  
        correct  
      ),  
    ].join("\n");  
  
    await updateGameMessage(  
      api,  
      threadID,  
      session.messageID,  
      finalText  
    );  
  } catch (error) {  
    console.error(  
      "[games] riddle reward:",  
      error  
    );  
  }  
  
  unlockGame(  
    threadID,  
    userID  
  );  
  
  return true;  
}  
  
// ============================================================  
// 8-BALL  
// ============================================================  
  
const EIGHTBALL_RESPONSES = [  
  "It is certain",  
  "It is decidedly so",  
  "Without a doubt",  
  "Yes definitely",  
  "You may rely on it",  
  "As I see it, yes",  
  "Most likely",  
  "Outlook good",  
  "Yes",  
  "Signs point to yes",  
  "Reply hazy, try again",  
  "Ask again later",  
  "Better not tell you now",  
  "Cannot predict now",  
  "Concentrate and ask again",  
  "Don't count on it",  
  "My reply is no",  
  "My sources say no",  
  "Outlook not so good",  
  "Very doubtful",  
];  
  
async function handleEightBall(  
  api,  
  event,  
  args  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  if (  
    !lockGame(  
      threadID,  
      userID  
    )  
  ) {  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil is already occupied.\n\nFinish your current challenge first."  
    );  
  
    return;  
  }  
  
  try {  
    const question =  
      Array.isArray(args)  
        ? args.join(" ")  
        : String(args || "");  
  
    if (  
      !question.trim()  
    ) {  
      unlockGame(  
        threadID,  
        userID  
      );  
  
      await safeReply(  
        api,  
        event,  
        "🔮 Ask the Oracle a question."  
      );  
  
      return;  
    }  
  
    const animator =  
      await createAnimator(  
        api,  
        threadID,  
        [  
          gameHeader(  
            "8ball",  
            playerLine(event)  
          ),  
          "",  
          "THE ORACLE LISTENS",  
          "",  
          `❝ ${question} ❞`,  
          "",  
          "🔮 Consulting the Veil...",  
          "",  
          "             **◉**",  
        ].join("\n"),  
        "8ball"  
      );  
  
    await sleep(  
      editDelay()  
    );  
  
    const response =  
      EIGHTBALL_RESPONSES[  
        randInt(  
          0,  
          EIGHTBALL_RESPONSES.length - 1  
        )  
      ];  
  
    const reward =  
      await awardPlayer(  
        threadID,  
        userID,  
        "8ball",  
        true  
      );  
  
    const balanceText =  
      await getFinalBalanceText(  
        threadID,  
        userID  
      );  
  
    const finalText = [  
      gameHeader("8ball"),  
      "",  
      "🔮 THE ORACLE ANSWERS",  
      "",  
      `❝ ${question} ❞`,  
      "",  
      `        ✦`,  
      "",  
      `"${response}"`,  
      "",  
      thinDivider(),  
      "",  
      `💰 +${formatNumber(reward.coins)} coins`,  
      `⭐ +${formatNumber(reward.xp)} XP`,  
      "",  
      balanceText,  
    ].join("\n");  
  
    await updateGameMessage(  
      api,  
      threadID,  
      animator.messageID,  
      finalText  
    );  
  } catch (error) {  
    console.error(  
      "[games] 8ball:",  
      error  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The Oracle could not answer."  
    );  
  } finally {  
    unlockGame(  
      threadID,  
      userID  
    );  
  }  
}  
  
// ============================================================  
// GAME STATUS  
// ============================================================  
  
async function handleGameStatus(  
  api,  
  event  
) {  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  try {  
    const user =  
      await db.getUser(  
        threadID,  
        userID  
      );  
  
    const balance =  
      formatNumber(  
        user?.balance ?? 0  
      );  
  
    const xp =  
      formatNumber(  
        user?.xp ?? 0  
      );  
  
    const active =  
      activeGames.has(  
        sessionKey(  
          threadID,  
          userID  
        )  
      );  
  
    const session =  
      getSession(  
        threadID,  
        userID  
      );  
  
    const sessionName =  
      session?.type  
        ? String(  
            session.type  
          ).toUpperCase()  
        : "NONE";  
  
    await sendMessageAsync(  
      api,  
      threadID,  
      [  
        gameHeader(  
          "8ball",  
          playerLine(event)  
        ),  
        "",  
        "YOUR VEIL STATUS",  
        "",  
        `💰 Wallet      ${balance}`,  
        `⭐ XP          ${xp}`,  
        "",  
        `🎮 Active      ${active ? "YES" : "NO"}`,  
        `🌑 Session     ${sessionName}`,  
        "",  
        thinDivider(),  
        "",  
        active  
          ? "✦ A challenge is currently active."  
          : "✦ No active challenge.",  
        "",  
        "The Veil remembers every result.",  
      ].join("\n")  
    );  
  
    return true;  
  } catch (error) {  
    console.error(  
      "[games] status:",  
      error  
    );  
  
    await safeReply(  
      api,  
      event,  
      "🌑 The Veil could not retrieve your status."  
    );  
  
    return true;  
  }  
}  
  
// ============================================================  
// GAME RULES  
// ============================================================  
  
async function handleGameRules(  
  api,  
  event  
) {  
  const threadID =  
    String(event.threadID);  
  
  await sendMessageAsync(  
    api,  
    threadID,  
    [  
      "**╭────────────────────────────╮**",  
      "          🌑 THE VEIL",  
      "           RULEBOOK",  
      "**╰────────────────────────────╯**",  
      "",  
      "       RISK • SKILL • FATE",  
      "",  
      "**╭──────** 🧠 CHALLENGES **──────╮**",  
      "",  
      "🧠 TRIVIA",  
      "• Four choices appear.",  
      "• Answer with A, B, C or D.",  
      "• Correct: +50 XP and +150 coins.",  
      "• Wrong: -25 XP.",  
      "",  
      "🧩 RIDDLE",  
      "• Solve the generated riddle.",  
      "• Correct: +50 XP and +150 coins.",  
      "• Wrong: -25 XP.",  
      "• Used riddles are tracked by the manager.",  
      "",  
      "🧮 MATH",  
      "• Solve the generated equation.",  
      "• Correct: +50 XP and +175 coins.",  
      "• Wrong: -25 XP.",  
      "",  
      "**╰────────────────────────────╯**",  
      "",  
      "**╭──────** 🎲 FORTUNE **─────────╮**",  
      "",  
      "🎲 ROLL",  
      "!roll <bet> [sides]",  
      "• Default die: 1–100.",  
      "• Custom die: 2–1000.",  
      "• High threshold is 55% of the die.",  
      "• Win = 2× wager.",  
      "",  
      "🪙 COINFLIP",  
      "!coinflip <bet> <heads|tails>",  
      "• Correct prediction = 2× wager.",  
      "• Wrong prediction loses the wager.",  
      "",  
      "🎰 SLOTS",  
      "!slots <bet>",  
      "• Any pair = 2×.",  
      "• Any normal triple = 10×.",  
      "• ⭐⭐⭐ = 15×.",  
      "• 💎💎💎 = 20×.",  
      "",  
      "**╰────────────────────────────╯**",  
      "",  
      "**╭──────** 🎯 CHALLENGES **──────╮**",  
      "",  
      "🎯 GUESS",  
      "!guess <min> <max>",  
      "• Find the hidden number.",  
      "• You receive 3 attempts.",  
      "• Correct = +50 XP and +150 coins.",  
      "• Wrong final result = -25 XP.",  
      "",  
      "⚔️ RPS",  
      "!rps <rock|paper|scissors>",  
      "• Rock beats Scissors.",  
      "• Scissors beats Paper.",  
      "• Paper beats Rock.",  
      "• Win = +40 XP and +100 coins.",  
      "• Draw = no coin reward.",  
      "",  
      "**╰────────────────────────────╯**",  
      "",  
      "**╭──────** ♠️ TABLE **───────────╮**",  
      "",  
      "♠️ BLACKJACK",  
      "!blackjack",  
      "",  
      "Actions:",  
      "!hit",  
      "!stand",  
      "",  
      "• Dealer draws until reaching 17.",  
      "• Higher hand wins.",  
      "• Dealer bust = player win.",  
      "• Equal totals = push.",  
      "• Win = +60 XP and +175 coins.",  
      "• Loss = -30 XP.",  
      "",  
      "**╰────────────────────────────╯**",  
      "",  
      "**╭──────** 🔮 UNKNOWN **─────────╮**",  
      "",  
      "🔮 8-BALL",  
      "!8ball <question>",  
      "• Ask the Oracle.",  
      "• No wager required.",  
      "• +10 XP and +25 coins.",  
      "",  
      "**╰────────────────────────────╯**",  
      "",  
      "**╭──────** 💰 LIMITS **──────────╮**",  
      "",  
      `Maximum wager: ${formatNumber(MAX_BET)} coins`,  
      "",  
      "Wagers are charged before resolution.",  
      "Unexpected failures are refunded",  
      "when the wager has already been charged.",  
      "",  
      "**╰────────────────────────────╯**",  
      "",  
      "        🌑 THE VEIL",  
      "",  
      "     Enter for fortune.",  
      "     Leave with what fate allows.",  
      "",  
      "**━━━━━━━━━━━━━━━━━━━━━━━━━━━━**",  
      "↩ !games • Return to the Game Center",  
      "**━━━━━━━━━━━━━━━━━━━━━━━━━━━━**",  
    ].join("\n")  
  );  
  
  return true;  
}  
  
// ============================================================  
// GAME CENTER  
// ============================================================  
  
async function handleGameCenter(  
  api,  
  event  
) {  
  const threadID =  
    String(event.threadID);  
  
  await sendMessageAsync(  
    api,  
    threadID,  
    [  
      "**╭────────────────────────────╮**",  
      "          🌑 THE VEIL",  
      "**╰────────────────────────────╯**",  
      "",  
      "      FATE • SKILL • FORTUNE",  
      "",  
      "**╭──────** 🧠 CHALLENGE **───────╮**",  
      "",  
      "🧠 TRIVIA",  
      "   Test your knowledge",  
      "   !trivia",  
      "",  
      "🧩 RIDDLE",  
      "   Outsmart the unknown",  
      "   !riddle",  
      "",  
      "🧮 MATH",  
      "   Precision under pressure",  
      "   !math",  
      "",  
      "**╰────────────────────────────╯**",  
      "",  
      "**╭──────** 🎲 FORTUNE **─────────╮**",  
      "",  
      "🎲 ROLL",  
      "   !roll <bet> [sides]",  
      "",  
      "🪙 COINFLIP",  
      "   !coinflip <bet> <heads|tails>",  
      "",  
      "🎯 GUESS",  
      "   !guess <min> <max>",  
      "",  
      "🎰 SLOTS",  
      "   !slots <bet>",  
      "",  
      "**╰────────────────────────────╯**",  
      "",  
      "**╭──────** ⚔️ TABLE **───────────╮**",  
      "",  
      "⚔️ RPS",  
      "   !rps <rock|paper|scissors>",  
      "",  
      "♠️ BLACKJACK",  
      "   !blackjack",  
      "   !hit • !stand",  
      "",  
      "🔮 8-BALL",  
      "   !8ball <question>",  
      "",  
      "**╰────────────────────────────╯**",  
      "",  
      "🌑 !games rules",  
      "   View the complete rulebook.",  
      "",  
      "🌑 !games status",  
      "   View your Veil status.",  
      "",  
      "        ✦ FATE HAS NO FAVORITES ✦",  
    ].join("\n")  
  );  
  
  return true;  
}  
  
// ============================================================  
// REPLY HELPER  
// ============================================================  
  
async function safeReply(  
  api,  
  event,  
  text  
) {  
  try {  
    const threadID =  
      String(event.threadID);  
  
    const messageID =  
      event.messageID;  
  
    if (  
      messageID &&  
      api.setMessageReaction  
    ) {  
      await new Promise(  
        (resolve) => {  
          api.setMessageReaction(  
            "❌",  
            messageID,  
            () => resolve(),  
            true  
          );  
        }  
      );  
    }  
  
    await sendMessageAsync(  
      api,  
      threadID,  
      text  
    );  
  } catch (error) {  
    console.error(  
      "[games] safeReply:",  
      error  
    );  
  }  
}  
  
// ============================================================  
// MAIN GAME COMMAND DISPATCHER  
// ============================================================  
  
async function handleGameCommand(  
  api,  
  event,  
  command,  
  args  
) {  
  const cmd =  
    String(command || "")  
      .trim()  
      .toLowerCase();  
  
  const normalizedArgs =  
    normalizeArgs(args);  
  
  // ----------------------------------------------------------  
  // GAME CENTER SUBCOMMANDS  
  // ----------------------------------------------------------  
  
  if (  
    cmd === "games"  
  ) {  
    const subcommand =  
      String(  
        normalizedArgs[0] || ""  
      )  
        .trim()  
        .toLowerCase();  
  
    if (  
      subcommand === "rules"  
    ) {  
      await handleGameRules(  
        api,  
        event  
      );  
  
      return true;  
    }  
  
    if (  
      subcommand === "status"  
    ) {  
      await handleGameStatus(  
        api,  
        event  
      );  
  
      return true;  
    }  
  
    await handleGameCenter(  
      api,  
      event  
    );  
  
    return true;  
  }  
  
  // ----------------------------------------------------------  
  // DAILY / WORK  
  // ----------------------------------------------------------  
  
  if (  
    cmd === "daily"  
  ) {  
    await handleDaily(  
      api,  
      event  
    );  
  
    return true;  
  }  
  
  if (  
    cmd === "work"  
  ) {  
    await handleWork(  
      api,  
      event  
    );  
  
    return true;  
  }  
  
  // ----------------------------------------------------------  
  // GAMES  
  // ----------------------------------------------------------  
  
  if (  
    cmd === "trivia"  
  ) {  
    await handleTrivia(  
      api,  
      event  
    );  
  } else if (  
    cmd === "rps"  
  ) {  
    await handleRPS(  
      api,  
      event,  
      normalizedArgs  
    );  
  } else if (  
    cmd === "roll"  
  ) {  
    await handleRoll(  
      api,  
      event,  
      normalizedArgs  
    );  
  } else if (  
    cmd === "guess"  
  ) {  
    await handleGuess(  
      api,  
      event,  
      normalizedArgs  
    );  
  } else if (  
    cmd === "coinflip" ||  
    cmd === "flip"  
  ) {  
    await handleCoinFlip(  
      api,  
      event,  
      normalizedArgs  
    );  
  } else if (  
    cmd === "blackjack" ||  
    cmd === "bj"  
  ) {  
    await handleBlackjack(  
      api,  
      event  
    );  
  } else if (  
    cmd === "slots" ||  
    cmd === "slot"  
  ) {  
    await handleSlots(  
      api,  
      event,  
      normalizedArgs  
    );  
  } else if (  
    cmd === "math"  
  ) {  
    await handleMath(  
      api,  
      event  
    );  
  } else if (  
    cmd === "riddle"  
  ) {  
    await handleRiddle(  
      api,  
      event  
    );  
  } else if (  
    cmd === "8ball" ||  
    cmd === "8-ball"  
  ) {  
    await handleEightBall(  
      api,  
      event,  
      normalizedArgs  
    );  
  } else {  
    await safeReply(  
      api,  
      event,  
      `🌑 UNKNOWN PATH\n\n"${cmd}" is not part of The Veil.\n\nUse !games to view the available games.`  
    );  
  
    return false;  
  }  
  
  return true;  
}  
  
// ============================================================  
// GAME RESPONSE DISPATCHER  
// ============================================================  
  
async function handleGameResponse(  
  api,  
  event,  
  responseText,  
  originalText  
) {  
  const answerText =  
    String(  
      originalText ||  
        responseText ||  
        ""  
    ).trim();  
  
  const threadID =  
    String(event.threadID);  
  
  const userID =  
    String(event.senderID);  
  
  const session =  
    getSession(  
      threadID,  
      userID  
    );  
  
  if (!session) {  
    return false;  
  }  
  
  if (  
    session.type === "trivia"  
  ) {  
    return resolveTrivia(  
      api,  
      event,  
      answerText  
    );  
  }  
  
  if (  
    session.type === "riddle"  
  ) {  
    return resolveRiddle(  
      api,  
      event,  
      answerText  
    );  
  }  
  
  if (  
    session.type === "guess"  
  ) {  
    return resolveGuess(  
      api,  
      event,  
      answerText  
    );  
  }  
  
  if (  
    session.type === "blackjack"  
  ) {  
    return resolveBlackjack(  
      api,  
      event,  
      answerText  
    );  
  }  
  
  if (  
    session.type === "math"  
  ) {  
    return resolveMath(  
      api,  
      event,  
      answerText  
    );  
  }  
  
  return false;  
}  
  
// ============================================================  
// EXPORTS  
// ============================================================  
  
module.exports = {  
  handleGameCommand,  
  
  handleGamesCommand:  
    handleGameCommand,  
  
  handleGameResponse,  
  
  handleDaily,  
  handleWork,  
  handleTrivia,  
  handleRPS,  
  handleRoll,  
  handleGuess,  
  handleCoinFlip,  
  handleBlackjack,  
  handleSlots,  
  handleMath,  
  handleRiddle,  
  handleEightBall,  
  
  handleGameCenter,  
  handleGameRules,  
  handleGameStatus,  
  
  lockGame,  
  unlockGame,  
};  
