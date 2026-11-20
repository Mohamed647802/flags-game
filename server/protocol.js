// server/protocol.js — strict validation of client WebSocket messages.
// validateClientMessage(raw) never throws: it always returns
// { ok: true, msg } or { ok: false, code, message } with a friendly Arabic message.
export const MAX_MESSAGE_BYTES = 4096;

const MESSAGE_TYPES = new Set([
  'hello', 'resume', 'ping', 'create_room', 'join_room', 'leave',
  'set_settings', 'set_team', 'kick', 'transfer_host', 'start', 'ready',
  'answer', 'submit_text_answer', 'host_judge', 'judge_answers',
  'skip_vote', 'pause', 'resume_game', 'skip_flag',
  'rematch', 'replay_missed', 'react',
]);

const REACT_EMOJIS = new Set(['👏', '😂', '😱', '🔥', '🤯', '👍']);

const MODES = new Set([
  // Client vocabulary (index.html selects) + engine modes.
  'classic', 'buzzer', 'turns',
  'race', 'fixed', 'sudden', 'teams', 'survival', 'daily', 'kids', 'solo',
]);
const ANSWER_MODES = new Set(['choice', 'typing', 'mixed', 'write_then_judge']);
const ANSWER_TYPES = new Set(['country', 'capital', 'continent', 'mixed', 'choice']);
const SCORINGS = new Set(['classic', 'streak', 'fixed', 'simple', 'speed']);
const QUESTION_TYPE_TOKENS = new Set([
  'flagToCountry', 'countryToFlag', 'capital', 'continent',
  'flag-country', 'country-flag', 'flag-capital', 'flag-continent',
  'blurry', 'zoom', 'odd-one-out',
]);
const CONTINENT_IDS = new Set(['africa', 'asia', 'europe', 'north-america', 'south-america', 'oceania']);
const DIFFICULTIES = new Set(['mixed', 'easy', 'medium', 'hard']);

const err = (code, message) => ({ ok: false, code, message });

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isIntInRange(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length >= 1 && v.length <= max;
}

function isIdString(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= 64;
}

function optBool(v) {
  return v === undefined || typeof v === 'boolean';
}

/**
 * Validate a settings object. Returns { ok: true, settings } with only the
 * known, sanitised fields, or { ok: false, code, message }.
 */
export function validateSettings(input) {
  if (!isPlainObject(input)) {
    return err('invalid_settings', 'الإعدادات غير صالحة');
  }
  const out = {};
  if (input.flagCount !== undefined) {
    if (!isIntInRange(input.flagCount, 1, 195)) {
      return err('invalid_settings', 'عدد الأعلام يجب أن يكون بين 1 و 195');
    }
    out.flagCount = input.flagCount;
  }
  if (input.maxPlayers !== undefined) {
    if (!isIntInRange(input.maxPlayers, 2, 8)) {
      return err('invalid_settings', 'عدد اللاعبين يجب أن يكون بين 2 و 8');
    }
    out.maxPlayers = input.maxPlayers;
  }
  if (input.durationSec !== undefined) {
    if (!isIntInRange(input.durationSec, 0, 60) || (input.durationSec > 0 && input.durationSec < 5)) {
      return err('invalid_settings', 'مدة السؤال يجب أن تكون 0 (بدون مؤقّت) أو بين 5 و 60 ثانية');
    }
    out.durationSec = input.durationSec;
  }
  if (input.raceTarget !== undefined) {
    if (!isIntInRange(input.raceTarget, 1, 50)) {
      return err('invalid_settings', 'هدف السباق يجب أن يكون بين 1 و 50');
    }
    out.raceTarget = input.raceTarget;
  }
  if (input.revealSec !== undefined) {
    if (!isIntInRange(input.revealSec, 2, 5)) {
      return err('invalid_settings', 'مدة عرض الإجابة يجب أن تكون بين 2 و 5 ثوانٍ');
    }
    out.revealSec = input.revealSec;
  }
  if (input.lateJoin !== undefined) {
    if (typeof input.lateJoin !== 'boolean') {
      return err('invalid_settings', 'خيار الانضمام المتأخر غير صالح');
    }
    out.lateJoin = input.lateJoin;
  }
  if (input.soloMode !== undefined) {
    if (typeof input.soloMode !== 'boolean') {
      return err('invalid_settings', 'خيار اللعب الفردي غير صالح');
    }
    out.soloMode = input.soloMode;
  }
  if (input.noTimer !== undefined) {
    if (typeof input.noTimer !== 'boolean') {
      return err('invalid_settings', 'خيار بدون مؤقّت غير صالح');
    }
    out.noTimer = input.noTimer;
  }
  if (input.mode !== undefined) {
    if (typeof input.mode !== 'string' || !MODES.has(input.mode)) {
      return err('invalid_settings', 'وضع اللعب غير صالح');
    }
    out.mode = input.mode;
  }
  if (input.answerMode !== undefined) {
    if (typeof input.answerMode !== 'string' || !ANSWER_MODES.has(input.answerMode)) {
      return err('invalid_settings', 'طريقة الإجابة غير صالحة');
    }
    out.answerMode = input.answerMode;
  }
  if (input.answerType !== undefined) {
    if (typeof input.answerType !== 'string' || !ANSWER_TYPES.has(input.answerType)) {
      return err('invalid_settings', 'نوع السؤال غير صالح');
    }
    out.answerType = input.answerType;
  }
  if (input.scoring !== undefined) {
    if (typeof input.scoring !== 'string' || !SCORINGS.has(input.scoring)) {
      return err('invalid_settings', 'طريقة حساب النقاط غير صالحة');
    }
    out.scoring = input.scoring;
  }
  if (input.questionTypes !== undefined) {
    if (!Array.isArray(input.questionTypes) || input.questionTypes.length > 8
      || input.questionTypes.some((v) => typeof v !== 'string' || !QUESTION_TYPE_TOKENS.has(v))) {
      return err('invalid_settings', 'أنواع الأسئلة غير صالحة');
    }
    out.questionTypes = [...input.questionTypes];
  }
  if (input.continents !== undefined) {
    if (!Array.isArray(input.continents) || input.continents.length > 6
      || input.continents.some((v) => typeof v !== 'string' || !CONTINENT_IDS.has(v))) {
      return err('invalid_settings', 'القارات غير صالحة');
    }
    out.continents = [...input.continents];
  }
  if (input.difficulty !== undefined) {
    if (typeof input.difficulty !== 'string' || !DIFFICULTIES.has(input.difficulty)) {
      return err('invalid_settings', 'الصعوبة غير صالحة');
    }
    out.difficulty = input.difficulty;
  }
  if (input.hint !== undefined) {
    if (!(typeof input.hint === 'boolean' || (typeof input.hint === 'string' && input.hint.length <= 32))) {
      return err('invalid_settings', 'خيار التلميح غير صالح');
    }
    out.hint = input.hint;
  }
  for (const key of ['arabOnly', 'similarOnly', 'rareOnly', 'negativePoints']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') {
        return err('invalid_settings', 'الإعدادات غير صالحة');
      }
      out[key] = input[key];
    }
  }
  if (input.seed !== undefined && input.seed !== null) {
    if (!((typeof input.seed === 'string' && input.seed.length <= 64) || typeof input.seed === 'number')) {
      return err('invalid_settings', 'البذرة غير صالحة');
    }
    out.seed = input.seed;
  }
  if (input.password !== undefined && input.password !== null) {
    if (typeof input.password !== 'string' || input.password.length > 12) {
      return err('invalid_settings', 'كلمة المرور يجب أن تكون حتى 12 حرفاً');
    }
    if (input.password.length > 0) out.password = input.password;
  }
  return { ok: true, settings: out };
}

function checkName(msg) {
  if (!isNonEmptyString(msg.name, 16)) {
    return err('invalid_name', 'الاسم يجب أن يكون من حرف إلى 16 حرفاً');
  }
  return null;
}

function checkCode(msg) {
  if (typeof msg.code !== 'string' || msg.code.length < 1 || msg.code.length > 12) {
    return err('invalid_code', 'كود الغرفة غير صالح');
  }
  return null;
}

function checkPassword(msg) {
  if (msg.password === undefined || msg.password === null || msg.password === '') return null;
  if (typeof msg.password !== 'string' || msg.password.length < 4 || msg.password.length > 12) {
    return err('invalid_password', 'كلمة المرور يجب أن تكون من 4 إلى 12 حرفاً');
  }
  return null;
}

function checkIdField(msg, field) {
  if (!isIdString(msg[field])) {
    return err('invalid_field', 'المعرّف غير صالح');
  }
  return null;
}

export function validateClientMessage(raw) {
  try {
    if (typeof raw !== 'string') {
      return err('bad_message', 'رسالة غير صالحة');
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
      return err('too_large', 'الرسالة كبيرة جداً');
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return err('bad_json', 'رسالة غير صالحة');
    }
    if (!isPlainObject(msg)) {
      return err('bad_message', 'رسالة غير صالحة');
    }
    if (typeof msg.t !== 'string' || !MESSAGE_TYPES.has(msg.t)) {
      return err('unknown_type', 'نوع الرسالة غير معروف');
    }

    let e = null;
    switch (msg.t) {
      case 'hello': {
        // The web client sends version: 1 (a number); accept string or number.
        if (msg.version !== undefined
          && !(typeof msg.version === 'number' || (typeof msg.version === 'string' && msg.version.length <= 32))) {
          return err('invalid_field', 'إصدار العميل غير صالح');
        }
        break;
      }
      case 'ping': {
        if (msg.c !== undefined && !(typeof msg.c === 'number' || (typeof msg.c === 'string' && msg.c.length <= 64))) {
          return err('invalid_field', 'بيانات النبضة غير صالحة');
        }
        break;
      }
      case 'create_room': {
        e = checkName(msg) || checkPassword(msg);
        if (e) return e;
        if (msg.settings !== undefined) {
          const s = validateSettings(msg.settings);
          if (!s.ok) return s;
          msg = { ...msg, settings: s.settings };
        }
        break;
      }
      case 'join_room': {
        e = checkCode(msg) || checkName(msg) || checkPassword(msg);
        if (e) return e;
        if (msg.playerId !== undefined && !isIdString(msg.playerId)) {
          return err('invalid_field', 'معرّف اللاعب غير صالح');
        }
        if (msg.secret !== undefined && !isIdString(msg.secret)) {
          return err('invalid_field', 'بيانات الاستئناف غير صالحة');
        }
        if (!optBool(msg.asSpectator)) {
          return err('invalid_field', 'خيار المشاهدة غير صالح');
        }
        if (msg.display !== undefined
          && !(typeof msg.display === 'boolean' || isPlainObject(msg.display) || typeof msg.display === 'string')) {
          return err('invalid_field', 'بيانات العرض غير صالحة');
        }
        break;
      }
      case 'resume': {
        e = checkCode(msg);
        if (e) return e;
        e = checkIdField(msg, 'playerId') || checkIdField(msg, 'secret');
        if (e) return e;
        break;
      }
      case 'leave':
      case 'start':
      case 'skip_vote':
      case 'pause':
      case 'resume_game':
      case 'skip_flag':
      case 'rematch':
      case 'replay_missed': {
        break;
      }
      case 'set_settings': {
        if (msg.settings === undefined) {
          return err('invalid_settings', 'الإعدادات مطلوبة');
        }
        const s = validateSettings(msg.settings);
        if (!s.ok) return s;
        msg = { ...msg, settings: s.settings };
        break;
      }
      case 'set_team': {
        if (!(msg.team === null || isNonEmptyString(msg.team, 16))) {
          return err('invalid_field', 'الفريق غير صالح');
        }
        break;
      }
      case 'kick':
      case 'transfer_host': {
        e = checkIdField(msg, 'playerId');
        if (e) return e;
        break;
      }
      case 'ready': {
        if (!isIdString(msg.questionId)) {
          return err('invalid_field', 'معرّف السؤال غير صالح');
        }
        break;
      }
      case 'submit_text_answer': {
        if (!isIdString(msg.questionId)) {
          return err('invalid_field', 'معرّف السؤال غير صالح');
        }
        if (typeof msg.text !== 'string' || msg.text.trim().length < 1 || msg.text.length > 40) {
          return err('invalid_answer', 'نص الإجابة يجب أن يكون من حرف إلى 40 حرفاً');
        }
        msg = { ...msg, text: msg.text.trim() };
        break;
      }
      case 'host_judge':
      case 'judge_answers': {
        if (!isIdString(msg.questionId)) {
          return err('invalid_field', 'معرّف السؤال غير صالح');
        }
        if (!Array.isArray(msg.decisions) || msg.decisions.length < 1 || msg.decisions.length > 8) {
          return err('invalid_judgement', 'قرارات التقييم غير صالحة');
        }
        const seen = new Set();
        for (const d of msg.decisions) {
          if (!isPlainObject(d) || !isIdString(d.playerId) || typeof d.correct !== 'boolean') {
            return err('invalid_judgement', 'قرار تقييم غير صالح');
          }
          if (seen.has(d.playerId)) return err('invalid_judgement', 'قرار مكرر لنفس اللاعب');
          seen.add(d.playerId);
        }
        break;
      }
      case 'answer': {
        if (!isIdString(msg.questionId)) {
          return err('invalid_field', 'معرّف السؤال غير صالح');
        }
        const hasChoice = msg.choiceIndex !== undefined;
        const hasText = msg.text !== undefined;
        if (hasChoice === hasText) {
          return err('invalid_answer', 'أرسل اختياراً واحداً أو نص إجابة واحداً');
        }
        if (hasChoice && !isIntInRange(msg.choiceIndex, 0, 3)) {
          return err('invalid_answer', 'رقم الاختيار غير صالح');
        }
        if (hasText) {
          if (typeof msg.text !== 'string' || msg.text.trim().length < 1 || msg.text.length > 40) {
            return err('invalid_answer', 'نص الإجابة يجب أن يكون من حرف إلى 40 حرفاً');
          }
          msg = { ...msg, text: msg.text.trim() };
        }
        break;
      }
      case 'react': {
        if (typeof msg.emoji !== 'string' || !REACT_EMOJIS.has(msg.emoji)) {
          return err('invalid_react', 'التفاعل غير مدعوم');
        }
        break;
      }
      default: {
        return err('unknown_type', 'نوع الرسالة غير معروف');
      }
    }

    // Normalise the name once (trim) so rooms never see padded names.
    if (typeof msg.name === 'string') {
      msg = { ...msg, name: msg.name.trim() };
    }
    return { ok: true, msg };
  } catch {
    return err('bad_message', 'رسالة غير صالحة');
  }
}
