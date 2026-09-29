import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const source =
  "function entry(value) {\n  const input = value;\n  return child(input);\n}\n\nfunction child(value) {\n  const output = value + 1;\n  return output;\n}\n";
export function fixture() {
  return {
    title: "Follow one input",
    scenario: "entry(2)",
    prose_language: "en",
    stages: [
      { id: "run", label: "Run", purpose: "Transform the scenario input." },
    ],
    frames: [
      {
        id: "entry",
        name: "entry",
        file: "main.js",
        purpose: "Delegate the input.",
        blocks: [
          {
            title: "Read input",
            purpose: "Keep the supplied value.",
            start: 1,
            end: 2,
          },
          {
            title: "Call child",
            purpose: "Return the child result.",
            start: 3,
            end: 4,
          },
        ],
        calls: { child: 1 },
      },
      {
        id: "child",
        name: "child",
        file: "main.js",
        purpose: "Increment a value.",
        blocks: [
          { title: "Compute", purpose: "Add one.", start: 6, end: 7 },
          { title: "Return", purpose: "Return the result.", start: 8, end: 9 },
        ],
        calls: {},
      },
    ],
    nodes: [
      {
        id: "call",
        kind: "happy",
        stage: "run",
        label: "Delegate",
        frame: "entry",
        blocks: [1],
        purpose: "Reuse child.",
        happens: "Pass input to child.",
        io: "number → number",
        remember: "The child computes.",
        example: {
          kind: "scenario",
          value: "entry(2)",
          provenance: "Scenario input",
        },
      },
      {
        id: "end",
        kind: "happy",
        stage: "run",
        label: "Increment",
        frame: "child",
        blocks: [0],
        purpose: "Add one.",
        happens: "Compute value + 1.",
        io: "number → number",
        remember: "One arithmetic step.",
      },
    ],
    edges: [{ from: "call", to: "end", label: "number", kind: "call" }],
  };
}
export function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "walkthrough-spec-"));
  fs.writeFileSync(path.join(root, "main.js"), source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
