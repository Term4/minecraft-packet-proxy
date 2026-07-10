#!/usr/bin/env node
/**
 * Reverse-engineers KnockbackConfig from knockback log data.
 * Fits parameters to minimize error between observed and predicted knockback.
 *
 * Usage:
 *   node reverse-knockback.js knockback-log.json
 *   node reverse-knockback.js -c config.json log1.json log2.json
 *   node reverse-knockback.js --range-start-extra-h 4 --range-factor-extra-h 0.25 --range-max-h 0.4 log.json
 *
 * Options:
 *   -c, --config <path>       Base config file
 *   --in-air                  Victim in air (air multipliers)
 *   --sweeping                Sweeping attack
 *   -v, --verbose             Per-hit error to stderr
 *   --range-start-extra-h N   Fix range start (e.g. 4 for Minemen)
 *   --range-factor-extra-h N  Fix range factor (e.g. 0.25)
 *   --range-max-h N           Fix range max (e.g. 0.4)
 */

const fs = require('fs');
const path = require('path');

const TPS = 20;
const MIN_DIST = 1e-6;

function defaultConfig() {
	return {
		kbInvulnTicks: null,
		sprintBuffer: 0,
		horizontal: 0.4,
		vertical: 0.4,
		extraHorizontal: 0.5,
		extraVertical: 0.1,
		verticalLimit: 0.4,
		yawWeight: 0.0,
		pitchWeight: 0.0,
		extraYawWeight: 1.0,
		extraPitchWeight: 0.0,
		heightDelta: 0.0,
		extraHeightDelta: 0.0,
		horizontalCombine: 'VECTOR_ADDITION',
		verticalCombine: 'SCALAR',
		degenerateFallback: 'RANDOM',
		frictionH: 2.0,
		frictionV: 2.0,
		frictionExtraH: 2.0,
		frictionExtraV: 2.0,
		rangeStartH: 0.0,
		rangeFactorH: 0.0,
		rangeStartV: 0.0,
		rangeFactorV: 0.0,
		rangeStartExtraH: 0.0,
		rangeFactorExtraH: 0.0,
		rangeStartExtraV: 0.0,
		rangeFactorExtraV: 0.0,
		rangeMaxH: 0.0,
		rangeMaxV: 0.0,
		aMultH: 1.0,
		aMultV: 1.0,
		aMultExtraH: 1.0,
		aMultExtraV: 1.0,
		aMultVLimit: 0,
		sweepFactorH: 0.0,
		sweepFactorV: 0.0,
		sweepFactorExtraH: 0.0,
		sweepFactorExtraV: 0.0,
		knockbackFormula: 'CLASSIC'
	};
}

function vec(x, y, z) {
	return { x: x ?? 0, y: y ?? 0, z: z ?? 0 };
}

function vecLen(v) {
	return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function vecLenXZ(v) {
	return Math.sqrt(v.x * v.x + v.z * v.z);
}

function yawPitchToDir(yawDeg, pitchDeg) {
	const yaw = (yawDeg ?? 0) * Math.PI / 180;
	const pitch = (pitchDeg ?? 0) * Math.PI / 180;
	const c = Math.cos(pitch);
	return vec(-Math.sin(yaw) * c, -Math.sin(pitch), Math.cos(yaw) * c);
}

/** Horizontal direction. Java deltaH(sPt,tPt) uses victim-attacker = direction FROM attacker TO victim.
 *  Our dp = attacker - victim, so posH = -dp/|dp| = victim - attacker. */
function deltaH(dp) {
	const dist = Math.sqrt(dp.dx * dp.dx + dp.dz * dp.dz);
	if (dist < MIN_DIST) return null;
	return vec(-dp.dx / dist, 0, -dp.dz / dist);  // victim - attacker (knockback pushes away)
}

/** Vertical direction: victim above attacker -> +Y, victim below -> -Y. dp = attacker - victim. */
function deltaV(dp) {
	if (Math.abs(dp.dy ?? 0) < MIN_DIST) return vec(0, 1, 0);
	return vec(0, -Math.sign(dp.dy), 0);  // Java: dy = victim - attacker; we have dp.dy = attacker - victim
}

function yawDir(dir) {
	const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
	if (len < MIN_DIST) return null;
	return vec(dir.x / len, 0, dir.z / len);
}

function pitchDir(dir) {
	if (Math.abs(dir.y) < MIN_DIST) return vec(0, 1, 0);
	return vec(0, Math.sign(dir.y), 0);
}

function vecMul(v, sx, sy, sz) {
	return vec(v.x * (sx ?? 1), v.y * (sy ?? 1), v.z * (sz ?? 1));
}

function resolveDS(raw, cfg, extra) {
	const h = extra ? cfg.extraHorizontal : cfg.horizontal;
	const v = extra ? cfg.extraVertical : cfg.vertical;
	const yw = extra ? cfg.extraYawWeight : cfg.yawWeight;
	const pw = extra ? cfg.extraPitchWeight : cfg.pitchWeight;
	const hw = extra ? cfg.extraHeightDelta : cfg.heightDelta;

	const posH = raw.posH || vec(0, 0, 1);
	const posV = raw.posV || vec(0, 1, 0);
	const yawH = raw.yaw || vec(0, 0, 1);
	const pitchV = raw.pitch || vec(0, 1, 0);

	let dirH, dirV, magH = h, magV = v;

	if (cfg.horizontalCombine === 'VECTOR_ADDITION') {
		const posMag = h * (1 - yw);
		const lookMag = h * yw;
		const cx = posH.x * posMag + yawH.x * lookMag;
		const cz = posH.z * posMag + yawH.z * lookMag;
		const len = Math.sqrt(cx * cx + cz * cz);
		dirH = len < MIN_DIST ? yawH : vec(cx / len, 0, cz / len);
		magH = len < MIN_DIST ? h : len;
	} else {
		const wA = 1 - yw, wB = yw;
		const sumX = posH.x * wA + yawH.x * wB;
		const sumZ = posH.z * wA + yawH.z * wB;
		const len = Math.sqrt(sumX * sumX + sumZ * sumZ);
		dirH = len < MIN_DIST ? yawH : vec(sumX / len, 0, sumZ / len);
	}

	if (cfg.verticalCombine === 'VECTOR_ADDITION') {
		const heightMag = v * hw;
		const pitchMag = v * pw;
		const cy = pitchV.y * pitchMag + posV.y * heightMag;
		const len = Math.abs(cy);
		dirV = len < MIN_DIST ? vec(0, 1, 0) : vec(0, Math.sign(cy), 0);
		magV = len < MIN_DIST ? v : len;
	} else {
		const vNet = Math.abs(pitchV.y) * pw + Math.abs(posV.y) * hw;
		const blendY = pitchV.y * pw + posV.y * hw;
		dirV = vec(0, Math.max(-1, Math.min(1, blendY / (vNet || 1))), 0);
	}

	const dir3D = vec(dirH.x, dirV.y, dirH.z);
	return { direction: dir3D, h: magH, v: magV };
}

/** Range factor sh for horizontal given distance and range params (hasExtra uses extra params). */
function rangeFactorH(dh, cfg, hasExtra) {
	const rsh = hasExtra ? (cfg.rangeStartExtraH ?? 0) : (cfg.rangeStartH ?? 0);
	const rfh = hasExtra ? (cfg.rangeFactorExtraH ?? 0) : (cfg.rangeFactorH ?? 0);
	let sh = dh <= rsh ? 1.0 : 1.0 - rfh * (dh - rsh);
	if ((cfg.rangeMaxH ?? 0) > 0) sh = Math.max(sh, cfg.rangeMaxH);
	return Math.max(0, Math.min(1, sh));
}

function applyRr(kb, dp, cfg, hasExtra) {
	const dh = Math.sqrt(dp.dx * dp.dx + dp.dz * dp.dz);
	const dv = Math.abs(dp.dy ?? 0);

	const rsh = hasExtra ? (cfg.rangeStartExtraH ?? 0) : (cfg.rangeStartH ?? 0);
	const rfh = hasExtra ? (cfg.rangeFactorExtraH ?? 0) : (cfg.rangeFactorH ?? 0);
	const rsv = hasExtra ? (cfg.rangeStartExtraV ?? 0) : (cfg.rangeStartV ?? 0);
	const rfv = hasExtra ? (cfg.rangeFactorExtraV ?? 0) : (cfg.rangeFactorV ?? 0);

	let sh = dh <= rsh ? 1.0 : 1.0 - rfh * (dh - rsh);
	let sv = dv <= rsv ? 1.0 : 1.0 - rfv * (dv - rsv);

	if ((cfg.rangeMaxH ?? 0) > 0) sh = Math.max(sh, cfg.rangeMaxH);
	if ((cfg.rangeMaxV ?? 0) > 0) sv = Math.max(sv, cfg.rangeMaxV);

	sh = Math.max(0, Math.min(1, sh));
	sv = Math.max(0, Math.min(1, sv));

	return vec(kb.x * sh, kb.y * sv, kb.z * sh);
}

function applyAMult(kb, inAir, cfg, hasExtra) {
	if (!inAir) return kb;
	const mH = hasExtra ? (cfg.aMultExtraH ?? 1) : (cfg.aMultH ?? 1);
	const mV = hasExtra ? (cfg.aMultExtraV ?? 1) : (cfg.aMultV ?? 1);
	let result = vec(kb.x * mH, kb.y * mV, kb.z * mH);
	if ((cfg.aMultVLimit ?? 0) > 0) {
		result = vec(result.x, Math.min(cfg.aMultVLimit, result.y), result.z);
	}
	return result;
}

function applySweeping(kb, cause, cfg, hasExtra) {
	if (cause !== 'SWEEPING') return kb;
	const sfh = hasExtra ? (cfg.sweepFactorExtraH ?? 0) : (cfg.sweepFactorH ?? 0);
	const sfv = hasExtra ? (cfg.sweepFactorExtraV ?? 0) : (cfg.sweepFactorV ?? 0);
	return vec(kb.x * (1 - sfh), kb.y * (1 - sfv), kb.z * (1 - sfh));
}

function addVectors(a, b, cfg) {
	const hAdd = cfg.horizontalCombine === 'VECTOR_ADDITION';
	const vAdd = cfg.verticalCombine === 'VECTOR_ADDITION';

	let resX, resZ, resY;

	if (hAdd) {
		resX = a.x + b.x;
		resZ = a.z + b.z;
	} else {
		const magA = vecLenXZ(a);
		const magB = vecLenXZ(b);
		const hNet = magA + magB;
		if (hNet < MIN_DIST) resX = resZ = 0;
		else {
			const sumX = a.x + b.x;
			const sumZ = a.z + b.z;
			const len = Math.sqrt(sumX * sumX + sumZ * sumZ);
			if (len < MIN_DIST) resX = resZ = 0;
			else {
				const s = hNet / len;
				resX = sumX * s;
				resZ = sumZ * s;
			}
		}
	}

	if (vAdd) resY = a.y + b.y;
	else {
		const vNet = Math.abs(a.y) + Math.abs(b.y);
		const blendY = a.y + b.y;
		resY = Math.max(-vNet, Math.min(vNet, blendY));
	}

	return vec(resX, resY, resZ);
}

function computeKbVec(entry, cfg, hasExtra, inAir = false, cause = 'MELEE') {
	cfg = { ...defaultConfig(), ...cfg };
	const dp = entry.dp || { dx: 0, dy: 0, dz: 0 };

	const dir3D = yawPitchToDir(entry.attackerYaw, entry.attackerPitch);
	const posH = deltaH(dp) || vec(0, 0, 1);  // direction from attacker to victim (deltaH now returns this)
	const posV = deltaV(dp);
	const yawH = yawDir(dir3D) || vec(0, 0, 1);
	const pitchV = pitchDir(dir3D);

	const raw = { posH, posV, yaw: yawH, pitch: pitchV };

	const normKb = resolveDS(raw, cfg, false);
	const extraKb = hasExtra ? resolveDS(raw, cfg, true) : null;

	let kb = vecMul(normKb.direction, normKb.h, normKb.v, normKb.h);
	let kbe = extraKb ? vecMul(extraKb.direction, extraKb.h, extraKb.v, extraKb.h) : null;

	kb = applyRr(kb, dp, cfg, false);
	kb = applyAMult(kb, inAir, cfg, false);
	kb = applySweeping(kb, cause, cfg, false);

	if (kbe) {
		kbe = applyRr(kbe, dp, cfg, true);
		kbe = applyAMult(kbe, inAir, cfg, true);
		kbe = applySweeping(kbe, cause, cfg, true);
	}

	let kbVec = kbe ? addVectors(kb, kbe, cfg) : kb;

	if ((cfg.verticalLimit ?? 0) > 0) {
		const y = Math.max(-cfg.verticalLimit, Math.min(cfg.verticalLimit, kbVec.y));
		kbVec = vec(kbVec.x, y, kbVec.z);
	}

	return kbVec;
}

/** Horizontal distance from attacker to victim (blocks) */
function horizontalDistance(entry) {
	const dp = entry.dp || { dx: 0, dy: 0, dz: 0 };
	return Math.sqrt(dp.dx * dp.dx + dp.dz * dp.dz);
}

/**
 * Processed horizontal magnitude: |(final - initial)| with Y removed.
 * This is the observable horizontal velocity change from the hit (blocks/tick).
 */
function processedHorizontalMag(entry) {
	const f = entry.final;
	const i = entry.initial;
	if (!f || !i) return null;

	const fx = (f.vx?.raw ?? f.vx ?? 0) / 8000;
	const fz = (f.vz?.raw ?? f.vz ?? 0) / 8000;
	const ix = (i.vx?.raw ?? i.vx ?? 0) / 8000;
	const iz = (i.vz?.raw ?? i.vz ?? 0) / 8000;

	const dx = fx - ix;
	const dz = fz - iz;
	return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Cluster processed horizontal magnitudes into sprint (larger) vs non-sprint (smaller).
 * Returns { sprintMag, nonSprintMag, assignments } or null if we can't find two distinct clusters.
 * assignments[i] = true for sprint, false for non-sprint.
 */
function clusterSprintNonSprint(entries) {
	const mags = [];
	const indices = [];
	for (let i = 0; i < entries.length; i++) {
		const m = processedHorizontalMag(entries[i]);
		if (m != null && m > 0.001) {
			mags.push(m);
			indices.push(i);
		}
	}
	if (mags.length < 2) return null;

	// 2-means clustering: smaller = non-sprint, larger = sprint
	let low = Math.min(...mags);
	let high = Math.max(...mags);
	if (high - low < 0.03) return null; // too close to distinguish

	for (let iter = 0; iter < 30; iter++) {
		const lowGroup = [];
		const highGroup = [];
		for (let j = 0; j < mags.length; j++) {
			const dLow = Math.abs(mags[j] - low);
			const dHigh = Math.abs(mags[j] - high);
			if (dLow <= dHigh) lowGroup.push(mags[j]);
			else highGroup.push(mags[j]);
		}
		if (lowGroup.length === 0 || highGroup.length === 0) break;
		low = lowGroup.reduce((a, b) => a + b, 0) / lowGroup.length;
		high = highGroup.reduce((a, b) => a + b, 0) / highGroup.length;
	}

	// Require clear separation: smaller = non-sprint, larger = sprint
	if (high - low < 0.04) return null;

	// Build assignments for all entries (null for entries we skipped)
	const assignments = [];
	const lowCount = [];
	const highCount = [];
	for (let i = 0; i < entries.length; i++) {
		const m = processedHorizontalMag(entries[i]);
		if (m != null && m > 0.001) {
			const isSprint = Math.abs(m - high) < Math.abs(m - low);
			assignments[i] = isSprint;
			if (isSprint) highCount.push(i);
			else lowCount.push(i);
		} else {
			assignments[i] = null;
		}
	}

	// Need at least 1 hit in each cluster
	if (lowCount.length === 0 || highCount.length === 0) return null;

	return { sprintMag: high, nonSprintMag: low, assignments, lowCount: lowCount.length, highCount: highCount.length };
}

function getObservedKbVec(entry, cfg, hasExtra) {
	const f = entry.final;
	const i = entry.initial;
	if (!f || !i) return null;

	const vx = (f.vx?.raw ?? f.vx ?? 0) / 8000;
	const vy = (f.vy?.raw ?? f.vy ?? 0) / 8000;
	const vz = (f.vz?.raw ?? f.vz ?? 0) / 8000;

	const ix = (i.vx?.raw ?? i.vx ?? 0) / 8000;
	const iy = (i.vy?.raw ?? i.vy ?? 0) / 8000;
	const iz = (i.vz?.raw ?? i.vz ?? 0) / 8000;

	const fH = hasExtra ? (cfg.frictionExtraH ?? 2) : (cfg.frictionH ?? 2);
	const fV = hasExtra ? (cfg.frictionExtraV ?? 2) : (cfg.frictionV ?? 2);

	return vec(
		vx - ix / fH,
		vy - iy / fV,
		vz - iz / fH
	);
}

function vecDiff(a, b) {
	return vec(a.x - b.x, a.y - b.y, a.z - b.z);
}

function vecSqLen(v) {
	return v.x * v.x + v.y * v.y + v.z * v.z;
}

/** Total squared error with FIXED sprint assignments per entry */
function totalErrorWithAssignments(entries, cfg, sprintAssignments, inAir = false, cause = 'MELEE') {
	let err = 0;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const hasExtra = sprintAssignments[i];
		if (hasExtra === null) continue; // skip unassigned

		const hasDp = e.dp && (Math.abs(e.dp.dx ?? 0) > 0.01 || Math.abs(e.dp.dz ?? 0) > 0.01);
		const hasLook = (e.attackerYaw != null || e.attackerPitch != null);
		if (!hasDp && !hasLook) continue;

		const obs = getObservedKbVec(e, cfg, hasExtra);
		const pred = computeKbVec(e, cfg, hasExtra, inAir, cause);
		if (obs) err += vecSqLen(vecDiff(obs, pred));
	}
	return err;
}

/** Total squared error when we try both sprint modes (used when no assignments) */
function totalError(entries, cfg, inAir = false, cause = 'MELEE') {
	let err = 0;
	for (const e of entries) {
		const hasDp = e.dp && (Math.abs(e.dp.dx ?? 0) > 0.01 || Math.abs(e.dp.dz ?? 0) > 0.01);
		const hasLook = (e.attackerYaw != null || e.attackerPitch != null);
		if (!hasDp && !hasLook) continue;

		const obsNorm = getObservedKbVec(e, cfg, false);
		const obsSprint = getObservedKbVec(e, cfg, true);
		const predNorm = computeKbVec(e, cfg, false, inAir, cause);
		const predSprint = computeKbVec(e, cfg, true, inAir, cause);

		const errNorm = obsNorm ? vecSqLen(vecDiff(obsNorm, predNorm)) : Infinity;
		const errSprint = obsSprint ? vecSqLen(vecDiff(obsSprint, predSprint)) : Infinity;
		err += Math.min(errNorm, errSprint);
	}
	return err;
}

/**
 * Fit range reduction by consistency of implied base strength across hits at different distances.
 * observed_h_mag = applied knockback (after range reduction). implied_base = observed_h_mag / sh.
 * With correct range params, implied_base should be consistent (same server config).
 * Uses one consistent range for both main and extra horizontal (rangeStartH = rangeStartExtraH, etc.).
 * Returns { rangeStartH, rangeFactorH, rangeStartExtraH, rangeFactorExtraH, rangeMaxH }.
 */
function fitRangeByVarianceConsistency(entries, sprintAssignments, frictionCfg) {
	const MIN_DH = 0.1;  // ignore hits too close (degenerate direction)
	// One consistent range for both main and extra horizontal
	const rangeConfigs = [
		{ rangeStartH: 0, rangeFactorH: 0, rangeStartExtraH: 0, rangeFactorExtraH: 0, rangeMaxH: 0 },
		{ rangeStartH: 1, rangeFactorH: 0.1, rangeStartExtraH: 1, rangeFactorExtraH: 0.1, rangeMaxH: 0.4 },
		{ rangeStartH: 2, rangeFactorH: 0.15, rangeStartExtraH: 2, rangeFactorExtraH: 0.15, rangeMaxH: 0.4 },
		{ rangeStartH: 3, rangeFactorH: 0.2, rangeStartExtraH: 3, rangeFactorExtraH: 0.2, rangeMaxH: 0.4 },
		{ rangeStartH: 4, rangeFactorH: 0.15, rangeStartExtraH: 4, rangeFactorExtraH: 0.15, rangeMaxH: 0.4 },
		{ rangeStartH: 4, rangeFactorH: 0.2, rangeStartExtraH: 4, rangeFactorExtraH: 0.2, rangeMaxH: 0.4 },
		{ rangeStartH: 4, rangeFactorH: 0.25, rangeStartExtraH: 4, rangeFactorExtraH: 0.25, rangeMaxH: 0.4 },
		{ rangeStartH: 4, rangeFactorH: 0.3, rangeStartExtraH: 4, rangeFactorExtraH: 0.3, rangeMaxH: 0.4 },
		{ rangeStartH: 5, rangeFactorH: 0.2, rangeStartExtraH: 5, rangeFactorExtraH: 0.2, rangeMaxH: 0.4 },
		{ rangeStartH: 6, rangeFactorH: 0.15, rangeStartExtraH: 6, rangeFactorExtraH: 0.15, rangeMaxH: 0.4 },
		{ rangeStartH: 6, rangeFactorH: 0.2, rangeStartExtraH: 6, rangeFactorExtraH: 0.2, rangeMaxH: 0.4 }
	];

	function variance(arr) {
		if (arr.length < 2) return Infinity;
		const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
		return arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
	}

	let bestRange = rangeConfigs[0];
	let bestVar = Infinity;
	let bestNSprint = 0, bestNNonSprint = 0;

	for (const rc of rangeConfigs) {
		const cfg = { ...frictionCfg, ...rc };
		const sprintImplied = [];
		const nonSprintImplied = [];

		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			const hasExtra = sprintAssignments ? sprintAssignments[i] : null;
			if (hasExtra === null && sprintAssignments) continue;

			const dh = horizontalDistance(e);
			if (dh < MIN_DH) continue;

			const obs = getObservedKbVec(e, cfg, hasExtra ?? false);
			if (!obs) continue;

			const obsH = Math.sqrt(obs.x * obs.x + obs.z * obs.z);
			if (obsH < 0.001) continue;

			const sh = rangeFactorH(dh, cfg, hasExtra ?? false);
			if (sh < 0.01) continue;  // avoid div by near-zero

			const implied = obsH / sh;
			if (hasExtra) sprintImplied.push(implied);
			else nonSprintImplied.push(implied);
		}

		const vSprint = variance(sprintImplied);
		const vNon = variance(nonSprintImplied);
		const totalVar = (sprintImplied.length * vSprint + nonSprintImplied.length * vNon) /
			Math.max(1, sprintImplied.length + nonSprintImplied.length);

		if (totalVar < bestVar && (sprintImplied.length >= 2 || nonSprintImplied.length >= 2)) {
			bestVar = totalVar;
			bestRange = rc;
			bestNSprint = sprintImplied.length;
			bestNNonSprint = nonSprintImplied.length;
		}
	}

	return {
		...bestRange,
		_varianceAtBest: bestVar,
		_nSprint: bestNSprint,
		_nNonSprint: bestNNonSprint
	};
}

/** Max |final.y| from packets - the actual velocity the server sets. verticalLimit must be >= this.
 *  Uses packet data directly (not inferred kbVec which depends on friction). */
function maxFinalVelocityY(entries) {
	const toBpt = v => (v?.raw ?? v ?? 0) / 8000;
	let maxY = 0;
	for (const e of entries) {
		const f = e.final;
		if (!f) continue;
		const fy = toBpt(f.vy);
		maxY = Math.max(maxY, Math.abs(fy));
	}
	return maxY;
}

/** Compute observed-from-logs stats: actual packet velocities, initial, raw deltas, observed kbVec, distance. */
function observedFromLogs(entries, cfg, sprintAssignments) {
	const toBpt = v => (v?.raw ?? v ?? 0) / 8000;
	const initV = { vx: [], vy: [], vz: [] };
	const finalV = { vx: [], vy: [], vz: [] };
	const rawDeltaY = [], rawDeltaH = [];
	const obsY = [], obsH = [];
	const distances = [];

	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const hasExtra = sprintAssignments ? sprintAssignments[i] : false;
		if (sprintAssignments && hasExtra === null) continue;
		const f = e.final, i0 = e.initial;
		if (!f || !i0) continue;

		const fx = toBpt(f.vx), fy = toBpt(f.vy), fz = toBpt(f.vz);
		const ix = toBpt(i0.vx), iy = toBpt(i0.vy), iz = toBpt(i0.vz);

		finalV.vx.push(fx); finalV.vy.push(fy); finalV.vz.push(fz);
		initV.vx.push(ix); initV.vy.push(iy); initV.vz.push(iz);
		rawDeltaY.push(fy - iy);
		rawDeltaH.push(Math.sqrt((fx - ix) ** 2 + (fz - iz) ** 2));
		distances.push(horizontalDistance(e));

		const obs = getObservedKbVec(e, cfg, hasExtra ?? false);
		if (obs) {
			obsY.push(obs.y);
			obsH.push(Math.sqrt(obs.x * obs.x + obs.z * obs.z));
		}
	}

	const stat = (arr, f = x => x) => {
		if (arr.length === 0) return { min: null, max: null, mean: null };
		const vals = arr.map(f);
		return {
			min: Math.min(...vals),
			max: Math.max(...vals),
			mean: vals.reduce((a, b) => a + b, 0) / vals.length
		};
	};

	return {
		horizontalDistance: stat(distances),
		finalVelocity: { vx: stat(finalV.vx), vy: stat(finalV.vy), vz: stat(finalV.vz) },
		initialVelocity: { vx: stat(initV.vx), vy: stat(initV.vy), vz: stat(initV.vz) },
		rawDelta: { y: stat(rawDeltaY), h: stat(rawDeltaH) },
		observedKbVec: { y: stat(obsY), h: stat(obsH) }
	};
}

/** Joint grid over range + horizontal (coupled). Returns best config. */
function jointRangeHorizontalSearch(entries, base, errFn, fixedRange, minVerticalLimit, varianceRange = null) {
	const baseRangeConfigs = [
		{ rangeStartExtraH: 0, rangeFactorExtraH: 0, rangeMaxH: 0 },
		{ rangeStartExtraH: 1, rangeFactorExtraH: 0.1, rangeMaxH: 0.4 },
		{ rangeStartExtraH: 2, rangeFactorExtraH: 0.15, rangeMaxH: 0.4 },
		{ rangeStartExtraH: 3, rangeFactorExtraH: 0.2, rangeMaxH: 0.4 },
		{ rangeStartExtraH: 4, rangeFactorExtraH: 0.15, rangeMaxH: 0.4 },
		{ rangeStartExtraH: 4, rangeFactorExtraH: 0.2, rangeMaxH: 0.4 },
		{ rangeStartExtraH: 4, rangeFactorExtraH: 0.25, rangeMaxH: 0.4 },
		{ rangeStartExtraH: 4, rangeFactorExtraH: 0.3, rangeMaxH: 0.4 },
		{ rangeStartExtraH: 5, rangeFactorExtraH: 0.2, rangeMaxH: 0.4 },
		{ rangeStartExtraH: 6, rangeFactorExtraH: 0.15, rangeMaxH: 0.4 },
		{ rangeStartExtraH: 6, rangeFactorExtraH: 0.2, rangeMaxH: 0.4 }
	];
	const rangeConfigs = fixedRange && Object.keys(fixedRange).length > 0
		? [fixedRange]
		: (varianceRange ? [varianceRange, ...baseRangeConfigs] : baseRangeConfigs);
	const hVals = [0.4, 0.5, 0.525, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1.0];
	const eHVals = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.65];

	let best = { ...base };
	if ((best.verticalLimit ?? 0) < minVerticalLimit) best.verticalLimit = Math.ceil(minVerticalLimit * 100) / 100;
	let bestErr = errFn(best);

	for (const rc of rangeConfigs) {
		const cBase = { ...base, ...rc };
		for (const h of hVals) {
			for (const eh of eHVals) {
				const c = { ...cBase, horizontal: h, extraHorizontal: eh };
				const e = errFn(c);
				if (e < bestErr) {
					bestErr = e;
					best = { ...c };
				}
			}
		}
	}
	return { best, bestErr };
}

/** Grid search over key parameters. Range + horizontal explored jointly FIRST (they're coupled). */
function fitConfig(entries, baseCfg = null, inAir = false, cause = 'MELEE', fixedRange = null) {
	const base = { ...defaultConfig(), ...baseCfg };
	const cluster = clusterSprintNonSprint(entries);
	const sprintAssignments = cluster ? cluster.assignments : null;
	const minVerticalLimit = maxFinalVelocityY(entries);

	const errFn = sprintAssignments
		? (cfg) => totalErrorWithAssignments(entries, cfg, sprintAssignments, inAir, cause)
		: (cfg) => totalError(entries, cfg, inAir, cause);

	// Phase 0: Fit range by variance consistency (implied base strength should match across distances)
	// observed_h_mag / sh = implied base strength; with correct range params this is consistent across hits
	let varianceBestRange = null;
	if (!fixedRange || Object.keys(fixedRange).length === 0) {
		const vbr = fitRangeByVarianceConsistency(entries, sprintAssignments,
			{ frictionH: 3.5, frictionV: 15, frictionExtraH: 3.5, frictionExtraV: 15 });
		// Strip diagnostics for use as config candidate
		varianceBestRange = { rangeStartH: vbr.rangeStartH, rangeFactorH: vbr.rangeFactorH,
			rangeStartExtraH: vbr.rangeStartExtraH, rangeFactorExtraH: vbr.rangeFactorExtraH, rangeMaxH: vbr.rangeMaxH };
	}

	// Phase 1: Joint range + horizontal search (include variance-based range as candidate)
	let { best, bestErr } = jointRangeHorizontalSearch(entries, base, errFn, fixedRange, minVerticalLimit, varianceBestRange);

	// Coarse search - other params (exclude range; already set in Phase 1)
	const derivedVertical = Math.round(Math.max(minVerticalLimit, 0.35) * 100) / 100;
	const verticalVals = [0.35, 0.4, 0.45].includes(derivedVertical) ? [0.35, 0.4, 0.45] : [0.35, derivedVertical, 0.4, 0.45];
	const params = [
		{ key: 'horizontal', vals: [0.3, 0.4, 0.5, 0.525, 0.6, 0.7, 0.8] },
		{ key: 'vertical', vals: verticalVals },
		{ key: 'extraHorizontal', vals: [0.25, 0.35, 0.3535, 0.45, 0.55, 0.65] },
		{ key: 'extraVertical', vals: [0, 0.05, 0.1] },
		{ key: 'verticalLimit', vals: [0, 0.3, 0.365, 0.4, 0.5] },
		{ key: 'yawWeight', vals: [0, 0.25, 0.5, 0.75, 1] },
		{ key: 'extraYawWeight', vals: [0, 0.25, 0.5, 0.75, 1] },
		{ key: 'frictionH', vals: [2, 2.5, 3, 3.5, 4] },
		{ key: 'frictionV', vals: [2, 3, 5, 10, 15, 20] },
		{ key: 'frictionExtraH', vals: [2, 2.5, 3, 3.5, 4] },
		{ key: 'frictionExtraV', vals: [2, 3, 5, 10, 15, 20] },
		{ key: 'rangeStartExtraH', vals: [0, 2, 4, 6] },
		{ key: 'rangeFactorExtraH', vals: [0, 0.1, 0.25, 0.4] },
		{ key: 'rangeMaxH', vals: [0, 0.2, 0.4, 0.6] }
	];

	for (const { key, vals } of params) {
		if (fixedRange && (key === 'rangeStartExtraH' || key === 'rangeFactorExtraH' || key === 'rangeMaxH') && key in fixedRange) continue;
		let localBest = bestErr;
		let localBestVal = best[key];
		const filtered = (key === 'verticalLimit' && minVerticalLimit > 0)
			? vals.filter(v => v === 0 || v >= minVerticalLimit)
			: vals;
		for (const v of (filtered.length ? filtered : vals)) {
			const c = { ...best, [key]: v };
			const e = errFn(c);
			if (e < localBest) {
				localBest = e;
				localBestVal = v;
			}
		}
		best = { ...best, [key]: localBestVal };
		bestErr = localBest;
	}

	// Refine with finer grid
	const refineParams = [
		{ key: 'horizontal', delta: 0.02, center: best.horizontal },
		{ key: 'vertical', delta: 0.01, center: best.vertical },
		{ key: 'extraHorizontal', delta: 0.02, center: best.extraHorizontal },
		{ key: 'extraVertical', delta: 0.01, center: best.extraVertical },
		{ key: 'verticalLimit', delta: 0.02, center: best.verticalLimit },
		{ key: 'yawWeight', delta: 0.1, center: best.yawWeight },
		{ key: 'extraYawWeight', delta: 0.1, center: best.extraYawWeight },
		{ key: 'frictionH', delta: 0.25, center: best.frictionH },
		{ key: 'frictionV', delta: 1, center: best.frictionV },
		{ key: 'frictionExtraH', delta: 0.25, center: best.frictionExtraH },
		{ key: 'frictionExtraV', delta: 1, center: best.frictionExtraV },
		{ key: 'rangeStartExtraH', delta: 0.5, center: best.rangeStartExtraH },
		{ key: 'rangeFactorExtraH', delta: 0.05, center: best.rangeFactorExtraH },
		{ key: 'rangeMaxH', delta: 0.05, center: best.rangeMaxH }
	];

	for (const { key, delta, center } of refineParams) {
		if (fixedRange && (key === 'rangeStartExtraH' || key === 'rangeFactorExtraH' || key === 'rangeMaxH') && key in fixedRange) continue;
		for (let d = -3; d <= 3; d++) {
			let v = center + d * delta;
			if (key.includes('friction') || key.includes('range')) v = Math.round(v * 100) / 100;
			else v = Math.round(v * 1000) / 1000;
			if (v < 0) continue;
			if (key === 'verticalLimit' && v > 0 && v < minVerticalLimit) continue;
			const c = { ...best, [key]: v };
			const e = errFn(c);
			if (e < bestErr) {
				bestErr = e;
				best = { ...best, [key]: v };
			}
		}
	}

	// Second pass - re-optimize in case of coupling
	for (const { key, vals } of params) {
		if (fixedRange && (key === 'rangeStartExtraH' || key === 'rangeFactorExtraH' || key === 'rangeMaxH') && key in fixedRange) continue;
		let localBest = bestErr;
		let localBestVal = best[key];
		const filtered = (key === 'verticalLimit' && minVerticalLimit > 0)
			? vals.filter(v => v === 0 || v >= minVerticalLimit)
			: vals;
		for (const v of (filtered.length ? filtered : vals)) {
			const c = { ...best, [key]: v };
			const e = errFn(c);
			if (e < localBest) {
				localBest = e;
				localBestVal = v;
			}
		}
		best = { ...best, [key]: localBestVal };
		bestErr = localBest;
	}

	// Final joint range+horizontal pass (friction/vertical now optimized; range may improve)
	if (!fixedRange || Object.keys(fixedRange).length === 0) {
		const { best: r2, bestErr: e2 } = jointRangeHorizontalSearch(entries, best, errFn, null, minVerticalLimit);
		if (e2 < bestErr) {
			best = r2;
			bestErr = e2;
		}
	}

	return { config: best, clusterInfo: cluster };
}

/** Known Minemen config for verification */
function minemenConfig() {
	const c = defaultConfig();
	c.sprintBuffer = 8;
	c.horizontal = 0.525;
	c.vertical = 0.4;
	c.extraHorizontal = 0.3535;
	c.extraVertical = 0.0;
	c.verticalLimit = 0.365;
	c.yawWeight = 0.5;
	c.extraYawWeight = 0.5;
	c.frictionH = 3.5;
	c.frictionV = 15;
	c.frictionExtraH = 3.5;
	c.frictionExtraV = 15;
	c.rangeStartExtraH = 4.0;
	c.rangeFactorExtraH = 0.25;
	c.rangeMaxH = 0.40;
	return c;
}

/** Verify: compare observed vs predicted with a given config. Reports per-hit and total error. */
function verifyConfig(entries, cfg, sprintAssignments, options = {}) {
	const { verbose = false, useExtraType = true } = options;
	const toBpt = v => (v?.raw ?? v ?? 0) / 8000;
	const results = [];
	let totalSqErr = 0;
	let n = 0;

	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		// Sprint: prefer extraType from data (idle/non_idle = sprint), else cluster assignment
		let hasExtra = null;
		if (useExtraType && (e.extraType === 'idle' || e.extraType === 'non_idle')) hasExtra = true;
		else if (sprintAssignments && i < sprintAssignments.length) hasExtra = sprintAssignments[i];
		else if (e.sprint != null) hasExtra = e.sprint;
		if (hasExtra === null && sprintAssignments) continue;

		const hasDp = e.dp && (Math.abs(e.dp.dx ?? 0) > 0.01 || Math.abs(e.dp.dz ?? 0) > 0.01);
		const hasLook = (e.attackerYaw != null || e.attackerPitch != null);
		if (!hasDp && !hasLook) continue;

		const obs = getObservedKbVec(e, cfg, hasExtra ?? false);
		const pred = computeKbVec(e, cfg, hasExtra ?? false);
		if (!obs) continue;

		const dx = obs.x - pred.x, dy = obs.y - pred.y, dz = obs.z - pred.z;
		const sqErr = dx * dx + dy * dy + dz * dz;
		totalSqErr += sqErr;
		n++;

		const obsH = Math.sqrt(obs.x * obs.x + obs.z * obs.z);
		const predH = Math.sqrt(pred.x * pred.x + pred.z * pred.z);
		results.push({
			i, hasExtra: hasExtra ?? false, extraType: e.extraType,
			obsH, predH, obsY: obs.y, predY: pred.y,
			sqErr, dh: horizontalDistance(e)
		});
	}

	return { totalSqErr, n, results, meanSqErr: n > 0 ? totalSqErr / n : 0 };
}

function main() {
	const args = process.argv.slice(2);
	let cfgPath = path.join(__dirname, 'reverse-knockback-config.json');
	let inAir = false;
	let cause = 'MELEE';
	let verbose = false;
	let verifyMode = false;
	let verifyConfigPath = null;
	const fixedRange = {};

	const inputFiles = [];
	for (let i = 0; i < args.length; i++) {
		if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) cfgPath = args[++i];
		else if (args[i] === '--in-air') inAir = true;
		else if (args[i] === '--sweeping') cause = 'SWEEPING';
		else if (args[i] === '--verbose' || args[i] === '-v') verbose = true;
		else if (args[i] === '--verify' && args[i + 1]) { verifyMode = true; verifyConfigPath = args[++i]; }
		else if (args[i] === '--range-start-extra-h' && args[i + 1]) { fixedRange.rangeStartExtraH = parseFloat(args[++i]); }
		else if (args[i] === '--range-factor-extra-h' && args[i + 1]) { fixedRange.rangeFactorExtraH = parseFloat(args[++i]); }
		else if (args[i] === '--range-max-h' && args[i + 1]) { fixedRange.rangeMaxH = parseFloat(args[++i]); }
		else if (!args[i].startsWith('-')) inputFiles.push(args[i]);
	}

	if (verifyMode) {
		// --verify <config.json> <data.json>
		const dataPath = verifyConfigPath ? (inputFiles[0] || args[args.indexOf('--verify') + 2]) : inputFiles[0];
		if (!verifyConfigPath || !dataPath) {
			console.error('Usage: node reverse-knockback.js --verify <config.json> <data.json>');
			process.exit(1);
		}
		const cfg = JSON.parse(fs.readFileSync(verifyConfigPath, 'utf8'));
		const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
		const entries = Array.isArray(data) ? data : [data];
		const cluster = clusterSprintNonSprint(entries);
		const sprintAssignments = cluster ? cluster.assignments : null;
		const v = verifyConfig(entries, cfg, sprintAssignments, { verbose: true });
		console.error(`Verify: n=${v.n}, totalSqErr=${v.totalSqErr.toFixed(6)}, meanSqErr=${v.meanSqErr.toFixed(6)}`);
		// Show worst hits
		const sorted = v.results.slice().sort((a, b) => b.sqErr - a.sqErr);
		for (let j = 0; j < Math.min(10, sorted.length); j++) {
			const r = sorted[j];
			console.error(`  hit ${r.i}: sprint=${r.hasExtra} extraType=${r.extraType} dh=${r.dh?.toFixed(2)} obsH=${r.obsH?.toFixed(4)} predH=${r.predH?.toFixed(4)} obsY=${r.obsY?.toFixed(4)} predY=${r.predY?.toFixed(4)} sqErr=${r.sqErr.toFixed(6)}`);
		}
		// Also verify with known Minemen
		const mm = verifyConfig(entries, minemenConfig(), sprintAssignments);
		console.error(`\nWith KNOWN Minemen config: n=${mm.n}, totalSqErr=${mm.totalSqErr.toFixed(6)}, meanSqErr=${mm.meanSqErr.toFixed(6)}`);
		process.exit(0);
	}

	let baseCfg = defaultConfig();
	try {
		if (fs.existsSync(cfgPath)) {
			baseCfg = { ...baseCfg, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
		}
	} catch (e) {}
	baseCfg = { ...baseCfg, ...fixedRange };

	const allEntries = [];
	if (inputFiles.length > 0) {
		for (const f of inputFiles) {
			try {
				const raw = fs.readFileSync(f, 'utf8');
				const data = JSON.parse(raw);
				const arr = Array.isArray(data) ? data : [data];
				allEntries.push(...arr);
			} catch (e) {
				console.error('Cannot read/parse file:', f, e.message);
				process.exit(1);
			}
		}
	} else {
		const input = fs.readFileSync(0, 'utf8');
		try {
			const data = JSON.parse(input);
			const arr = Array.isArray(data) ? data : [data];
			allEntries.push(...arr);
		} catch (e) {
			console.error('Invalid JSON input');
			process.exit(1);
		}
	}

	const entries = allEntries;
	const valid = entries.filter(e => e.dp || e.attackerYaw != null || e.attackerPitch != null);

	if (valid.length === 0) {
		console.error('No valid entries with dp or attacker look');
		console.log(JSON.stringify(baseCfg, null, 2));
		process.exit(1);
	}

	const { config: fittedCfg, clusterInfo } = fitConfig(valid, baseCfg, inAir, cause, fixedRange);
	const result = { ...baseCfg, ...fittedCfg };
	if (clusterInfo) {
		result._clusterInfo = {
			sprintMag: clusterInfo.sprintMag,
			nonSprintMag: clusterInfo.nonSprintMag,
			nonSprintCount: clusterInfo.lowCount,
			sprintCount: clusterInfo.highCount
		};
	}
	result._minVerticalLimit = maxFinalVelocityY(valid);
	result._observedFromLogs = observedFromLogs(valid, fittedCfg, clusterInfo?.assignments ?? null);
	// Variance-based range fit: implied_base = observed_h_mag / sh should be consistent across hits.
	// Use fitted friction so observedKbVec reflects actual applied knockback.
	const vbr = fitRangeByVarianceConsistency(valid, clusterInfo?.assignments ?? null, {
		frictionH: fittedCfg.frictionH ?? 3.5,
		frictionV: fittedCfg.frictionV ?? 15,
		frictionExtraH: fittedCfg.frictionExtraH ?? 3.5,
		frictionExtraV: fittedCfg.frictionExtraV ?? 15
	});
	result._varianceRangeFit = vbr;

	if (verbose) {
		const sprintAssignments = clusterInfo ? clusterInfo.assignments : null;
		let totalErr = 0;
		const samples = [];
		for (let i = 0; i < valid.length; i++) {
			const e = valid[i];
			const hasExtra = sprintAssignments ? sprintAssignments[i] : null;
			if (hasExtra === null && sprintAssignments) continue;
			const hasDp = e.dp && (Math.abs(e.dp.dx ?? 0) > 0.01 || Math.abs(e.dp.dz ?? 0) > 0.01);
			const hasLook = (e.attackerYaw != null || e.attackerPitch != null);
			if (!hasDp && !hasLook) continue;
			let err, usedSprint;
			if (hasExtra !== null) {
				const obs = getObservedKbVec(e, fittedCfg, hasExtra);
				const pred = computeKbVec(e, fittedCfg, hasExtra, inAir, cause);
				err = obs ? vecSqLen(vecDiff(obs, pred)) : 0;
				usedSprint = hasExtra;
			} else {
				const o0 = getObservedKbVec(e, fittedCfg, false), o1 = getObservedKbVec(e, fittedCfg, true);
				const p0 = computeKbVec(e, fittedCfg, false, inAir, cause), p1 = computeKbVec(e, fittedCfg, true, inAir, cause);
				const e0 = o0 ? vecSqLen(vecDiff(o0, p0)) : Infinity;
				const e1 = o1 ? vecSqLen(vecDiff(o1, p1)) : Infinity;
				err = Math.min(e0, e1);
				usedSprint = e1 < e0;
			}
			totalErr += err;
			if (samples.length < 5) samples.push({ i, dp: e.dp, err, sprint: usedSprint });
		}
		console.error(`[verbose] entries=${valid.length}, totalSqErr=${totalErr.toFixed(6)}`);
		samples.forEach(s => console.error(`  hit ${s.i}: dp=(${s.dp?.dx?.toFixed(2)},${s.dp?.dz?.toFixed(2)}), sprint=${s.sprint}, err=${s.err.toFixed(6)}`));
	}

	console.log(JSON.stringify(result, null, 2));
}

main();
