// Headless sanity check for the authoritative simulation: build a room,
// add two players, start the match and a wave, and step the sim for a
// while. Fails (non-zero exit) if anything throws or the sim never advances.
//
//   node apps/server/scripts/sim-smoke.mjs
import { Sim } from '@dtc/shared/sim/sim.js';
import { SIM_DT } from '@dtc/shared/config.js';

const sim = new Sim();
sim.addPlayer('a', 'Alice', 'archer', {}, null, null);
sim.addPlayer('b', 'Bob', 'mage', {}, null, null);

if (sim.phase !== 'lobby') throw new Error(`expected lobby, got ${sim.phase}`);

sim.start();
if (sim.phase !== 'build') throw new Error(`expected build after start, got ${sim.phase}`);

// drive some inputs and step a couple simulated seconds
for (let i = 0; i < 120; i++) {
  sim.setInput('a', { x: 0, z: 4, yaw: 0, m: true });
  sim.setInput('b', { x: 1, z: 4, yaw: 0, m: false });
  sim.step(SIM_DT);
}

sim.startWave();
let snaps = 0;
for (let i = 0; i < 300; i++) {
  sim.step(SIM_DT);
  const snap = sim.buildSnapshot();
  if (snap && Array.isArray(snap.pl)) snaps++;
  sim.drainEvents();
}

if (snaps === 0) throw new Error('no snapshots produced');
if (sim.buildSnapshot().pl.length !== 2) throw new Error('players missing from snapshot');

console.log(`sim-smoke OK — wave=${sim.wave} phase=${sim.phase} snapshots=${snaps}`);
