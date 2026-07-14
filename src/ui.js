import { CLASSES, TOWERS, TOWER_LEVEL_MAX, TOWER_UPGRADE, CRYSTAL_BREACH_LIMIT, SKILLS } from './config.js';
import { sfx, setSfxVolume } from './audio.js';
import { normalizeRoomCode } from './utils.js';
import { icon, mountIcons } from './icons.js';
import { settings } from './settings.js';
import { music } from './music.js';
import { loadCharacter, saveCharacter } from './character.js';
import { getSlots } from './render/customize.js';

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

// ============================================================
// All DOM: screens, HUD, build cards, panels, toasts.
// Game logic never touches the DOM directly — it goes via UI.
// ============================================================
export class UI {
  constructor(callbacks) {
    this.cb = callbacks;
    this.character = loadCharacter();     // { name, cls, colors }
    this.charDraft = null;                // working copy on the creation screen
    this.preview = null;                  // 3D turntable (attached after assets load)
    this.selectedItem = null;   // build card
    this.pendingCell = null;    // two-tap confirm on touch
    this.panelCell = null;
    this.lastSnap = null;
    this.isHost = false;
    this.skillReady = false;   // gated by this character's own 30s cooldown
    this.myCls = this.character.cls;

    mountIcons();
    this.bindMenu();
    this.bindCharacter();
    this.bindLobby();
    this.bindHud();
    this.bindOverlays();
    this.bindSettings();
  }

  // the live 3D preview is created once assets are ready (main.js)
  attachPreview(preview) { this.preview = preview; }

  // ---------------- helpers ----------------

  show(id) { $(id).classList.remove('hidden'); }
  hide(id) { $(id).classList.add('hidden'); }

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

  // ---------------- menu ----------------

  bindMenu() {
    const heroName = () => this.character.name.trim() || 'Hero';

    $('hero-card').addEventListener('click', () => { sfx.click(); this.showCharacter(); });

    $('host-btn').addEventListener('click', () => {
      sfx.click();
      this.cb.onHost({ ...this.character, name: heroName() });
    });
    $('join-btn').addEventListener('click', () => {
      sfx.click();
      const code = normalizeRoomCode($('join-code').value);
      if (code.length < 5) return this.menuError('Enter the 5-letter room code');
      this.cb.onJoin(code, { ...this.character, name: heroName() });
    });
    $('join-code').addEventListener('input', (e) => {
      e.target.value = normalizeRoomCode(e.target.value);
    });

    const best = localStorage.getItem('dtc-best-wave');
    if (best) $('best-wave').textContent = `Best run: wave ${best}`;

    // joining via shared link (?room=CODE): show join-only, no host/code entry
    const url = new URL(location.href);
    const room = normalizeRoomCode(url.searchParams.get('room') || '');
    if (room.length === 5) {
      $('join-code').value = room;
      $('host-btn').classList.add('hidden');
      $('join-code').classList.add('hidden');
    }
  }

  menuError(msg) { $('menu-error').textContent = msg; sfx.error(); }

  updateHeroCard() {
    const c = this.character;
    $('hero-thumb').innerHTML = entityImg('class-' + c.cls);
    $('hero-name').textContent = c.name.trim() || 'Hero';
    $('hero-cls').textContent = CLASSES[c.cls]?.name || '';
  }

  showMenu() {
    this.hide('loading'); this.hide('character'); this.hide('lobby'); this.hide('hud');
    this.hide('checkpoint'); this.hide('gameover'); this.hide('host-lost');
    this.preview?.stop();
    this.updateHeroCard();
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
      this.charDraft.name = e.target.value.slice(0, 12);
    });

    $('char-random').addEventListener('click', () => {
      sfx.click();
      for (const slot of getSlots(CLASSES[this.charDraft.cls].model)) {
        this.charDraft.colors[slot.id] = randomHex();
      }
      this.renderColorSlots();
      this.preview?.setColors(this.charDraft.colors);
    });

    $('char-save').addEventListener('click', () => {
      sfx.success();
      this.charDraft.name = ($('char-name').value.trim() || 'Hero').slice(0, 12);
      this.character = saveCharacter(this.charDraft);
      this.showMenu();
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

  renderColorSlots() {
    const host = $('char-colors');
    host.innerHTML = '';
    const slots = getSlots(CLASSES[this.charDraft.cls].model);
    if (!slots.length) {
      host.innerHTML = '<div class="muted" style="font-size:.75rem">This model has no separate colour zones.</div>';
      return;
    }
    for (const slot of slots) {
      const wrap = document.createElement('div');
      wrap.className = 'color-slot';
      const input = document.createElement('input');
      input.type = 'color';
      input.value = this.charDraft.colors[slot.id] || slot.base;
      const label = document.createElement('label');
      label.textContent = slot.label;
      input.addEventListener('input', (e) => {
        this.charDraft.colors[slot.id] = e.target.value;
        this.preview?.setColors(this.charDraft.colors);
      });
      wrap.appendChild(input);
      wrap.appendChild(label);
      host.appendChild(wrap);
    }
  }

  showCharacter() {
    // work on a copy so "Save" is an explicit commit
    this.charDraft = {
      name: this.character.name,
      cls: this.character.cls,
      colors: { ...this.character.colors },
    };
    this.hide('loading'); this.hide('menu'); this.hide('lobby'); this.hide('hud');
    this.hide('checkpoint'); this.hide('gameover'); this.hide('host-lost');
    $('char-name').value = this.charDraft.name;
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
      li.innerHTML = `<span class="pl-cls">${entityImg('class-' + p.cls)}</span>
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

  // called every frame with the freshest snapshot
  updateHud(snap, selfId) {
    if (!snap) return;
    this.lastSnap = snap;

    const inCombat = snap.ph === 'combat';
    $('wave-label').textContent = inCombat
      ? `${snap.w} · ${snap.left} left`
      : snap.ph === 'build' ? `${snap.w + 1} next` : `${snap.w}`;

    $('points-label').textContent = snap.pts;
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
      const [, cls, , , , hp, mhp, lvl, xp, xpn, , dead, resp, obst] = me;
      if (this._pbCls !== cls) {
        this._pbCls = cls;
        $('pb-class').innerHTML = entityImg('class-' + cls);
      }
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
        $('skill-icon').innerHTML = icon(CLASSES[cls]?.icon || 'sparkle');
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
