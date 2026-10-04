// snarkjs ships no type definitions; these are the parts this project uses.
declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: unknown,
      wasmFile: string,
      zkeyFile: string,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
  };
  export const wtns: {
    calculate(input: unknown, wasmFile: string, output: { type: "mem" } | string): Promise<void>;
  };
}
