import {
  CLASSES, TOWERS, TOWER_LEVEL_MAX, TOWER_UPGRADE, TOWER_SPECIALS,
  CRYSTAL_BREACH_LIMIT, NAME_MAX,
  PETS, PET, petXpNext, petEffects,
  WEAPONS, WEAPON_TIER_MAX, CLASS_WEAPONS,
  weaponEffects, weaponUpgradeCost,
} from './config.js';
import {
  t, applyStaticI18n, getLang, setLang, onLangChange,
  className, classBlurb, classWeaponName, powerName, powerDesc,
  petName, petBlurb, petEffectText, weaponName, weaponBlurb, weaponStatText,
  tierName, towerName, towerSpecName, towerSpecDesc,
} from './i18n.js';
import { sfx, setSfxVolume } from './audio.js';
import { normalizeRoomCode } from './utils.js';
import { icon, mountIcons, mountFlags } from './icons.js';
import { settings } from './settings.js';
import { music } from './music.js';
import { isInstalled, hasNativePrompt, promptInstall, onInstallChange } from './pwa.js';
import { loadRoster, saveRoster, defaultCharacter, petRefOf, grantPetXp, loadoutOf } from './character.js';
import { getSlots } from './render/customize.js';

// class accent colours (mirror the 3D CLASS_TINT) used to tint the
// class glyph in the roster, lobby and HUD chrome
const CLASS_COLORS = {
  berserker: '#ff6a4d', tanker: '#6a9cff', archer: '#7de87d', mage: '#c07dff',
};

// per-class stat bars for the character screen (labels are localized keys
// under statbar.*; kept here so the DOM layer owns its own copy)
const STAT_BARS = {
  berserker: [['atk', 0.95], ['def', 0.55], ['rng', 0.2], ['spd', 0.6]],
  tanker: [['atk', 0.5], ['def', 0.95], ['rng', 0.2], ['spd', 0.4]],
  archer: [['atk', 0.5], ['def', 0.25], ['rng', 0.8], ['spd', 0.95]],
  mage: [['atk', 0.5], ['def', 0.5], ['rng', 1], ['spd', 0.6]],
};

function randomHex() {
  const h = Math.random(), s = 0.5 + Math.random() * 0.4, l = 0.42 + Math.random() * 0.26;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const $ = (id) => document.getElementById(id);

// Some HUD buttons (jump, skill, build cards, start-wave) must react
// even while a finger is already holding the movement joystick down
// elsewhere on screen. Browsers only synthesize a `click` event from
// the FIRST touch point active on the page — a second simultaneous
// finger gets touchstart/touchend on its own target but no click,
// which silently ate taps on any HUD button while moving. Pointer
// events don't share that limitation: every touch gets its own
// independent pointerdown regardless of how many other fingers are
// down, so trigger on that (falling back to click for keyboard/
// assistive-tech activation, which never fires pointerdown).
const bindTap = (el, fn) => {
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    fn();
  });
  el.addEventListener('click', fn);
};

// real render of the 3D model (Kenney preview) instead of a generic glyph
const entityImg = (name) =>
  `<img class="entity-img" src="${import.meta.env.BASE_URL || './'}img/${name}.png" alt="">`;

const petImgSrc = (petId) =>
  `${import.meta.env.BASE_URL || './'}img/pets/animal-${petId}.png`;

// the weapon's preview render for its upgrade tier (0 base / 1 gold /
// 2 crystal) — the 3D model, and thus the print, changes on upgrade
const weaponImgSrc = (weaponId, tier = 0) =>
  `${import.meta.env.BASE_URL || './'}img/weapons/${weaponId}${['', '-g', '-c'][tier] || ''}.png`;

// tier badge chip (Normal / Gold / Crystal)
const tierBadge = (tier) =>
  `<span class="wpn-tier t${tier}">${tierName(tier)}</span>`;

// ============================================================
// All DOM: screens, HUD, build cards, panels, toasts.
// Game logic never touches the DOM directly — it goes via UI.
// ============================================================
export class UI {
  constructor(callbacks) {
    this.cb = callbacks;
    this.roster = loadRoster();           // { chars: [...], activeId }
    this.character = this.activeChar();   // active hero { id, name, cls, colors }
    this.charDraft = null;                // working copy on the creation screen
    this.editingId = null;                // id being edited, null when creating new
    this.statsOpen = false;
    this.preview = null;                  // 3D turntable (attached after assets load)
    this.selectedItem = null;   // build card in sticky placement mode
    this.dragItem = null;       // build card mid drag & drop
    this.placePtr = 'mouse';    // pointer that picked the card (hint wording)
    this.pendingCell = null;    // two-tap confirm on touch
    this.panelCell = null;
    this.lastSnap = null;
    this.isHost = false;
    this.skillReady = false;   // gated by this character's own 30s cooldown
    this.myCls = this.character.cls;
    this.shopNear = false;     // standing at Tonho's stall (main.js feeds this)
    this.petTab = 'mine';      // pet panel tab: 'mine' | 'shop'
    this.petPanelOpen = false;
    this.petPickerCtx = null;  // active pet-picker step callback bundle
    this.ppPick = 'dog';       // selected starter in the picker
    this.ppName = '';          // typed pet name in the picker
    this.smithNear = false;    // standing at Baru's smithy (main.js feeds this)
    this.weaponTab = 'mine';   // weapon panel tab: 'mine' | 'shop'
    this.weaponPanelOpen = false;

    mountIcons();
    mountFlags();            // draw real SVG flags on the language buttons
    applyStaticI18n();       // paint every [data-i18n*] node in the current language
    this.bindStart();
    this.bindMenu();
    this.bindCharacter();
    this.bindPetPicker();
    this.bindLobby();
    this.bindHud();
    this.bindPets();
    this.bindWeapons();
    this.bindOverlays();
    this.bindSettings();
    this.bindLang();
    this.bindInstall();
    // a language change re-paints the static chrome and re-renders every
    // dynamic bit currently on screen, so the whole UI stays one language
    onLangChange(() => this.retranslate());
  }

  // wire both language switchers (start screen + settings) and reflect
  // the active language on their flag buttons
  bindLang() {
    for (const btn of document.querySelectorAll('[data-lang-switch] .lang-btn')) {
      btn.addEventListener('click', () => {
        sfx.click();
        setLang(btn.dataset.lang); // explicit pick — overrides auto-detect
      });
    }
    this.refreshLangButtons();
  }

  refreshLangButtons() {
    const lang = getLang();
    for (const btn of document.querySelectorAll('[data-lang-switch] .lang-btn')) {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    }
  }

  // "Install app" affordances: one under the language buttons on the
  // start screen, one in the settings modal. They stay visible the whole
  // time the game ISN'T installed. On click we use the browser's native
  // install prompt when we have one (Chromium, once it's offered); on
  // every other browser (iOS Safari, Firefox, or before Chrome offers
  // the prompt) there is no API to open that dialog, so we show a short
  // manual "how to install" guide instead. Once installed, both vanish.
  bindInstall() {
    const trigger = async () => {
      sfx.click();
      if (hasNativePrompt()) {
        const outcome = await promptInstall();
        // if the native prompt couldn't run after all, fall back to help
        if (outcome === null) this.showInstallHelp();
      } else {
        this.showInstallHelp();
      }
      this.refreshInstall();
    };
    $('install-btn')?.addEventListener('click', trigger);
    $('set-install')?.addEventListener('click', trigger);

    $('install-help-close')?.addEventListener('click', () => { sfx.click(); this.hide('install-help'); });
    $('install-help-ok')?.addEventListener('click', () => { sfx.click(); this.hide('install-help'); });
    $('install-help')?.addEventListener('click', (e) => {
      if (e.target === $('install-help')) this.hide('install-help');
    });

    onInstallChange(() => this.refreshInstall());
    this.refreshInstall();
  }

  // show the buttons whenever the game isn't already installed
  refreshInstall() {
    const show = !isInstalled();
    $('install-btn')?.classList.toggle('hidden', !show);
    $('install-row')?.classList.toggle('hidden', !show);
  }

  // manual install instructions, tailored to the platform, for browsers
  // that don't expose the native prompt
  showInstallHelp() {
    const el = $('install-help-steps');
    if (el) el.textContent = this.installHelpStep();
    this.show('install-help');
  }

  installHelpStep() {
    const ua = navigator.userAgent || '';
    const iOS = /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS masquerades as Mac
    const android = /android/i.test(ua);
    const coarse = matchMedia?.('(pointer: coarse)').matches;
    if (iOS) return t('install.iosSafari');
    if (android) return t('install.androidChrome');
    if (!coarse) return t('install.desktop');
    return t('install.generic');
  }

  // re-apply translations everywhere without a reload, so switching the
  // language never leaves a half-translated screen behind
  retranslate() {
    applyStaticI18n();
    this.refreshLangButtons();
    this.renderRoster();
    // re-render whatever dynamic panels are live
    if (this.charDraft) { this.renderCharInfo(); }
    if (this.petPanelOpen) this.renderPetPanel();
    if (this.weaponPanelOpen) this.renderWeaponPanel();
    if (this.petDetailOpen) this.renderPetDetail();
    if (this.statsOpen && this._lastMe) { this._statsKey = null; this.renderStats(this._lastMe); }
    if (this.selectedItem || this.dragItem) this.renderBuildHint(); // rebuild the hint text
    // one-shot texts set outside the static pass
    this._goldShown = null; this._pbName = null; this._petHudKey = null;
    if (this.lobbyPlayersCache) this.updateLobby(this.lobbyPlayersCache, this.selfIdCache);
    if (this.roomCode) {
      $('lobby-hint').textContent = this.isHost ? t('lobby.alliesMidBattle') : t('lobby.waitingHostStart');
    }
    const best = localStorage.getItem('dtc-best-wave');
    if (best) $('best-wave').textContent = t('menu.bestRun', { n: best });
  }

  // the live 3D preview is created once assets are ready (main.js)
  attachPreview(preview) { this.preview = preview; }

  // ---------------- helpers ----------------

  show(id) { $(id)?.classList.remove('hidden'); }
  hide(id) { $(id)?.classList.add('hidden'); }

  // ---------------- character roster ----------------

  activeChar() {
    const { chars, activeId } = this.roster;
    return chars.find((c) => c.id === activeId) || chars[0] || defaultCharacter();
  }

  setActiveChar(id) {
    this.roster = saveRoster(this.roster.chars, id);
    this.character = this.activeChar();
    this.myCls = this.character.cls;
    this.renderRoster();
  }

  deleteChar(id) {
    const chars = this.roster.chars.filter((c) => c.id !== id);
    let activeId = this.roster.activeId === id ? (chars[0]?.id || null) : this.roster.activeId;
    this.roster = saveRoster(chars, activeId);
    this.character = this.activeChar();
    this.renderRoster();
  }

  // paint the menu's hero roster: one card per saved hero (tap to make
  // active, edit/delete affordances), plus a "new hero" card
  renderRoster() {
    const host = $('hero-roster');
    if (!host) return;
    host.innerHTML = '';
    const { chars, activeId } = this.roster;
    const canDelete = chars.length > 1;
    for (const c of chars) {
      const card = document.createElement('button');
      card.className = 'hero-card' + (c.id === activeId ? ' active' : '');
      card.dataset.id = c.id;
      const color = CLASS_COLORS[c.cls] || 'var(--gold)';
      card.innerHTML =
        `<span class="hero-thumb" style="color:${color}">${icon('cls-' + c.cls)}</span>
         <span class="hero-meta">
           <span class="hero-name"></span>
           <span class="hero-cls">${className(c.cls)}</span>
         </span>
         <span class="hero-actions">
           <span class="hc-btn" data-act="edit" title="${t('tip.settings')}">${icon('gear')}</span>
           ${canDelete ? `<span class="hc-btn hc-del" data-act="del" title="${t('common.close')}">${icon('x')}</span>` : ''}
         </span>`;
      // names are user input — set as text, never as HTML
      card.querySelector('.hero-name').textContent = c.name.trim() || t('common.hero');
      host.appendChild(card);
    }
    const add = document.createElement('button');
    add.className = 'hero-card add-hero';
    add.dataset.id = '';
    add.innerHTML =
      `<span class="hero-thumb add-thumb">${icon('sparkle')}</span>
       <span class="hero-meta">
         <span class="hero-name">${t('menu.newHero')}</span>
         <span class="hero-cls muted">${t('menu.createCharacter')}</span>
       </span>`;
    host.appendChild(add);
  }

  // small warnings / feedback — tucked into the bottom-left corner log so
  // they never cover the field mid-wave (newest sits at the bottom)
  toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('log-toasts').appendChild(el);
    setTimeout(() => el.remove(), 2800);
    if (kind === 'error') sfx.error();
  }

  // centered announcement (only the wave banner uses this) — the one
  // message that's allowed to sit in the middle of the screen
  announce(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  // huge dramatic splash when a (mini-)boss stomps onto the field
  showBossBanner(name, flavor, mini = false) {
    const b = $('boss-banner');
    clearTimeout(this._bannerT);
    $('bb-tag').textContent = mini ? t('hud.miniBoss') : t('hud.bossIncoming');
    $('bb-name').textContent = name;
    $('bb-flavor').textContent = flavor || '';
    b.classList.remove('hidden', 'boss', 'mini');
    void b.offsetWidth; // restart the CSS animation
    b.classList.add(mini ? 'mini' : 'boss');
    this._bannerT = setTimeout(() => b.classList.add('hidden'), mini ? 2600 : 3700);
  }

  // ---------------- loading ----------------

  loadProgress(frac) {
    $('load-fill').style.width = `${Math.round(frac * 100)}%`;
    if (frac >= 1) $('load-label').textContent = t('start.ready');
  }

  // ---------------- start screen ----------------

  // the room code baked into a shared link, if any (?room=CODE)
  linkedRoom() {
    const url = new URL(location.href);
    const room = normalizeRoomCode(url.searchParams.get('room') || '');
    return room.length === 5 ? room : '';
  }

  bindStart() {
    $('start-btn-main').addEventListener('click', () => {
      sfx.click();
      // reveal the roster (returning players) or creation (first run)
      if (this.roster.chars.length) this.showMenu();
      else this.showCharacter(null);
    });
  }

  // shown once assets finish loading — a landing screen with a Play
  // button, so the player never falls straight into character creation
  showStart() {
    this.hide('menu'); this.hide('character'); this.hide('lobby'); this.hide('hud');
    this.hide('checkpoint'); this.hide('gameover'); this.hide('host-lost');
    this.show('loading');
    // the title stays put; loading and actions share one fixed-height cell,
    // so this is a pure cross-fade — the loading bar bows out and the
    // Play/lang actions fade in over the exact same spot, nothing shifts
    $('load-area').classList.add('leaving');
    $('start-area').classList.add('revealed');
    const room = this.linkedRoom();
    const invite = $('room-invite');
    if (room) {
      $('ri-code').textContent = room;
      invite.classList.remove('hidden');
    } else {
      invite.classList.add('hidden');
    }
  }

  // ---------------- menu ----------------

  bindMenu() {
    const heroName = () => this.character.name.trim() || t('common.hero');

    // roster: tap a card to make it active, its gear to edit, its × to
    // delete, or the "new hero" card to create another character
    $('hero-roster').addEventListener('click', (e) => {
      const card = e.target.closest('.hero-card');
      if (!card) return;
      const id = card.dataset.id;
      if (!id) { sfx.click(); this.showCharacter(null); return; } // add-new
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'edit') { sfx.click(); this.showCharacter(id); return; }
      if (act === 'del') { sfx.click(); this.deleteChar(id); return; }
      sfx.click();
      this.setActiveChar(id);
    });

    $('host-btn').addEventListener('click', () => {
      sfx.click();
      this.ensurePetThen(() => this.cb.onHost({ ...this.character, name: heroName() }));
    });
    $('join-btn').addEventListener('click', () => {
      sfx.click();
      const code = normalizeRoomCode($('join-code').value);
      if (code.length < 5) return this.menuError(t('menu.enterRoomCode'));
      this.ensurePetThen(() => this.cb.onJoin(code, { ...this.character, name: heroName() }));
    });
    $('join-code').addEventListener('input', (e) => {
      e.target.value = normalizeRoomCode(e.target.value);
    });

    const best = localStorage.getItem('dtc-best-wave');
    if (best) $('best-wave').textContent = t('menu.bestRun', { n: best });

    // joining via shared link (?room=CODE): make it crystal clear the
    // player is entering one specific match — hide hosting, lock the code
    const room = this.linkedRoom();
    if (room) {
      $('join-code').value = room;
      $('join-code').readOnly = true;
      $('host-btn').classList.add('hidden');
      $('menu-linked').classList.remove('hidden');
      $('menu-linked-code').textContent = room;
      $('join-label').classList.add('hidden');
      $('join-btn').innerHTML = `${icon('link')} ${t('menu.joinThisMatch')}`;
    }
  }

  menuError(msg) { $('menu-error').textContent = msg; sfx.error(); }

  showMenu() {
    this.hide('loading'); this.hide('character'); this.hide('lobby'); this.hide('hud');
    this.hide('checkpoint'); this.hide('gameover'); this.hide('host-lost'); this.hide('pet-picker');
    this.preview?.stop();
    this.renderRoster();
    this.show('menu');
  }

  // ---------------- character creation ----------------

  bindCharacter() {
    for (const card of document.querySelectorAll('.cc-card')) {
      card.addEventListener('click', () => {
        if (card.classList.contains('selected')) return;
        sfx.click();
        this.charDraft.cls = card.dataset.cls;
        this.charDraft.colors = {}; // parts differ per model — start from its defaults
        this.selectCharClass(card.dataset.cls);
        this.renderCharInfo();
        this.renderColorSlots();
        this.preview?.setClass(this.charDraft.cls, this.charDraft.colors);
      });
    }

    $('char-name').addEventListener('input', (e) => {
      this.charDraft.name = e.target.value.slice(0, NAME_MAX);
    });

    $('char-back').addEventListener('click', () => { sfx.click(); this.showMenu(); });

    $('char-random').addEventListener('click', () => {
      sfx.click();
      for (const slot of getSlots(CLASSES[this.charDraft.cls].model)) {
        this.charDraft.colors[slot.id] = randomHex();
      }
      this.renderColorSlots();
      this.preview?.setColors(this.charDraft.colors);
    });

    $('char-save').addEventListener('click', () => {
      this.charDraft.name = ($('char-name').value.trim() || t('common.hero')).slice(0, NAME_MAX);
      // a hero with no pet yet (brand new, or one saved before pets
      // existed) goes to step 2 — the pet picker — to choose & name its
      // free starter; anyone who already has pets saves straight away
      if (this.needsStarter) {
        sfx.click();
        this.openPetPicker({
          allowBack: true,
          onBack: () => this.showCharacter(this.editingId, true),
          onConfirm: (id, name) => {
            this.charDraft.pets = { ...this.charDraft.pets, [id]: { lvl: 1, xp: 0, name } };
            this.charDraft.activePet = id;
            this.commitCharDraft();
          },
        });
      } else {
        this.commitCharDraft();
      }
    });
  }

  // persist the working character draft into the roster and return to
  // the menu (the saved/created hero becomes the active one)
  commitCharDraft() {
    sfx.success();
    const chars = [...this.roster.chars];
    const i = this.editingId ? chars.findIndex((c) => c.id === this.editingId) : -1;
    if (i >= 0) chars[i] = { ...this.charDraft, id: this.editingId };
    else chars.push(this.charDraft);
    this.roster = saveRoster(chars, this.charDraft.id);
    this.character = this.activeChar();
    this.myCls = this.character.cls;
    this.showMenu();
  }

  // ---------------- pet picker (creation step 2 / legacy normalize) ----------------

  bindPetPicker() {
    $('pp-grid').addEventListener('click', (e) => {
      const card = e.target.closest('.pp-pet');
      if (!card) return;
      sfx.click();
      this.ppPick = card.dataset.pet;
      this.renderPetPicker();
    });
    $('pp-name').addEventListener('input', (e) => {
      this.ppName = e.target.value.slice(0, PET.NAME_MAX);
    });
    $('pp-back').addEventListener('click', () => {
      sfx.click();
      const ctx = this.petPickerCtx;
      this.petPickerCtx = null;
      // always tear the picker down first so it can never linger over
      // whatever comes next (menu / lobby); the × is an escape hatch too
      this.hide('pet-picker');
      ctx?.onBack?.();
    });
    $('pp-confirm').addEventListener('click', () => {
      const ctx = this.petPickerCtx;
      if (!ctx) return; // already handled — a stray second click
      const id = PETS[this.ppPick] ? this.ppPick : 'dog';
      const name = (this.ppName.trim() || petName(id)).slice(0, PET.NAME_MAX);
      this.petPickerCtx = null;
      this.hide('pet-picker');
      ctx.onConfirm?.(id, name);
    });
  }

  // ctx: { onConfirm(petId, petName), onBack?, allowBack?, intro?, confirmLabel? }
  openPetPicker(ctx) {
    this.petPickerCtx = ctx;
    this.ppPick = 'dog';
    this.ppName = '';
    this.preview?.stop();
    this.hide('loading'); this.hide('menu'); this.hide('character'); this.hide('lobby');
    this.hide('hud'); this.hide('checkpoint'); this.hide('gameover'); this.hide('host-lost');
    $('pp-back').classList.toggle('hidden', !ctx.allowBack);
    $('pp-intro').innerHTML = ctx.intro || t('pp.intro');
    $('pp-confirm').textContent = ctx.confirmLabel || t('char.saveContinue');
    $('pp-name').value = '';
    this.renderPetPicker();
    this.show('pet-picker');
  }

  renderPetPicker() {
    const grid = $('pp-grid');
    grid.innerHTML = '';
    for (const [id, def] of Object.entries(PETS)) {
      if (!def.starter) continue;
      const card = document.createElement('button');
      card.className = 'pp-pet' + (this.ppPick === id ? ' selected' : '');
      card.dataset.pet = id;
      card.innerHTML = `<img src="${petImgSrc(id)}" alt=""><span>${petName(id)}</span>`;
      grid.appendChild(card);
    }
    const pick = PETS[this.ppPick] ? this.ppPick : 'dog';
    $('pp-detail-name').textContent = petName(pick);
    $('pp-blurb').textContent = `${petBlurb(pick)} (${petEffectText(pick, 1)})`;
    $('pp-name').placeholder = t('pp.nameYour', { name: petName(pick).toLowerCase() });
  }

  // legacy heroes saved before pets existed have none; make them pick &
  // name a starter (normalizing them) before a match can start
  ensurePetThen(proceed) {
    const c = this.character;
    if (c.activePet && c.pets?.[c.activePet]) return proceed();
    this.openPetPicker({
      allowBack: false,
      confirmLabel: t('pp.confirmPet'),
      intro: t('pp.needsCompanion', { name: (c.name || '').trim() || t('common.yourHero') }),
      onConfirm: (id, name) => {
        const chars = this.roster.chars.map((ch) =>
          ch.id === c.id
            ? { ...ch, pets: { ...(ch.pets || {}), [id]: { lvl: 1, xp: 0, name } }, activePet: id }
            : ch);
        this.roster = saveRoster(chars, c.id);
        this.character = this.activeChar();
        sfx.success();
        proceed();
      },
    });
  }

  selectCharClass(cls) {
    for (const card of document.querySelectorAll('.cc-card')) {
      card.classList.toggle('selected', card.dataset.cls === cls);
    }
  }

  renderCharInfo() {
    const cls = this.charDraft.cls;
    $('ci-name').textContent = className(cls);
    $('ci-weapon').textContent = classWeaponName(cls) || '—';
    $('ci-power').textContent = powerDesc(cls) || powerName(cls) || '—';
    $('ci-blurb').textContent = classBlurb(cls);
    $('ci-stats').innerHTML = (STAT_BARS[cls] || [])
      .map(([k, v]) => `<i style="--v:${v}">${t('statbar.' + k)}</i>`).join('');
  }

  // colour circles stacked top-to-bottom, in the model's own head→feet
  // order (getSlots is already sorted that way), sitting beside the 3D view
  renderColorSlots() {
    const host = $('char-colors');
    host.innerHTML = '';
    const slots = getSlots(CLASSES[this.charDraft.cls].model);
    if (!slots.length) return;
    for (const slot of slots) {
      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'color-dot';
      input.title = slot.label;
      input.value = this.charDraft.colors[slot.id] || slot.base;
      input.addEventListener('input', (e) => {
        this.charDraft.colors[slot.id] = e.target.value;
        this.preview?.setColors(this.charDraft.colors);
      });
      host.appendChild(input);
    }
  }

  // id = edit that hero; null/undefined = create a fresh one.
  // keepDraft = returning from the step-2 pet picker: keep the working
  // draft (class/colours/name) exactly as the player left it.
  showCharacter(id = null, keepDraft = false) {
    this.editingId = id;
    if (!keepDraft) {
      const src = id ? this.roster.chars.find((c) => c.id === id) : null;
      // work on a copy so "Save" is an explicit commit — pets/coins ride
      // along untouched so editing can never wipe them
      this.charDraft = src
        ? {
            id: src.id, name: src.name, cls: src.cls, colors: { ...src.colors },
            pets: JSON.parse(JSON.stringify(src.pets || {})),
            activePet: src.activePet, coins: src.coins,
          }
        : defaultCharacter();
      // a hero with no pet (brand new, or one saved before pets existed)
      // is routed through the step-2 pet picker when it saves
      this.needsStarter = !Object.keys(this.charDraft.pets || {}).length;
    }
    this.hide('loading'); this.hide('menu'); this.hide('lobby'); this.hide('hud'); this.hide('pet-picker');
    this.hide('checkpoint'); this.hide('gameover'); this.hide('host-lost');
    // returning to the menu is only allowed once at least one hero exists
    $('char-back').classList.toggle('hidden', this.roster.chars.length === 0);
    $('char-name').value = this.charDraft.name;
    // a hero's class is permanent: when editing, only that class shows —
    // the other three are hidden so it can never be swapped
    const editing = !!id;
    $('char-class-grid').classList.toggle('locked', editing);
    for (const card of document.querySelectorAll('.cc-card')) {
      card.classList.toggle('hidden', editing && card.dataset.cls !== this.charDraft.cls);
    }
    this.selectCharClass(this.charDraft.cls);
    this.renderCharInfo();
    this.renderColorSlots();
    this.show('character');
    this.preview?.setClass(this.charDraft.cls, this.charDraft.colors);
    this.preview?.start();
  }

  // ---------------- lobby ----------------

  bindLobby() {
    $('copy-code').addEventListener('click', async () => {
      sfx.click();
      try {
        await navigator.clipboard.writeText(this.roomCode);
        this.toast(t('lobby.codeCopied'), 'gold');
      } catch { this.toast(this.roomCode, 'gold'); }
    });
    $('share-code').addEventListener('click', async () => {
      sfx.click();
      const url = `${location.origin}${location.pathname}?room=${this.roomCode}`;
      if (navigator.share) {
        navigator.share({ title: 'Defend the Crystal', text: t('lobby.shareText', { code: this.roomCode }), url }).catch(() => {});
      } else {
        try { await navigator.clipboard.writeText(url); this.toast(t('lobby.inviteCopied'), 'gold'); }
        catch { this.toast(url, 'gold'); }
      }
    });
    $('start-btn').addEventListener('click', () => { sfx.success(); this.cb.onStartMatch(); });
    $('leave-btn').addEventListener('click', () => this.cb.onLeaveLobby());
  }

  showLobby(code, isHost) {
    this.roomCode = code;
    this.isHost = isHost;
    this.preview?.stop();
    this.hide('menu'); this.hide('character'); this.hide('pet-picker');
    this.show('lobby');
    $('room-code').textContent = code;
    $('start-btn').classList.toggle('hidden', !isHost);
    $('lobby-hint').textContent = isHost
      ? t('lobby.alliesMidBattle')
      : t('lobby.waitingHostStart');
  }

  updateLobby(players, selfId) {
    this.lobbyPlayersCache = players;   // kept so a language switch can re-render
    this.selfIdCache = selfId;
    const list = $('player-list');
    list.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      const color = CLASS_COLORS[p.cls] || 'var(--gold)';
      li.innerHTML = `<span class="pl-cls" style="color:${color}">${icon('cls-' + p.cls)}</span>
        <span class="pl-name"></span>
        <span class="pl-tag">${className(p.cls)}${p.host ? ` · ${t('common.host')}` : ''}${p.id === selfId ? ` · ${t('common.you')}` : ''}</span>`;
      li.querySelector('.pl-name').textContent = p.name;
      list.appendChild(li);
    }
    $('lobby-status').textContent = t('lobby.defenders', { n: players.length });
  }

  // ---------------- HUD ----------------

  bindHud() {
    this.bindBuildCards();
    // the hint bar doubles as a big cancel button
    $('build-hint').addEventListener('click', () => this.selectItem(null));
    for (const [key, def] of Object.entries(TOWERS)) {
      const el = document.querySelector(`[data-cost="${key}"]`);
      if (el) el.textContent = def.cost;
    }
    bindTap($('startwave-btn'), () => {
      sfx.click();
      this.cb.onAction({ t: 'start' });
    });
    bindTap($('jump-btn'), () => this.cb.onJump?.());
    bindTap($('skill-btn'), () => this.cb.onSkill?.());
    $('room-chip').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(this.roomCode); this.toast(t('lobby.codeCopied'), 'gold'); } catch { /* ok */ }
    });

    // tap the class badge to open the live character stats sheet
    $('pb-class').addEventListener('click', () => { sfx.click(); this.openStats(); });
    $('stats-close').addEventListener('click', () => { sfx.click(); this.closeStats(); });
    $('stats-panel').addEventListener('click', (e) => {
      if (e.target === $('stats-panel')) this.closeStats();
    });

    $('upg-btn').addEventListener('click', () => {
      if (this.panelCell) {
        sfx.click();
        const upgrading = this.panelType === 'tower';
        this.cb.onAction({ t: upgrading ? 'upg' : 'remove', ...this.panelCell });
        // stay open on upgrade — the panel refreshes itself every frame
        // from the live snapshot, so allies can queue upgrades back to back
        if (!upgrading) this.closePanel();
      }
    });
    $('sell-btn').addEventListener('click', () => {
      if (this.panelCell) {
        sfx.click();
        this.cb.onAction({ t: 'sell', ...this.panelCell });
        this.closePanel();
      }
    });
    $('close-upg').addEventListener('click', () => { sfx.click(); this.closePanel(); });
  }

  showHud() {
    this.hide('menu'); this.hide('lobby'); this.hide('pet-picker');
    this.show('hud');
    $('room-label').textContent = this.roomCode || '';
  }

  // lit only while the character faces a grid cell it can vault over
  setJumpEnabled(on) {
    $('jump-btn').disabled = !on;
  }

  // ---------------- placing towers & blocks ----------------
  //
  // Two ways to put something on the grid, both starting from a card:
  //  1. press & DRAG the card — the item rides the pointer as a ghost
  //     over the grid and drops on release (one placement per drag);
  //  2. TAP the card — sticky placement mode: on desktop the ghost
  //     follows the mouse and a click confirms; on touch the first tap
  //     previews a tile and a second tap on it confirms.

  bindBuildCards() {
    const DRAG_PX = 10; // movement below this is still a tap
    let drag = null;    // { item, id, sx, sy, started }
    // Esc (and game-over) can abort a drag mid-gesture; the leftover
    // pointer events are ignored because `drag` is already gone
    this.cancelDrag = () => {
      if (!drag) return;
      const started = drag.started;
      drag = null;
      if (started) this.finishDrag(null);
    };
    for (const card of document.querySelectorAll('.build-card')) {
      card.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (drag) return; // one drag at a time — a second finger is ignored
        e.preventDefault();
        drag = {
          item: card.dataset.item, id: e.pointerId,
          sx: e.clientX, sy: e.clientY, started: false,
        };
        // keep every move/up on the card even when the pointer crosses
        // onto the canvas (otherwise the joystick would grab the touch)
        try { card.setPointerCapture(e.pointerId); } catch { /* ok */ }
      });
      card.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (!drag.started) {
          if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < DRAG_PX) return;
          drag.started = true;
          this.startDrag(drag.item);
        }
        this.cb.onDragMove?.(e.clientX, e.clientY);
      });
      const up = (e, cancelled) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        if (d.started) {
          this.finishDrag(cancelled ? null : { x: e.clientX, y: e.clientY });
        } else if (!cancelled) {
          // a plain tap toggles sticky placement mode
          this.selectItem(this.selectedItem === d.item ? null : d.item, e.pointerType);
        }
      };
      card.addEventListener('pointerup', (e) => up(e, false));
      card.addEventListener('pointercancel', (e) => up(e, true));
      // pointer-driven activation is fully handled above, but the browser
      // still synthesizes a click after pointerup — possibly SECONDS later
      // on a busy main thread, so a timing window can't filter it. Accept
      // only non-pointer clicks (keyboard / assistive tech: no pointerType,
      // detail 0), which never fire pointerdown.
      card.addEventListener('click', (e) => {
        if (e.pointerType || e.detail > 0) return;
        this.selectItem(this.selectedItem === card.dataset.item ? null : card.dataset.item);
      });
    }
  }

  startDrag(item) {
    // a sticky selection from before gives way to the drag
    if (this.selectedItem) this.selectItem(null, null, { silent: true });
    this.dragItem = item;
    this.pendingCell = null;
    this.closePanel();
    sfx.toggle(true);
    for (const card of document.querySelectorAll('.build-card')) {
      card.classList.toggle('dragging', card.dataset.item === item);
    }
    this.cb.onBuildMode(true);
    this.renderBuildHint();
  }

  // drop = {x, y} on release, or null when the drag was cancelled
  finishDrag(drop) {
    const item = this.dragItem;
    if (!item) return;
    this.dragItem = null;
    for (const card of document.querySelectorAll('.build-card')) {
      card.classList.remove('dragging');
    }
    this.cb.onDragEnd?.(item, drop);
    this.cb.onBuildMode(false);
    this.renderBuildHint();
  }

  selectItem(item, pointerType = null, opts = {}) {
    this.selectedItem = item;
    // the hint's wording depends on how placement will be confirmed —
    // remember which pointer picked the card (keyboard shortcuts fall
    // back to the device's primary pointer)
    if (item) {
      this.placePtr = pointerType && pointerType !== 'pen'
        ? pointerType
        : (matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse');
    }
    this.pendingCell = null;
    this.closePanel();
    if (!opts.silent) sfx.toggle(!!item);
    for (const card of document.querySelectorAll('.build-card')) {
      card.classList.toggle('selected', card.dataset.item === item);
    }
    this.cb.onBuildMode(!!item);
    this.renderBuildHint();
  }

  // the placement hint bar, tucked into the bottom-left corner with the
  // rest of the feedback messages; doubles as a big cancel button (also
  // rebuilt on a language switch)
  renderBuildHint() {
    const hint = $('build-hint');
    const item = this.dragItem || this.selectedItem;
    $('hud').classList.toggle('placing', !!item);
    if (!item) { hint.classList.add('hidden'); return; }
    hint.classList.remove('hidden');
    const label = item === 'obstacle'
      ? t('card.obstacle')
      : `${towerName(item)} (${icon('gem')}${TOWERS[item].cost})`;
    const key = this.dragItem
      ? 'hud.dragHint'
      : this.placePtr === 'touch' ? 'hud.placeTapHint' : 'hud.placeClickHint';
    // the message must be ONE flex item — bare text nodes around the
    // inline gem icon would each become their own item and wrap apart
    hint.innerHTML =
      `<span class="hint-x">${icon('x')}</span><span class="hint-msg">${t(key, { name: label })}</span>`;
  }

  selectCardByIndex(i) {
    const items = ['obstacle', 'ballista', 'catapult', 'cannon', 'crystal', 'flame'];
    this.selectItem(this.selectedItem === items[i] ? null : items[i]);
  }

  // upgrade/remove panel for an existing structure
  openPanel(info) {
    this.panelCell = { c: info.c, r: info.r };
    this.panelType = info.type;
    if (info.type === 'tower') {
      this.renderTowerPanel(info.kind, info.lvl, info.spec);
    } else {
      $('upg-title').innerHTML = `${entityImg('block')} ${t('upg.block')}`;
      $('upg-stats').textContent = t('upg.reclaimBlock');
      $('upg-btn').textContent = t('upg.remove');
      $('upg-btn').disabled = false;
      $('upg-specials').innerHTML = '';
      delete $('upg-specials').dataset.sig;
      $('sell-btn').classList.add('hidden');
    }
    this.show('upgrade-panel');
  }

  // (re)paints the tower upgrade panel — called on open and every frame
  // while it's up, so the cost/afford state always tracks live coins
  renderTowerPanel(kind, lvl, spec = 0) {
    const def = TOWERS[kind];
    const stat = (mult, add = 0) => (base) => base * Math.pow(mult, lvl - 1) + add * (lvl - 1);
    const dmg = Math.round(stat(TOWER_UPGRADE.dmgMult)(def.dmg));
    // the crystal's "range" IS its growing pulse area
    const grows = def.aoeGrow || 0;
    const rng = def.pulse
      ? (def.aoe + grows * (lvl - 1)).toFixed(1)
      : (def.range + TOWER_UPGRADE.rangeAdd * (lvl - 1)).toFixed(1);
    const spd = (def.rate * Math.pow(TOWER_UPGRADE.rateMult, lvl - 1)).toFixed(2);
    const dmgLbl = t('upg.damage');
    const rngLbl = def.pulse ? t('upg.pulseArea') : t('upg.range');
    const spdLbl = t('upg.speed');
    $('upg-title').innerHTML =
      `${entityImg(def.img || 'tower-' + kind)} ${t('upg.towerLevel', { name: towerName(kind), lvl })}`;
    const maxed = lvl >= TOWER_LEVEL_MAX;
    const areaTxt = def.pulse ? '' : (def.aoe ? `\n${t('upg.area')} ${def.aoe}` : '');
    if (maxed) {
      $('upg-stats').textContent =
        `${dmgLbl} ${dmg} · ${rngLbl} ${rng} · ${spdLbl} ${spd}/s` +
        areaTxt.replace('\n', ' · ');
    } else {
      const nDmg = Math.round(def.dmg * Math.pow(TOWER_UPGRADE.dmgMult, lvl));
      const nRng = def.pulse
        ? (def.aoe + grows * lvl).toFixed(1)
        : (def.range + TOWER_UPGRADE.rangeAdd * lvl).toFixed(1);
      const nSpd = (def.rate * Math.pow(TOWER_UPGRADE.rateMult, lvl)).toFixed(2);
      $('upg-stats').textContent =
        `${dmgLbl} ${dmg} ➜ ${nDmg}\n${rngLbl} ${rng} ➜ ${nRng}` +
        `\n${spdLbl} ${spd}/s ➜ ${nSpd}/s` + areaTxt;
    }
    const cost = maxed ? 0 : Math.round(def.cost * TOWER_UPGRADE.costMult[lvl]);
    $('upg-btn').innerHTML = maxed ? t('upg.maxLevel') : t('upg.upgradeCost', { cost: `${icon('gem')}${cost}` });
    $('upg-btn').disabled = maxed || (this.lastSnap && this.lastSnap.pts < cost);
    this.renderTowerSpecials(kind, spec);
    $('sell-btn').classList.remove('hidden');
    $('sell-btn').textContent = t('upg.sell');
  }

  // special effects (bonus upgrades): bought once, on top of levels —
  // never instead of them. Two options are an exclusive choice.
  renderTowerSpecials(kind, spec) {
    const box = $('upg-specials');
    const defs = TOWER_SPECIALS[kind];
    if (!defs) { box.innerHTML = ''; return; }
    // avoid trashing the DOM (and button taps) on the per-frame repaint
    const sig = `${kind}:${spec}:${this.lastSnap?.pts | 0}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    if (spec) {
      box.innerHTML = `<div class="spec-owned">✦ ${towerSpecName(kind, spec)}<span class="muted"> — ${towerSpecDesc(kind, spec)}</span></div>`;
      return;
    }
    box.innerHTML = Object.entries(defs).map(([id, d]) => {
      const afford = !this.lastSnap || this.lastSnap.pts >= d.cost;
      return `<button class="btn small spec-btn" data-spec="${id}" ${afford ? '' : 'disabled'}>
        <b>${towerSpecName(kind, id)}</b> ${icon('gem')}${d.cost}<span class="spec-desc muted">${towerSpecDesc(kind, id)}</span>
      </button>`;
    }).join('');
    for (const b of box.querySelectorAll('.spec-btn')) {
      b.addEventListener('click', () => {
        if (!this.panelCell) return;
        sfx.click();
        this.cb.onAction({ t: 'spec', ...this.panelCell, spec: b.dataset.spec });
      });
    }
  }

  closePanel() {
    this.panelCell = null;
    this.panelType = null;
    this.hide('upgrade-panel');
    this.cb.onPanelClose?.();
  }

  // ---------------- pets ----------------

  // write the (mutated) active character back into the persisted roster
  persistCharacter() {
    this.roster = saveRoster(this.roster.chars, this.roster.activeId);
    this.character = this.activeChar();
  }

  // the equipped pet as {id, lvl, name} — what the sim/net layer wants
  activePetInfo() { return petRefOf(this.character); }

  // gold coins picked up in a match are banked permanently, per character
  addCoins(amt) {
    this.character.coins += amt;
    this.persistCharacter();
    this._goldShown = null;
    this.toast(t(amt > 1 ? 'toast.coinsMany' : 'toast.coinsOne', { amt }), 'gold');
    if (this.petPanelOpen) this.renderPetPanel();
    if (this.weaponPanelOpen) this.renderWeaponPanel();
  }

  // XP the hero collects also feeds its companion — permanently
  grantPetXpFromPickup(amt) {
    if (!this.character.activePet) return;
    const gained = grantPetXp(this.character, amt);
    this.persistCharacter();
    if (gained > 0) {
      const pet = this.character.pets[this.character.activePet];
      if (pet) {
        this.toast(t('toast.petLevel', { name: pet.name, lvl: pet.lvl }), 'gold');
        sfx.levelUp();
        this.cb.onPetChange?.(this.activePetInfo());
      }
    }
    if (this.petPanelOpen && this.petTab === 'mine') this.renderPetPanel();
    if (this.petDetailOpen) this.renderPetDetail();
  }

  equipPet(id) {
    if (!this.character.pets[id] || this.character.activePet === id) return;
    // swapping companions is only allowed while chatting with the vendor
    if (!this.shopNear) return this.toast(t('toast.onlyTonhoSwitch'), 'error');
    this.character.activePet = id;
    this.persistCharacter();
    sfx.success();
    this.renderPetPanel();
    this.cb.onPetChange?.(this.activePetInfo());
  }

  renamePet(id, name) {
    const pet = this.character.pets[id];
    if (!pet) return;
    pet.name = (String(name).trim() || petName(id)).slice(0, PET.NAME_MAX);
    this.persistCharacter();
    this.renderPetPanel();
    if (this.character.activePet === id) this.cb.onPetChange?.(this.activePetInfo());
  }

  buyPet(id) {
    const def = PETS[id];
    if (!def || this.character.pets[id]) return;
    if (!this.shopNear) return this.toast(t('toast.visitTonhoBuy'), 'error');
    if (this.character.coins < def.price) return this.toast(t('toast.notEnoughGold'), 'error');
    this.character.coins -= def.price;
    this.character.pets[id] = { lvl: 1, xp: 0, name: petName(id) };
    const firstPet = !this.character.activePet;
    if (firstPet) this.character.activePet = id;
    this.persistCharacter();
    this._goldShown = null;
    sfx.success();
    this.toast(t('toast.petJoined', { name: petName(id) }), 'gold');
    // jump to My pets and open the name field right away so the new
    // companion never sits with a generic name
    this.petTab = 'mine';
    this.renderPetPanel();
    const card = $('pet-list').querySelector(`.pet-card[data-pet="${id}"]`);
    if (card) this.startPetRename(card, id);
    if (firstPet) this.cb.onPetChange?.(this.activePetInfo());
  }

  // main.js flips this as the hero walks up to / away from the stall.
  // The full manage/shop panel is ONLY reachable here (i.e. during
  // checkpoints, when you can roam to the vendor); walking away closes it.
  setShopNear(near) {
    if (near === this.shopNear) return;
    this.shopNear = near;
    $('petshop-prompt').classList.toggle('hidden', !near);
    if (near) sfx.notify();
    else if (this.petPanelOpen) this.closePetPanel();
    if (this.petPanelOpen) this.renderPetPanel();
  }

  bindPets() {
    // the HUD pet row only opens a read-only detail card
    bindTap($('pet-icon'), () => { sfx.click(); this.openPetDetail(); });
    $('pd-close').addEventListener('click', () => { sfx.click(); this.closePetDetail(); });
    $('pet-detail').addEventListener('click', (e) => {
      if (e.target === $('pet-detail')) this.closePetDetail();
    });
    // switching & buying live only at Tonho's stall (the shop prompt)
    bindTap($('petshop-prompt'), () => { sfx.click(); this.openPetPanel('mine'); });
    $('pet-close').addEventListener('click', () => { sfx.click(); this.closePetPanel(); });
    $('pet-panel').addEventListener('click', (e) => {
      if (e.target === $('pet-panel')) this.closePetPanel();
    });
    $('pet-tab-mine').addEventListener('click', () => { sfx.click(); this.petTab = 'mine'; this.renderPetPanel(); });
    $('pet-tab-shop').addEventListener('click', () => { sfx.click(); this.petTab = 'shop'; this.renderPetPanel(); });

    // one delegated handler covers equip / rename / buy on every card
    $('pet-list').addEventListener('click', (e) => {
      const card = e.target.closest('.pet-card');
      if (!card) return;
      const id = card.dataset.pet;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'equip') this.equipPet(id);
      else if (act === 'buy') this.buyPet(id);
      else if (act === 'rename') this.startPetRename(card, id);
    });
  }

  openPetPanel(tab = 'mine') {
    if (!this.shopNear) return; // manage/shop is vendor-only
    this.petTab = tab;
    this.petPanelOpen = true;
    this.renderPetPanel();
    this.show('pet-panel');
  }

  closePetPanel() {
    this.petPanelOpen = false;
    this.hide('pet-panel');
  }

  // read-only card for the currently-equipped pet, opened from the HUD
  openPetDetail() {
    if (!this.character.activePet) return;
    this.petDetailOpen = true;
    this.renderPetDetail();
    this.show('pet-detail');
  }

  closePetDetail() {
    this.petDetailOpen = false;
    this.hide('pet-detail');
  }

  // the HUD pet row: a smaller round pet icon under the class badge, the
  // pet name, its XP bar and level — the pet's mirror of the player row
  refreshPetHud() {
    const row = $('pet-row');
    const id = this.character.activePet;
    const pet = id && this.character.pets[id];
    if (!pet) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    if (this._petHudKey !== id) {
      this._petHudKey = id;
      $('pet-icon').innerHTML = `<img src="${petImgSrc(id)}" alt="">`;
    }
    const maxed = pet.lvl >= PET.LEVEL_CAP;
    const next = petXpNext(pet.lvl);
    $('pb-pet-name').textContent = pet.name;
    $('pb-pet-level').textContent = pet.lvl;
    $('pb-pet-xp').style.width = `${maxed ? 100 : Math.min((pet.xp / next) * 100, 100)}%`;
  }

  renderPetDetail() {
    const id = this.character.activePet;
    const pet = id && this.character.pets[id];
    if (!pet) return this.closePetDetail();
    const maxed = pet.lvl >= PET.LEVEL_CAP;
    const next = petXpNext(pet.lvl);
    $('pd-img').src = petImgSrc(id);
    $('pd-name').textContent = pet.name;
    $('pd-sub').textContent = `${petName(id)} · ${t('common.level')} ${pet.lvl}${maxed ? ` · ${t('common.max')}` : ''}`;
    $('pd-effect').textContent = petEffectText(id, pet.lvl);
    $('pd-xpfill').style.width = `${maxed ? 100 : Math.min((pet.xp / next) * 100, 100)}%`;
    $('pd-xptext').textContent = maxed ? t('petd.maxedOut') : t('petd.xpToLevel', { xp: pet.xp, next, lvl: pet.lvl + 1 });
  }

  // swap the pet's name for an inline input; Enter/blur commits
  startPetRename(card, id) {
    const span = card.querySelector('.pet-pname');
    if (!span || card.querySelector('input')) return;
    const input = document.createElement('input');
    input.maxLength = PET.NAME_MAX;
    input.value = this.character.pets[id]?.name || '';
    input.className = 'pet-rename';
    input.placeholder = petName(id);
    span.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => this.renamePet(id, input.value);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') this.renderPetPanel();
    });
    input.addEventListener('blur', commit);
  }

  renderPetPanel() {
    $('pet-gold-label').textContent = this.character.coins;
    $('pet-tab-mine').classList.toggle('active', this.petTab === 'mine');
    $('pet-tab-shop').classList.toggle('active', this.petTab === 'shop');
    $('pet-shop-hint').classList.toggle('hidden', this.petTab !== 'shop' || this.shopNear);
    const host = $('pet-list');
    host.innerHTML = '';
    if (this.petTab === 'mine') this.renderOwnedPets(host);
    else this.renderPetShop(host);
  }

  renderOwnedPets(host) {
    const owned = Object.keys(PETS).filter((id) => this.character.pets[id]);
    if (!owned.length) {
      host.innerHTML = `<div class="muted pet-empty">${t('petp.noPetsYet')}</div>`;
      return;
    }
    for (const id of owned) {
      const pet = this.character.pets[id];
      const active = this.character.activePet === id;
      const maxed = pet.lvl >= PET.LEVEL_CAP;
      const next = petXpNext(pet.lvl);
      const card = document.createElement('div');
      card.className = 'pet-card' + (active ? ' active' : '');
      card.dataset.pet = id;
      card.innerHTML =
        `<img class="pet-img" src="${petImgSrc(id)}" alt="">
         <div class="pet-meta">
           <div class="pet-name-row">
             <span class="pet-pname"></span>
             <button class="pet-edit" data-act="rename" title="${t('tip.rename')}">✎</button>
           </div>
           <div class="pet-kind">${petName(id)} · ${t('common.lvAbbr')} ${pet.lvl}${maxed ? ` <b class="pet-max">${t('common.max')}</b>` : ''}</div>
           <div class="pet-effect">${petEffectText(id, pet.lvl)}</div>
           <div class="pet-xpbar"><div class="pet-xpfill" style="width:${maxed ? 100 : Math.min((pet.xp / next) * 100, 100)}%"></div></div>
         </div>
         <div class="pet-actions">
           ${active
             ? `<span class="pet-equipped">${icon('paw')} ${t('petp.withYou')}</span>`
             : `<button class="btn small primary" data-act="equip">${t('petp.equip')}</button>`}
         </div>`;
      // pet names are user input — set as text, never as HTML
      card.querySelector('.pet-pname').textContent = pet.name;
      host.appendChild(card);
    }
  }

  renderPetShop(host) {
    const forSale = Object.entries(PETS).sort((a, b) => a[1].price - b[1].price);
    for (const [id, def] of forSale) {
      const owned = !!this.character.pets[id];
      const afford = this.character.coins >= def.price;
      const card = document.createElement('div');
      card.className = 'pet-card shop' + (owned ? ' owned' : '');
      card.dataset.pet = id;
      card.innerHTML =
        `<img class="pet-img" src="${petImgSrc(id)}" alt="">
         <div class="pet-meta">
           <div class="pet-kind">${petName(id)}${def.starter ? ` <b class="pet-starter">${t('petp.starter')}</b>` : ''}</div>
           <div class="pet-effect">${petBlurb(id)}</div>
           <div class="pet-effect muted">${t('petp.lvToLv', { a: petEffectText(id, 1), cap: PET.LEVEL_CAP, b: petEffectText(id, PET.LEVEL_CAP) })}</div>
         </div>
         <div class="pet-actions">
           ${owned
             ? `<span class="pet-equipped">${t('petp.owned')}</span>`
             : `<button class="btn small primary" data-act="buy" ${!this.shopNear || !afford ? 'disabled' : ''}>
                  ${icon('goldcoin')}${def.price}
                </button>`}
         </div>`;
      host.appendChild(card);
    }
  }

  // ---------------- weapons (Baru's smithy) ----------------

  // main.js flips this as the hero walks up to / away from the smithy.
  // Same rules as the pet stall: buying, upgrading and swapping weapons
  // is ONLY possible here (i.e. during checkpoints, when you can roam).
  setSmithNear(near) {
    if (near === this.smithNear) return;
    this.smithNear = near;
    $('weaponshop-prompt').classList.toggle('hidden', !near);
    if (near) sfx.notify();
    else if (this.weaponPanelOpen) this.closeWeaponPanel();
    if (this.weaponPanelOpen) this.renderWeaponPanel();
  }

  bindWeapons() {
    bindTap($('weaponshop-prompt'), () => { sfx.click(); this.openWeaponPanel('mine'); });
    $('weapon-close').addEventListener('click', () => { sfx.click(); this.closeWeaponPanel(); });
    $('weapon-panel').addEventListener('click', (e) => {
      if (e.target === $('weapon-panel')) this.closeWeaponPanel();
    });
    $('weapon-tab-mine').addEventListener('click', () => { sfx.click(); this.weaponTab = 'mine'; this.renderWeaponPanel(); });
    $('weapon-tab-shop').addEventListener('click', () => { sfx.click(); this.weaponTab = 'shop'; this.renderWeaponPanel(); });

    // one delegated handler covers equip / upgrade / buy on every card
    $('weapon-list').addEventListener('click', (e) => {
      const card = e.target.closest('.pet-card');
      if (!card) return;
      const id = card.dataset.weapon;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'equip') this.equipWeapon(id);
      else if (act === 'buy') this.buyWeapon(id);
      else if (act === 'upgrade') this.upgradeWeapon(id);
    });
  }

  openWeaponPanel(tab = 'mine') {
    if (!this.smithNear) return; // arsenal/shop is smith-only
    this.weaponTab = tab;
    this.weaponPanelOpen = true;
    this.renderWeaponPanel();
    this.show('weapon-panel');
  }

  closeWeaponPanel() {
    this.weaponPanelOpen = false;
    this.hide('weapon-panel');
  }

  // push the (changed) equipped loadout to the sim via main.js
  notifyLoadout() {
    this.cb.onLoadoutChange?.(loadoutOf(this.character));
  }

  equipWeapon(id) {
    const c = this.character;
    const def = WEAPONS[id];
    if (!def || !c.weapons[id]) return;
    if (!this.smithNear) return this.toast(t('toast.onlyBaruSwitch'), 'error');
    const slot = def.slot === 'shield' ? 'activeShield' : 'activeWeapon';
    if (c[slot] === id) return;
    c[slot] = id;
    this.persistCharacter();
    sfx.success();
    this.renderWeaponPanel();
    this.notifyLoadout();
  }

  buyWeapon(id) {
    const c = this.character;
    const def = WEAPONS[id];
    if (!def || c.weapons[id] || !def.classes.includes(c.cls)) return;
    if (!this.smithNear) return this.toast(t('toast.visitBaruBuy'), 'error');
    if (c.coins < def.price) return this.toast(t('toast.notEnoughGold'), 'error');
    c.coins -= def.price;
    c.weapons[id] = { tier: 0 };
    this.persistCharacter();
    this._goldShown = null;
    sfx.success();
    this.toast(t('toast.weaponAdded', { name: weaponName(id) }), 'gold');
    this.weaponTab = 'mine';
    this.renderWeaponPanel();
  }

  upgradeWeapon(id) {
    const c = this.character;
    const owned = c.weapons[id];
    if (!owned || owned.tier >= WEAPON_TIER_MAX) return;
    if (!this.smithNear) return this.toast(t('toast.visitBaruUpgrade'), 'error');
    const cost = weaponUpgradeCost(id, owned.tier);
    if (c.coins < cost) return this.toast(t('toast.notEnoughGold'), 'error');
    c.coins -= cost;
    owned.tier += 1;
    this.persistCharacter();
    this._goldShown = null;
    sfx.levelUp();
    this.toast(t('toast.weaponForged', { name: weaponName(id), tier: tierName(owned.tier) }), 'gold');
    this.renderWeaponPanel();
    // an upgraded equipped weapon changes live stats & looks
    if (c.activeWeapon === id || c.activeShield === id) this.notifyLoadout();
  }

  renderWeaponPanel() {
    $('weapon-gold-label').textContent = this.character.coins;
    $('weapon-tab-mine').classList.toggle('active', this.weaponTab === 'mine');
    $('weapon-tab-shop').classList.toggle('active', this.weaponTab === 'shop');
    $('weapon-shop-hint').classList.toggle('hidden', this.weaponTab !== 'shop' || this.smithNear);
    const host = $('weapon-list');
    host.innerHTML = '';
    if (this.weaponTab === 'mine') this.renderOwnedWeapons(host);
    else this.renderWeaponShop(host);
  }

  renderOwnedWeapons(host) {
    const c = this.character;
    const arsenal = (CLASS_WEAPONS[c.cls] || []).filter((id) => c.weapons[id]);
    for (const id of arsenal) {
      const def = WEAPONS[id];
      const owned = c.weapons[id];
      const active = c.activeWeapon === id || c.activeShield === id;
      const maxed = owned.tier >= WEAPON_TIER_MAX;
      const cost = weaponUpgradeCost(id, owned.tier);
      const afford = c.coins >= cost;
      const card = document.createElement('div');
      card.className = 'pet-card' + (active ? ' active' : '');
      card.dataset.weapon = id;
      card.innerHTML =
        `<img class="pet-img" src="${weaponImgSrc(id, owned.tier)}" alt="">
         <div class="pet-meta">
           <div class="pet-kind">${weaponName(id)} ${tierBadge(owned.tier)}</div>
           <div class="pet-effect">${weaponStatText(id, owned.tier)}</div>
           ${maxed
             ? `<div class="pet-effect muted">${t('wpnp.fullyForged')}</div>`
             : `<div class="pet-effect muted">${t('wpnp.next', { tier: tierName(owned.tier + 1), stat: weaponStatText(id, owned.tier + 1) })}</div>`}
         </div>
         <div class="pet-actions">
           ${active
             ? `<span class="pet-equipped">${icon('swords')} ${t('wpnp.equipped')}</span>`
             : `<button class="btn small primary" data-act="equip">${t('petp.equip')}</button>`}
           ${maxed
             ? ''
             : `<button class="btn small wpn-upg-btn" data-act="upgrade" ${!this.smithNear || !afford ? 'disabled' : ''}>
                  ⬆ ${icon('goldcoin')}${cost}
                </button>`}
         </div>`;
      host.appendChild(card);
    }
  }

  renderWeaponShop(host) {
    const c = this.character;
    const forSale = (CLASS_WEAPONS[c.cls] || [])
      .slice()
      .sort((a, b) => WEAPONS[a].price - WEAPONS[b].price);
    for (const id of forSale) {
      const def = WEAPONS[id];
      const owned = !!c.weapons[id];
      const afford = c.coins >= def.price;
      const starter = def.starterFor?.includes(c.cls);
      const card = document.createElement('div');
      card.className = 'pet-card shop' + (owned ? ' owned' : '');
      card.dataset.weapon = id;
      card.innerHTML =
        `<img class="pet-img" src="${weaponImgSrc(id)}" alt="">
         <div class="pet-meta">
           <div class="pet-kind">${weaponName(id)}${starter ? ` <b class="pet-starter">${t('petp.starter')}</b>` : ''}</div>
           <div class="pet-effect">${weaponBlurb(id)}</div>
           <div class="pet-effect muted">${weaponStatText(id, 0)}</div>
         </div>
         <div class="pet-actions">
           ${owned
             ? `<span class="pet-equipped">${t('petp.owned')}</span>`
             : `<button class="btn small primary" data-act="buy" ${!this.smithNear || !afford ? 'disabled' : ''}>
                  ${icon('goldcoin')}${def.price}
                </button>`}
         </div>`;
      host.appendChild(card);
    }
  }

  // ---------------- character stats sheet ----------------

  openStats() {
    if (!this._lastMe) return;
    this.statsOpen = true;
    this._statsKey = null;
    this.renderStats(this._lastMe);
    this.show('stats-panel');
  }

  closeStats() { this.statsOpen = false; this.hide('stats-panel'); }

  // Full stat breakdown for the local hero. The level-scaled values
  // (HP, attack) come live from the snapshot; the rest is consolidated
  // client-side from class base + pet bonus + equipped weapon & shield
  // — the same math the sim runs — so the sheet shows FINAL stats.
  renderStats(me) {
    const cls = me[1];
    const def = CLASSES[cls] || {};
    const lvl = me[7], hp = me[5], mhp = me[6], xp = me[8], xpn = me[9];
    const kills = me[14];
    const atk = typeof me[18] === 'number' ? me[18] : Math.round(def.atk || 0);
    const color = CLASS_COLORS[cls] || 'var(--gold)';
    $('stats-icon').innerHTML = icon('cls-' + cls);
    $('stats-icon').style.color = color;
    $('stats-title').textContent = (me[15] || t('common.hero'));
    $('stats-sub').textContent = t('stat.subLevel', { cls: className(cls), lvl });

    // snapshot columns: pet 20/21/22, weapon 23/24, shield 25/26
    // (petNick is the pet's custom name — kept out of the imported
    // petName() getter's way)
    const petId = me[20], petNick = me[21], petLvl = me[22];
    const wpnId = me[23], wpnTier = me[24] || 0, shdId = me[25], shdTier = me[26] || 0;
    const pfx = petEffects(petId, petLvl);
    const wfx = weaponEffects(wpnId, wpnTier);
    const sfx2 = weaponEffects(shdId, shdTier);
    const magic = WEAPONS[wpnId]?.kind === 'magic';

    const rows = [
      [t('stat.health'), `${hp} / ${mhp}`],
      [magic ? t('stat.magicPower') : t('stat.attack'), `${Math.round(atk)}`],
      [t('stat.defense'), `${Math.round(Math.min((def.def || 0) + pfx.def + sfx2.def, PET.DEF_CAP) * 100)}%`],
      [t('stat.range'), `${((def.range || 0) + wfx.range).toFixed(1)}`],
      [t('stat.atkSpeed'), `${((def.rate || 0) * pfx.rate * wfx.rate).toFixed(2)}/s`],
      // snapshot row 19 carries the live (pet+weapon-adjusted) move speed
      [t('stat.moveSpeed'), `${(typeof me[19] === 'number' && me[19] > 0 ? me[19] : def.speed || 0).toFixed(1)}`],
      [t('stat.knockback'), `${((def.knockback || 0) * pfx.kbMult).toFixed(1)}`],
    ];
    const crit = pfx.crit + wfx.crit;
    if (crit > 0) rows.push([t('stat.critChance'), t('stat.critValue', { v: Math.round(crit * 100), m: PET.CRIT_MULT })]);
    if (sfx2.block > 0) rows.push([t('stat.blockChance'), `${Math.round(sfx2.block * 100)}%`]);
    if (wfx.stun > 0) rows.push([t('stat.stunChance'), `${Math.round(wfx.stun * 100)}%`]);
    if (def.aoe) {
      rows.push(wfx.bolts > 0
        ? [t('stat.guidedBolts'), t('stat.boltsValue', { v: wfx.bolts })]
        : [t('stat.blastArea'), `${(def.aoe * wfx.aoe).toFixed(1)}`]);
    }
    rows.push([t('stat.experience'), `${xp} / ${xpn}`]);
    rows.push([t('stat.kills'), `${kills}`]);

    // equipped weapon & shield blocks — the gear the stats above
    // already include (managed at Baru's smithy during checkpoints)
    const gearBlock = (id, tier) => (id && WEAPONS[id])
      ? `<div class="stat-pet">
           <img class="stat-pet-img" src="${weaponImgSrc(id, tier)}" alt="">
           <div class="stat-pet-meta">
             <span class="sp-name">${weaponName(id)} ${tierBadge(tier)}</span>
             <span class="sp-desc">${weaponStatText(id, tier)}</span>
           </div>
         </div>`
      : '';

    // pet bonus block: read the companion off the snapshot row so it's
    // clear where the extra stats are coming from
    const petBlock = (petId && PETS[petId])
      ? `<div class="stat-pet">
           <img class="stat-pet-img" src="${petImgSrc(petId)}" alt="">
           <div class="stat-pet-meta">
             <span class="sp-name">${this.escapeHtml(petNick || petName(petId))} · ${petName(petId)} ${t('common.lvAbbr')} ${petLvl}</span>
             <span class="sp-desc">${petEffectText(petId, petLvl)}</span>
           </div>
         </div>`
      : '';

    $('stats-body').innerHTML =
      rows.map(([k, v]) => `<div class="stat-line"><span class="sk">${k}</span><span class="sv">${v}</span></div>`).join('') +
      gearBlock(wpnId, wpnTier) + gearBlock(shdId, shdTier) + petBlock +
      `<div class="stat-power">
         <span class="sp-name">${powerName(cls)}</span>
         <span class="sp-desc">${powerDesc(cls)}</span>
       </div>`;
  }

  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // called every frame with the freshest snapshot
  updateHud(snap, selfId) {
    if (!snap) return;
    this.lastSnap = snap;

    const inCombat = snap.ph === 'combat';
    $('wave-label').textContent = inCombat
      ? t('hud.waveLeft', { w: snap.w, left: snap.left })
      : snap.ph === 'build' ? t('hud.waveNext', { n: snap.w + 1 }) : `${snap.w}`;

    $('points-label').textContent = snap.pts;
    // permanent gold (per character, banked locally)
    if (this._goldShown !== this.character.coins) {
      this._goldShown = this.character.coins;
      $('gold-label').textContent = this.character.coins;
    }
    // companion pet row (mirrors the player row just above it)
    this.refreshPetHud();
    const remaining = Math.max(CRYSTAL_BREACH_LIMIT - snap.br, 0);
    $('crystal-hp').textContent = remaining;
    $('crystal-chip').classList.toggle('warn', remaining <= 3);

    // keep the upgrade panel live while it's open: coins ticking up
    // should unlock the button immediately, and back-to-back upgrades
    // (level, stats, next cost) should refresh without closing
    if (this.panelCell) {
      if (this.panelType === 'tower') {
        const tw = snap.tw.find((t) => t[2] === this.panelCell.c && t[3] === this.panelCell.r);
        if (tw) this.renderTowerPanel(tw[1], tw[4], tw[6] || 0);
        else this.closePanel();
      } else if (this.panelType === 'obstacle') {
        const ob = snap.ob.find((o) => o[2] === this.panelCell.c && o[3] === this.panelCell.r);
        if (!ob) this.closePanel();
      }
    }

    // start-wave button (lives in the top-right action slot)
    const btn = $('startwave-btn');
    if (snap.ph === 'build') {
      btn.classList.remove('hidden');
      btn.disabled = !this.isHost;
      const secs = snap.bt >= 0 ? Math.ceil(snap.bt) : null;
      $('startwave-label').innerHTML = this.isHost
        ? (secs !== null ? t('hud.startIn', { t: secs }) : t('hud.startWave'))
        : (secs !== null ? t('hud.waveIn', { t: secs }) : t('hud.waitingHost'));
    } else {
      btn.classList.add('hidden');
    }

    // own player row
    const me = snap.pl.find((r) => r[0] === selfId);
    if (me) {
      this._lastMe = me;
      const [, cls, , , , hp, mhp, lvl, xp, xpn, , dead, resp, obst] = me;
      if (this._pbCls !== cls) {
        this._pbCls = cls;
        const el = $('pb-class');
        el.innerHTML = icon('cls-' + cls);
        el.style.color = CLASS_COLORS[cls] || 'var(--gold)';
      }
      // keep an open stats sheet in sync as HP / level / attack /
      // pet / equipped gear change
      if (this.statsOpen) {
        const key = `${lvl}|${hp}|${mhp}|${xp}|${me[14]}|${me[18]}|${me[20]}|${me[22]}|${me[23]}|${me[24]}|${me[25]}|${me[26]}`;
        if (key !== this._statsKey) { this._statsKey = key; this.renderStats(me); }
      }
      // hero name (so the player always sees who they are, top-left)
      const myName = me[15] || t('common.hero');
      if (this._pbName !== myName) { this._pbName = myName; $('pb-name').textContent = myName; }
      $('pb-hp').style.width = `${(hp / mhp) * 100}%`;
      $('pb-hp-text').textContent = `${hp}/${mhp}`;
      $('pb-xp').style.width = `${(xp / xpn) * 100}%`;
      $('pb-level').textContent = lvl;
      $('obst-stock').textContent = `×${obst}`;

      const ro = $('respawn-overlay');
      ro.classList.toggle('hidden', dead !== 1);
      if (dead === 1) $('respawn-timer').textContent = `${Math.ceil(resp)}s`;

      // class special attack button (next to jump)
      this.myCls = cls;
      if (this._skCls !== cls) {
        this._skCls = cls;
        $('skill-icon').innerHTML = icon('sk-' + cls);
        $('skill-btn').title = `${powerName(cls)} (K)`;
        // paint the skill button in the class's signature colour
        $('skill-btn').style.setProperty('--skill-color', CLASS_COLORS[cls] || '#e9e9ee');
      }
      const skillCd = me[16] || 0;
      this.skillReady = skillCd <= 0 && dead !== 1;
      $('skill-btn').disabled = !this.skillReady;
      const cdEl = $('skill-cd');
      cdEl.classList.toggle('hidden', skillCd <= 0);
      if (skillCd > 0) cdEl.textContent = Math.ceil(skillCd);

      // never disable the currently selected card — otherwise you
      // couldn't tap it again to unselect when resources run out —
      // nor the one mid-drag (disabling it would kill the gesture)
      const inUse = (key) => this.selectedItem === key || this.dragItem === key;
      const obstCard = document.querySelector('[data-item="obstacle"]');
      // blocks stay selected so you can lay several in a row; once the
      // stock is spent, drop the selection so a stray tap doesn't just buzz
      if (this.selectedItem === 'obstacle' && obst < 1) {
        this.selectItem(null, null, { silent: true });
      }
      obstCard.disabled = obst < 1 && !inUse('obstacle');
      for (const [key, def] of Object.entries(TOWERS)) {
        document.querySelector(`[data-item="${key}"]`).disabled =
          snap.pts < def.cost && !inUse(key);
      }
    }

    // checkpoint action lives in the same top-right slot the start-wave
    // button uses the rest of the time — no blocking banner any more, the
    // whole checkpoint fits on the "keep going" button itself (with a live
    // tally of who's already ready baked in, so co-op still reads clearly)
    const cont = $('cont-btn');
    if (snap.ph === 'checkpoint') {
      cont.classList.remove('hidden');
      const ready = snap.cont?.length || 0;
      const total = snap.pl.length;
      const waiting = snap.cont?.includes(selfId);
      cont.disabled = waiting;
      $('cont-label').textContent = waiting ? t('hud.waitingAllies') : t('hud.keepGoing');
      const countEl = $('cont-count');
      // the tally only means something with allies around
      if (total > 1) {
        countEl.textContent = t('hud.ready', { ready, total });
        countEl.classList.remove('hidden');
      } else {
        countEl.classList.add('hidden');
      }
    } else {
      cont.classList.add('hidden');
    }
  }

  // ---------------- overlays ----------------

  bindOverlays() {
    $('cont-btn').addEventListener('click', () => {
      sfx.click();
      this.cb.onAction({ t: 'cont' });
    });
    $('restart-btn').addEventListener('click', () => {
      sfx.click();
      this.cb.onAction({ t: 'restart' });
    });
    $('exit-btn').addEventListener('click', () => this.cb.onExit());
    $('hl-exit').addEventListener('click', () => this.cb.onExit());
  }

  showGameOver(ev, isHost) {
    const best = Number(localStorage.getItem('dtc-best-wave') || 0);
    if (ev.wave > best) localStorage.setItem('dtc-best-wave', String(ev.wave));
    const lines = [t('over.survivedToWave', { n: ev.wave }) + (ev.wave > best ? t('over.newBest') : ''), ''];
    for (const s of Object.values(ev.kills || {})) {
      lines.push(t('over.killsLine', { name: s.name, kills: s.kills, lvl: s.lvl }));
    }
    $('go-stats').textContent = lines.join('\n');
    $('restart-btn').classList.toggle('hidden', !isHost);
    $('go-hint').classList.toggle('hidden', isHost);
    this.show('gameover');
  }

  hideGameOver() { this.hide('gameover'); }
  showHostLost() { this.show('host-lost'); }

  // ---------------- settings ----------------

  bindSettings() {
    const paintMutes = () => {
      for (const [btn, key] of [['mute-music', 'musicMuted'], ['mute-sfx', 'sfxMuted']]) {
        const muted = settings.get(key);
        $(btn).innerHTML = icon(muted ? 'mute' : 'speaker');
        $(btn).classList.toggle('muted', muted);
      }
    };
    const applyMusic = () =>
      music.setVolume(settings.get('musicMuted') ? 0 : settings.get('musicVol'));
    const applySfx = () =>
      setSfxVolume(settings.get('sfxMuted') ? 0 : settings.get('sfxVol'));

    const openPanel = () => {
      sfx.click();
      $('set-music').value = Math.round(settings.get('musicVol') * 100);
      $('set-sfx').value = Math.round(settings.get('sfxVol') * 100);
      $('set-shake').checked = settings.get('shake');
      $('set-shadows').checked = settings.get('shadows');
      paintMutes();
      this.show('settings-panel');
    };
    $('menu-settings').addEventListener('click', openPanel);
    $('char-settings').addEventListener('click', openPanel);
    $('hud-settings').addEventListener('click', openPanel);
    $('settings-close').addEventListener('click', () => { sfx.click(); this.hide('settings-panel'); });

    $('mute-music').addEventListener('click', () => {
      settings.set('musicMuted', !settings.get('musicMuted'));
      applyMusic();
      paintMutes();
      sfx.click();
    });
    $('mute-sfx').addEventListener('click', () => {
      settings.set('sfxMuted', !settings.get('sfxMuted'));
      applySfx();
      paintMutes();
      sfx.click();
    });

    // dragging a slider unmutes — you asked for sound, you get sound
    $('set-music').addEventListener('input', (e) => {
      settings.set('musicVol', Number(e.target.value) / 100);
      if (settings.get('musicMuted')) { settings.set('musicMuted', false); paintMutes(); }
      applyMusic();
    });
    $('set-sfx').addEventListener('input', (e) => {
      settings.set('sfxVol', Number(e.target.value) / 100);
      if (settings.get('sfxMuted')) { settings.set('sfxMuted', false); paintMutes(); }
      applySfx();
    });
    $('set-shake').addEventListener('change', (e) => settings.set('shake', e.target.checked));
    $('set-shadows').addEventListener('change', (e) => settings.set('shadows', e.target.checked));
  }
}
