// Copy this file to  config.local.js  and fill it in.
// config.local.js is gitignored and never leaves your machine.
//
// It's for a copy served from this folder (see README, Running it): the hosted
// site gets its own, written by deploy/build.js from the Vercel project's
// settings. It is a plain <script> that assigns a global, so it loads however
// the page is served.
//
// If the file is missing, or the URL is still a placeholder, the app simply
// asks for these on screen instead. Nothing breaks.

window.HEIMDESK_CONFIG = {
  // Supabase → Settings → API
  url: "https://YOUR-PROJECT.supabase.co",
  key: "sb_publishable_...",

  // Postgres schema this app owns. Must be listed under Exposed schemas.
  schema: "heimdesk"
};
