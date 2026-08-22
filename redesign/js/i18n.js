/* Localisation scaffold. Strings migrate here incrementally — the shell
 * screens (home / host setup / join) are wired via data-i18n attributes;
 * in-game strings are still English and move over as translations arrive.
 *
 * Pick a language with ?lang=xx in the URL (remembered per device), e.g.
 * https://…/mafia/?lang=en. To add a language: copy the `en` block, translate
 * the values, and add matching keys for any new strings. Missing keys fall
 * back to English automatically. */

const I18N = (() => {
  const LANGS = {
    en: {
      'home.tagline': 'A browser-based operator for the classic party game.<br>One device hosts, everyone else joins.',
      'home.host': 'Host a game',
      'home.join': 'Join a game',
      'home.hint': 'No accounts, no servers — devices connect directly to the host. Keep the host device awake for the whole game.',
      'hostsetup.title': 'Host a game',
      'hostsetup.blurb': "You'll play too — the app runs the game as a neutral operator.",
      'hostsetup.name': 'Your name',
      'hostsetup.create': 'Create game',
      'join.title': 'Join a game',
      'join.name': 'Your name',
      'join.code': 'Room code',
      'join.join': 'Join',
      'join.public': '🌐 Public games',
      'common.back': '← Back',
    },
    // Add more languages here, e.g.:
    // es: { 'home.host': 'Crear partida', … },
  };

  let lang = 'en';
  try {
    lang = new URLSearchParams(location.search).get('lang') ||
      localStorage.getItem('mafia-lang') || 'en';
    if (!LANGS[lang]) lang = 'en';
    localStorage.setItem('mafia-lang', lang);
  } catch (e) { lang = 'en'; }

  const t = key => (LANGS[lang] && LANGS[lang][key]) || LANGS.en[key] || key;

  /* Apply translations to every element carrying a data-i18n attribute. */
  function apply(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach(el => {
      el.innerHTML = t(el.dataset.i18n);
    });
  }

  return { t, apply, lang };
})();
