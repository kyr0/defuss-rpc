/**
 * The website's behavior: the theme toggle and the copy buttons. The diagrams, the client/server diffs, tabs, the menu
 * sheet, the parallax hero, the scroll reveals and the back-to-top button come from defuss-shadcn's all.min.js;
 * scripts/docs.ts writes the npm badges' version.
 *
 * Why no live demo: the website is static and no RPC server runs behind it; the e2e test runs the browser example
 * (examples/browser.ts) against the demo servers instead. scripts/docs.ts bundles this file into docs/assets/site.js.
 * VERIFIED: scripts/e2e.mjs toggles the theme and copies a code block in Chromium.
 */

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
// A diff moves its divider on every pointerdown inside it and captures the pointer, so a click on a copy button there
// would land on the diff instead. VERIFIED: defuss-shadcn 0.9.11 all.min.js (the `.diff` pointerdown handler calls
// setPointerCapture); scripts/e2e.mjs copies a block inside a diff.
for (const button of document.querySelectorAll(".diff .mk-code-block-copy")) {
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
}
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

