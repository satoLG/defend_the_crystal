// ============================================================
// Unified controls: WASD/arrows on desktop, a floating virtual
// joystick on touch. Build-mode pointer taps are forwarded to
// whoever registered the handlers (the build UI).
// Cross-play: both schemes are always active.
// ============================================================

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.joy = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
    this.joyEl = document.getElementById('joystick');
    this.joyBase = document.getElementById('joy-base');
    this.joyKnob = document.getElementById('joy-knob');

    this.buildModeCheck = () => false; // set by UI
    this.onTap = null;      // (x, y, pointerType)
    this.onHover = null;    // (x, y)
    this.onKeyAction = null; // (action)

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      this.keys.add(e.code);
      const map = {
        KeyB: 'build', Digit1: 'card0', Digit2: 'card1', Digit3: 'card2', Digit4: 'card3',
        Escape: 'cancel', Space: 'startwave',
      };
      if (map[e.code]) {
        if (e.code === 'Space') e.preventDefault();
        this.onKeyAction?.(map[e.code]);
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    window.addEventListener('pointerup', (e) => this.pointerUp(e));
    window.addEventListener('pointercancel', (e) => this.pointerUp(e));
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onKeyAction?.('cancel');
    });
  }

  pointerDown(e) {
    if (e.pointerType === 'touch' && !this.buildModeCheck()) {
      // virtual joystick anywhere on the board
      if (this.joy.active) return;
      this.joy.active = true;
      this.joy.id = e.pointerId;
      this.joy.ox = e.clientX;
      this.joy.oy = e.clientY;
      this.joy.dx = 0; this.joy.dy = 0;
      this.joyEl.classList.remove('hidden');
      this.joyBase.style.left = `${e.clientX}px`;
      this.joyBase.style.top = `${e.clientY}px`;
      this.joyKnob.style.transform = 'translate(-50%, -50%)';
      return;
    }
    this.onTap?.(e.clientX, e.clientY, e.pointerType, e.button);
  }

  pointerMove(e) {
    if (this.joy.active && e.pointerId === this.joy.id) {
      const max = 46;
      let dx = e.clientX - this.joy.ox;
      let dy = e.clientY - this.joy.oy;
      const d = Math.hypot(dx, dy);
      if (d > max) { dx = (dx / d) * max; dy = (dy / d) * max; }
      this.joy.dx = dx / max;
      this.joy.dy = dy / max;
      this.joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      return;
    }
    if (e.pointerType !== 'touch') this.onHover?.(e.clientX, e.clientY);
  }

  pointerUp(e) {
    if (this.joy.active && e.pointerId === this.joy.id) {
      this.joy.active = false;
      this.joy.dx = 0; this.joy.dy = 0;
      this.joyEl.classList.add('hidden');
    }
  }

  // world-space movement direction; screen up == -Z, right == +X
  moveDir() {
    let x = 0, z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    x += this.joy.dx;
    z += this.joy.dy;
    const d = Math.hypot(x, z);
    if (d > 1) { x /= d; z /= d; }
    return { x, z };
  }
}
