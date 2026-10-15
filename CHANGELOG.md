# Changelog

## 0.2.0 - 2026-10-15

- Target apparent wind angle and speed from the polar targets (signalk-polar-builder, else the polar file)
- Laylines to the course destination: `navigation.racing.layline` and `oppositeLayline` distance and time, using target angle and speed and current
- Gybe loss, gybing performance and gybe angle, scored like tacks
- Calibration check: TWD jump across tacks and gybes, averaged into an estimated TWA error upwind and downwind, with a status warning when it's consistently over 3°
- Laylines and next leg use the course destination even without an active route
- The polar status only shows when a value is actually waiting on the polar

## 0.1.1 - 2026-10-12

- Magnetic compass heading works without a live GPS: magnetic variation is no longer dropped after *max input age*. The last value is kept however old, read from the server at startup, and a fallback can be configured for when none has been received.
- Status says "missing: magnetic variation" instead of "missing: heading" when there is a magnetic heading but no variation.

## 0.1.0 - 2026-10-11

First release.

- True wind (angle, speed, direction true/magnetic) from apparent wind and STW, with optional heel correction, leeway and damping
- Ground wind angle, speed and direction
- VMG and VMG performance against polar target VMG
- Current set and drift (needs a compass heading)
- Opposite tack heading and COG, including current
- True wind statistics: average, gust, lull, mean direction, wind phase and lift
- True wind speed scaled to a reference height
- Start line bias from `navigation.racing.startLine*` or signalk-race-control
- Tack loss, tacking performance and tack angle after each tack
- Next leg bearing, distance, TWA and target speed from the active route and the live signalk-polar-builder polar (or a polar file)
- Dead reckoning bearing and distance through the water, resettable by PUT, HTTP or race start
- Falls back to COG as heading for boats without a compass
