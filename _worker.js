/**
 * دليلك — Cloudflare Pages Worker
 * ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
 * 1) يخدم ملفات الموقع الثابتة كما هي (index.html, map.html, الفيديوهات…)
 * 2) يوفّر مسارًا آمنًا لتحويل الصوت إلى نص:  POST /api/transcribe
 *
 * لا توجد أي مفاتيح داخل هذا الملف — تُقرأ من متغيّرات البيئة في Cloudflare:
 *   STT_PROVIDER   =  openai | groq | deepgram        (الافتراضي: openai)
 *   STT_API_KEY    =  مفتاح المزوّد (سرّي — يُضاف كـ Secret)
 *   STT_MODEL      =  اختياري (مثال: whisper-1 أو whisper-large-v3)
 *   STT_LANG       =  اختياري (الافتراضي: ar)
 *
 * الطلب:  multipart/form-data  { audio: Blob, lang?: string }
 * الرد :  { "text": "النص المُحوَّل" }
 */

const MAX_BYTES = 8 * 1024 * 1024; // 8MB — تسجيل 60 ثانية أقل من ذلك بكثير
const ALLOWED_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/transcribe') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      try {
        return await handleTranscribe(request, env);
      } catch (err) {
        return json({ error: 'server_error', detail: String(err && err.message || err) }, 500);
      }
    }

    if (url.pathname === '/api/tts') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      try {
        if (url.searchParams.get('debug') === '1') {
          return json({ provider: (env.TTS_PROVIDER || 'azure'), voice: (env.TTS_VOICE || 'ar-SA-HamedNeural'),
                        region: (env.TTS_REGION || 'uaenorth'), key_set: !!env.TTS_API_KEY });
        }
        return await handleTTS(request, env);
      } catch (err) {
        return json({ error: 'server_error', detail: String(err && err.message || err) }, 500);
      }
    }

    // كل ما عدا ذلك: ملفات الموقع الثابتة
    return env.ASSETS.fetch(request);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function handleTranscribe(request, env) {
  const key = env.STT_API_KEY;
  if (!key) return json({ error: 'stt_not_configured', message: 'خدمة تحويل الصوت غير مُفعّلة بعد.' }, 503);

  const form = await request.formData();
  const audio = form.get('audio');
  if (!audio || typeof audio === 'string') return json({ error: 'no_audio' }, 400);
  if (audio.size > MAX_BYTES) return json({ error: 'audio_too_large' }, 413);
  if (audio.type && !ALLOWED_TYPES.some(t => audio.type.startsWith(t))) {
    return json({ error: 'unsupported_type', type: audio.type }, 415);
  }

  const provider = (env.STT_PROVIDER || 'openai').toLowerCase();
  const langRaw = String(form.get('lang') || env.STT_LANG || 'ar');
  const lang = langRaw.split('-')[0]; // ar-SA -> ar

  let text = '';
  if (provider === 'deepgram') text = await viaDeepgram(audio, lang, key);
  else if (provider === 'groq') text = await viaOpenAICompatible(audio, lang, key,
      'https://api.groq.com/openai/v1/audio/transcriptions', env.STT_MODEL || 'whisper-large-v3');
  else text = await viaOpenAICompatible(audio, lang, key,
      'https://api.openai.com/v1/audio/transcriptions', env.STT_MODEL || 'whisper-1');

  // لا يُخزَّن أي صوت أو نص على الخادم
  return json({ text: (text || '').trim() });
}

/** OpenAI Whisper و Groq يستخدمان نفس الواجهة */
async function viaOpenAICompatible(audio, lang, key, endpoint, model) {
  const fd = new FormData();
  fd.append('file', audio, filenameFor(audio));
  fd.append('model', model);
  if (lang) fd.append('language', lang);
  // تلميح لتحسين دقة العربية والمصطلحات الطبية الشائعة
  fd.append('prompt', 'استفسار مريض داخل مستشفى: مواعيد، صيدلية، مختبر، أشعة، تطعيمات، أقسام.');

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd
  });
  if (!r.ok) throw new Error('provider_' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return d.text || '';
}

async function viaDeepgram(audio, lang, key) {
  const q = new URLSearchParams({ model: 'nova-2', language: lang === 'ar' ? 'ar' : lang, smart_format: 'true' });
  const r = await fetch('https://api.deepgram.com/v1/listen?' + q, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': audio.type || 'audio/webm' },
    body: await audio.arrayBuffer()
  });
  if (!r.ok) throw new Error('provider_' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return d?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

function filenameFor(audio) {
  const t = audio.type || 'audio/webm';
  if (t.includes('ogg')) return 'audio.ogg';
  if (t.includes('mp4') || t.includes('m4a')) return 'audio.m4a';
  if (t.includes('mpeg')) return 'audio.mp3';
  if (t.includes('wav')) return 'audio.wav';
  return 'audio.webm';
}

/* ══════════════════════════════════════════════════════════════
   تحويل النص إلى صوت (TTS)
   المزوّد الافتراضي: Azure AI Speech — يوفّر أصواتًا سعودية حقيقية.
   متغيّرات البيئة:
     TTS_PROVIDER = azure | google        (الافتراضي: azure)
     TTS_API_KEY  = المفتاح (Secret)
     TTS_REGION   = منطقة Azure، مثال: uaenorth  (مطلوب مع azure)
     TTS_VOICE    = اختياري — الافتراضي ar-SA-HamedNeural (ذكر سعودي)
                    بدائل: ar-SA-ZariyahNeural (أنثى سعودية) · ar-XA-Wavenet-B (جوجل)
   الطلب : { text: "..." }        الرد : audio/mpeg
   ══════════════════════════════════════════════════════════════ */
const TTS_MAX_CHARS = 600;

function xmlEsc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;')}

async function handleTTS(request, env) {
  const key = env.TTS_API_KEY;
  if (!key) return json({ error: 'tts_not_configured', message: 'خدمة النطق غير مُفعّلة بعد.' }, 503);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
  let text = String((body && body.text) || '').trim();
  if (!text) return json({ error: 'no_text' }, 400);
  if (text.length > TTS_MAX_CHARS) text = text.slice(0, TTS_MAX_CHARS);

  const provider = (env.TTS_PROVIDER || 'azure').toLowerCase();
  const bytes = provider === 'google'
    ? await ttsGoogle(text, key, env)
    : await ttsAzure(text, key, env);

  return new Response(bytes, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' }
  });
}

/* Azure AI Speech — صوت سعودي */
async function ttsAzure(text, key, env) {
  const region = env.TTS_REGION || 'uaenorth';
  const voice  = (env.TTS_VOICE || 'ar-SA-HamedNeural').trim();
  // اللهجة تُشتق من اسم الصوت نفسه (ar-SA / ar-EG ...) لضمان اللكنة الصحيحة
  const locale = (voice.match(/^([a-z]{2}-[A-Z]{2})/) || [, 'ar-SA'])[1];
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${voice}"><prosody rate="-4%">${xmlEsc(text)}</prosody></voice></speak>`;

  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'daleelk'
    },
    body: ssml
  });
  if (!r.ok) throw new Error('azure_' + r.status + ': ' + (await r.text()).slice(0, 200));
  return new Uint8Array(await r.arrayBuffer());
}

/* Google Cloud TTS (بديل) */
async function ttsGoogle(text, key, env) {
  const voice = env.TTS_VOICE || 'ar-XA-Wavenet-B';
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'ar-XA', name: voice },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95 }
    })
  });
  if (!r.ok) throw new Error('google_' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  if (!d.audioContent) throw new Error('google_empty');
  const bin = atob(d.audioContent);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
