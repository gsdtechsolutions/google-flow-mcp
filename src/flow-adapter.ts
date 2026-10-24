import { spawn } from "node:child_process";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type Download, type Locator, type Page } from "playwright-core";

import type { Config } from "./config.js";
import { StateStore } from "./state.js";
import { matchMention, MODEL_RULES, parseCreditLine, type GenerationSettings } from "./flow-settings.js";
import type { AuthRecord, FlowMediaItem, PageInspection } from "./types.js";

// Flow moved from labs.google/fx/tools/flow to flow.google.com; old URLs redirect.
const FLOW_URL = "https://flow.google.com/";
const FLOW_HOSTS = new Set(["flow.google.com", "labs.google"]);
const isAssetMedia = (media: FlowMediaItem) => new URL(media.href).pathname.startsWith("/asb/");
const CREDIT_ACTION = /^(generate|create|approve|生成|制作|产生)(\s|$)/i;
// Would disable Flow's per-generation credit confirmation for the whole account.
const BLOCKED_CREDIT_ACTION = /always approve/i;
// Only flow_submit_generation may press this, because it checks the credit line against maxCredits first.
const SUBMIT_ONLY_ACTION = /^start generation$/i;
const BLOCKED_AUTH_ACTION = /(password|passkey|verification|验证码|验证|sign\s*out|log\s*out|退出登录|登出)/i;

// Verified against flow.google.com in 2026-10 (Agent mode off).
const SELECTORS = {
  overlay: ".cdk-overlay-container",
  agentChip: "button.agent-mode-chip",
  agentPanelClose: "button[aria-label='Close']",
  settingsTrigger: "button[aria-label='Settings trigger']",
  radio: "button[role=radio]",
  modelMenu: "button[aria-label='Select model family']",
  menuItem: "[role=menuitem], [role=menuitemradio]",
  mentionSearch: "input[aria-label='Search assets']",
  mentionOption: "[role=option]",
  mentionTitle: ".asset-title",
  mentionAdd: /^\s*Add to prompt\s*$/,
  mentionChip: ".mention-chip",
  charactersNav: "button",
  charactersNavText: /^\s*accessibility_new\s*Characters\s*$/,
  characterTile: "flow-character-tile",
  characterName: ".character-tile-name",
  characterThumbnail: "img.character-tile-thumbnail",
  editName: "button[aria-label='Edit name']",
  nameInput: "input[aria-label='Character name']",
  characterInfo: "textarea[aria-label='Character personality']",
  toolSection: "section.applet-section",
  toolSectionTitle: ".section-title",
  toolCard: ".applet-card",
  toolName: ".applet-name",
  toolAuthor: ".applet-author",
  toolDescription: ".applet-description",
  toolThumbnail: ".applet-preview-image",
} as const;
const TOOL_TABS = { community: "Community", templates: "Templates", mine: "My Tools" } as const;
const CHARACTER_URL = /\/character\/([0-9a-f-]{36})/;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type FlowCharacter = { id: string; name: string; url: string };
export type FlowTool = { name: string; author: string; description: string; section: string; thumbnail: string };

type VisibleControl = { locator: Locator; label: string; frame: number };

const projectBaseUrl = (projectUrl: string) => {
  const url = new URL(projectUrl);
  const match = url.pathname.match(/^\/project\/[^/]+/);
  if (url.hostname !== "flow.google.com" || !match) throw new Error("This action needs a flow.google.com project URL.");
  return `${url.origin}${match[0]}`;
};

export class FlowBrowserAdapter {
  private context?: BrowserContext;
  private page?: Page;

  constructor(private readonly config: Config, private readonly store: StateStore) {}

  async startLogin(projectId: string): Promise<AuthRecord> {
    const state = await this.store.read();
    if (!state.projects.some((project) => project.id === projectId)) throw new Error(`Project not found: ${projectId}`);
    await this.close();
    const loginBrowser = spawn(this.config.browserExecutable, [
      `--user-data-dir=${this.config.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      FLOW_URL,
    ], { detached: true, stdio: "ignore", windowsHide: false });
    loginBrowser.unref();
    const next = await this.store.update((draft) => {
      draft.auth = {
        status: "awaiting_user_fresh_sign_in",
        initiatedAt: new Date().toISOString(),
        lastUrl: FLOW_URL,
        lastMessage: "请在普通 Chrome 中亲自完成全新登录。进入 Flow 后关闭此专用 Chrome 的所有窗口，再让 AI 确认登录。不要把密码或验证码发送给 AI。",
      };
    });
    return next.auth;
  }

  async getAuthStatus(): Promise<AuthRecord> {
    if (!this.context || !this.page || this.page.isClosed()) return (await this.store.read()).auth;
    const detected = await this.detectAuthentication();
    const state = await this.store.read();
    const status = detected === "login_required" ? "login_required" : state.auth.status === "ready" ? "ready" : "signed_in_unconfirmed";
    const next = await this.store.update((draft) => {
      draft.auth.status = status;
      draft.auth.lastUrl = this.page!.url();
      draft.auth.lastMessage = status === "login_required"
        ? "请在可见浏览器中完成 Google 登录。"
        : status === "ready" ? "登录检查点已完成。" : "浏览器已登录；仍需用户确认全新登录、会员资格和可用额度。";
    });
    return next.auth;
  }

  async confirmLogin(input: {
    projectId: string;
    userConfirmedFreshSignIn: boolean;
    membershipConfirmed: boolean;
    creditsAvailableConfirmed: boolean;
  }): Promise<AuthRecord> {
    if (!input.userConfirmedFreshSignIn) throw new Error("Fresh sign-in must be completed and confirmed by the user.");
    if (!input.membershipConfirmed || !input.creditsAvailableConfirmed) {
      throw new Error("Google Flow membership/access and usable credits must be confirmed before generation.");
    }
    const state = await this.store.read();
    if (!state.projects.some((project) => project.id === input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    try {
      const page = await this.ensurePage();
      if (!page.url().startsWith(FLOW_URL)) await page.goto(FLOW_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      if ((await this.detectAuthentication()) === "login_required") throw new Error("Google still shows a login page. Complete login in the normal Chrome window first.");
    } catch (error) {
      if (/profile.*in use|processsingleton|user data directory.*in use|singletonlock/i.test((error as Error).message)) {
        throw new Error("The login Chrome is still running. Close all windows using the dedicated Flow profile, then confirm login again.", { cause: error });
      }
      throw error;
    }
    const next = await this.store.update((draft) => {
      draft.auth.status = "ready";
      draft.auth.confirmedAt = new Date().toISOString();
      draft.auth.freshLoginForProjectId = input.projectId;
      draft.auth.lastUrl = this.page?.url();
      draft.auth.lastMessage = "Fresh login, membership/access, and usable credits were user-confirmed.";
    });
    return next.auth;
  }

  async inspectPage(): Promise<PageInspection> {
    const page = await this.ensurePage();
    const buttons = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1']), summary, input[type='button'], input[type='submit']");
    const textboxes = await this.visibleControls("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
    let fileInputCount = 0;
    for (const frame of page.frames()) fileInputCount += await frame.locator("input[type='file']").count();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    return {
      url: page.url(),
      title: await page.title(),
      visibleText: bodyText.replace(/\s+/g, " ").trim().slice(0, 12_000),
      buttons: buttons.slice(0, 120).map((control, index) => ({ index, label: control.label, frame: control.frame })),
      textboxes: await Promise.all(textboxes.slice(0, 40).map(async (control, index) => ({
        index,
        label: control.label,
        multiline: await control.locator.evaluate((element) => element.tagName === "TEXTAREA" || element.getAttribute("aria-multiline") === "true"),
        frame: control.frame,
      }))),
      fileInputCount,
      media: await this.inspectMedia(),
      failureCount: (bodyText.match(/\bwarning\s+Failed\b|生成失败/gi) ?? []).length,
    };
  }

  async openFlowProject(projectUrl: string): Promise<PageInspection> {
    this.validateFlowProjectUrl(projectUrl);
    const page = await this.ensurePage();
    await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3_000);
    return this.inspectPage();
  }

  async openMedia(input: { projectUrl: string; mediaId?: string; title?: string }): Promise<{ media: FlowMediaItem; page: PageInspection }> {
    await this.openFlowProject(input.projectUrl);
    const media = await this.findMedia(input);
    if (isAssetMedia(media)) return { media, page: await this.inspectPage() };
    const page = await this.ensurePage();
    await page.goto(media.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.getByRole("button", { name: /Download|下载/i }).first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(500);
    return { media, page: await this.inspectPage() };
  }

  async waitForMedia(input: {
    projectUrl: string;
    baselineMediaIds: string[];
    baselineFailureCount: number;
    expectedKind: "image" | "video";
    timeoutSeconds: number;
    pollIntervalSeconds: number;
  }): Promise<{ status: "complete" | "failed" | "timeout"; media?: FlowMediaItem; observations: number; page: PageInspection }> {
    const page = await this.ensurePage();
    if (!page.url().startsWith(input.projectUrl)) await this.openFlowProject(input.projectUrl);
    const baseline = new Set(input.baselineMediaIds);
    const deadline = Date.now() + input.timeoutSeconds * 1_000;
    let failedObservations = 0;
    let observations = 0;
    let inspection = await this.inspectPage();
    while (Date.now() <= deadline) {
      observations += 1;
      inspection = await this.inspectPage();
      // Flow lists newest first and lazy-loads tiles, so an old tile can first appear after the baseline was taken.
      // Only the topmost tile of the wanted kind can be the new result.
      const newest = inspection.media.find((item) => item.kind === input.expectedKind);
      const created = newest && !baseline.has(newest.tileId) && (!newest.providerMediaId || !baseline.has(newest.providerMediaId)) ? newest : undefined;
      if (created) return { status: "complete", media: created, observations, page: inspection };
      failedObservations = inspection.failureCount > input.baselineFailureCount ? failedObservations + 1 : 0;
      if (failedObservations >= 3) return { status: "failed", observations, page: inspection };
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await page.waitForTimeout(Math.min(input.pollIntervalSeconds * 1_000, remaining));
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
    }
    return { status: "timeout", observations, page: inspection };
  }

  async fillTextbox(input: { text: string; label?: string; index?: number }): Promise<PageInspection> {
    const page = await this.ensurePage();
    if (new URL(page.url()).hostname === "accounts.google.com") throw new Error("Credential entry is user-only. Type login details directly in the visible browser.");
    const controls = await this.visibleControls("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
    const target = this.chooseControl(controls, input.label, input.index, "textbox");
    if (BLOCKED_AUTH_ACTION.test(target.label)) throw new Error("MCP refuses to fill credential or verification fields.");
    await target.locator.fill(input.text);
    return this.inspectPage();
  }

  async uploadFile(input: { filePath: string; inputIndex?: number }): Promise<PageInspection> {
    const page = await this.ensurePage();
    const absolute = path.resolve(input.filePath);
    await access(absolute);
    const inputs: Locator[] = [];
    for (const frame of page.frames()) {
      const locator = frame.locator("input[type='file']");
      for (let index = 0; index < await locator.count(); index += 1) inputs.push(locator.nth(index));
    }
    if (inputs.length === 0) throw new Error("No file input is currently present. Inspect or open the upload control first.");
    const index = input.inputIndex ?? 0;
    if (!inputs[index]) throw new Error(`File input index ${index} does not exist.`);
    await inputs[index].setInputFiles(absolute);
    return this.inspectPage();
  }

  async bindAssetToPrompt(input: { assetLabel: string; promptLabel: string }): Promise<PageInspection> {
    const sources = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1'])");
    let source: VisibleControl;
    try { source = this.chooseControl(sources, input.assetLabel, undefined, "asset"); }
    catch (error) {
      const textMatches = await this.visibleExactText(input.assetLabel);
      if (textMatches.length !== 1) throw error;
      source = textMatches[0];
    }
    const prompts = await this.visibleControls("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
    const prompt = this.chooseControl(prompts, input.promptLabel, undefined, "prompt textbox");
    await source.locator.dragTo(prompt.locator, { timeout: 30_000 });
    await this.page?.waitForTimeout(1_500);
    return this.inspectPage();
  }

  async approveCreditPrompt(): Promise<boolean> {
    const page = await this.ensurePage();
    const approve = page.getByRole("button", { name: /^\s*(check\s+)?approve\s*$/i }).last();
    // shortcut: waits up to 20s even when no prompt comes (image jobs); switch to watching the assistant reply if that delay matters.
    const appeared = await approve.waitFor({ state: "visible", timeout: 20_000 }).then(() => true, () => false);
    if (appeared) await approve.click();
    return appeared;
  }

  async clickControl(input: { label?: string; index?: number; allowCreditSpend: boolean; creditsChecked?: boolean }): Promise<PageInspection> {
    const controls = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1']), summary, input[type='button'], input[type='submit']");
    let target: VisibleControl;
    try { target = this.chooseControl(controls, input.label, input.index, "button"); }
    catch (error) {
      if (!input.label || input.index !== undefined) throw error;
      const textMatches = await this.visibleExactText(input.label);
      if (textMatches.length !== 1) throw error;
      target = textMatches[0];
    }
    if (BLOCKED_AUTH_ACTION.test(target.label)) throw new Error("Signing out and credential-related actions are user-only.");
    if (BLOCKED_CREDIT_ACTION.test(target.label)) throw new Error("Blanket credit approval is user-only.");
    if (SUBMIT_ONLY_ACTION.test(target.label) && !input.creditsChecked) throw new Error("Use flow_submit_generation with maxCredits to start a generation.");
    if (CREDIT_ACTION.test(target.label) && !input.allowCreditSpend) throw new Error("This control may spend Google Flow credits. Set allowCreditSpend=true only after user approval.");
    await target.locator.click();
    await this.page?.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    try { return await this.inspectPage(); }
    catch {
      const page = await this.ensurePage();
      return { url: page.url(), title: await page.title().catch(() => ""), visibleText: "", buttons: [], textboxes: [], fileInputCount: 0, media: [], failureCount: 0 };
    }
  }

  async downloadAsset(input: { label?: string; index?: number; destinationDir: string; fileName?: string }): Promise<{ path: string; suggestedFileName: string; sourceUrl: string }> {
    const page = await this.ensurePage();
    const controls = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1']), summary, input[type='button'], input[type='submit']");
    let target: VisibleControl;
    try { target = this.chooseControl(controls, input.label, input.index, "download control"); }
    catch (error) {
      if (!input.label || input.index !== undefined) throw error;
      const textMatches = await this.visibleExactText(input.label);
      if (textMatches.length !== 1) throw error;
      target = textMatches[0];
    }
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await target.locator.click();
    const download = await downloadPromise;
    return this.saveDownload(download, input.destinationDir, input.fileName, page.url());
  }

  async downloadMedia(input: { projectUrl: string; mediaId?: string; title?: string; destinationDir: string; fileName?: string }): Promise<{ path: string; suggestedFileName: string; sourceUrl: string; media: FlowMediaItem; bytes: number }> {
    const { media } = await this.openMedia(input);
    const page = await this.ensurePage();
    if (isAssetMedia(media)) {
      // Images: =d is the original file. Videos: =m22 is 720p MP4, =m18 is the 360p fallback (bare URL returns a JPEG poster).
      let response = await page.request.get(`${media.href}${media.kind === "video" ? "=m22" : "=d"}`);
      if (media.kind === "video" && !response.ok()) response = await page.request.get(`${media.href}=m18`);
      if (!response.ok()) throw new Error(`Flow media download failed with HTTP ${response.status()}.`);
      const extension = (response.headers()["content-type"] ?? "").split(";")[0].split("/")[1]?.replace("jpeg", "jpg") || "bin";
      const suggestedFileName = `${media.tileId.slice(0, 24)}.${extension}`;
      const requestedName = input.fileName ? path.basename(input.fileName) : suggestedFileName;
      if (!requestedName || requestedName === "." || requestedName === "..") throw new Error("Invalid download file name.");
      const destinationDir = path.resolve(input.destinationDir);
      await mkdir(destinationDir, { recursive: true });
      const destination = path.join(destinationDir, requestedName);
      const body = await response.body();
      if (!body.length) throw new Error("Flow download completed with an empty file.");
      await writeFile(destination, body);
      return { path: destination, suggestedFileName, sourceUrl: media.href, media, bytes: body.length };
    }
    const downloadControl = page.getByRole("button", { name: /Download|下载/i }).first();
    if (!(await downloadControl.isVisible().catch(() => false))) throw new Error("Flow media detail page does not expose a visible Download control.");
    let download = await Promise.all([
      page.waitForEvent("download", { timeout: 10_000 }).catch(() => undefined), downloadControl.click(),
    ]).then(([value]) => value);
    if (!download) {
      const menuItem = page.getByText(/Original|Original size|原始|原图|1080p|720p/i).last();
      if (!(await menuItem.isVisible().catch(() => false))) throw new Error("Download menu opened, but no supported original-size item was found.");
      download = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), menuItem.click()]).then(([value]) => value);
    }
    if (!download) throw new Error("Flow did not produce a download.");
    const saved = await this.saveDownload(download, input.destinationDir, input.fileName, page.url());
    return { ...saved, media, bytes: (await stat(saved.path)).size };
  }

  async configureGeneration(projectUrl: string, settings: GenerationSettings): Promise<{ summary: string; credits: number }> {
    const page = await this.openProjectPage(projectUrl);
    await this.turnAgentOff(page);
    const overlay = page.locator(SELECTORS.overlay);
    await this.openSettings(page);
    await this.chooseRadio(page, settings.type === "image" ? "Image" : "Video");
    const menu = overlay.locator(SELECTORS.modelMenu);
    if (!(await menu.innerText()).includes(settings.model)) {
      await menu.click();
      const item = overlay.locator(SELECTORS.menuItem).filter({ hasText: settings.model });
      if (await item.count() !== 1) throw new Error(`Flow model menu has ${await item.count()} items named "${settings.model}".`);
      await item.click();
      await page.waitForTimeout(1_200);
      await this.openSettings(page);
      if (!(await menu.innerText()).includes(settings.model)) throw new Error(`Flow did not switch the model to ${settings.model}.`);
    }
    if (settings.type === "video") await this.chooseRadio(page, settings.videoMode === "frames" ? "Frames" : "Ingredients");
    await this.chooseRadio(page, settings.aspectRatio);
    const rule = MODEL_RULES[settings.model];
    // Single-option settings (Veo is fixed at 8s/720p) have no control in the popover.
    if (settings.resolution && (rule.resolutions?.length ?? 0) > 1) await this.chooseRadio(page, settings.resolution);
    if (settings.durationSeconds && (rule.durations?.length ?? 0) > 1) await this.chooseRadio(page, `${settings.durationSeconds}s`);
    await this.chooseRadio(page, `x${settings.outputs}`);
    const credits = parseCreditLine(await overlay.innerText());
    await this.closeSettings(page);
    if (credits === undefined) throw new Error("Flow settings did not show a \"Generating will use N credits\" line.");
    const summary = (await page.locator(SELECTORS.settingsTrigger).innerText()).replace(/\s+/g, " ").trim();
    return { summary, credits };
  }

  // Reads the live credit line; undefined when it is not visible (for example with Agent mode on).
  async readGenerationCredits(): Promise<number | undefined> {
    const page = await this.ensurePage();
    if (!(await page.locator(SELECTORS.settingsTrigger).isVisible().catch(() => false))) return undefined;
    await this.openSettings(page);
    const credits = parseCreditLine(await page.locator(SELECTORS.overlay).innerText());
    await this.closeSettings(page);
    return credits;
  }

  async fillPrompt(input: { text: string; label?: string; index?: number }): Promise<PageInspection> {
    const parts = input.text.split(/(?<=^|\s)@(?=\S)/);
    if (parts.length === 1) return this.fillTextbox(input);
    const page = await this.ensurePage();
    const controls = await this.visibleControls("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
    const target = this.chooseControl(controls, input.label, input.index, "textbox");
    await target.locator.fill("");
    // insertText never sends Enter, which would submit the prompt.
    if (parts[0]) await page.keyboard.insertText(parts[0]);
    const overlay = page.locator(SELECTORS.overlay);
    for (const part of parts.slice(1)) {
      await page.keyboard.type("@");
      const search = overlay.locator(SELECTORS.mentionSearch);
      await search.waitFor({ state: "visible", timeout: 10_000 });
      const firstWord = part.match(/^[^\s]+/)![0];
      await search.fill(firstWord);
      await page.waitForTimeout(1_500);
      const titles = await overlay.locator(`${SELECTORS.mentionOption} ${SELECTORS.mentionTitle}`).allInnerTexts();
      const name = matchMention(part, titles.map((title) => title.trim()));
      if (!name) {
        await page.keyboard.press("Escape");
        throw new Error(`No Flow asset or character named "@${firstWord}..." for this mention. Known matches: ${titles.join(", ") || "none"}.`);
      }
      await search.fill(name);
      await page.waitForTimeout(1_000);
      const option = overlay.locator(SELECTORS.mentionOption).filter({ has: page.locator(SELECTORS.mentionTitle, { hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) }) });
      if (await option.count() < 1) throw new Error(`Flow mention option "${name}" disappeared.`);
      // Clicking an option only previews it; "Add to prompt" inserts the previewed item.
      await option.first().click();
      await overlay.getByRole("button", { name: SELECTORS.mentionAdd }).click();
      await page.waitForTimeout(800);
      const chip = (await target.locator.locator(SELECTORS.mentionChip).last().textContent().catch(() => ""))?.trim();
      if (chip !== name) throw new Error(`Flow inserted mention "${chip}" instead of "${name}".`);
      // Flow inserts a space after the chip.
      const rest = part.slice(name.length).replace(/^ /, "");
      if (rest) await page.keyboard.insertText(rest);
    }
    return this.inspectPage();
  }

  async listCharacters(projectUrl: string): Promise<FlowCharacter[]> {
    const page = await this.ensurePage();
    const characters: FlowCharacter[] = [];
    for (let index = 0; ; index += 1) {
      await this.openProjectPage(projectUrl, true);
      await page.locator(SELECTORS.charactersNav).filter({ hasText: SELECTORS.charactersNavText }).click();
      await page.waitForTimeout(3_000);
      const tiles = page.locator(SELECTORS.characterTile);
      if (index >= await tiles.count()) return characters;
      const name = (await tiles.nth(index).locator(SELECTORS.characterName).innerText()).trim();
      await tiles.nth(index).locator(SELECTORS.characterThumbnail).click();
      await page.waitForURL(CHARACTER_URL, { timeout: 30_000 });
      characters.push({ id: page.url().match(CHARACTER_URL)![1], name, url: page.url().split("?")[0] });
    }
  }

  async createCharacter(input: { projectUrl: string; name: string; imagePath: string; description?: string }): Promise<FlowCharacter> {
    const imagePath = path.resolve(input.imagePath);
    if (!(await stat(imagePath).catch(() => undefined))?.isFile()) throw new Error(`Image file not found: ${imagePath}`);
    const page = await this.ensurePage();
    await page.goto(`${projectBaseUrl(input.projectUrl)}/character`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const upload = page.getByRole("button", { name: /^\s*(upload\s*)?Upload\s*$/ });
    await upload.waitFor({ state: "visible", timeout: 30_000 });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 15_000 }), upload.click()]);
    await chooser.setFiles(imagePath);
    const agree = page.locator(SELECTORS.overlay).getByRole("button", { name: /^\s*I agree\s*$/ });
    if (await agree.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false)) await agree.click();
    await page.waitForURL(CHARACTER_URL, { timeout: 90_000 });
    await page.locator(SELECTORS.editName).click();
    const nameInput = page.locator(SELECTORS.nameInput);
    await nameInput.fill(input.name);
    await nameInput.press("Enter");
    if (input.description) await page.locator(SELECTORS.characterInfo).fill(input.description);
    await page.waitForTimeout(1_500);
    const character = { id: page.url().match(CHARACTER_URL)![1], name: input.name, url: page.url().split("?")[0] };
    await page.getByRole("button", { name: /^\s*Done\s*$/ }).click();
    await page.waitForTimeout(3_000);
    return character;
  }

  async listTools(projectUrl: string, tab: keyof typeof TOOL_TABS): Promise<FlowTool[]> {
    const page = await this.ensurePage();
    await page.goto(`${projectBaseUrl(projectUrl)}/tools`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const tabRadio = page.locator(SELECTORS.radio).filter({ hasText: new RegExp(`^\\s*${TOOL_TABS[tab]}\\s*$`) });
    await tabRadio.waitFor({ state: "visible", timeout: 30_000 });
    await tabRadio.click();
    await page.waitForTimeout(5_000);
    const { toolCard, toolSectionTitle, toolName, toolAuthor, toolDescription, toolThumbnail } = SELECTORS;
    return page.locator(SELECTORS.toolSection).evaluateAll((sections, selectors) => sections.flatMap((section) => {
      const text = (root: Element, selector: string) => root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      return [...section.querySelectorAll(selectors.toolCard)].map((card) => ({
        name: text(card, selectors.toolName),
        author: text(card, selectors.toolAuthor),
        description: text(card, selectors.toolDescription),
        section: text(section, selectors.toolSectionTitle),
        thumbnail: card.querySelector<HTMLImageElement>(selectors.toolThumbnail)?.src ?? "",
      }));
    }), { toolCard, toolSectionTitle, toolName, toolAuthor, toolDescription, toolThumbnail });
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    await context?.close();
  }

  private async openProjectPage(projectUrl: string, force = false): Promise<Page> {
    this.validateFlowProjectUrl(projectUrl);
    const page = await this.ensurePage();
    if (force || page.url().split("?")[0] !== projectUrl.split("?")[0]) {
      await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    await page.locator(`${SELECTORS.settingsTrigger}, ${SELECTORS.agentChip}, ${SELECTORS.agentPanelClose}`).first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1_500);
    return page;
  }

  private async turnAgentOff(page: Page): Promise<void> {
    const chip = page.locator(SELECTORS.agentChip);
    // The agent chat panel hides the Agent chip until it is closed.
    if (!(await chip.isVisible().catch(() => false))) {
      await page.locator(SELECTORS.agentPanelClose).first().click();
      await chip.waitFor({ state: "visible", timeout: 10_000 });
    }
    if ((await chip.getAttribute("aria-pressed")) === "true") await chip.click();
    await page.locator(SELECTORS.settingsTrigger).waitFor({ state: "visible", timeout: 10_000 });
  }

  private async settingsOpen(page: Page): Promise<boolean> {
    return parseCreditLine(await page.locator(SELECTORS.overlay).innerText().catch(() => "")) !== undefined;
  }

  private async openSettings(page: Page): Promise<void> {
    if (await this.settingsOpen(page)) return;
    await page.locator(SELECTORS.settingsTrigger).click();
    await page.waitForTimeout(1_200);
    if (!(await this.settingsOpen(page))) throw new Error("Flow settings popover did not open.");
  }

  // A backdrop click does not reliably close the popover; Escape or a second trigger click does.
  private async closeSettings(page: Page): Promise<void> {
    if (!(await this.settingsOpen(page))) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    if (await this.settingsOpen(page)) await page.locator(SELECTORS.settingsTrigger).click();
    await page.waitForTimeout(700);
    if (await this.settingsOpen(page)) throw new Error("Flow settings popover did not close.");
  }

  private async chooseRadio(page: Page, label: string): Promise<void> {
    const radios = page.locator(SELECTORS.overlay).locator(SELECTORS.radio);
    // Radio text is an icon name plus the label (and sometimes an info icon), one per line.
    const matches = await radios.evaluateAll((elements, wanted) => elements.flatMap((element, index) =>
      (element as HTMLElement).innerText.split("\n").some((line) => line.trim() === wanted) ? [index] : []), label);
    if (matches.length !== 1) throw new Error(`Expected one Flow setting "${label}", found ${matches.length}.`);
    const radio = radios.nth(matches[0]);
    if ((await radio.getAttribute("aria-checked")) !== "true") {
      await radio.click();
      await page.waitForTimeout(600);
    }
    if ((await radio.getAttribute("aria-checked")) !== "true") throw new Error(`Flow did not select setting "${label}".`);
  }

  private async ensurePage(): Promise<Page> {
    if (!this.context) {
      const context = await chromium.launchPersistentContext(this.config.profileDir, {
        executablePath: this.config.browserExecutable,
        headless: false,
        viewport: null,
        acceptDownloads: true,
        ignoreDefaultArgs: ["--no-sandbox"],
        args: ["--no-first-run", "--disable-default-apps"],
      });
      this.context = context;
      context.once("close", () => {
        if (this.context === context) { this.context = undefined; this.page = undefined; }
      });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages().find((candidate) => FLOW_HOSTS.has(new URL(candidate.url()).hostname)) ?? this.context.pages()[0] ?? await this.context.newPage();
    }
    return this.page;
  }

  private async inspectMedia(): Promise<FlowMediaItem[]> {
    const page = await this.ensurePage();
    const results: FlowMediaItem[] = [];
    for (const frame of page.frames()) {
      const tiles = frame.locator("[data-tile-id]");
      const count = Math.min(await tiles.count(), 200);
      for (let index = 0; index < count; index += 1) {
        const tile = tiles.nth(index);
        if (!(await tile.isVisible().catch(() => false))) continue;
        const item = await tile.evaluate((element) => {
          const domTileId = element.getAttribute("data-tile-id") ?? "";
          const anchor = element.querySelector("a[href*='/fx/tools/flow/project/'][href*='/edit/']") as HTMLAnchorElement | null;
          const href = anchor ? new URL(anchor.href, location.origin).toString() : "";
          const tileId = href ? new URL(href).pathname.split("/").filter(Boolean).at(-1) ?? domTileId.replace(/^fe_id_/, "") : domTileId.replace(/^fe_id_/, "");
          const video = element.querySelector("video") as HTMLVideoElement | null;
          const image = element.querySelector("img") as HTMLImageElement | null;
          const source = video?.getAttribute("src") ?? image?.getAttribute("src") ?? "";
          let providerMediaId: string | undefined;
          try { providerMediaId = new URL(source, location.origin).searchParams.get("name") ?? undefined; } catch { providerMediaId = undefined; }
          const leaf = Array.from(element.querySelectorAll("div")).find((node) => {
            const value = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
            return value.length > 2 && node.children.length === 0 && !/^(play|play_arrow|play_circle)$/i.test(value);
          });
          return {
            tileId,
            providerMediaId,
            title: leaf?.textContent?.replace(/\s+/g, " ").trim() ?? image?.getAttribute("alt") ?? tileId,
            kind: video ? "video" as const : image ? "image" as const : "unknown" as const,
            href,
          };
        });
        if (item.tileId && item.href) results.push(item);
      }
    }
    // flow.google.com has no data-tile-id tiles; media are /asb/ assets keyed by their asset token.
    // shortcut: video assets are assumed to use the same /asb/ src; verify on the first video job.
    results.push(...await page.locator("img[src*='/asb/'], video[src*='/asb/']").evaluateAll((elements) => elements.map((element) => {
      const href = new URL(element.getAttribute("src") ?? "", location.origin);
      href.pathname = href.pathname.replace(/=[^/]*$/, "");
      const tileId = href.pathname.split("/").at(-1) ?? "";
      const alt = element.getAttribute("alt") ?? "";
      const kind = element.tagName === "VIDEO" || /video/i.test(alt) ? "video" as const : "image" as const;
      return { tileId, providerMediaId: tileId, title: alt || tileId, kind, href: `${href.origin}${href.pathname}` };
    })));
    // A video tile also renders a poster <img>; the Map below keeps the last entry per href, so videos go last.
    results.sort((a, b) => Number(a.kind === "video") - Number(b.kind === "video"));
    return [...new Map(results.map((item) => [item.href, item])).values()];
  }

  private async findMedia(input: { mediaId?: string; title?: string }): Promise<FlowMediaItem> {
    const normalizedTitle = input.title?.trim().toLocaleLowerCase();
    let lastMatches: FlowMediaItem[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const items = await this.inspectMedia();
      lastMatches = items.filter((item) =>
        (input.mediaId && (item.tileId === input.mediaId || item.providerMediaId === input.mediaId)) ||
        (normalizedTitle && item.title.toLocaleLowerCase().includes(normalizedTitle)));
      if (lastMatches.length === 1) return lastMatches[0];
      if (lastMatches.length > 1) break;
      await (await this.ensurePage()).waitForTimeout(2_000);
    }
    throw new Error(`Expected one Flow media item, found ${lastMatches.length}. Inspect flow_inspect_page.media and use tileId or providerMediaId.`);
  }

  private async saveDownload(download: Download, destinationDirInput: string, fileName: string | undefined, sourceUrl: string) {
    const suggestedFileName = download.suggestedFilename();
    const requestedName = fileName ? path.basename(fileName) : suggestedFileName;
    if (!requestedName || requestedName === "." || requestedName === "..") throw new Error("Invalid download file name.");
    const destinationDir = path.resolve(destinationDirInput);
    await mkdir(destinationDir, { recursive: true });
    const destination = path.join(destinationDir, requestedName);
    await download.saveAs(destination);
    if ((await stat(destination)).size <= 0) throw new Error("Flow download completed with an empty file.");
    return { path: destination, suggestedFileName, sourceUrl };
  }

  private validateFlowProjectUrl(projectUrl: string): void {
    const url = new URL(projectUrl);
    const projectPath = url.hostname === "flow.google.com" ? "/project/" : "/fx/tools/flow/project/";
    if (url.protocol !== "https:" || !FLOW_HOSTS.has(url.hostname) || !url.pathname.startsWith(projectPath)) {
      throw new Error("Only official Google Flow project URLs are allowed.");
    }
  }

  private async detectAuthentication(): Promise<"login_required" | "signed_in"> {
    const page = await this.ensurePage();
    const hostname = new URL(page.url()).hostname;
    if (!FLOW_HOSTS.has(hostname)) return "login_required";
    const signInLinks = page.locator("a[href*='accounts.google.com']").filter({ hasText: /sign in|登录|登入/i });
    return await signInLinks.count() ? "login_required" : "signed_in";
  }

  private async visibleControls(selector: string): Promise<VisibleControl[]> {
    const page = await this.ensurePage();
    const controls: VisibleControl[] = [];
    const frames = page.frames();
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const locator = frames[frameIndex].locator(selector);
      const count = Math.min(await locator.count(), 200);
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (!(await item.isVisible().catch(() => false))) continue;
        const label = await this.controlLabel(item);
        if (label) controls.push({ locator: item, label, frame: frameIndex });
      }
    }
    return controls;
  }

  private async controlLabel(locator: Locator): Promise<string> {
    return locator.evaluate((element) => {
      const html = element as HTMLElement;
      const label = html.getAttribute("aria-label") ?? html.getAttribute("placeholder") ?? html.getAttribute("title") ?? html.innerText ?? html.textContent ?? "";
      return label.replace(/\s+/g, " ").trim().slice(0, 300);
    }).catch(() => "");
  }

  private async visibleExactText(label: string): Promise<VisibleControl[]> {
    const page = await this.ensurePage();
    const collect = async (exact: boolean): Promise<VisibleControl[]> => {
      const matches: VisibleControl[] = [];
      const frames = page.frames();
      for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
        const locator = frames[frameIndex].getByText(label, { exact });
        const count = Math.min(await locator.count(), 20);
        for (let index = 0; index < count; index += 1) {
          const item = locator.nth(index);
          if (await item.isVisible().catch(() => false)) matches.push({ locator: item, label, frame: frameIndex });
        }
      }
      return matches;
    };
    const exactMatches = await collect(true);
    return exactMatches.length > 0 ? exactMatches : collect(false);
  }

  private chooseControl(controls: VisibleControl[], label: string | undefined, index: number | undefined, kind: string): VisibleControl {
    if (typeof index === "number") {
      if (!controls[index]) throw new Error(`${kind} index ${index} does not exist.`);
      return controls[index];
    }
    if (!label) throw new Error(`Provide an exact ${kind} label or index from flow_inspect_page.`);
    const normalized = label.trim().toLocaleLowerCase();
    const matches = controls.filter((control) => control.label.toLocaleLowerCase() === normalized);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${kind} labelled "${label}", found ${matches.length}. Inspect the page and use an index.`);
    return matches[0];
  }
}
