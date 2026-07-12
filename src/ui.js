import { CLASSES, TOWERS, TOWER_LEVEL_MAX, TOWER_UPGRADE, CRYSTAL_BREACH_LIMIT } from './config.js';
import { sfx, setSfxVolume } from './audio.js';
import { normalizeRoomCode } from './utils.js';
import { icon, mountIcons } from './icons.js';
import { settings } from './settings.js';
import { music } from './music.js';

const $ = (id) => document.getElementById(id);

// ============================================================
// All DOM: screens, HUD, build cards, panels, toasts.
// Game logic never touches the DOM directly — it goes via UI.
// ============================================================
export class UI {
  constructor(callbacks) {
    this.cb = callbacks;
    this.selectedClass = localStorage.getItem('dtc-class') || 'berserker';
    this.selectedItem = null;   // build card
    this.pendingCell = null;    // two-tap confirm on touch
    this.panelCell = null;
    this.lastSnap = null;
    this.isHost = false;

    mountIcons();
    this.bindMenu();
    this.bindLobby();
    this.bindHud();
    this.bindOverlays();
    this.bindSettings();
  }

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

  // ---------------- loading ----------------

  loadProgress(frac) {
    $('load-fill').style.width = `${Math.round(frac * 100)}%`;
    if (frac >= 1) $('load-label').textContent = 'Ready!';
  }

  // ---------------- menu ----------------

  bindMenu() {
    $('name-input').value = localStorage.getItem('dtc-name') || '';

    for (const card of document.querySelectorAll('.class-card')) {
      if (card.dataset.cls === this.selectedClass) {
        document.querySelector('.class-card.selected')?.classList.remove('selected');
        card.classList.add('selected');
      }
      card.addEventListener('click', () => {
        sfx.click();
        document.querySelector('.class-card.selected')?.classList.remove('selected');
        card.classList.add('selected');
        this.selectedClass = card.dataset.cls;
        localStorage.setItem('dtc-class', this.selectedClass);
      });
    }

    const getName = () => {
      const n = $('name-input').value.trim() || 'Hero';
      localStorage.setItem('dtc-name', n);
      return n;
    };

    $('host-btn').addEventListener('click', () => {
      sfx.click();
      this.cb.onHost(getName(), this.selectedClass);
    });
    $('join-btn').addEventListener('click', () => {
      sfx.click();
      const code = normalizeRoomCode($('join-code').value);
      if (code.length < 5) return this.menuError('Enter the 5-letter room code');
      this.cb.onJoin(code, getName(), this.selectedClass);
    });
    $('join-code').addEventListener('input', (e) => {
      e.target.value = normalizeRoomCode(e.target.value);
    });

    const best = localStorage.getItem('dtc-best-wave');
    if (best) $('best-wave').textContent = `Best run: wave ${best}`;

    // joining via shared link (?room=CODE)
    const url = new URL(location.href);
    const room = normalizeRoomCode(url.searchParams.get('room') || '');
    if (room.length === 5) $('join-code').value = room;
  }

  menuError(msg) { $('menu-error').textContent = msg; sfx.error(); }

  showMenu() {
    this.hide('loading'); this.hide('lobby'); this.hide('hud');
    this.hide('checkpoint'); this.hide('gameover'); this.hide('host-lost');
    this.show('menu');
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
    this.hide('menu');
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
      li.innerHTML = `<span class="pl-cls">${icon(cls?.icon || 'gem')}</span>
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
      card.addEventListener('click', () => this.selectItem(
        card.dataset.item === this.selectedItem ? null : card.dataset.item
      ));
    }
    for (const [key, def] of Object.entries(TOWERS)) {
      const el = document.querySelector(`[data-cost="${key}"]`);
      if (el) el.textContent = def.cost;
    }
    $('startwave-btn').addEventListener('click', () => {
      sfx.click();
      this.cb.onAction({ t: 'start' });
    });
    $('room-chip').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(this.roomCode); this.toast('Code copied!', 'gold'); } catch { /* ok */ }
    });

    $('upg-btn').addEventListener('click', () => {
      if (this.panelCell) {
        sfx.click();
        this.cb.onAction({ t: this.panelType === 'tower' ? 'upg' : 'remove', ...this.panelCell });
        this.closePanel();
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
      hint.textContent = item === 'obstacle'
        ? 'Place a block — you cannot fully seal the path'
        : `Place ${TOWERS[item].name} (🪙${TOWERS[item].cost})`;
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
      const def = TOWERS[info.kind];
      const lvl = info.lvl;
      const dmg = Math.round(def.dmg * Math.pow(TOWER_UPGRADE.dmgMult, lvl - 1));
      $('upg-title').textContent = `${def.icon} ${def.name} — level ${lvl}`;
      $('upg-stats').textContent =
        `Damage ${dmg} · Range ${(def.range + TOWER_UPGRADE.rangeAdd * (lvl - 1)).toFixed(1)}` +
        (def.aoe ? ` · Area ${def.aoe}` : '');
      const maxed = lvl >= TOWER_LEVEL_MAX;
      const cost = maxed ? 0 : Math.round(def.cost * TOWER_UPGRADE.costMult[lvl]);
      $('upg-btn').textContent = maxed ? 'Max level' : `Upgrade 🪙${cost}`;
      $('upg-btn').disabled = maxed || (this.lastSnap && this.lastSnap.pts < cost);
      $('sell-btn').classList.remove('hidden');
      $('sell-btn').textContent = 'Sell';
    } else {
      $('upg-title').textContent = '🪨 Block';
      $('upg-stats').textContent = 'Reclaim it to get a block back in your stock.';
      $('upg-btn').textContent = 'Remove';
      $('upg-btn').disabled = false;
      $('sell-btn').classList.add('hidden');
    }
    this.show('upgrade-panel');
  }

  closePanel() {
    this.panelCell = null;
    this.hide('upgrade-panel');
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
      $('pb-class').textContent = CLASSES[cls]?.icon || '❔';
      $('pb-hp').style.width = `${(hp / mhp) * 100}%`;
      $('pb-hp-text').textContent = `${hp}/${mhp}`;
      $('pb-xp').style.width = `${(xp / xpn) * 100}%`;
      $('pb-level').textContent = lvl;
      $('obst-stock').textContent = `×${obst}`;

      const ro = $('respawn-overlay');
      ro.classList.toggle('hidden', dead !== 1);
      if (dead === 1) $('respawn-timer').textContent = `${Math.ceil(resp)}s`;

      const obstCard = document.querySelector('[data-item="obstacle"]');
      obstCard.disabled = obst < 1;
      for (const [key, def] of Object.entries(TOWERS)) {
        document.querySelector(`[data-item="${key}"]`).disabled = snap.pts < def.cost;
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
      lines.push(`⚔️ ${s.name} — ${s.kills} kills · level ${s.lvl}`);
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
    const openPanel = () => {
      sfx.click();
      $('set-music').value = Math.round(settings.get('musicVol') * 100);
      $('set-sfx').value = Math.round(settings.get('sfxVol') * 100);
      $('set-shake').checked = settings.get('shake');
      $('set-shadows').checked = settings.get('shadows');
      this.show('settings-panel');
    };
    $('menu-settings').addEventListener('click', openPanel);
    $('hud-settings').addEventListener('click', openPanel);
    $('settings-close').addEventListener('click', () => { sfx.click(); this.hide('settings-panel'); });

    $('set-music').addEventListener('input', (e) => {
      const v = Number(e.target.value) / 100;
      settings.set('musicVol', v);
      music.setVolume(v);
    });
    $('set-sfx').addEventListener('input', (e) => {
      const v = Number(e.target.value) / 100;
      settings.set('sfxVol', v);
      setSfxVolume(v);
    });
    $('set-shake').addEventListener('change', (e) => settings.set('shake', e.target.checked));
    $('set-shadows').addEventListener('change', (e) => settings.set('shadows', e.target.checked));
  }
}
