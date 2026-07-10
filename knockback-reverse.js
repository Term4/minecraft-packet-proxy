/**
 * Reverse-engineers initial velocity from knockback data using the Minestom
 * KnockbackCalculator formula. Port of logic from MinestomMechanics.
 *
 * Formula: finalVec = (initialVec / friction) + kbVec
 * Reverse: initialVec = (finalVec - kbVec) * friction
 *
 * Units: Minecraft packet raw = blocks_per_tick * 8000
 * So: blocks_per_tick = raw / 8000
 */

const TPS = 20;
const MIN_DIST = 1e-6;

/** Default config matching KnockbackConfig.defaultConfig() */
function defaultConfig() {
	return {
		horizontal: 0.4,
		vertical: 0.4,
		extraHorizontal: 0.5,
		extraVertical: 0.1,
		verticalLimit: 0.4,
		yawWeight: 0.0,
		extraYawWeight: 1.0,
		pitchWeight: 0.0,
		extraPitchWeight: 0.0,
		heightDelta: 0.0,
		extraHeightDelta: 0.0,
		horizontalCombine: 'VECTOR_ADDITION',
		verticalCombine: 'SCALAR',
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
		sweepFactorExtraV: 0.0
	};
}

function vec(x, y, z) {
	return { x: x ?? 0, y: y ?? 0, z: z ?? 0 };
}

function vecAdd(a, b) {
	return vec(a.x + b.x, a.y + b.y, a.z + b.z);
}

function vecMul(v, sx, sy, sz) {
	return vec(v.x * (sx ?? 1), v.y * (sy ?? 1), v.z * (sz ?? 1));
}

function vecLen(v) {
	return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function vecLenXZ(v) {
	return Math.sqrt(v.x * v.x + v.z * v.z);
}

function vecNorm(v) {
	const len = vecLen(v);
	if (len < MIN_DIST) return v;
	return vec(v.x / len, v.y / len, v.z / len);
}

/** Yaw (degrees) + pitch (degrees) -> 3D unit direction (Minecraft convention) */
function yawPitchToDir(yawDeg, pitchDeg) {
	const yaw = (yawDeg ?? 0) * Math.PI / 180;
	const pitch = (pitchDeg ?? 0) * Math.PI / 180;
	const c = Math.cos(pitch);
	return vec(-Math.sin(yaw) * c, -Math.sin(pitch), Math.cos(yaw) * c);
}

/** Horizontal (XZ) direction from attacker to victim. dp = victim - attacker = (dx, dy, dz) */
function deltaH(dp) {
	const dist = Math.sqrt(dp.dx * dp.dx + dp.dz * dp.dz);
	if (dist < MIN_DIST) return null;
	return vec(dp.dx / dist, 0, dp.dz / dist);
}

/** Vertical direction from height delta */
function deltaV(dp) {
	if (Math.abs(dp.dy ?? 0) < MIN_DIST) return vec(0, 1, 0);
	return vec(0, Math.sign(dp.dy), 0);
}

/** Horizontal component of 3D direction */
function yawDir(dir) {
	const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
	if (len < MIN_DIST) return null;
	return vec(dir.x / len, 0, dir.z / len);
}

/** Vertical component of 3D direction */
function pitchDir(dir) {
	if (Math.abs(dir.y) < MIN_DIST) return vec(0, 1, 0);
	return vec(0, Math.sign(dir.y), 0);
}

/** Resolve direction + strength. Returns { direction, h, v } */
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
		if (hNet < MIN_DIST) {
			resX = resZ = 0;
		} else {
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

	if (vAdd) {
		resY = a.y + b.y;
	} else {
		const vNet = Math.abs(a.y) + Math.abs(b.y);
		const blendY = a.y + b.y;
		resY = Math.max(-vNet, Math.min(vNet, blendY));
	}

	return vec(resX, resY, resZ);
}

/**
 * Compute kbVec (knockback impulse before friction) from logged data.
 * @param {Object} data - { dp: {dx,dy,dz}, sprint, attackerYaw, attackerPitch }
 * @param {Object} cfg - KnockbackConfig (use defaultConfig() if null)
 * @param {boolean} inAir - victim in air (default false if unknown)
 * @param {string} cause - 'MELEE' | 'SWEEPING' (default 'MELEE')
 */
function computeKbVec(data, cfg, inAir = false, cause = 'MELEE') {
	cfg = { ...defaultConfig(), ...cfg };
	const dp = data.dp || { dx: 0, dy: 0, dz: 0 };
	const hasExtra = !!data.sprint;

	const dir3D = yawPitchToDir(data.attackerYaw, data.attackerPitch);
	const posH = deltaH(dp) || vec(0, 0, 1);
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

/**
 * Reverse-engineer initial velocity from knockback log entry.
 * @param {Object} entry - { dp, sprint, attackerYaw, attackerPitch, final: {vx,vy,vz} }
 * @param {Object} cfg - KnockbackConfig override (optional)
 * @param {boolean} inAir - victim in air (optional, default false)
 * @returns {{ raw: {vx,vy,vz}, scaled: {vx,vy,vz} } | null}
 */
function reverseInitialVelocity(entry, cfg = null, inAir = false) {
	const finalRaw = entry.final;
	if (!finalRaw) return null;
	// Need dp or attacker yaw/pitch for meaningful reverse
	const hasDp = entry.dp && (Math.abs(entry.dp.dx ?? 0) > 0.01 || Math.abs(entry.dp.dz ?? 0) > 0.01);
	const hasLook = (entry.attackerYaw != null || entry.attackerPitch != null);
	if (!hasDp && !hasLook) return null;

	const vx = finalRaw.vx?.raw ?? finalRaw.vx ?? 0;
	const vy = finalRaw.vy?.raw ?? finalRaw.vy ?? 0;
	const vz = finalRaw.vz?.raw ?? finalRaw.vz ?? 0;

	// Packet raw = blocks_per_tick * 8000. Minestom multiplies by TPS before packet.
	// So raw = mot * tps * 8000? No - packet format is blocks_per_tick * 8000.
	// Minestom: mot = (initial/friction) + kbVec; output = mot * tps; packet = output/20 * 8000 = output * 400
	// So raw = output * 400, output = raw/400 (blocks/sec). mot = output/tps = raw/8000 (blocks/tick).
	const finalVec = vec(vx / 8000, vy / 8000, vz / 8000);

	const kbVec = computeKbVec(entry, cfg ?? defaultConfig(), inAir);

	const cfgResolved = cfg ?? defaultConfig();
	const fH = entry.sprint ? (cfgResolved.frictionExtraH ?? 2) : (cfgResolved.frictionH ?? 2);
	const fV = entry.sprint ? (cfgResolved.frictionExtraV ?? 2) : (cfgResolved.frictionV ?? 2);

	// Reverse: finalVec = (initialVec / friction) + kbVec  =>  initialVec = (finalVec - kbVec) * friction
	const initialVec = vec(
		(finalVec.x - kbVec.x) * fH,
		(finalVec.y - kbVec.y) * fV,
		(finalVec.z - kbVec.z) * fH
	);

	return {
		raw: {
			vx: Math.round(initialVec.x * 8000),
			vy: Math.round(initialVec.y * 8000),
			vz: Math.round(initialVec.z * 8000)
		},
		scaled: {
			vx: Math.round(initialVec.x * 10000) / 10000,
			vy: Math.round(initialVec.y * 10000) / 10000,
			vz: Math.round(initialVec.z * 10000) / 10000
		}
	};
}

module.exports = {
	defaultConfig,
	computeKbVec,
	reverseInitialVelocity
};
