/**
 * Styles for the shadow root, as a string: the bundle is a single IIFE with no
 * separate CSS file (see vite.config.ts).
 *
 * Mobile first — everything works at 360 px, because the whole point is using this
 * from a phone next to the printer. Layout lives on `.wrap`, never on `:host`: page
 * rules that match the host element (Vuetify's global `*{padding:0;margin:0}` reset)
 * beat `:host`, since Shadow DOM isolates selectors and not the host's own box.
 */
export const APP_CSS = `
:host{display:block;color:inherit}
*,*::before,*::after{box-sizing:border-box}
.wrap{padding:16px;font:14px/1.5 Roboto,system-ui,-apple-system,"Segoe UI",sans-serif;
  color:var(--ccad-fg);max-width:1400px;margin:0 auto;color-scheme:dark}
/* The palette is always dark: native popups (select lists, number spinners) must be
   too, or their options are light text on a light list. */
select option{background:#2a2b30;color:#e2e8f0}
button{font:inherit;cursor:pointer}
a{color:var(--ccad-accent);text-decoration:none}

.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.head h2{margin:0;font-size:19px;font-weight:600;flex:1 1 auto}
.sub{font-size:12px;opacity:.6}

.tabs{display:flex;gap:4px;margin:0 0 12px;flex-wrap:wrap}
.tab{background:transparent;border:1px solid var(--ccad-line);color:inherit;
  padding:7px 14px;border-radius:999px;font-size:13px;opacity:.75}
.chips{display:flex;gap:6px;margin:-4px 0 12px;overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:4px 12px;font-size:12px}
.chip[aria-pressed="true"]{background:var(--ccad-accent);border-color:var(--ccad-accent);color:#fff;opacity:1}
.card .types{opacity:.8}
.tab[aria-selected="true"]{background:var(--ccad-accent);border-color:var(--ccad-accent);
  color:#fff;opacity:1;font-weight:500}

.search{display:flex;gap:8px;margin-bottom:14px}
.search input{flex:1 1 auto;min-width:0;background:var(--ccad-input);color:inherit;
  border:1px solid var(--ccad-line);border-radius:6px;padding:9px 12px;font:inherit}
.search input:focus{outline:2px solid var(--ccad-accent);outline-offset:-1px}
.btn{background:var(--ccad-accent);color:#fff;border:0;border-radius:6px;padding:9px 16px;font-weight:500}
.btn.ghost{background:transparent;border:1px solid var(--ccad-line);color:inherit}
.btn:disabled{opacity:.5;cursor:default}
.btn.sm{padding:3px 10px;font-size:12px}
.sent{border:1px solid var(--ccad-line);border-radius:8px;padding:12px 14px;margin-top:12px;
  background:var(--ccad-card);display:grid;gap:8px}
.warnbox{border:1px solid #f6ad5555;background:#f6ad550f;border-radius:6px;padding:10px 12px;font-size:13px}
.warnbox ul{margin:6px 0 6px 18px;padding:0}
.warnbox p{margin:0}

.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
@media (min-width:700px){.grid{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}}

.card{border:1px solid var(--ccad-line);border-radius:8px;overflow:hidden;
  background:var(--ccad-card);display:flex;flex-direction:column;text-align:left;
  padding:0;color:inherit;width:100%}
.card:hover{border-color:var(--ccad-accent)}
.thumb{aspect-ratio:4/3;width:100%;object-fit:cover;background:var(--ccad-input);display:block}
.thumb.ph{display:flex;align-items:center;justify-content:center;font-size:11px;opacity:.4}
.card .body{padding:9px 10px 10px;display:flex;flex-direction:column;gap:3px;flex:1 1 auto}
.card .title{font-size:13px;font-weight:600;line-height:1.3;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card .meta{font-size:11px;opacity:.6}
.card .foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:5px}

.badge{font-size:10px;font-weight:600;padding:2px 7px;border-radius:999px;
  border:1px solid var(--ccad-line);white-space:nowrap}
.badge.fit{color:#48bb78;border-color:#48bb7855;background:#48bb7814}
.badge.nofit{color:#f6ad55;border-color:#f6ad5555;background:#f6ad5514}
.badge.cad{color:#a0aec0;border-color:var(--ccad-line)}
.badge.private{color:#d6bcfa;border-color:#d6bcfa55;background:#d6bcfa14}

.msg{border:1px solid var(--ccad-line);border-radius:8px;padding:18px;text-align:center;
  background:var(--ccad-card)}
.msg p{margin:0 0 12px}
.msg.warn{border-color:#f6ad5555;background:#f6ad550f}
.cmd{text-align:left;background:var(--ccad-input);border:1px solid var(--ccad-line);border-radius:6px;
  padding:10px 12px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto;margin:0 0 12px}
.skeleton{border:1px solid var(--ccad-line);border-radius:8px;background:var(--ccad-card);
  aspect-ratio:4/3;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.45}50%{opacity:.8}}

.more{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:16px}

.detail{display:grid;gap:18px;grid-template-columns:minmax(0,1fr)}
@media (min-width:760px){.detail{grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)}}
.detail img.hero{width:100%;border-radius:8px;border:1px solid var(--ccad-line);
  background:var(--ccad-input)}
.detail h3{margin:0 0 4px;font-size:20px;font-weight:600}
.facts{list-style:none;padding:0;margin:12px 0 0;font-size:13px}
.facts li{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--ccad-line)}
.facts li span:first-child{opacity:.6;min-width:96px}
.files{list-style:none;padding:0;margin:10px 0 0;font-size:12px;max-height:260px;overflow:auto}
.files li{display:flex;flex-wrap:wrap;gap:8px;padding:5px 0;border-bottom:1px solid var(--ccad-line)}
.files li{align-items:center}
.files .path{flex:1 1 0;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files .btn{flex:0 0 auto}
.files .sz{opacity:.55;white-space:nowrap}
.files .icon-btn.sm{flex:0 0 auto}
.files.grown{max-height:none}
.settings-grid{column-count:1;column-gap:14px}
@media (min-width:1000px){.settings-grid{column-count:2}}
/* Masonry by columns: each column fills on its own, so a tall card leaves no hole. */
.settings-slot{break-inside:avoid;-webkit-column-break-inside:avoid;display:block;margin:0 0 14px}
.settings-slot > .settings-card{display:block;width:100%;margin:0}
/* An open Profiles or Materials editor gets the page. */
.settings-grid.focus{column-count:1}
.settings-grid.focus > :not(.focused){display:none}
.settings-card .files-table .wide-only{display:none}   /* panels are half width */
.settings-card .files-table td,.settings-card .files-table th{padding:0 10px}
.hidden-defaults{padding:8px 16px 14px}
.hidden-defaults ul{list-style:none;margin:8px 0;padding:0}
.hidden-defaults li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;
  border-bottom:1px solid var(--ccad-line)}
.default-pick label{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px}
.settings-grid > .settings-card{break-inside:avoid;-webkit-column-break-inside:avoid;display:block;width:100%;margin:0 0 14px}
.about-grid{display:grid;gap:14px;grid-template-columns:minmax(0,1fr)}
@media (min-width:1000px){.about-grid{grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch}}
.settings-body .field > label{font-size:13px}
.settings-body .sub{font-size:13px}
.perm-switch{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:13px}
.perm-switch .switch{width:18px;height:18px;accent-color:var(--ccad-accent)}
.settings-card .panel-head{font-size:16px;min-height:42px}
.settings-body{padding:14px 16px;display:grid;gap:16px}
.settings-body .field input:not([type=checkbox]){max-width:100%}
.about p{margin:0;line-height:1.6}
.about-grid > .settings-card{display:flex;flex-direction:column}
.about-grid .settings-body{flex:1 1 auto;align-content:start}
.settings-body.about{display:flex;flex-direction:column;gap:22px}
.ccad-banner{margin-top:auto;display:flex;align-items:center;gap:14px;padding:16px;border-radius:8px;text-decoration:none;
  color:inherit;border:1px solid var(--ccad-line);background:linear-gradient(135deg,rgba(33,150,243,.18),rgba(33,150,243,.04))}
.ccad-banner:hover{border-color:var(--ccad-accent)}
.ccad-banner strong{display:block;font-size:15px;margin-bottom:2px}
.ccad-banner-icon{color:var(--ccad-accent);flex:0 0 auto}
.ccad-banner-go{margin-left:auto;font-size:24px;opacity:.6}
.about-list{margin:6px 0;padding-left:18px;font-size:13px;line-height:1.6}
.about-links{display:flex;flex-direction:column;gap:6px;font-size:14px}
.badge.stage{background:rgba(246,173,85,.15);color:#f6ad55;border:1px solid rgba(246,173,85,.4)}
.feedback input:not([type=checkbox]),.feedback textarea{width:100%;box-sizing:border-box;background:var(--ccad-input);color:inherit;
  border:1px solid var(--ccad-line);border-radius:6px;padding:9px 10px;font:inherit;font-size:14px}
.feedback .chips{margin:0;flex-wrap:wrap}
.feedback .check{display:flex;gap:8px;align-items:center}
.versions{margin:0;padding:8px 10px;background:var(--ccad-input);border-radius:6px;font-size:12px;white-space:pre-wrap}
.quick{border:1px solid var(--ccad-line);border-radius:8px;padding:10px 12px;margin:6px 0;display:grid;gap:8px;
  background:var(--ccad-card)}
.quick-head{display:flex;align-items:center;justify-content:space-between}
.quick-choices{display:flex;gap:10px;flex-wrap:wrap}
.quick-choices label{display:flex;flex-direction:column;gap:4px;flex:1 1 140px;min-width:0}
.quick-choices select{max-width:100%}
.quick-summary{margin:0;font-size:15px;font-weight:500}
.quick-step{margin:0}
.sort-select{margin-left:auto;padding:5px 8px;font-size:13px}
.gallery{position:relative}
.gallery-strip{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;border-radius:8px}
.gallery-strip::-webkit-scrollbar{display:none}
.gallery-item{flex:0 0 100%;scroll-snap-align:start;margin:0}
.gallery-item img.hero{aspect-ratio:4/3;object-fit:contain;background:var(--ccad-input)}
.gallery-item figcaption{margin-top:4px}
.gallery-dots{display:flex;justify-content:center;gap:0;margin-top:4px}
.gallery-frame{position:relative}
/* Arrows over the picture, big enough to hit on a phone; always shown, not on hover only. */
.gallery-arrow{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:40px;border-radius:50%;border:0;
  background:rgba(20,21,24,.72);color:#fff;font-size:26px;line-height:1;padding:0 0 3px;cursor:pointer;
  box-shadow:0 2px 8px rgba(0,0,0,.4)}
.gallery-arrow:hover{background:rgba(20,21,24,.9)}
.gallery-arrow.prev{left:8px}
.gallery-arrow.next{right:8px}
.gallery-count{position:absolute;top:8px;right:8px;padding:2px 8px;border-radius:10px;background:rgba(20,21,24,.72);
  color:#ddd;font-size:12px}
.gallery-strip:focus-visible{outline:2px solid var(--ccad-accent);outline-offset:2px}
.gallery-dots button{width:24px;height:24px;padding:0;border:0;background:none;cursor:pointer;display:grid;place-items:center}
.gallery-dots button::before{content:"";width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.3)}
.gallery-dots button[aria-selected=true]::before{background:var(--ccad-accent)}
.model-desc{margin:8px 0 0;line-height:1.5}
.tag-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.tag-chip{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--ccad-line);opacity:.8}
.readme{margin-top:20px;border-top:1px solid var(--ccad-line);padding-top:12px}
.readme h3{margin:0 0 8px;font-size:16px}
.md{line-height:1.55;font-size:14px;overflow-wrap:anywhere}
.md.faded{max-height:320px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 70%,transparent)}
.md img{max-width:100%;height:auto;border-radius:6px}
.md pre{overflow-x:auto;background:var(--ccad-input);padding:8px 10px;border-radius:6px;font-size:12px}
.md code{background:var(--ccad-input);padding:1px 4px;border-radius:4px;font-size:12px}
.md pre code{background:none;padding:0}
.md blockquote{margin:8px 0;padding-left:10px;border-left:3px solid var(--ccad-line);opacity:.85}
.md h3,.md h4,.md h5,.md h6{margin:14px 0 6px}
.md ul,.md ol{padding-left:20px}
.recent-list{list-style:none;margin:0 0 10px;padding:0}
.recent-row{display:flex;align-items:center;gap:12px;width:100%;padding:8px 4px;background:none;border:0;
  border-bottom:1px solid var(--ccad-line);color:inherit;text-align:left;cursor:pointer}
.recent-row:hover{background:rgba(255,255,255,.04)}
.recent-thumb{flex:0 0 56px;height:42px;border-radius:4px;background:var(--ccad-input);display:flex;align-items:center;
  justify-content:center;overflow:hidden;opacity:.9}
.recent-thumb img{width:100%;height:100%;object-fit:cover}
.recent-text{display:flex;flex-direction:column;min-width:0}
.recent-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.setting-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:space-between;margin:4px 0}
.setting-note{margin:0 0 8px;opacity:.75;line-height:1.45}
.menu-backdrop{position:fixed;inset:0;z-index:40}
/* The confirm before a print starts: over the page, never below the fold. */
.share-plate{display:flex;gap:12px;align-items:flex-start;margin:8px 0}
.plate-pic{width:112px;height:112px;flex:0 0 112px;border-radius:8px;background:#26262b;object-fit:contain;
  border:1px solid var(--ccad-line)}
.share-what{min-width:0;flex:1 1 auto}
.share-summary{margin:0 0 6px;font-weight:500;line-height:1.45}
.share-warn{margin:0 0 6px;color:#f6ad55}
.share-ticks{display:flex;flex-direction:column;gap:4px}
.share-ticks .check{display:flex;gap:8px;align-items:center}
@media (max-width:600px){.share-plate{flex-direction:column}.plate-pic{width:100%;height:auto;aspect-ratio:1;flex:none;max-width:260px}}
.transfer{display:flex;flex-direction:column;gap:4px;margin:4px 0;width:100%}
.transfer-track{height:6px;border-radius:3px;background:var(--ccad-input);overflow:hidden}
.transfer-fill{height:100%;background:var(--ccad-accent);transition:width .4s linear}
.file-row{flex-direction:column;align-items:stretch!important;gap:6px!important;padding:8px 0!important}
.file-head{display:flex;align-items:center;gap:8px;min-width:0}
.file-head .path{flex:1 1 auto}
.file-actions{display:flex;flex-wrap:wrap;gap:6px}
.act{display:inline-flex;align-items:center;gap:6px}
.act .icon{flex:none}
.act-short{display:none}
/* Narrow (a phone, or desktop's file column): one row of icons with short captions,
   rather than five buttons over two rows. Measured on the list, not the screen. */
.files li{container-type:inline-size}
.file-actions{flex:1 1 100%;min-width:0}
@container (max-width:560px){
  .file-actions{flex-wrap:nowrap;align-items:flex-start}
  .files .file-actions .act{flex:1 1 0;min-width:0;flex-direction:column;justify-content:center;gap:3px;height:52px;padding:6px 1px}
  .act-label{display:none}
  .act-short{display:block;font-size:10px;letter-spacing:-.1px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
}
.sheet .menu-search{margin:6px 0}
.sheet .menu-project{padding:8px 4px}
.card-wrap{position:relative;display:flex;flex-direction:column}
.card-box{position:relative;flex:1 1 auto;display:flex;flex-direction:column}
.card-box > .card{flex:1 1 auto}
.card-add{position:absolute;right:8px;bottom:8px;width:36px;height:36px;border-radius:50%;border:0;
  background:var(--ccad-accent);color:#fff;font-size:22px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.card-add.added{background:#2f855a;font-size:17px}
.card-add:disabled:not(.added){opacity:.7}
/* The + takes the foot's right corner: keep badges and "Printed" clear of it. The bar
   sits over the picture, the one place with room for "2.6 MB of 47 MB · 6 %". */
.card-box.can-add .card .foot{padding-right:40px}
.card-transfer{position:absolute;left:8px;right:8px;top:8px;background:rgba(30,32,36,.92);border-radius:6px;padding:4px 6px}
.card-transfer .transfer{margin:0}
.card-note{position:absolute;left:6px;right:6px;top:6px;display:flex;gap:6px;align-items:flex-start;
  padding:7px 6px 7px 9px;background:rgba(24,25,28,.95);border:1px solid #6b4a2a;border-left:3px solid #f0b37e;
  border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.45)}
/* Over the picture, never past it: long text is clipped to five lines (full text on hover). */
.card-note p{margin:0;flex:1;font-size:12.5px;line-height:1.4;color:#f0b37e;
  display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.card-note-close{flex:none;border:0;background:none;color:#aaa;cursor:pointer;font-size:13px;padding:0 2px;line-height:1.4}
.plate-bar{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;
  padding:10px 12px;background:#2a2b30;border:1px solid var(--ccad-line);border-radius:10px;box-shadow:0 -4px 16px rgba(0,0,0,.35)}
.plate-bar span{flex:1 1 auto}
.plate-note{margin:8px 0}
.plate-pick{display:flex;gap:8px;align-items:center;padding:4px 0}
.sheet-backdrop{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.5)}
.sheet{position:fixed;z-index:51;left:50%;top:50%;transform:translate(-50%,-50%);width:min(460px,calc(100vw - 32px));
  max-height:85vh;overflow:auto;background:#2a2b30;border:1px solid var(--ccad-line);border-radius:10px;
  padding:18px 18px 16px;box-shadow:0 12px 40px rgba(0,0,0,.55)}
.sheet .sent{margin:0;border:0;padding:0;background:none}
.sheet .confirm-title{font-size:17px;margin-bottom:8px;padding-right:36px}
.sheet .acts{margin-top:14px}
.sheet .acts .btn{min-height:42px;padding:9px 18px}
.sheet-close{position:absolute;top:10px;right:10px}
@media (max-width:600px){.sheet{left:0;right:0;top:auto;bottom:0;transform:none;width:auto;border-radius:14px 14px 0 0;
  padding:18px 16px calc(16px + env(safe-area-inset-bottom))}}
.menu{position:fixed;z-index:41;top:var(--menu-top,auto);bottom:var(--menu-bottom,auto);right:var(--menu-right,8px);
  width:280px;max-height:min(420px,70vh);overflow:auto;background:#2a2b30;border:1px solid var(--ccad-line);
  border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.45);padding:6px;font-size:13px}
.menu-item{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;
  background:none;border:0;color:inherit;padding:9px 10px;border-radius:6px;cursor:pointer;position:relative;font-size:13px}
.menu-item:hover:not(:disabled){background:rgba(255,255,255,.07)}
.menu-item:disabled{opacity:.5;cursor:default}
.menu-item .sub{font-size:11px}
.menu-chev{position:absolute;right:10px;top:50%;transform:translateY(-50%);opacity:.6;font-size:16px}
.menu-head{display:flex;align-items:center;gap:10px;padding:6px 8px 8px}
.menu-search{width:100%;box-sizing:border-box;margin:0 0 4px;padding:7px 9px;border-radius:6px;
  border:1px solid var(--ccad-line);background:var(--ccad-input);color:inherit;font-size:13px}
.menu-project{flex-direction:row;align-items:center;gap:10px}
.menu-thumb{flex:0 0 40px;height:40px;border-radius:4px;background:var(--ccad-input);display:flex;
  align-items:center;justify-content:center;overflow:hidden;opacity:.9}
.menu-thumb img{width:100%;height:100%;object-fit:cover}
.menu-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu-new{color:var(--ccad-accent);border-top:1px solid var(--ccad-line);border-radius:0 0 6px 6px;margin-top:4px}
.menu-note{padding:4px 10px;margin:0}
@media (max-width:600px){.menu{left:0;right:0!important;top:auto!important;bottom:0!important;width:auto;
  max-height:75vh;border-radius:12px 12px 0 0;padding:10px 10px calc(10px + env(safe-area-inset-bottom))}
  .menu-item{padding:12px 10px;font-size:15px}.menu-backdrop{background:rgba(0,0,0,.4)}}

.connect{border:1px solid var(--ccad-line);border-radius:8px;padding:22px 18px;
  background:var(--ccad-card);text-align:center;max-width:460px;margin:0 auto}
.connect p{margin:0 0 10px}
.code{font:700 34px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;
  margin:0 0 14px;word-break:break-all}
@media (min-width:420px){.code{font-size:42px}}
.qr{width:min(190px,60vw);height:auto;border-radius:6px;padding:8px;background:#fff;margin:6px 0}

.form{display:grid;gap:14px;max-width:420px}
.field{display:grid;gap:5px}
.field label{font-size:12px;opacity:.7}
.field input{background:var(--ccad-input);color:inherit;border:1px solid var(--ccad-line);
  border-radius:6px;padding:8px 10px;font:inherit}
.row3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.row3 input{width:100%;min-width:0}

/* Top navigation: Browse, Models, Settings. */
.topnav{display:flex;gap:4px;margin:0 0 14px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
.topnav::-webkit-scrollbar{display:none}
.topnav .tab{flex:0 0 auto}
.tab-more{display:none}
.tab-more.active .tab{background:var(--ccad-accent);color:#fff;border-color:transparent}
.menu-item[aria-current=page]{color:var(--ccad-accent);font-weight:600}
@media (max-width:600px){.topnav .tab-more-item{display:none}.tab-more{display:flex}
  .topnav{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}
  .topnav .tab{min-height:40px;padding:6px 4px;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}

/* Models on the printer, modelled on Mainsail's G-Code Files panel:
   a header bar, tools, an info line, then a plain table with 48 px rows. */
.icon{display:inline-block;flex:0 0 auto;vertical-align:middle}
.panel{background:var(--ccad-panel,#1e1e1e);border-radius:4px;overflow:hidden;
  box-shadow:0 2px 1px -1px rgba(0,0,0,.2),0 1px 1px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.12)}
.panel-head{display:flex;align-items:center;gap:10px;min-height:48px;padding:0 16px;
  background:var(--ccad-panel-head,#272727);font-size:20px;font-weight:400}
.panel-tools{display:flex;align-items:center;gap:8px;padding:16px 16px 8px}
.panel-search{flex:0 1 300px;display:flex;align-items:center;gap:6px;min-width:0;
  border:1px solid rgba(255,255,255,.24);border-radius:4px;padding:0 10px;height:40px}
.panel-search input{flex:1 1 auto;min-width:0;background:transparent;border:0;outline:0;
  color:inherit;font:inherit;font-size:16px}
.panel-search:focus-within{border-color:var(--ccad-accent)}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:40px;height:36px;
  margin-left:auto;border:0;border-radius:4px;background:rgba(255,255,255,.08);color:inherit}
.icon-btn.sm{width:32px;height:28px;margin-left:0;vertical-align:middle}
.icon-btn:hover{background:rgba(255,255,255,.14)}
.panel-info{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
  padding:8px 16px 12px;font-size:14px;border-bottom:1px solid rgba(255,255,255,.12)}
.table-scroll{overflow-x:auto}
.files-table{width:100%;border-collapse:collapse;font-size:14px}
.files-table th{height:48px;padding:0 16px;text-align:left;font-size:12px;font-weight:700;
  color:rgba(255,255,255,.7);white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.12)}
.files-table td{height:48px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.12)}
.files-table tbody tr:hover{background:rgba(255,255,255,.04)}
.files-table .thumb-col{width:56px;padding-right:0}
.files-table .thumb-col img{width:32px;height:32px;object-fit:cover;border-radius:2px;display:block}
.files-table .name{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files-table .from{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75}
.files-table .nowrap{white-space:nowrap}
.files-table .actions-col{text-align:right}
.panel-empty{padding:24px 16px;text-align:center}
.panel-body{padding:16px}
.skel-rows{display:grid;gap:8px;padding:12px 16px}
.skel-row{height:40px;border-radius:6px;background:linear-gradient(90deg,rgba(127,127,127,.08),rgba(127,127,127,.16),rgba(127,127,127,.08));
  background-size:200% 100%;animation:ccad-shimmer 1.2s linear infinite}
@keyframes ccad-shimmer{from{background-position:200% 0}to{background-position:0 0}}
@media (prefers-reduced-motion:reduce){.skel-row{animation:none}}
.panel-head .head-note{margin-left:auto;font-size:12px;white-space:nowrap}
.panel-empty p{margin:0 0 8px}
.link-btn{background:none;border:0;padding:0 2px;color:var(--ccad-accent);font-size:12px;cursor:pointer}
@media (max-width:600px){.panel-head{font-size:18px}.files-table td,.files-table th{padding:0 10px}
  .files-table .name{max-width:150px}.files-table .wide-only{display:none}
  .files-table .thumb-col{width:44px}}
.slice-body{padding:16px;display:flex;flex-direction:column;gap:6px}
.slice-body .field{margin:0}
.slice-body .field label{display:block;font-size:12px;opacity:.7;margin:6px 0 6px}
.slice-body .chips{margin:0}
.panel-head .icon-btn{margin-left:0}
.mat-group{border-top:1px solid rgba(255,255,255,.12);padding:4px 0}
.mat-group > summary{cursor:pointer;padding:10px 0;list-style:none}
.mat-group > summary::-webkit-details-marker{display:none}
.group-summary{display:flex;align-items:center;gap:12px}
.group-icon{flex:0 0 36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;
  background:rgba(33,150,243,.12);color:var(--ccad-accent)}
.group-text{display:flex;flex-direction:column;min-width:0}
.group-name{font-weight:500}
.group-blurb{font-size:12px}
.mat-subgroup{margin:6px 0 6px 48px}
.mat-subgroup > summary{cursor:pointer;padding:6px 0}
/* One setting: label and tip | value and unit | reset. */
.mat-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(140px,260px) 26px;gap:10px;
  align-items:center;padding:6px 0}
.mat-row.multi{grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) 26px}
.mat-row.changed .mat-label > span{color:var(--ccad-accent)}
.mat-label{display:flex;flex-direction:column;min-width:0}
.mat-label > span{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.mat-label code{font-size:10px;opacity:.45;overflow:hidden;text-overflow:ellipsis}
.mat-value{display:flex;align-items:center;gap:6px;min-width:0}
.mat-value .unit{font-size:12px;opacity:.6;white-space:nowrap;flex:0 0 44px}
.mat-row input,.mat-row textarea,.slice-body .field input{width:100%;min-width:0;background:transparent;
  color:inherit;border:1px solid rgba(255,255,255,.24);border-radius:4px;padding:6px 8px;font:inherit;font-size:13px}
.mat-row textarea{font-family:ui-monospace,monospace;font-size:12px}
.mat-row .reset{background:transparent;border:0;color:#e9a23b;font-size:16px;padding:0;cursor:pointer}
.mat-row .reset:disabled{visibility:hidden}
.info-tip{background:none;border:0;padding:0 2px;color:inherit;opacity:.55;cursor:pointer;display:inline-flex;
  vertical-align:middle}
.info-tip:hover,.info-tip[aria-expanded=true]{opacity:1;color:var(--ccad-accent)}
.tip-text{flex-basis:100%;font-size:12px;line-height:1.45;opacity:.85;background:rgba(33,150,243,.08);
  border-left:2px solid var(--ccad-accent);padding:6px 8px;border-radius:0 4px 4px 0;margin-top:4px;font-weight:400}
.editor-view{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:6px 0}
.essentials{border:1px solid var(--ccad-line);border-radius:8px;padding:6px 14px 10px}
.essentials > .sub{margin:6px 0 4px}
.simple-section{padding:4px 0 6px;border-top:1px solid var(--ccad-line)}
.simple-section:first-of-type{border-top:0}
.simple-head{display:flex;align-items:center;gap:10px;font-weight:500;padding:8px 0 2px}
.simple-head .group-icon{flex-basis:30px;height:30px}
.colour-field{display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0}
.colour-top{display:flex;align-items:center;gap:8px}
.colour-current{flex:0 0 32px;height:32px;border-radius:6px;border:1px solid var(--ccad-line);cursor:pointer;
  background:repeating-conic-gradient(#555 0 25%,#333 0 50%) 50%/10px 10px;position:relative;overflow:hidden}
.colour-current input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;border:0;padding:0}
.swatches{display:flex;flex-wrap:wrap;gap:5px}
.swatch-pick{width:20px;height:20px;border-radius:50%;border:1px solid rgba(255,255,255,.35);padding:0;cursor:pointer}
.swatch-pick[aria-pressed=true]{outline:2px solid var(--ccad-accent);outline-offset:2px}
.preset-list{display:flex;flex-direction:column;align-items:flex-start;gap:4px;max-height:220px;
  overflow:auto;margin-top:6px}
.sticky-foot{display:flex;position:sticky;bottom:0;background:var(--ccad-panel,#1e1e1e);padding:10px 0;align-items:center;gap:14px;flex-wrap:wrap}
@media (max-width:600px){.mat-row,.mat-row.multi{grid-template-columns:minmax(0,1fr) 26px}
  .mat-row .mat-value{grid-column:1/2;grid-row:2}.mat-row .reset{grid-column:2;grid-row:2}
  .mat-subgroup{margin-left:0}}
.panel-tools .icon-btn.upload{margin-left:auto;color:var(--ccad-accent)}
.panel-tools .icon-btn.upload + input + .icon-btn{margin-left:0}
.files-table .check-col{width:40px;padding-right:0}
.narrow-only{display:none}
@media (max-width:600px){.narrow-only{display:block}.files-table .name .sub{font-size:11px;line-height:1.2}}
.files-table .check-col input{width:18px;height:18px;accent-color:var(--ccad-accent)}
.files-table tr.selected{background:rgba(255,255,255,.06)}
a.icon-btn{text-decoration:none}
.action-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 16px;
  background:rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.12);font-size:14px}
.action-bar span{margin-right:auto}
.upload-bar{padding:8px 16px;font-size:13px}
.upload-track{height:4px;background:rgba(255,255,255,.12);border-radius:2px;margin-top:6px;overflow:hidden}
.upload-track div{height:100%;background:var(--ccad-accent)}
.ask-card{border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:12px;margin:8px 0}
.ask-card p{margin:6px 0}
.ask-card .chips{margin:6px 0 0}
.printer-card{border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:12px;min-width:0;
  overflow-wrap:anywhere}
.printer-card .facts li{gap:12px}
.printer-card .facts li span:last-child{min-width:0}
.printer-card .evidence{margin:4px 0 8px;padding-left:16px}
.facts-box{margin-top:12px;border-top:1px solid rgba(255,255,255,.12);padding-top:10px}
.snippet{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);border-radius:4px;padding:8px;
  font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
.title-input{flex:1 1 auto;min-width:0;background:transparent;border:0;color:inherit;
  font:inherit;font-size:18px;padding:4px 0;border-bottom:1px dashed transparent}
.title-input:focus{outline:0;border-bottom-color:var(--ccad-accent)}
.plate-view{display:flex;flex-direction:column}
.plate-canvas{position:relative;width:100%;height:clamp(260px,48vh,480px);border-radius:6px;overflow:hidden;
  background:#26262b;border:1px solid var(--ccad-line)}
.plate-canvas canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}
.plate-note{margin:0;padding:16px;color:#ddd;font-size:13px}
.plate-note p{margin:0 0 10px}
.material-check{display:flex;flex-direction:column;gap:6px;margin:8px 0}
.material-check .check{display:flex;gap:8px;align-items:center;font-size:14px}
.material-check .check input{width:20px;height:20px;flex:none}
.material-other{display:flex;flex-direction:column;gap:4px}
.gl-lost{padding:16px;color:#ddd;font-size:13px}
.gl-lost p{margin:0 0 10px}
.plate-list{position:absolute;top:8px;right:8px;display:flex;flex-direction:column;gap:6px;
  max-height:calc(100% - 56px);overflow-y:auto;scrollbar-width:none}
.plate-list button{width:38px;height:38px;flex:0 0 auto;border-radius:6px;border:1px solid rgba(255,255,255,.25);
  background:rgba(30,32,36,.85);color:#ddd;font-size:12px;font-weight:600}
.plate-list button[aria-selected="true"]{border-color:var(--ccad-accent);background:var(--ccad-accent);color:#fff}
.plate-tools{position:absolute;left:8px;bottom:8px;right:8px;display:flex;gap:4px;flex-wrap:wrap;pointer-events:none}
.plate-tools button{pointer-events:auto;display:inline-flex;align-items:center;gap:4px;background:rgba(30,32,36,.88);
  border:1px solid rgba(255,255,255,.2);color:#ddd;border-radius:6px;padding:5px 9px;font-size:12px}
.plate-tools button.on{background:var(--ccad-accent);border-color:var(--ccad-accent);color:#fff}
.plate-tools button:disabled{opacity:.6}
.plate-list.left{right:auto;left:8px;top:30px}
.layer-slider{position:absolute;right:8px;top:8px;bottom:52px;width:46px;display:flex;flex-direction:column;
  align-items:center;gap:4px}
.layer-slider input{flex:1 1 auto;min-height:0;width:30px;margin:0;writing-mode:vertical-lr;direction:rtl;
  touch-action:none;accent-color:var(--ccad-accent)}
.layer-track{position:relative;flex:1 1 auto;min-height:0;display:flex;justify-content:center}
.layer-track input{height:100%}
.layer-mark{position:absolute;left:-2px;width:12px;height:6px;margin-bottom:-3px;border:0;border-radius:2px;padding:0;
  cursor:pointer;background:#f6ad55}
.layer-mark.filament{background:#63b3ed}
.marker-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}
.marker-list{list-style:none;margin:0 0 8px;padding:0;font-size:13px}
.marker-list li{display:flex;align-items:center;gap:8px;padding:4px 0}
.marker-list .dot{width:10px;height:10px;border-radius:2px;background:#f6ad55;flex:0 0 auto}
.marker-list .dot.filament{background:#63b3ed}
.layer-label{font-size:11px;color:#ddd;background:rgba(30,32,36,.88);border-radius:4px;padding:2px 5px;
  text-align:center;line-height:1.2;min-width:34px}
.layer-label small{display:block;opacity:.7;font-size:10px}
.legend{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.legend button{display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid var(--ccad-line);
  color:inherit;border-radius:999px;padding:3px 9px;font-size:12px}
.legend button[aria-pressed="false"]{opacity:.4;text-decoration:line-through}
.legend .swatch{width:10px;height:10px;border-radius:2px}
.sel-tools{position:absolute;left:8px;top:28px;right:56px;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.sel-tools button,.turn-by button{display:inline-flex;align-items:center;gap:4px;background:rgba(30,32,36,.9);
  border:1px solid rgba(255,255,255,.22);color:#ddd;border-radius:6px;padding:5px 9px;font-size:12px}
.sel-tools button.on{background:var(--ccad-accent);border-color:var(--ccad-accent);color:#fff}
.sel-tools button:disabled{opacity:.5}
.sel-name{font-size:12px;color:#fff;background:rgba(30,32,36,.9);border-radius:6px;padding:5px 9px;max-width:140px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.turn-by{display:inline-flex;gap:2px}
.turn-by input{width:52px;background:rgba(30,32,36,.9);border:1px solid rgba(255,255,255,.22);color:#ddd;
  border-radius:6px;padding:4px 6px;font-size:12px}
.sel-tools .snap{font-size:12px;color:#ddd;background:rgba(30,32,36,.9);border-radius:6px;padding:4px 8px;
  display:inline-flex;gap:4px;align-items:center}
.spacing-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;font-size:13px}
.spacing-row .num{display:flex;align-items:center;gap:6px}
.spacing-row input{width:80px;text-align:right;background:var(--ccad-input);color:inherit;border:1px solid var(--ccad-line);
  border-radius:6px;padding:6px 8px;font:inherit}
.spacing-row .unit{font-size:12px;opacity:.6}
.projects-home{padding-bottom:16px}
.home-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;padding:16px}
.home-action{display:flex;align-items:center;gap:12px;text-align:left;background:var(--ccad-card);color:inherit;
  border:1px solid var(--ccad-line);border-radius:8px;padding:12px 14px}
.home-action:hover{border-color:var(--ccad-accent)}
.home-action:disabled{opacity:.6}
.home-action strong{display:block;font-weight:500}
.home-icon{width:40px;height:40px;flex:0 0 auto;border-radius:8px;display:flex;align-items:center;justify-content:center;
  background:var(--ccad-accent);color:#fff;font-size:24px;line-height:1}
.home-head{display:flex;align-items:center;gap:8px;padding:0 16px 8px}
.home-head h3{margin:0;font-size:15px;font-weight:500;flex:1 1 auto}
.home-search{max-width:220px;flex:0 1 220px;min-width:0}
.home-head h3{white-space:nowrap}
.project-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0 16px}
@media (min-width:700px){.project-grid{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}}
.project-card{position:relative;display:flex;flex-direction:column;border:1px solid var(--ccad-line);border-radius:8px;
  overflow:hidden;background:var(--ccad-card)}
.project-card:hover{border-color:var(--ccad-accent)}
.project-open{display:flex;flex-direction:column;gap:2px;background:transparent;border:0;color:inherit;text-align:left;
  padding:0 0 8px;min-width:0}
.project-thumb{display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;background:#26262b;
  color:rgba(255,255,255,.35);margin-bottom:6px}
.project-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.project-name{padding:0 10px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-open .sub{padding:0 10px}
.project-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-actions{position:absolute;top:6px;right:6px;display:flex;gap:4px}
.project-actions .icon-btn{background:rgba(30,32,36,.85)}
.folder-picker{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;max-width:100%}
.folder-root{font-size:13px;opacity:.7}
.folder-picker select,.folder-picker input{background:var(--ccad-input);color:inherit;border:1px solid var(--ccad-line);
  border-radius:6px;padding:6px 8px;font:inherit;min-width:0;max-width:220px}
.send-to{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 2px}
.setting-select{background:var(--ccad-input);color:inherit;border:1px solid var(--ccad-line);border-radius:6px;
  padding:7px 8px;font:inherit;max-width:100%}
.proc-save{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0 6px}
.proc-save input{flex:1 1 140px;min-width:0;background:var(--ccad-input);color:inherit;border:1px solid var(--ccad-line);
  border-radius:6px;padding:5px 8px;font:inherit}
.orca-presets .foot{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 6px}
.import-preview{border:1px solid var(--ccad-line);border-radius:6px;padding:10px 12px;margin:6px 0}
.import-preview ul{list-style:none;margin:8px 0;padding:0}
.import-preview li{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.import-preview li.skip{opacity:.55}
.import-preview .name{font-weight:500}
.import-preview .sub{flex:1 1 100%}
.tag{font-size:11px;border-radius:4px;padding:1px 6px;background:var(--ccad-input)}
.tag.profile{background:rgba(66,153,225,.25)}
.tag.material{background:rgba(237,137,54,.25)}
.update-ready{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;text-align:left}
.update-ready p{margin:0;flex:1 1 200px}
.notice ul{margin:4px 0 8px;padding-left:20px;display:flex;flex-direction:column;gap:6px}
.notice p{margin:4px 0}
.share-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;text-align:left}
.share-banner p{margin:0;flex:1 1 220px}
.share-card{border:1px solid var(--ccad-line);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.share-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.share-details .facts li.setting span:first-child{min-width:0;opacity:.7}
.share-details .facts code{font-size:11px}
.share-perm .code{font-size:26px;letter-spacing:3px;font-weight:600;margin:6px 0}
.outbox-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.outbox-line p{margin:0;flex:1 1 200px;color:#f6ad55;opacity:1}
.composer{border-top:1px solid var(--ccad-line);padding-top:8px;display:flex;flex-direction:column;gap:6px}
.composer textarea{width:100%;min-width:0;background:var(--ccad-input);color:inherit;border:1px solid var(--ccad-line);
  border-radius:6px;padding:8px;font:inherit;resize:vertical}
.photo-row{display:flex;gap:6px;flex-wrap:wrap}
.photo{position:relative;width:76px;height:76px;border-radius:6px;overflow:hidden;border:1px solid var(--ccad-line)}
.photo img{width:100%;height:100%;object-fit:cover;display:block}
.photo .icon-btn{position:absolute;top:2px;right:2px;background:rgba(0,0,0,.6);padding:0 5px}
.photo .tag{position:absolute;left:2px;bottom:2px;font-size:10px}
.photo.add{display:flex;align-items:center;justify-content:center;background:var(--ccad-card);color:inherit;
  border:1px dashed var(--ccad-line);font-size:12px}
.check{display:flex;gap:6px;align-items:center}
.tl-preview{width:100%;max-height:240px;border-radius:6px;background:#000}
.plate-warn{color:#f6ad55;opacity:1;margin:6px 0 0}
@media (max-width:600px){.sel-tools .turn-by{display:none}.sel-name{max-width:90px}}
.plate-count{position:absolute;left:10px;top:8px;font-size:11px;color:#ccc;opacity:.8;pointer-events:none}

.slicer{background:var(--ccad-panel,#1e1e1e);border-radius:4px}
.slicer-head{display:flex;align-items:center;gap:8px;min-height:52px;padding:6px 12px;flex-wrap:wrap;
  border-bottom:1px solid var(--ccad-line)}
.slicer-head .title-input{flex:1 1 120px}
.seg{display:inline-flex;border:1px solid var(--ccad-line);border-radius:6px;overflow:hidden}
.seg button{background:transparent;border:0;color:inherit;padding:6px 14px;font-size:13px;opacity:.75}
.seg button[aria-selected="true"]{background:var(--ccad-accent);color:#fff;opacity:1}
.seg button:disabled{opacity:.35;cursor:default}
.slicer-go{display:none;gap:6px}
.slicer-body{display:flex;flex-direction:column;gap:12px;padding:12px}
.slicer-stage,.slicer-side{display:flex;flex-direction:column;gap:8px;min-width:0}
.slicer-bar{position:sticky;bottom:0;z-index:2;display:flex;gap:8px;padding:10px 12px;
  background:var(--ccad-panel,#1e1e1e);border-top:1px solid var(--ccad-line);border-radius:0 0 4px 4px}
.slicer-bar .btn{flex:1 1 auto}
@media (min-width:900px){
  .slicer-go{display:flex}
  .slicer-bar{display:none}
  .slicer-body{display:grid;grid-template-columns:320px minmax(0,1fr);align-items:start}
  .slicer-side{order:-1}
  .slicer-stage{position:sticky;top:12px}
  .slicer .plate-canvas{height:calc(100vh - 230px);min-height:420px;max-height:none}
}
.sec{border:1px solid var(--ccad-line);border-radius:6px}
.sec summary{display:flex;align-items:baseline;gap:8px;padding:9px 12px;cursor:pointer;font-weight:500;list-style:none}
.sec summary::-webkit-details-marker{display:none}
.sec summary::before{content:'▾';opacity:.6;font-size:11px}
.sec:not([open]) summary::before{content:'▸'}
.sec summary .sub{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400}
.sec-body{padding:0 12px 12px;display:flex;flex-direction:column;gap:6px}
.sec-body .field label{display:block;font-size:12px;opacity:.7;margin:4px 0 6px}
.sec-body .chips{margin:0}
.side-row{display:flex;flex-direction:column}
.filament{display:flex;align-items:center;gap:8px}
.swatch{width:20px;height:20px;border-radius:4px;flex:0 0 auto;border:1px solid rgba(255,255,255,.3)}
.filament select{flex:1 1 auto;min-width:0;background:var(--ccad-input);color:inherit;
  border:1px solid var(--ccad-line);border-radius:6px;padding:7px 8px;font:inherit}
.subtabs{display:flex;border-bottom:1px solid var(--ccad-line);margin-bottom:4px;overflow-x:auto;scrollbar-width:none}
.subtabs button{background:transparent;border:0;border-bottom:2px solid transparent;color:inherit;
  padding:6px 10px;font-size:13px;opacity:.7;flex:0 0 auto}
.subtabs button[aria-selected="true"]{border-bottom-color:var(--ccad-accent);opacity:1}
.proc{display:flex;flex-direction:column;gap:2px}
.proc-preset{display:flex;gap:8px;align-items:center;margin-bottom:6px}
.proc select,.proc input[type=number]{background:var(--ccad-input);color:inherit;border:1px solid var(--ccad-line);
  border-radius:6px;padding:6px 8px;font:inherit;min-width:0}
.proc-preset select{flex:1 1 auto}
.proc-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,150px) 28px;align-items:center;gap:8px;
  padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.proc-row label{font-size:13px;opacity:.85;overflow:hidden;text-overflow:ellipsis}
.proc-row select{width:100%}
.proc-row .num{display:flex;align-items:center;gap:6px}
.proc-row .num input{width:100%;text-align:right}
.proc-row .unit{font-size:12px;opacity:.6;min-width:18px}
.proc-row.changed input,.proc-row.changed select{border-color:#e9a23b}
.proc-row .reset{background:transparent;border:0;color:#e9a23b;font-size:16px;padding:0}
.proc-row .reset:disabled{visibility:hidden}
.proc .switch{width:18px;height:18px;justify-self:start;accent-color:var(--ccad-accent)}
.subtabs .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#e9a23b;margin-left:5px;vertical-align:middle}
.preview-summary{border:1px solid var(--ccad-line);border-radius:6px;padding:10px 12px}
.plate-result.current{border-left:2px solid var(--ccad-accent);padding-left:8px}
.preview-summary a.sub{display:inline-block;margin-top:6px}
.plate-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.08)}
.plate-row .name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stepper{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto}
.plate-result{border-top:1px solid rgba(255,255,255,.12);padding-top:6px;margin-top:6px}
.picker{border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:10px;margin-top:8px}
.picker-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.picker-row{display:flex;align-items:center;gap:8px;padding:6px 0}
.picker-row .name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files-table tr.clickable{cursor:pointer}
.sent.confirm{border-color:var(--ccad-accent);box-shadow:0 0 0 1px var(--ccad-accent) inset}
.confirm-title{display:block;margin-bottom:4px}
.sent .acts{display:flex;gap:8px;flex-wrap:wrap}
.tab.unavailable{opacity:.45}

/* Phones: tap targets last, so they win over the sizes above. */
@media (max-width:600px){.btn.sm{min-height:36px;padding:6px 12px}.icon-btn.sm{width:36px;height:36px}
  .link-btn{min-height:32px}.panel-body{padding:12px 10px}
  .grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
  .files .sz.size{display:none}}
`;
