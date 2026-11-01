// Decoder for a2a-itk's protos/instruction.proto — the only proto the ITK
// agent reads. Hand-written (protobuf wire format, ~70 lines) so the agent
// needs no codegen step or protobuf dependency.
export type Instruction =
  | { callAgent: CallAgent }
  | { returnResponse: { response: string; holdTask: boolean } }
  | { steps: Instruction[] };
export interface CallAgent {
  transport: string;
  agentCardUri: string;
  instruction: Instruction;
  /** The nested instruction's wire bytes, forwarded to the called agent as-is. */
  instructionBytes?: Uint8Array;
  streaming: boolean;
  behavior: "send_message" | "push_notification" | "resubscribe";
  pushUrl?: string;
}

/** Yields [fieldNumber, value] for each field: varints as numbers, length-delimited as bytes. */
function* fields(buf: Uint8Array): Generator<[number, number | Uint8Array]> {
  let i = 0;
  const varint = (): number => {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      const b = buf[i++]!;
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return v;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const wire = key & 7;
    if (wire === 0) yield [key >>> 3, varint()];
    else if (wire === 2) {
      const len = varint();
      yield [key >>> 3, buf.subarray(i, (i += len))];
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

const str = (v: number | Uint8Array) => new TextDecoder().decode(v as Uint8Array);

export function decodeInstruction(buf: Uint8Array): Instruction {
  for (const [f, v] of fields(buf)) {
    const sub = v as Uint8Array;
    if (f === 1) {
      const c: CallAgent = { transport: "", agentCardUri: "", instruction: { steps: [] }, streaming: false, behavior: "send_message" };
      for (const [g, w] of fields(sub)) {
        if (g === 1) c.transport = str(w);
        else if (g === 2) c.agentCardUri = str(w);
        else if (g === 3) {
          c.instructionBytes = w as Uint8Array;
          c.instruction = decodeInstruction(c.instructionBytes);
        } else if (g === 4) c.streaming = w === 1;
        else if (g === 6) {
          c.behavior = "push_notification";
          for (const [h, x] of fields(w as Uint8Array)) if (h === 1) c.pushUrl = str(x);
        } else if (g === 7) c.behavior = "resubscribe";
      }
      return { callAgent: c };
    }
    if (f === 2) {
      const r = { response: "", holdTask: false };
      for (const [g, w] of fields(sub)) {
        if (g === 1) r.response = str(w);
        else if (g === 2) r.holdTask = w === 1;
      }
      return { returnResponse: r };
    }
    if (f === 3) {
      const steps: Instruction[] = [];
      for (const [g, w] of fields(sub)) if (g === 1) steps.push(decodeInstruction(w as Uint8Array));
      return { steps };
    }
  }
  throw new Error("empty instruction");
}
