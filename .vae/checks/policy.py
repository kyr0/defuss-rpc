#!/usr/bin/env python3
"""Repository invariants that no linter or test sees; `make policy` (part of `make lint`) and the gate run it.

Each check prints what to fix and the script exits 1 when any fails. Why a script instead of VERIFY.py regex rules:
these invariants span several files (package.json against src/, CI against README and the website, examples/
against the e2e harness) or need git.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def check_exports() -> None:
    """Every entry point exists with and without `.js`, points at a dist file built from a src/ module, and the
    package ships nothing but dist/, README.md and LICENSE. Why: README and users import both spellings, and a
    renamed source file must not silently drop an entry point."""
    pkg = json.loads(read("package.json"))
    exports = {k: v for k, v in pkg["exports"].items() if k != "./package.json"}
    for key, target in exports.items():
        twin = key[:-3] if key.endswith(".js") else f"{key}.js"
        if exports.get(twin) != target:
            fail(f"package.json exports: {key} has no identical twin {twin}")
        for path in re.findall(r"\./dist/([\w/-]+)\.(?:mjs|cjs|d\.mts|d\.cts)", json.dumps(target)):
            if not (ROOT / "src" / f"{path}.ts").is_file():
                fail(f"package.json exports: {key} → dist/{path}.* has no src/{path}.ts")
    if pkg.get("files") != ["dist", "README.md", "LICENSE"]:
        fail('package.json files must be ["dist", "README.md", "LICENSE"]')
    for spec in sorted(set(re.findall(r'from "(defuss-rpc/[\w.-]+)"', read("README.md")))):
        if f"./{spec.removeprefix('defuss-rpc/')}" not in exports:
            fail(f"README.md imports {spec}, which package.json does not export")


FRAMEWORKS = ("express", "bunway")


def check_providers() -> None:
    """HTTP frameworks stay behind providers: only src/providers/ imports one, and every provider has an entry point
    (with its .js twin), a runnable example and a README mention. Why: the server must load no framework the
    application did not select, and a provider nobody can import or see run is not a supported option."""
    pattern = re.compile(r'from "(' + "|".join(re.escape(f) for f in FRAMEWORKS) + r')"')
    for file in sorted((ROOT / "src").rglob("*.ts")):
        rel = file.relative_to(ROOT)
        if rel.parts[1] != "providers" and pattern.search(file.read_text(encoding="utf-8")):
            fail(f"{rel}: imports an HTTP framework; only src/providers/*.ts may, behind RpcServerProvider")
    exports = json.loads(read("package.json"))["exports"]
    readme = read("README.md")
    for file in sorted((ROOT / "src/providers").glob("*.ts")):
        if "@internal" in file.read_text(encoding="utf-8"):
            continue
        name = file.stem
        for key in (f"./providers/{name}", f"./providers/{name}.js"):
            if key not in exports:
                fail(f"package.json exports: provider src/providers/{name}.ts has no {key}")
        if not (ROOT / f"examples/server-{name}.ts").is_file():
            fail(f"examples/server-{name}.ts is missing: every provider has a demo server that e2e runs")
        if f"defuss-rpc/providers/{name}" not in readme:
            fail(f"README.md does not mention defuss-rpc/providers/{name}")


def check_runtimes() -> None:
    """The Node.js versions CI tests are the versions README.md and the website claim."""
    matrix = re.search(r"node:\s*\[([^\]]+)\]", read(".github/workflows/verify.yml"))
    if not matrix:
        fail(".github/workflows/verify.yml: no node version matrix")
        return
    tested = ", ".join(v.strip() for v in matrix.group(1).split(","))
    for page in ("README.md", "docs/index.html"):
        if f"Node.js {tested}" not in read(page):
            fail(f'{page}: runtime table must say "Node.js {tested}", the versions CI tests')


def check_examples_run() -> None:
    """Every example file is executed by the e2e test, directly or through an import: what the docs show runs."""
    e2e = read("scripts/e2e.mjs")
    examples = [*ROOT.glob("examples/**/*"), *ROOT.glob("integrations/*/example/**/*")]
    examples = [p for p in examples if "node_modules" not in p.parts]
    roots = [p for p in examples if p.is_file() and str(p.relative_to(ROOT)) in e2e]
    roots += [ROOT / "docs/src/site.ts"]
    for folder in re.findall(r'"((?:integrations/[\w-]+/example|examples/[\w-]+))"', e2e):
        roots += [p for p in (ROOT / folder).rglob("*") if p.is_file() and ".astro/" not in str(p)]
    reached: set[pathlib.Path] = set()
    queue = list(roots)
    while queue:
        file = queue.pop()
        if file in reached or not file.is_file():
            continue
        reached.add(file)
        if file.suffix in (".ts", ".astro"):
            for spec in re.findall(r'(?:from|import)\s+"(\.{1,2}/[^"]+)"', file.read_text(encoding="utf-8")):
                queue.append((file.parent / spec).resolve())
    for file in sorted(examples):
        rel = file.relative_to(ROOT)
        if not file.is_file() or file.name in ("tsconfig.json",) or file.name.endswith(".d.ts") or ".astro/" in str(rel):
            continue
        if file.resolve() not in {r.resolve() for r in reached}:
            fail(f"{rel}: no e2e run executes this example (scripts/e2e.mjs or an import from a file it runs)")


CORE_FREE_OF = ("vite", "astro")
INTEGRATIONS = {"integrations/vite": "defuss-rpc-vite", "integrations/astro": "defuss-rpc-astro"}


def check_integrations() -> None:
    """defuss-rpc depends on no build tool or framework: src/ imports neither vite nor astro, and package.json lists
    neither as a dependency or peer (vite stays a devDependency only, because Vitest requires it). Each integration
    package has its README.md, ARCH.md, lockfile and example, and its README imports only what it exports. Why: the
    Vite plugin and the Astro integration were moved out so applications install them only when they use them."""
    pattern = re.compile(r'from "(' + "|".join(CORE_FREE_OF) + r')(?:/[^"]*)?"')
    for file in sorted((ROOT / "src").rglob("*.ts")):
        if pattern.search(file.read_text(encoding="utf-8")):
            fail(f"{file.relative_to(ROOT)}: imports vite or astro; that code belongs in integrations/")
    pkg = json.loads(read("package.json"))
    for field in ("dependencies", "peerDependencies", "optionalDependencies"):
        for name in CORE_FREE_OF:
            if name in pkg.get(field, {}):
                fail(f"package.json {field} lists {name}; only integrations/ may depend on it")
    if "astro" in pkg.get("devDependencies", {}):
        fail("package.json devDependencies lists astro; integrations/astro owns it")
    for folder, name in INTEGRATIONS.items():
        for rel in ("package.json", "README.md", "ARCH.md", "bun.lock", "example"):
            if not (ROOT / folder / rel).exists():
                fail(f"{folder}/{rel} is missing")
        if not (ROOT / folder / "package.json").exists():
            continue
        manifest = json.loads(read(f"{folder}/package.json"))
        if manifest.get("name") != name:
            fail(f"{folder}/package.json: name must be {name}")
        if manifest.get("files") != ["dist", "README.md", "LICENSE"]:
            fail(f'{folder}/package.json files must be ["dist", "README.md", "LICENSE"]')
        readme = read(f"{folder}/README.md") if (ROOT / folder / "README.md").exists() else ""
        for spec in sorted(set(re.findall(r'from "(' + re.escape(name) + r'(?:/[\w.-]+)?)"', readme))):
            key = "." + spec.removeprefix(name)
            if key not in manifest.get("exports", {}):
                fail(f"{folder}/README.md imports {spec}, which {folder}/package.json does not export")


def check_commit_trailers() -> None:
    """No commit credits Claude or Anthropic as co-author: this repository's history names human authors only."""
    if not (ROOT / ".git").exists():
        return
    log = subprocess.run(["git", "log", "--format=%H%n%B"], cwd=ROOT, capture_output=True, text=True)
    if log.returncode != 0:
        return  # a repository without commits yet
    commit = ""
    for line in log.stdout.splitlines():
        if re.fullmatch(r"[0-9a-f]{40}", line):
            commit = line
        elif re.match(r"(?i)co-authored-by:.*(claude|anthropic)", line):
            fail(f"commit {commit[:12]} credits an AI assistant as co-author: rewrite its message without the trailer")
    hook = ROOT / ".githooks/commit-msg"
    if not hook.is_file():
        fail(".githooks/commit-msg is missing: it rejects such trailers before they enter the history")


for check in (check_exports, check_providers, check_runtimes, check_examples_run, check_integrations, check_commit_trailers):
    check()
if failures:
    print("\n".join(f"policy: {f}" for f in failures))
    sys.exit(1)
print("policy: exports, providers, runtime claims, example coverage, integrations and commit trailers hold")
