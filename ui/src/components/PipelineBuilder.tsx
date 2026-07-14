import { useState } from "react";
import { FileCode2 } from "lucide-react";
import { api } from "../api";

const STARTER = `version: 1
phases:
  test:
    image: "python:3.12"
    command: "pip install -e '.[dev]' && pytest"
  deploy:
    image: "google/cloud-sdk:slim"
    only_ref: main
    gate: human
    requires: [gcp-sa]
    command: >
      gcloud auth activate-service-account --key-file=$GCP_SA &&
      scripts/deploy.sh
`;

type Validation = { ok: boolean; error?: string; phases?: Array<{ name: string; image: string; gate: string; requires: string[]; only_ref: string | null }> };

/**
 * Author a .daboss/pipeline.yaml with live validation against the real parser.
 * Copy/download it into the target repo. (A repo-commit action is a follow-up.)
 */
export function PipelineBuilder() {
  const [yaml, setYaml] = useState(STARTER);
  const [result, setResult] = useState<Validation | null>(null);

  const validate = () => api.validatePipeline(yaml).then(setResult).catch(() => setResult({ ok: false, error: "request failed" }));
  const download = () => {
    const blob = new Blob([yaml], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pipeline.yaml";
    a.click();
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-2 flex items-center gap-2">
        <FileCode2 size={18} /> Pipeline Builder
      </h2>
      <p className="text-gray-400 text-sm mb-3">
        Author your repo's <code className="text-blue-400">.daboss/pipeline.yaml</code>. Validated against the
        real parser — what passes here is exactly what the runner accepts. Each phase: an{" "}
        <code className="text-blue-400">image</code> (its toolchain), a <code className="text-blue-400">command</code>,{" "}
        <code className="text-blue-400">requires</code> (named secrets → env), <code className="text-blue-400">gate</code>,{" "}
        <code className="text-blue-400">only_ref</code>.
      </p>
      <textarea
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
        className="w-full h-64 bg-gray-950 border border-gray-800 rounded px-3 py-2 text-gray-100 font-mono text-xs focus:outline-none focus:border-blue-500"
      />
      <div className="flex gap-2 mt-2">
        <button onClick={validate} className="bg-blue-600 hover:bg-blue-500 text-white text-sm rounded px-4 py-2">Validate</button>
        <button onClick={download} className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded px-4 py-2">Download</button>
      </div>
      {result && (
        <div className="mt-3 text-sm">
          {result.ok ? (
            <div>
              <div className="text-green-400 mb-1">✓ Valid — {result.phases?.length} phase(s):</div>
              {result.phases?.map((p) => (
                <div key={p.name} className="text-xs text-gray-400 font-mono">
                  {p.name}: image={p.image}, gate={p.gate}
                  {p.only_ref ? `, only_ref=${p.only_ref}` : ""}
                  {p.requires.length ? `, requires=[${p.requires.join(",")}]` : ""}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-red-400 text-xs">✗ {result.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
