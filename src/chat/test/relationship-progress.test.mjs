import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBondGrowth, deriveMeetupAccess, projectBondProgress } from '../relationship-progress.js';

test('SFW grows friendship until heart unlock and never grows desire', () => {
    assert.deepEqual(projectBondProgress({ contentMode: 'SFW', relationship: { 友情值: 39 }, assessment: { kind: 'romantic_flirt', intensity: 3 } }), { field: '友情值', delta: 4, nextValue: 43, kind: 'romantic_flirt' });
    assert.deepEqual(projectBondProgress({ contentMode: 'SFW', relationship: { 友情值: 40, 心动值: 0 }, assessment: { kind: 'romantic_flirt', intensity: 2 } }), { field: '心动值', delta: 4, nextValue: 4, kind: 'romantic_flirt' });
    assert.equal(projectBondProgress({ contentMode: 'SFW', relationship: { 欲望值: 0 }, assessment: { kind: 'sexual_desire', intensity: 3 } }).delta, 0);
});

test('NSFW isolates romantic and sexual desire progress', () => {
    assert.equal(projectBondProgress({ contentMode: 'NSFW', relationship: { 心动值: 50 }, assessment: { kind: 'romantic_desire', intensity: 3 } }).field, '心动值');
    assert.equal(projectBondProgress({ contentMode: 'NSFW', relationship: { 欲望值: 50 }, assessment: { kind: 'sexual_desire', intensity: 3 } }).field, '欲望值');
    assert.equal(projectBondProgress({ contentMode: 'NSFW', relationship: { 友情值: 0 }, assessment: { kind: 'friendly', intensity: 3 } }).delta, 0);
});

test('growth slows at high values and stops at 100', () => {
    assert.ok(calculateBondGrowth(0, 3) > calculateBondGrowth(75, 3));
    assert.equal(calculateBondGrowth(100, 3), 0);
    assert.equal(calculateBondGrowth(99, 3), 1);
});

test('meetup route is mode isolated and uses stable highest-score route', () => {
    assert.deepEqual(deriveMeetupAccess({ contentMode: 'SFW', relationship: { 友情值: 59, 心动值: 59, 欲望值: 100 } }), { unlocked: false, route: '', routes: [], reason: 'threshold_not_met' });
    assert.equal(deriveMeetupAccess({ contentMode: 'SFW', relationship: { 友情值: 60, 心动值: 60, 欲望值: 100 } }).route, '友情');
    assert.equal(deriveMeetupAccess({ contentMode: 'NSFW', relationship: { 友情值: 60, 心动值: 70, 欲望值: 80 } }).route, '欲望');
});
