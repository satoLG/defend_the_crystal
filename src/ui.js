import {
  CLASSES, TOWERS, TOWER_LEVEL_MAX, TOWER_UPGRADE, CRYSTAL_BREACH_LIMIT, SKILLS, NAME_MAX,
  PETS, PET, petEffectText, petXpNext,
} from './config.js';
import { sfx, setSfxVolume } from './audio.js';
import { normalizeRoomCode } from './utils.js';
import { icon, mountIcons } from './icons.js';
import { settings } from './settings.js';
import { music } from './music.js';
import { loadRoster, saveRoster, defaultCharacter, petRefOf, grantPetXp } from './character.js';
import { getSlots } from './render/customize.js';

// class accent colours (mirror the 3D CLASS_TINT) used to tint the
// class glyph in the roster, lobby and HUD chrome
const CLASS_COLORS = {
  berserker: '#ff6a4d', tanker: '#6a9cff', archer: '#7de87d', mage: '#c07dff',
};

// per-class stat bars + one-line special-power blurbs for the
// character screen (kept here so the DOM layer owns its own copy)
const STAT_BARS = {
  berserker: [['ATK', 0.95], ['DEF', 0.55], ['RNG', 0.2], ['SPD', 0.6]],
  tanker: [['ATK', 0.5], ['DEF', 0.95], ['RNG', 0.2], ['SPD', 0.4]],
  archer: [['ATK', 0.5], ['DEF', 0.25], ['RNG', 0.8], ['SPD', 0.95]],
  mage: [['ATK', 0.5], ['DEF', 0.5], ['RNG', 1], ['SPD', 0.6]],
};
const POWER_DESC = {
  berserker: 'Rampage Dash — charge through the horde, hurling enemies aside.',
  tanker: 'Wall Mode — become immovable with doubled defense for a while.',
  archer: 'Arrow Storm — unleash rapid volleys at the nearest foes.',
  mage: 'Arcane Orb — a giant blast dealing massive area damage.',
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
    this.selectedItem = null;   // build card
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

    mountIcons();
    this.bindStart();
    this.bindMenu();
    this.bindCharacter();
    this.bindPetPicker();
    this.bindLobby();
    this.bindHud();
    this.bindPets();
    this.bindOverlays();
    this.bindSettings();
  }

  // the live 3D preview is created once assets are ready (main.js)
  attachPreview(preview) { this.preview = preview; }

  // ---------------- helpers ----------------

  show(id) { $(id).classList.remove('hidden'); }
  hide(id) { $(id).classList.add('hidden'); }

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
           <span class="hero-cls">${CLASSES[c.cls]?.name || ''}</span>
         </span>
         <span class="hero-actions">
           <span class="hc-btn" data-act="edit" title="Edit">${icon('gear')}</span>
           ${canDelete ? `<span class="hc-btn hc-del" data-act="del" title="Delete">${icon('x')}</span>` : ''}
         </span>`;
      // names are user input — set as text, never as HTML
      card.querySelector('.hero-name').textContent = c.name.trim() || 'Hero';
      host.appendChild(card);
    }
    const add = document.createElement('button');
    add.className = 'hero-card add-hero';
    add.dataset.id = '';
    add.innerHTML =
      `<span class="hero-thumb add-thumb">${icon('sparkle')}</span>
       <span class="hero-meta">
         <span class="hero-name">New hero</span>
         <span class="hero-cls muted">Create a character</span>
       </span>`;
    host.appendChild(add);
  }

  toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 2800);
    if (kind === 'error') sfx.error();
  }

  // huge dramatic splash when a (mini-)boss stomps onto the field
  showBossBanner(name, flavor, mini = false) {
    const b = $('boss-banner');
    clearTimeout(this._bannerT);
    $('bb-tag').textContent = mini ? '⚠ MINI-BOSS ⚠' : '☠ BOSS INCOMING ☠';
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
    if (frac >= 1) $('load-label').textContent = 'Ready!';
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
    this.hide('load-area');
    this.show('loading');
    this.show('start-area');
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
    const heroName = () => this.character.name.trim() || 'Hero';

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
      if (code.length < 5) return this.menuError('Enter the 5-letter room code');
      this.ensurePetThen(() => this.cb.onJoin(code, { ...this.character, name: heroName() }));
    });
    $('join-code').addEventListener('input', (e) => {
      e.target.value = normalizeRoomCode(e.target.value);
    });

    const best = localStorage.getItem('dtc-best-wave');
    if (best) $('best-wave').textContent = `Best run: wave ${best}`;

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
      $('join-btn').innerHTML = `${icon('link')} Join this match`;
    }
  }

  menuError(msg) { $('menu-error').textContent = msg; sfx.error(); }

  showMenu() {
    this.hide('loading'); this.hide('character'); this.hide('lobby'); this.hide('hud');
    this.hide('checkpoint'); this.hide('gameover'); this.hide('host-lost');
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
      this.charDraft.name = ($('char-name').value.trim() || 'Hero').slice(0, NAME_MAX);
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
      ctx?.onBack?.();
    });
    $('pp-confirm').addEventListener('click', () => {
      const id = PETS[this.ppPick] ? this.ppPick : 'dog';
      const name = (this.ppName.trim() || PETS[id].name).slice(0, PET.NAME_MAX);
      const ctx = this.petPickerCtx;
      this.petPickerCtx = null;
      ctx?.onConfirm?.(id, name);
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
    if (ctx.intro) $('pp-intro').innerHTML = ctx.intro;
    $('pp-confirm').textContent = ctx.confirmLabel || 'Save & continue';
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
      card.innerHTML = `<img src="${petImgSrc(id)}" alt=""><span>${def.name}</span>`;
      grid.appendChild(card);
    }
    const def = PETS[this.ppPick] || PETS.dog;
    $('pp-detail-name').textContent = def.name;
    $('pp-blurb').textContent = `${def.blurb} (${petEffectText(this.ppPick, 1)})`;
    $('pp-name').placeholder = `Name your ${def.name.toLowerCase()}`;
  }

  // legacy heroes saved before pets existed have none; make them pick &
  // name a starter (normalizing them) before a match can start
  ensurePetThen(proceed) {
    const c = this.character;
    if (c.activePet && c.pets?.[c.activePet]) return proceed();
    this.openPetPicker({
      allowBack: false,
      confirmLabel: 'Confirm pet',
      intro: `${(c.name || '').trim() || 'Your hero'} needs a companion!<br/>Pick a starter pet and give it a name before you head out — it levels up permanently.`,
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
    const def = CLASSES[cls];
    $('ci-name').textContent = def.name;
    $('ci-weapon').textContent = def.weapon || '—';
    $('ci-power').textContent = POWER_DESC[cls] || SKILLS[cls]?.name || '—';
    $('ci-blurb').textContent = def.blurb || '';
    $('ci-stats').innerHTML = (STAT_BARS[cls] || [])
      .map(([k, v]) => `<i style="--v:${v}">${k}</i>`).join('');
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
        this.toast('Code copied!', 'gold');
      } catch { this.toast(this.roomCode, 'gold'); }
    });
    $('share-code').addEventListener('click', async () => {
      sfx.click();
      const url = `${location.origin}${location.pathname}?room=${this.roomCode}`;
      if (navigator.share) {
        navigator.share({ title: 'Defend the Crystal', text: `Join my defense! Code: ${this.roomCode}`, url }).catch(() => {});
      } else {
        try { await navigator.clipboard.writeText(url); this.toast('Invite link copied!', 'gold'); }
        catch { this.toast(url, 'gold'); }
      }
    });
    $('start-btn').addEventListener('click', () => { sfx.success(); this.cb.onStartMatch(); });
    $('leave-btn').addEventListener('click', () => this.cb.onExit());
  }

  showLobby(code, isHost) {
    this.roomCode = code;
    this.isHost = isHost;
    this.preview?.stop();
    this.hide('menu'); this.hide('character');
    this.show('lobby');
    $('room-code').textContent = code;
    $('start-btn').classList.toggle('hidden', !isHost);
    $('lobby-hint').textContent = isHost
      ? 'Allies can also drop in mid-battle with this code.'
      : 'Waiting for the host to start…';
  }

  updateLobby(players, selfId) {
    const list = $('player-list');
    list.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      const cls = CLASSES[p.cls];
      const color = CLASS_COLORS[p.cls] || 'var(--gold)';
      li.innerHTML = `<span class="pl-cls" style="color:${color}">${icon('cls-' + p.cls)}</span>
        <span class="pl-name"></span>
        <span class="pl-tag">${cls?.name || ''}${p.host ? ' · Host' : ''}${p.id === selfId ? ' · You' : ''}</span>`;
      li.querySelector('.pl-name').textContent = p.name;
      list.appendChild(li);
    }
    $('lobby-status').textContent = `${players.length}/4 defenders — difficulty scales with party size`;
  }

  // ---------------- HUD ----------------

  bindHud() {
    for (const card of document.querySelectorAll('.build-card')) {
      bindTap(card, () => this.selectItem(
        card.dataset.item === this.selectedItem ? null : card.dataset.item
      ));
    }
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
      try { await navigator.clipboard.writeText(this.roomCode); this.toast('Code copied!', 'gold'); } catch { /* ok */ }
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
    this.hide('menu'); this.hide('lobby');
    this.show('hud');
    $('room-label').textContent = this.roomCode || '';
  }

  // lit only while the character faces a grid cell it can vault over
  setJumpEnabled(on) {
    $('jump-btn').disabled = !on;
  }

  selectItem(item) {
    this.selectedItem = item;
    this.pendingCell = null;
    this.closePanel();
    sfx.toggle(!!item);
    for (const card of document.querySelectorAll('.build-card')) {
      card.classList.toggle('selected', card.dataset.item === item);
    }
    this.cb.onBuildMode(!!item);
    const hint = $('build-hint');
    if (item) {
      hint.classList.remove('hidden');
      hint.innerHTML = `<span class="hint-x">${icon('x')}</span>` + (item === 'obstacle'
        ? 'Place a block — tap here to cancel'
        : `Place ${TOWERS[item].name} (${icon('coin')}${TOWERS[item].cost}) — tap here to cancel`);
    } else {
      hint.classList.add('hidden');
    }
  }

  selectCardByIndex(i) {
    const items = ['obstacle', 'ballista', 'catapult', 'cannon'];
    this.selectItem(this.selectedItem === items[i] ? null : items[i]);
  }

  // upgrade/remove panel for an existing structure
  openPanel(info) {
    this.panelCell = { c: info.c, r: info.r };
    this.panelType = info.type;
    if (info.type === 'tower') {
      this.renderTowerPanel(info.kind, info.lvl);
    } else {
      $('upg-title').innerHTML = `${entityImg('block')} Block`;
      $('upg-stats').textContent = 'Reclaim it to get a block back in your stock.';
      $('upg-btn').textContent = 'Remove';
      $('upg-btn').disabled = false;
      $('sell-btn').classList.add('hidden');
    }
    this.show('upgrade-panel');
  }

  // (re)paints the tower upgrade panel — called on open and every frame
  // while it's up, so the cost/afford state always tracks live coins
  renderTowerPanel(kind, lvl) {
    const def = TOWERS[kind];
    const stat = (mult, add = 0) => (base) => base * Math.pow(mult, lvl - 1) + add * (lvl - 1);
    const dmg = Math.round(stat(TOWER_UPGRADE.dmgMult)(def.dmg));
    const rng = (def.range + TOWER_UPGRADE.rangeAdd * (lvl - 1)).toFixed(1);
    const spd = (def.rate * Math.pow(TOWER_UPGRADE.rateMult, lvl - 1)).toFixed(2);
    $('upg-title').innerHTML = `${entityImg('tower-' + kind)} ${def.name} — level ${lvl}`;
    const maxed = lvl >= TOWER_LEVEL_MAX;
    if (maxed) {
      $('upg-stats').textContent =
        `Damage ${dmg} · Range ${rng} · Speed ${spd}/s` + (def.aoe ? ` · Area ${def.aoe}` : '');
    } else {
      const nDmg = Math.round(def.dmg * Math.pow(TOWER_UPGRADE.dmgMult, lvl));
      const nRng = (def.range + TOWER_UPGRADE.rangeAdd * lvl).toFixed(1);
      const nSpd = (def.rate * Math.pow(TOWER_UPGRADE.rateMult, lvl)).toFixed(2);
      $('upg-stats').textContent =
        `Damage ${dmg} ➜ ${nDmg}\nRange ${rng} ➜ ${nRng}\nSpeed ${spd}/s ➜ ${nSpd}/s` +
        (def.aoe ? `\nArea ${def.aoe}` : '');
    }
    const cost = maxed ? 0 : Math.round(def.cost * TOWER_UPGRADE.costMult[lvl]);
    $('upg-btn').innerHTML = maxed ? 'Max level' : `Upgrade ${icon('coin')}${cost}`;
    $('upg-btn').disabled = maxed || (this.lastSnap && this.lastSnap.pts < cost);
    $('sell-btn').classList.remove('hidden');
    $('sell-btn').textContent = 'Sell';
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
    this.toast(`+${amt} gold coin${amt > 1 ? 's' : ''}!`, 'gold');
    if (this.petPanelOpen) this.renderPetPanel();
  }

  // XP the hero collects also feeds its companion — permanently
  grantPetXpFromPickup(amt) {
    if (!this.character.activePet) return;
    const gained = grantPetXp(this.character, amt);
    this.persistCharacter();
    if (gained > 0) {
      const pet = this.character.pets[this.character.activePet];
      if (pet) {
        this.toast(`${pet.name} reached level ${pet.lvl}!`, 'gold');
        sfx.levelUp();
        this.cb.onPetChange?.(this.activePetInfo());
      }
    }
    if (this.petPanelOpen && this.petTab === 'mine') this.renderPetPanel();
  }

  equipPet(id) {
    if (!this.character.pets[id] || this.character.activePet === id) return;
    this.character.activePet = id;
    this.persistCharacter();
    sfx.success();
    this.renderPetPanel();
    this.cb.onPetChange?.(this.activePetInfo());
  }

  renamePet(id, name) {
    const pet = this.character.pets[id];
    if (!pet) return;
    pet.name = (String(name).trim() || PETS[id].name).slice(0, PET.NAME_MAX);
    this.persistCharacter();
    this.renderPetPanel();
    if (this.character.activePet === id) this.cb.onPetChange?.(this.activePetInfo());
  }

  buyPet(id) {
    const def = PETS[id];
    if (!def || this.character.pets[id]) return;
    if (!this.shopNear) return this.toast("Visit Tonho's stall in the sanctuary to buy", 'error');
    if (this.character.coins < def.price) return this.toast('Not enough gold coins', 'error');
    this.character.coins -= def.price;
    this.character.pets[id] = { lvl: 1, xp: 0, name: def.name };
    const firstPet = !this.character.activePet;
    if (firstPet) this.character.activePet = id;
    this.persistCharacter();
    this._goldShown = null;
    sfx.success();
    this.toast(`${def.name} joined your team!`, 'gold');
    this.renderPetPanel();
    if (firstPet) this.cb.onPetChange?.(this.activePetInfo());
  }

  // main.js flips this as the hero walks up to / away from the stall
  setShopNear(near) {
    if (near === this.shopNear) return;
    this.shopNear = near;
    $('petshop-prompt').classList.toggle('hidden', !near);
    if (near) sfx.notify();
    if (this.petPanelOpen && this.petTab === 'shop') this.renderPetPanel();
  }

  bindPets() {
    bindTap($('pet-btn'), () => { sfx.click(); this.openPetPanel('mine'); });
    bindTap($('petshop-prompt'), () => { sfx.click(); this.openPetPanel('shop'); });
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
    this.petTab = tab;
    this.petPanelOpen = true;
    this.renderPetPanel();
    this.show('pet-panel');
  }

  closePetPanel() {
    this.petPanelOpen = false;
    this.hide('pet-panel');
  }

  // swap the pet's name for an inline input; Enter/blur commits
  startPetRename(card, id) {
    const span = card.querySelector('.pet-pname');
    if (!span || card.querySelector('input')) return;
    const input = document.createElement('input');
    input.maxLength = PET.NAME_MAX;
    input.value = this.character.pets[id]?.name || '';
    input.className = 'pet-rename';
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
      host.innerHTML = '<div class="muted pet-empty">No pets yet — buy one at Tonho\'s stall in the sanctuary.</div>';
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
             <button class="pet-edit" data-act="rename" title="Rename">✎</button>
           </div>
           <div class="pet-kind">${PETS[id].name} · Lv ${pet.lvl}${maxed ? ' <b class="pet-max">MAX</b>' : ''}</div>
           <div class="pet-effect">${petEffectText(id, pet.lvl)}</div>
           <div class="pet-xpbar"><div class="pet-xpfill" style="width:${maxed ? 100 : Math.min((pet.xp / next) * 100, 100)}%"></div></div>
         </div>
         <div class="pet-actions">
           ${active
             ? `<span class="pet-equipped">${icon('paw')} With you</span>`
             : '<button class="btn small primary" data-act="equip">Equip</button>'}
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
           <div class="pet-kind">${def.name}${def.starter ? ' <b class="pet-starter">STARTER</b>' : ''}</div>
           <div class="pet-effect">${def.blurb}</div>
           <div class="pet-effect muted">Lv 1: ${petEffectText(id, 1)} → Lv ${PET.LEVEL_CAP}: ${petEffectText(id, PET.LEVEL_CAP)}</div>
         </div>
         <div class="pet-actions">
           ${owned
             ? '<span class="pet-equipped">Owned</span>'
             : `<button class="btn small primary" data-act="buy" ${!this.shopNear || !afford ? 'disabled' : ''}>
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

  // full stat breakdown for the local hero — the level-scaled values
  // (HP, attack) come live from the snapshot, the rest from the class
  renderStats(me) {
    const cls = me[1];
    const def = CLASSES[cls] || {};
    const lvl = me[7], hp = me[5], mhp = me[6], xp = me[8], xpn = me[9];
    const kills = me[14];
    const atk = typeof me[18] === 'number' ? me[18] : Math.round(def.atk || 0);
    const color = CLASS_COLORS[cls] || 'var(--gold)';
    $('stats-icon').innerHTML = icon('cls-' + cls);
    $('stats-icon').style.color = color;
    $('stats-title').textContent = (me[15] || 'Hero');
    $('stats-sub').textContent = `${def.name || ''} · Level ${lvl}`;

    const rows = [
      ['Health', `${hp} / ${mhp}`],
      ['Attack', `${Math.round(atk)}`],
      ['Defense', `${Math.round((def.def || 0) * 100)}%`],
      ['Range', `${(def.range || 0).toFixed(1)}`],
      ['Attack speed', `${(def.rate || 0).toFixed(2)}/s`],
      // snapshot row 19 carries the live (pet-buffed) move speed
      ['Move speed', `${(typeof me[19] === 'number' && me[19] > 0 ? me[19] : def.speed || 0).toFixed(1)}`],
      ['Knockback', `${(def.knockback || 0).toFixed(1)}`],
    ];
    if (def.aoe) rows.push(['Blast area', `${def.aoe.toFixed(1)}`]);
    rows.push(['Experience', `${xp} / ${xpn}`]);
    rows.push(['Kills', `${kills}`]);

    $('stats-body').innerHTML =
      rows.map(([k, v]) => `<div class="stat-line"><span class="sk">${k}</span><span class="sv">${v}</span></div>`).join('') +
      `<div class="stat-power">
         <span class="sp-name">${SKILLS[cls]?.name || 'Special'}</span>
         <span class="sp-desc">${POWER_DESC[cls] || ''}</span>
       </div>`;
  }

  // called every frame with the freshest snapshot
  updateHud(snap, selfId) {
    if (!snap) return;
    this.lastSnap = snap;

    const inCombat = snap.ph === 'combat';
    $('wave-label').textContent = inCombat
      ? `${snap.w} · ${snap.left} left`
      : snap.ph === 'build' ? `${snap.w + 1} next` : `${snap.w}`;

    $('points-label').textContent = snap.pts;
    // permanent gold (per character, banked locally)
    if (this._goldShown !== this.character.coins) {
      this._goldShown = this.character.coins;
      $('gold-label').textContent = this.character.coins;
    }
    const remaining = Math.max(CRYSTAL_BREACH_LIMIT - snap.br, 0);
    $('crystal-hp').textContent = remaining;
    $('crystal-chip').classList.toggle('warn', remaining <= 3);

    // keep the upgrade panel live while it's open: coins ticking up
    // should unlock the button immediately, and back-to-back upgrades
    // (level, stats, next cost) should refresh without closing
    if (this.panelCell) {
      if (this.panelType === 'tower') {
        const tw = snap.tw.find((t) => t[2] === this.panelCell.c && t[3] === this.panelCell.r);
        if (tw) this.renderTowerPanel(tw[1], tw[4]);
        else this.closePanel();
      } else if (this.panelType === 'obstacle') {
        const ob = snap.ob.find((o) => o[2] === this.panelCell.c && o[3] === this.panelCell.r);
        if (!ob) this.closePanel();
      }
    }

    // start-wave button
    const btn = $('startwave-btn');
    if (snap.ph === 'build') {
      btn.classList.remove('hidden');
      btn.disabled = !this.isHost;
      const t = snap.bt >= 0 ? Math.ceil(snap.bt) : null;
      $('startwave-label').innerHTML = this.isHost
        ? (t !== null ? `Start<br/>${t}s` : 'Start<br/>wave')
        : (t !== null ? `Wave in<br/>${t}s` : 'Waiting<br/>host…');
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
      // keep an open stats sheet in sync as HP / level / attack change
      if (this.statsOpen) {
        const key = `${lvl}|${hp}|${mhp}|${xp}|${me[14]}|${me[18]}`;
        if (key !== this._statsKey) { this._statsKey = key; this.renderStats(me); }
      }
      // hero name (so the player always sees who they are, top-left)
      const myName = me[15] || 'Hero';
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
        $('skill-btn').title = `${SKILLS[cls]?.name || 'Special attack'} (K)`;
      }
      const skillCd = me[16] || 0;
      this.skillReady = skillCd <= 0 && dead !== 1;
      $('skill-btn').disabled = !this.skillReady;
      const cdEl = $('skill-cd');
      cdEl.classList.toggle('hidden', skillCd <= 0);
      if (skillCd > 0) cdEl.textContent = Math.ceil(skillCd);

      // never disable the currently selected card — otherwise you
      // couldn't tap it again to unselect when resources run out
      const obstCard = document.querySelector('[data-item="obstacle"]');
      obstCard.disabled = obst < 1 && this.selectedItem !== 'obstacle';
      for (const [key, def] of Object.entries(TOWERS)) {
        document.querySelector(`[data-item="${key}"]`).disabled =
          snap.pts < def.cost && this.selectedItem !== key;
      }
    }

    // checkpoint overlay
    if (snap.ph === 'checkpoint') {
      this.show('checkpoint');
      $('cp-wave').textContent = snap.w;
      const ready = snap.cont?.length || 0;
      $('cp-status').textContent = `${ready}/${snap.pl.length} ready`;
      $('cont-btn').disabled = snap.cont?.includes(selfId);
      $('cont-btn').textContent = snap.cont?.includes(selfId) ? 'Waiting for allies…' : 'Keep going ➜';
    } else {
      this.hide('checkpoint');
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
    const lines = [`Survived to wave ${ev.wave}${ev.wave > best ? ' — new best!' : ''}`, ''];
    for (const s of Object.values(ev.kills || {})) {
      lines.push(`${s.name} — ${s.kills} kills · level ${s.lvl}`);
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
