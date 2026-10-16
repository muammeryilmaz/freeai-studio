// Sunucu tarafı dil desteği: istek dilini belirler ve kullanıcıya dönen mesajları çevirir.
const LANGS = ['en', 'tr'];
const DEFAULT_LANG = 'en';

function normalizeLang(lang) {
  const l = String(lang || '').toLowerCase().slice(0, 2);
  return LANGS.includes(l) ? l : DEFAULT_LANG;
}

/** Arayüz her isteğe X-Lang başlığı ekler; başlık yoksa varsayılan dil (İngilizce) kullanılır. */
function requestLang(req) {
  return normalizeLang(req.headers['x-lang']);
}

const MESSAGES = {
  tr: {
    invalidProvider: 'Geçersiz sağlayıcı.',
    invalidProviderId: (id) => `Geçersiz sağlayıcı: ${id}`,
    noApiKey: (label) => `${label} için API anahtarı girilmemiş. Ayarlardan ekleyin.`,
    noApiKeyShort: (label) => `${label} için API anahtarı girilmemiş.`,
    unreachable: (msg) => `Sağlayıcıya ulaşılamadı: ${msg}`,
    visionStripped: (err) => `Bu model görselleri kabul etmedi, görseller çıkarılarak gönderildi. (${err})`,
    imagesDropped: (n) => `[Kullanıcı ${n} görsel ekledi ancak bu model görsel desteklemediği için görseller iletilemedi.]`,
    modelAndMessagesRequired: 'model ve messages gerekli.',
    modelRequired: 'model gerekli.',
    chatIdRequired: 'chatId ve message gerekli.',
    providerAndModelRequired: 'provider ve model gerekli.',
    piNotConnected: (id) => `${id} için Pi bağlantısı yok. Ayarlar > Pi Üyelikleri bölümünden bağlanın.`,
    piNotConnectedList: (ids) => `Şu sağlayıcılar için Pi bağlantısı yok: ${ids}. Ayarlar > Pi Üyelikleri bölümünden bağlanın.`,
    piNotConnectedShort: 'Bu sağlayıcı için Pi bağlantısı yok.',
    piTestDisabled: 'Pi sağlayıcıları için model testi kapalı; model Pi oturumu üzerinden çalışır.',
    piProviderNote: 'Pi üzerinden abonelikle bağlı — Ayarlar > Pi Üyelikleri.',
    piModelsNote: 'Pi üzerinden bağlı sağlayıcı',
    timeout20: 'zaman aşımı (20sn)',
    loginNotFound: 'Giriş oturumu bulunamadı.',
    pathEmpty: 'Klasör yolu boş olamaz.',
    pathNotFound: 'Belirtilen klasör bulunamadı.',
    pathNotDir: 'Belirtilen yol bir klasör değil.',
    nameAndRolesRequired: 'name ve roles gerekli.',
    projectPathRequired: 'Geçerli bir proje klasörü (projectPath) belirtmelisiniz.',
    teamNotFound: 'Ekip bulunamadı.',
    textOrAttachments: 'text veya attachments gerekli.',
    forbiddenOrigin: 'Bu istek başka bir siteden geldiği için reddedildi.',
    attachedFile: (name) => `--- Ekli dosya: ${name} ---`,
    lookAtImages: 'Bu görsel(ler)e bak.',
    piChatIntro: 'Sen FreeAI Studio uygulamasındaki yapay zeka kodlama asistanısın (Pi CLI üzerinden çalışıyorsun).',
    piChatProject: (cwd) =>
      `Kullanıcının proje klasörü: ${cwd}\nDosyaları okuyabilir, düzenleyebilir, oluşturabilir ve kabukta komut çalıştırabilirsin. Değişiklik yapmadan önce ilgili dosyaları oku.`,
    piChatScratch: 'Şu an bir proje klasörü seçilmediği için geçici bir çalışma alanındasın. Kullanıcıya, dosyalarında çalışmamı istiyorsa proje klasörü seçmesini kısaca hatırlat.',
    piChatStyle: 'Yanıtlarını Türkçe, net ve gereksiz uzatmadan ver.',
    listening: (url) => `FreeAI Studio çalışıyor: ${url}`,
    piCliMissing: 'Pi CLI bulunamadı (vendor/pi/cli.js).',
    piExited: (code, tail) => `Pi süreci kapandı (kod ${code}). ${tail}`,
    piCommandFailed: 'pi komutu başarısız',
    piTurnTimeout: 'Pi turu zaman aşımına uğradı (10 dk).',
    unsupportedProvider: (id) => `Desteklenmeyen sağlayıcı: ${id}`,
    loginIncomplete: 'Giriş tamamlanamadı (kimlik bilgisi alınamadı).',
  },
  en: {
    invalidProvider: 'Invalid provider.',
    invalidProviderId: (id) => `Invalid provider: ${id}`,
    noApiKey: (label) => `No API key set for ${label}. Add one in Settings.`,
    noApiKeyShort: (label) => `No API key set for ${label}.`,
    unreachable: (msg) => `Could not reach the provider: ${msg}`,
    visionStripped: (err) => `This model rejected the images; they were removed and the message was sent without them. (${err})`,
    imagesDropped: (n) => `[The user attached ${n} image(s), but they could not be sent because this model does not support images.]`,
    modelAndMessagesRequired: 'model and messages are required.',
    modelRequired: 'model is required.',
    chatIdRequired: 'chatId and message are required.',
    providerAndModelRequired: 'provider and model are required.',
    piNotConnected: (id) => `No Pi connection for ${id}. Connect it under Settings > Pi Subscriptions.`,
    piNotConnectedList: (ids) => `No Pi connection for these providers: ${ids}. Connect them under Settings > Pi Subscriptions.`,
    piNotConnectedShort: 'No Pi connection for this provider.',
    piTestDisabled: 'Model testing is disabled for Pi providers; the model runs through the Pi session.',
    piProviderNote: 'Connected through a Pi subscription — Settings > Pi Subscriptions.',
    piModelsNote: 'Provider connected through Pi',
    timeout20: 'timed out (20s)',
    loginNotFound: 'Login session not found.',
    pathEmpty: 'Folder path cannot be empty.',
    pathNotFound: 'The folder was not found.',
    pathNotDir: 'The path is not a folder.',
    nameAndRolesRequired: 'name and roles are required.',
    projectPathRequired: 'You must specify a valid project folder (projectPath).',
    teamNotFound: 'Team not found.',
    textOrAttachments: 'text or attachments are required.',
    forbiddenOrigin: 'This request was rejected because it came from another site.',
    attachedFile: (name) => `--- Attached file: ${name} ---`,
    lookAtImages: 'Look at these image(s).',
    piChatIntro: 'You are the AI coding assistant in the FreeAI Studio app (running through the Pi CLI).',
    piChatProject: (cwd) =>
      `The user's project folder: ${cwd}\nYou can read, edit and create files and run shell commands. Read the relevant files before making changes.`,
    piChatScratch: 'No project folder is selected, so you are in a temporary workspace. Briefly remind the user to pick a project folder if they want you to work on their files.',
    piChatStyle: 'Answer in English, clearly and concisely.',
    listening: (url) => `FreeAI Studio is running: ${url}`,
    piCliMissing: 'Pi CLI not found (vendor/pi/cli.js).',
    piExited: (code, tail) => `The Pi process exited (code ${code}). ${tail}`,
    piCommandFailed: 'pi command failed',
    piTurnTimeout: 'The Pi turn timed out (10 min).',
    unsupportedProvider: (id) => `Unsupported provider: ${id}`,
    loginIncomplete: 'Login could not be completed (no credentials received).',
  },
};

/** msg(lang, key, ...args): metin ya da fonksiyonsa çağrılmış hali. */
function msg(lang, key, ...args) {
  const table = MESSAGES[normalizeLang(lang)];
  const v = table[key] ?? MESSAGES[DEFAULT_LANG][key] ?? key;
  return typeof v === 'function' ? v(...args) : v;
}

/** { tr, en } biçimindeki bir değerden dile uygun olanı seçer. */
function pick(value, lang) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value[normalizeLang(lang)] ?? value[DEFAULT_LANG];
  return value;
}

module.exports = { LANGS, DEFAULT_LANG, normalizeLang, requestLang, msg, pick };
