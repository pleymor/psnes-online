/**
 * Checksum Worker
 *
 * Offloads checksum computation and sync verification from the main thread.
 * Receives memory snapshots, computes checksums, and manages sync state.
 */

export interface ComputeChecksumMessage {
  type: 'compute_checksum';
  frame: number;
  memorySnapshot: Uint8Array;
}

export interface CompareChecksumMessage {
  type: 'compare_checksum';
  frame: number;
  remoteChecksum: string;
  memorySnapshot: Uint8Array;
}

export interface SerializeStateMessage {
  type: 'serialize_state';
  frame: number;
  stateData: Uint8Array;
}

export type ChecksumWorkerMessage = ComputeChecksumMessage | CompareChecksumMessage | SerializeStateMessage;

export interface ChecksumResultResponse {
  type: 'checksum_result';
  frame: number;
  checksum: string;
}

export interface CompareResultResponse {
  type: 'compare_result';
  frame: number;
  match: boolean;
  localChecksum: string;
  remoteChecksum: string;
}

export interface SerializedStateResponse {
  type: 'serialized_state';
  frame: number;
  stateArray: number[];
}

export type ChecksumWorkerResponse = ChecksumResultResponse | CompareResultResponse | SerializedStateResponse;

// Worker context
const ctx = self as unknown as Worker;

/**
 * Compute fast XOR-based checksum from memory snapshot
 */
function computeChecksum(data: Uint8Array): string {
  const len = data.length;

  let h1 = 0, h2 = 0, h3 = 0, h4 = 0;
  let h5 = 0, h6 = 0, h7 = 0, h8 = 0;

  // Sample every 64th byte for speed
  for (let i = 0; i < len; i += 64) {
    h1 ^= data[i] ^ (i & 0xFF);
    h2 ^= (data[i + 1] || 0) ^ ((i >> 8) & 0xFF);
    h3 ^= (data[i + 2] || 0) ^ ((i >> 16) & 0xFF);
    h4 ^= (data[i + 3] || 0) ^ (i & 0xFF);
    h5 ^= (data[i + 4] || 0) ^ ((i >> 8) & 0xFF);
    h6 ^= (data[i + 5] || 0) ^ ((i >> 16) & 0xFF);
    h7 ^= (data[i + 6] || 0) ^ (i & 0xFF);
    h8 ^= (data[i + 7] || 0) ^ ((i >> 8) & 0xFF);
  }

  return [h1, h2, h3, h4, h5, h6, h7, h8]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

ctx.onmessage = (event: MessageEvent<ChecksumWorkerMessage>) => {
  const msg = event.data;

  if (msg.type === 'compute_checksum') {
    const checksum = computeChecksum(msg.memorySnapshot);

    const response: ChecksumResultResponse = {
      type: 'checksum_result',
      frame: msg.frame,
      checksum
    };

    ctx.postMessage(response);
  } else if (msg.type === 'compare_checksum') {
    const localChecksum = computeChecksum(msg.memorySnapshot);
    const match = localChecksum === msg.remoteChecksum;

    const response: CompareResultResponse = {
      type: 'compare_result',
      frame: msg.frame,
      match,
      localChecksum,
      remoteChecksum: msg.remoteChecksum
    };

    ctx.postMessage(response);
  } else if (msg.type === 'serialize_state') {
    // Convert Uint8Array to number[] for JSON serialization (off main thread)
    const stateArray = Array.from(msg.stateData);

    const response: SerializedStateResponse = {
      type: 'serialized_state',
      frame: msg.frame,
      stateArray
    };

    ctx.postMessage(response);
  }
};
