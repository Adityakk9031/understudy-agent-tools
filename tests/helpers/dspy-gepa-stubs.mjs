// Provider-free Python stand-ins for the pinned dspy-gepa runtime. They mirror the
// DSPy 3.4 engine seam: dspy.LM refuses connection settings when given a custom
// engine and routes every call through engine.complete(Request) -> Response.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const dspyGepaRuntimeVersions = [
  ["dspy", "3.4.1"],
  ["gepa", "0.1.4"],
  ["cloudpickle", "3.1.2"],
  ["litellm", "1.106.2"],
];

export function writePythonDistributionMetadata(root, versions = dspyGepaRuntimeVersions) {
  for (const [name, version] of versions) {
    const metadataDir = join(root, `${name}-${version}.dist-info`);
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(
      join(metadataDir, "METADATA"),
      `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`,
      "utf8",
    );
  }
}

// dspy.LM as the engine seam sees it. Request/response shapes follow dspy.lm15.
export const dspyLmStubSource = `
from types import SimpleNamespace

class LM:
    def __init__(self, model, engine=None, max_tokens=None, num_retries=3, **kwargs):
        for key in ("api_key", "api_base", "base_url"):
            if kwargs.get(key) is not None and engine is not None:
                raise ValueError(f"{key} configures a connection a custom engine owns")
        self.model = model
        self.engine = engine
        self.num_retries = num_retries
        self.kwargs = {
            "max_tokens": max_tokens,
            "temperature": kwargs.get("temperature"),
            "reasoning_effort": kwargs.get("reasoning_effort"),
        }
        _record_lm(self)
    def __call__(self, prompt=None, messages=None, **kwargs):
        return self.forward(prompt=prompt, messages=messages, **kwargs)
    def forward(self, prompt=None, messages=None, **kwargs):
        if self.num_retries != 0:
            raise AssertionError("retries were not disabled")
        request = SimpleNamespace(
            model=self.model,
            messages=messages or [{"role": "user", "content": prompt or ""}],
            config=SimpleNamespace(max_tokens=self.kwargs["max_tokens"], extensions={}),
        )
        try:
            return self.engine.complete(request)
        except Exception as error:
            # DSPy wraps anything raised inside an engine (LMUnexpectedError).
            raise RuntimeError("wrapped LM error") from error
`;

export function writeDspyClientsEngineStub(dspyRoot, completeBody) {
  mkdirSync(join(dspyRoot, "clients", "engines"), { recursive: true });
  writeFileSync(join(dspyRoot, "clients", "__init__.py"), "", "utf8");
  writeFileSync(join(dspyRoot, "clients", "engines", "__init__.py"), `
import os
from types import SimpleNamespace

class LiteLLMEngine:
    def __init__(self, api_key=None, api_base=None):
        self.api_key = api_key
        self.api_base = api_base
    def complete(self, request):
${completeBody}
`, "utf8");
}

// Stand-ins for the gepa package that record how the runtime configures them.
export function writeGepaPackageStubs(root) {
  const gepaPackage = join(root, "gepa");
  mkdirSync(join(gepaPackage, "utils"), { recursive: true });
  mkdirSync(join(gepaPackage, "strategies"), { recursive: true });
  writeFileSync(join(gepaPackage, "__init__.py"), "", "utf8");
  writeFileSync(join(gepaPackage, "utils", "__init__.py"), "", "utf8");
  writeFileSync(join(gepaPackage, "strategies", "__init__.py"), "", "utf8");
  writeFileSync(join(gepaPackage, "utils", "stop_condition.py"), `
class _Recorded:
    def __init__(self, *args):
        self.args = list(args)
    def describe(self):
        return [type(self).__name__, *self.args]

class FileStopper(_Recorded): pass
class NoImprovementStopper(_Recorded): pass
class ScoreThresholdStopper(_Recorded): pass
class TimeoutStopCondition(_Recorded): pass
`, "utf8");
  writeFileSync(join(gepaPackage, "strategies", "proposal_sampling.py"), `
class IndependentSampling:
    def __init__(self, count):
        self.count = count
    def describe(self):
        return ["IndependentSampling", self.count]
`, "utf8");
  writeFileSync(join(gepaPackage, "strategies", "proposal_selection.py"), `
class BestImprovement:
    def describe(self):
        return ["BestImprovement"]
`, "utf8");
}

export function writeScoreWithFeedbackStub(dspyRoot, gepaInit = "") {
  const gepaRoot = join(dspyRoot, "teleprompt", "gepa");
  mkdirSync(gepaRoot, { recursive: true });
  writeFileSync(join(dspyRoot, "teleprompt", "__init__.py"), "", "utf8");
  writeFileSync(join(gepaRoot, "__init__.py"), gepaInit, "utf8");
  writeFileSync(join(gepaRoot, "gepa_utils.py"), `
class ScoreWithFeedback:
    def __init__(self, score, feedback):
        self.score = score
        self.feedback = feedback
`, "utf8");
}

// A signature-scaffold DSPy with a GEPA that records how the runtime configured it,
// replays GEPA 0.1.4 callbacks, and returns an "evolved" program. The evolved
// program answers "a2"; the seed program answers "a1".
export function writeMeteredDspyGepaStubs(stubRoot) {
  const dspyRoot = join(stubRoot, "dspy");
  mkdirSync(dspyRoot, { recursive: true });
  writePythonDistributionMetadata(stubRoot);
  writeGepaPackageStubs(stubRoot);
  writeScoreWithFeedbackStub(dspyRoot, `
class InstructionProposer:
    def __init__(self, **kwargs):
        self.kwargs = {key: [str(item) for item in value] if key == "skills" and value else value for key, value in kwargs.items()}
`);
  writeDspyClientsEngineStub(dspyRoot, `
        with open(os.environ["PROVIDER_SENTINEL"], "a", encoding="utf-8") as handle:
            handle.write("called\\n")
        if os.environ.get("STUB_ZERO_USAGE"):
            return SimpleNamespace(usage=SimpleNamespace(input_tokens=0, output_tokens=0))
        return SimpleNamespace(usage=SimpleNamespace(input_tokens=10, output_tokens=5))`);
  writeFileSync(join(dspyRoot, "__init__.py"), `
import copy
import json
import os
from types import SimpleNamespace

configured_lm = None

def configure(lm):
    global configured_lm
    configured_lm = lm

def _record_lm(lm):
    pass
${dspyLmStubSource}
class Signature:
    def __init__(self, value):
        self.value = value
        self.instructions = "seed instruction"

class Example:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
    def with_inputs(self, *keys):
        return self

class Predict:
    def __init__(self, signature):
        self.signature = signature
    def named_predictors(self):
        return [("predict", self)]
    def __call__(self, **kwargs):
        configured_lm(prompt=str(kwargs))
        return SimpleNamespace(answer="a2" if "evolved" in self.signature.instructions else "a1")
    def dump_state(self, json_mode=False):
        return {"predict": {"instructions": self.signature.instructions}}

class ChainOfThought(Predict):
    pass

COMPILES = []

class GEPA:
    def __init__(self, reflection_lm=None, **kwargs):
        self.reflection_lm = reflection_lm
        self.kwargs = kwargs
    def compile(self, student, trainset=None, valset=None):
        copied = copy.deepcopy(self.reflection_lm)
        copied(prompt="reflection")
        repo = os.path.dirname(os.environ["PROVIDER_SENTINEL"])
        # What a progress consumer could see while the optimizer is still running.
        state_dir = os.path.join(repo, ".understudy", "optimize-workload", "dspy-gepa")
        with open(os.path.join(state_dir, "run-state.json"), encoding="utf-8") as handle:
            live_state = json.load(handle)
        with open(os.path.join(state_dir, "events.jsonl"), encoding="utf-8") as handle:
            live_events = [json.loads(line)["event"] for line in handle]
        inner = self.kwargs.get("gepa_kwargs") or {}
        callbacks = inner.get("callbacks") or []
        for callback in callbacks:
            callback.on_optimization_start({"trainset_size": 1, "valset_size": 1})
            callback.on_proposal_end({"iteration": 1, "new_instructions": {"predict": "evolved instruction"}})
            callback.on_valset_evaluated({
                "iteration": 1, "candidate_idx": 1, "candidate": {"predict": "evolved instruction"},
                "average_score": 0.75, "num_examples_evaluated": 1, "total_valset_size": 1, "is_best_program": True,
            })
            callback.on_candidate_accepted({"iteration": 1, "new_candidate_idx": 1, "new_score": 0.75, "parent_ids": [0]})
            callback.on_candidate_rejected({"iteration": 2, "old_score": 0.75, "new_score": 0.5, "reason": "not-better"})
            callback.on_error({"iteration": 3, "exception": ValueError("x"), "will_continue": True})
            callback.on_optimization_end({"best_candidate_idx": 1, "total_iterations": 3, "total_metric_calls": 2})
        proposer = self.kwargs.get("instruction_proposer")
        COMPILES.append({
            "seed_instructions": student.signature.instructions,
            "log_dir": self.kwargs.get("log_dir"),
            "stoppers": [stopper.describe() for stopper in inner.get("stop_callbacks", [])],
            "sampling": inner["sampling_strategy"].describe() if "sampling_strategy" in inner else None,
            "selection": inner["selection_strategy"].describe() if "selection_strategy" in inner else None,
            "acceptance": inner.get("acceptance_criterion"),
            "use_cloudpickle": inner.get("use_cloudpickle"),
            "candidate_selection": self.kwargs.get("candidate_selection_strategy"),
            "use_merge": self.kwargs.get("use_merge"),
            "proposer": proposer.kwargs if proposer is not None else None,
        })
        with open(os.environ["GEPA_KWARGS_PATH"], "w", encoding="utf-8") as handle:
            json.dump({
                "live_run_state": {"status": live_state["status"], "phase": live_state["phase"]},
                "live_events": live_events,
                "callback_count": len(callbacks),
                "compiles": COMPILES,
                "gepa": {key: value for key, value in self.kwargs.items() if key not in ("metric", "gepa_kwargs", "instruction_proposer")},
                "reflection_lm_kwargs": self.reflection_lm.kwargs,
                "reflection_model": self.reflection_lm.model,
            }, handle)
        if os.environ.get("STUB_TOUCH_STOP_FILE"):
            open(os.path.join(state_dir, "STOP"), "w", encoding="utf-8").close()
        evolved = copy.deepcopy(student)
        already_evolved = "evolved" in student.signature.instructions
        evolved.signature.instructions = "evolved instruction"
        evolved.detailed_results = SimpleNamespace(
            val_aggregate_scores=[0.75, 0.75] if already_evolved else [0.25, 0.75],
            total_metric_calls=2,
            num_full_val_evals=2,
        )
        return evolved
`, "utf8");
}
