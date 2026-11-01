/**
 * The website's behavior: theme toggle, copy buttons and the live demo.
 *
 * Why the demo imports examples/browser.ts: the upload and download code the page shows under "The code behind the
 * demo" is the code that runs here, so the e2e test that drives this page also proves the shown snippet works.
 * scripts/docs.ts bundles this file with the defuss-rpc client into docs/assets/site.js.
 */
import { clearSchemaCache, getRpcClient } from "defuss-rpc/client";
import type { RpcApi } from "../../examples/api.ts";
import { fetchFile, sendFile, sha256Hex } from "../../examples/browser.ts";

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

// -- theme --------------------------------------------------------------------
const toggle = $<HTMLInputElement>("#theme-toggle");
toggle.checked = document.documentElement.classList.contains("dark");
toggle.addEventListener("change", () => {
	document.documentElement.classList.toggle("dark", toggle.checked);
	document.documentElement.style.colorScheme = toggle.checked ? "dark" : "light";
	try {
		localStorage.setItem("defuss-rpc-theme", toggle.checked ? "dark" : "light");
	} catch {
		// storage blocked: the choice lasts for this page view
	}
});

// -- copy buttons -------------------------------------------------------------
for (const button of document.querySelectorAll<HTMLButtonElement>(".mk-code-block-copy")) {
	button.addEventListener("click", async () => {
		const block = button.closest(".mk-code-block")!;
		const pre = [...block.querySelectorAll("pre")].find((p) => p.checkVisibility()) ?? block.querySelector("pre")!;
		const lines = [...pre.querySelectorAll("code > span")].map((line) => line.textContent ?? "");
		const status = block.querySelector(".mk-code-block-status");
		try {
			await navigator.clipboard.writeText(lines.join("\n"));
			if (status) status.textContent = "Copied";
		} catch {
			if (status) status.textContent = "Copy failed";
		}
		setTimeout(() => status && (status.textContent = ""), 1500);
	});
}

// -- live demo ----------------------------------------------------------------
const endpointInput = $<HTMLInputElement>("#endpoint");
const status = $("#server-status");
const offline = $("#offline");
const demoControls = document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("[data-demo]");
const fromQuery = new URLSearchParams(location.search).get("rpc");
if (fromQuery) endpointInput.value = fromQuery;

let rpc: RpcApi | null = null;

function setStatus(text: string, variant: "default" | "outline" | "destructive") {
	status.textContent = text;
	status.dataset.variant = variant;
}

/** Connects to the endpoint in the input: fetches the schema and asks the server which runtime it is. */
async function connect() {
	const baseUrl = endpointInput.value.trim().replace(/\/+$/, "");
	rpc = null;
	setStatus("connecting", "outline");
	for (const control of demoControls) control.disabled = true;
	clearSchemaCache();
	try {
		rpc = await getRpcClient<RpcApi>({ baseUrl });
		const runtime = await rpc.ServerInfo.runtime();
		setStatus(`connected · ${runtime}`, "default");
		status.dataset.runtime = runtime.split(" ")[0];
		offline.hidden = true;
		for (const control of demoControls) control.disabled = false;
	} catch {
		setStatus("offline", "destructive");
		offline.hidden = false;
	}
}

const baseUrl = () => endpointInput.value.trim().replace(/\/+$/, "");

$("#connect").addEventListener("click", () => void connect());

$<HTMLFormElement>("#add-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const a = Number($<HTMLInputElement>("#add-a").value);
	const b = Number($<HTMLInputElement>("#add-b").value);
	$("#add-result").textContent = `= ${await rpc!.MathApi.add(a, b)}`;
});

$<HTMLFormElement>("#greet-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	$("#greet-result").textContent = await new rpc!.GreeterApi().greet($<HTMLInputElement>("#greet-name").value);
});

$<HTMLFormElement>("#stream-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const output = $("#stream-output");
	const meta = $("#stream-meta");
	output.textContent = "";
	meta.textContent = "";
	const started = performance.now();
	const frames: number[] = [];
	const stream = rpc!.ChatApi.reply($<HTMLInputElement>("#stream-prompt").value);
	while (true) {
		const step = await stream.next();
		if (step.done) {
			meta.textContent = `${frames.length} frames, return value "${step.value}", ${Math.round(performance.now() - started)} ms`;
			meta.dataset.frames = String(frames.length);
			break;
		}
		frames.push(performance.now());
		const word = document.createElement("span");
		word.textContent = `${step.value} `;
		output.append(word);
	}
});

const describe = (value: unknown): [string, string] => {
	if (value instanceof Date) return ["Date", value.toISOString()];
	if (value instanceof Set) return ["Set", JSON.stringify([...value])];
	if (value instanceof Map) return ["Map", JSON.stringify([...value])];
	if (typeof value === "bigint") return ["bigint", `${value}n`];
	if (value instanceof Uint8Array) return ["Uint8Array", Array.from(value, (b) => b.toString(16).padStart(2, "0")).join(" ")];
	return [typeof value, String(value)];
};

$("#types-run").addEventListener("click", async () => {
	const sample = await rpc!.TypesApi.sample();
	const table = $<HTMLTableElement>("#types-table");
	const body = table.tBodies[0];
	body.replaceChildren(
		...Object.entries(sample).map(([field, value]) => {
			const row = body.insertRow();
			const [type, text] = describe(value);
			for (const cell of [field, type, text]) {
				const td = row.insertCell();
				td.textContent = cell;
			}
			row.dataset.type = type;
			return row;
		}),
	);
	table.hidden = false;
});

const fileInput = $<HTMLInputElement>("#file-input");
let downloadUrl: string | undefined;

fileInput.addEventListener("change", async () => {
	const file = fileInput.files?.[0];
	if (!file) return;
	const send = $<HTMLProgressElement>("#send-progress");
	const received = $<HTMLProgressElement>("#recv-progress");
	const error = $("#file-error");
	const facts = $("#file-facts");
	send.value = 0;
	received.value = 0;
	error.hidden = true;
	facts.hidden = true;
	$("#file-preview").hidden = true;
	try {
		const [result, localSha] = await Promise.all([
			sendFile(file, baseUrl(), (phase, percent) => {
				(phase === "sending" ? send : received).value = percent;
			}),
			sha256Hex(file),
		]);
		send.value = 100;
		received.value = 100;
		$("#file-size").textContent = `${result.bytesReceived.toLocaleString("en")} bytes`;
		$("#file-sha-server").textContent = result.sha256;
		$("#file-sha-local").textContent = localSha;
		const match = $("#file-match");
		match.textContent = localSha === result.sha256 ? "match" : "mismatch";
		match.dataset.variant = localSha === result.sha256 ? "default" : "destructive";
		const { blob, filename } = await fetchFile(result.result.id, baseUrl());
		if (downloadUrl) URL.revokeObjectURL(downloadUrl);
		downloadUrl = URL.createObjectURL(new Blob([blob], { type: file.type || "application/octet-stream" }));
		const link = $<HTMLAnchorElement>("#file-download");
		link.href = downloadUrl;
		link.download = filename;
		link.textContent = `${filename} (${blob.size.toLocaleString("en")} bytes)`;
		facts.hidden = false;
		if (file.type.startsWith("image/")) await preview(downloadUrl);
	} catch (err) {
		error.textContent = err instanceof Error ? err.message : String(err);
		error.hidden = false;
	}
});

/** Draws the downloaded image into the canvas, scaled to fit: the bytes made the full round trip. */
async function preview(url: string) {
	const image = new Image();
	image.src = url;
	await image.decode();
	const canvas = $<HTMLCanvasElement>("#file-preview");
	const scale = Math.min(canvas.width / image.width, canvas.height / image.height, 1);
	const context = canvas.getContext("2d")!;
	context.clearRect(0, 0, canvas.width, canvas.height);
	context.drawImage(image, 0, 0, image.width * scale, image.height * scale);
	canvas.hidden = false;
	canvas.dataset.drawn = "true";
}

void connect();
