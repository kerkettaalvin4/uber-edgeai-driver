/** A Hybrid Logical Clock value ordered by physical time, counter, then node. */
export interface HlcTimestamp {
  readonly physicalMs: number;
  readonly logicalCounter: number;
  readonly nodeId: string;
}

export interface HlcReceiveResult {
  readonly timestamp: HlcTimestamp;
  /** How far the resulting HLC time is ahead of this device's wall clock. */
  readonly clockSkewMs: number;
}

const HLC_PATTERN = /^(\d+):([0-9a-fA-F]{4,}):([^:]+)$/;

/** Create the initial clock value for a node at its current wall time. */
export function createHlc(nodeId: string, physicalMs: number): HlcTimestamp {
  assertNodeId(nodeId);
  assertNonNegativeSafeInteger(physicalMs, 'physicalMs');

  return { physicalMs, logicalCounter: 0, nodeId };
}

/**
 * Advance a local clock. If wall time has stalled or moved backward, increment
 * the logical counter instead so the returned value still moves forward.
 */
export function hlcNow(
  current: HlcTimestamp,
  wallClockMs: number,
): HlcTimestamp {
  assertHlc(current);
  assertNonNegativeSafeInteger(wallClockMs, 'wallClockMs');

  if (wallClockMs > current.physicalMs) {
    return {
      physicalMs: wallClockMs,
      logicalCounter: 0,
      nodeId: current.nodeId,
    };
  }

  return {
    physicalMs: current.physicalMs,
    logicalCounter: current.logicalCounter + 1,
    nodeId: current.nodeId,
  };
}

/**
 * Incorporate a received clock using the PRD's HLC receive rules. The caller
 * persists the returned value and logs when clockSkewMs exceeds 60,000 ms.
 */
export function hlcReceive(
  local: HlcTimestamp,
  remote: HlcTimestamp,
  wallClockMs: number,
): HlcReceiveResult {
  assertHlc(local);
  assertHlc(remote);
  assertNonNegativeSafeInteger(wallClockMs, 'wallClockMs');

  const physicalMs = Math.max(
    local.physicalMs,
    remote.physicalMs,
    wallClockMs,
  );

  let logicalCounter: number;
  if (
    physicalMs === local.physicalMs &&
    physicalMs === remote.physicalMs
  ) {
    logicalCounter =
      Math.max(local.logicalCounter, remote.logicalCounter) + 1;
  } else if (physicalMs === local.physicalMs) {
    logicalCounter = local.logicalCounter + 1;
  } else if (physicalMs === remote.physicalMs) {
    logicalCounter = remote.logicalCounter + 1;
  } else {
    logicalCounter = 0;
  }

  assertNonNegativeSafeInteger(logicalCounter, 'logicalCounter');

  return {
    timestamp: {
      physicalMs,
      logicalCounter,
      nodeId: local.nodeId,
    },
    clockSkewMs: physicalMs - wallClockMs,
  };
}

/** Compare HLC values lexicographically as required for LWW tie-breaking. */
export function compareHlc(left: HlcTimestamp, right: HlcTimestamp): number {
  assertHlc(left);
  assertHlc(right);

  if (left.physicalMs !== right.physicalMs) {
    return left.physicalMs < right.physicalMs ? -1 : 1;
  }
  if (left.logicalCounter !== right.logicalCounter) {
    return left.logicalCounter < right.logicalCounter ? -1 : 1;
  }
  if (left.nodeId === right.nodeId) return 0;
  return left.nodeId < right.nodeId ? -1 : 1;
}

/** Serialize as `<physicalMs>:<counter as at least 4 hex digits>:<nodeId>`. */
export function serializeHlc(timestamp: HlcTimestamp): string {
  assertHlc(timestamp);
  return `${timestamp.physicalMs}:${timestamp.logicalCounter
    .toString(16)
    .padStart(4, '0')}:${timestamp.nodeId}`;
}

/** Parse the wire/storage representation used by the PRD. */
export function parseHlc(value: string): HlcTimestamp {
  const match = HLC_PATTERN.exec(value);
  if (!match) {
    throw new TypeError('HLC must use physicalMs:hexCounter:nodeId format');
  }

  const timestamp: HlcTimestamp = {
    physicalMs: Number(match[1]),
    logicalCounter: Number.parseInt(match[2], 16),
    nodeId: match[3],
  };
  assertHlc(timestamp);
  return timestamp;
}

function assertHlc(timestamp: HlcTimestamp): void {
  assertNonNegativeSafeInteger(timestamp.physicalMs, 'physicalMs');
  assertNonNegativeSafeInteger(timestamp.logicalCounter, 'logicalCounter');
  assertNodeId(timestamp.nodeId);
}

function assertNodeId(nodeId: string): void {
  if (nodeId.length === 0 || nodeId.includes(':')) {
    throw new TypeError('nodeId must be non-empty and cannot contain a colon');
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
