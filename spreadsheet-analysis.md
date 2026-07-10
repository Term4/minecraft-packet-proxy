# Book1.xlsx – Knockback Calculation Analysis

## Shared Strings (Column Labels)

| Index | Label |
|-------|-------|
| 0 | CONSTANTS |
| 1 | base h |
| 2 | GUESS |
| 3 | start |
| 4 | Initial V_x |
| 5 | Initial V_z |
| 6 | Final V_x |
| 7 | Final V_z |
| 8 | d_x |
| 9 | d_z |
| 10 | NOTE |
| 11 | Each of these rows corresponds to TWO of the input rows (need two equations since range reduction and friction are linked) |
| 12 | m_1 |
| 13 | m_0 |
| 14 | deltad_1 |
| 15 | deltad_0 |
| 16 | D |
| 17 | d_0 |
| 18 | d_1 |
| 19 | h_x |
| 20 | h_y |
| 21 | h_z |
| 22 | **idle extra h** |
| 23 | **non idle extra h** |
| 24 | idle total h |
| 25 | non idle total h |
| 26 | friction |
| 27 | range reduction |
| 28 | deltah_0 |
| 29 | deltah_1 |
| 30 | H |
| 31 | USE H INSTEAD |
| 32 | TAKES IDLE INTO ACCOUNT |

---

## Layout (Rows 3–4)

**Row 3 (headers):** CONSTANTS | GUESS | Initial V_x | Initial V_z | Final V_x | Final V_z | d_x | d_z | h_x | h_y | h_z

**Row 4 (data):**
- B4: base h = 1
- C4: **0.52725** (base h value)
- E4: start = 3
- F4: **4** (start value – range start?)
- I4: Initial V_x = 0.569625
- J4: Initial V_z = 4.84
- K4: formula → **0.339**

**Row 5:**
- B5: **idle extra h** = 22
- C5: **0.327125**
- I5: Initial V_x (same)
- J5: Initial V_z = 5.53
- K5: shared formula

**Row 6:**
- B6: **non idle extra h** = 23
- C6: (empty)

**Row 7:**
- B7: **idle total h** = 24
- C7: **SUM(C4:C5)** = 0.854375 (base h + idle extra h)

---

## Core Formula (K4:K21)

```
((I - $C$4) - $C$5) / (-(J - $F$4))
```

Where:
- **I** = Initial V_x (column I)
- **J** = Initial V_z (column J)
- **$C$4** = base h (0.52725)
- **$C$5** = idle extra h (0.327125)
- **$F$4** = start (4)

Expanded:
```
((Initial_V_x - base_h) - idle_extra_h) / (-(Initial_V_z - start))
```

**Interpretation:** This appears to solve for a ratio or slope relating:
- Numerator: (Initial_V_x − base_h) − idle_extra_h
- Denominator: −(Initial_V_z − start)

The `start` in the denominator may be range start (distance threshold). The formula uses **idle extra h** (row 5), so this path is for the **idle** (victim not moving) case.

---

## Row 24 Summary Formulas

| Cell | Formula | Meaning |
|------|---------|---------|
| I24 | `SQRT(I4^2 + J4^2)` | m_0 = magnitude of initial velocity (horizontal) |
| J24 | `SQRT(K4^2 + L4^2)` | m_1 = magnitude of final velocity (horizontal) |
| K24 | `SQRT(M4^2 + N4^2)` | d_0 = horizontal distance (d_x, d_z) |
| L24 | `SQRT(M5^2 + N5^2)` | d_1 |
| M24 | `F4 - K24` | deltad_0 = start − d_0 |
| N24 | `F4 - L24` | deltad_1 = start − d_1 |
| O24 | `O4 - C5` | deltah_0 = h_x − idle_extra_h |
| P24 | `Q4 - C5` | deltah_1 = h_z − idle_extra_h |
| Q24 | `L24/K24` | D = d_1 / d_0 |
| T24 | `(J24-Q24*I24)/(O24-Q24*P24)` | **friction** |

---

## Idle vs Non-Idle Extra Horizontal

The spreadsheet already separates:

1. **idle extra h** (row 5, C5 = 0.327125) – when victim is **not** moving  
2. **non idle extra h** (row 6, C6 empty) – when victim **is** moving  

**idle total h** = base h + idle extra h = 0.854375  

For the mod, the logic is:

- If victim is **idle** (not moving): use **idle extra h**
- If victim is **moving**: use **extra h** (non-idle)

---

## Parameters to Add for Mod

| Parameter | Description |
|-----------|-------------|
| `idleExtraHorizontal` | Extra horizontal when victim is NOT moving |
| `extraHorizontal` | Extra horizontal when victim IS moving |

The mod should check victim velocity magnitude (e.g. `sqrt(vx² + vz²) < threshold`) to decide which value to use.
