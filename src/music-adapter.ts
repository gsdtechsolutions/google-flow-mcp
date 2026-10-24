import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { Page } from "playwright-core";

// Verified against www.flowmusic.app in 2026-10. It shares the Chrome profile (and Google sign-in) with Flow.
const MUSIC_URL = "https://www.flowmusic.app/";
const SESSION_URL = /^https:\/\/www\.flowmusic\.app\/session\/[0-9a-f-]{36}/;
const SONG_BUTTON = /^More options for (.+)$/;

export type MusicSession = {
  sessionUrl: string;
  status: "complete" | "generating" | "empty";
  songs: string[];
  producerText: string;
};

export class FlowMusicAdapter {
  // The Flow adapter owns the browser context; music gets a fresh tab so the Flow tab keeps its state.
  constructor(private readonly newPage: () => Promise<Page>) {}

  async generate(prompt: string, timeoutSeconds: number): Promise<MusicSession> {
    const page = await this.newPage();
    try {
      await this.open(page, MUSIC_URL);
      await page.getByPlaceholder("Let's create...").click();
      await page.keyboard.insertText(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await page.waitForURL(SESSION_URL, { timeout: 30_000 });
      // Right after the redirect the home page's featured-song buttons are still in the DOM; reload for a clean session view.
      await this.open(page, page.url().match(SESSION_URL)![0]);
      return await this.poll(page, timeoutSeconds);
    } finally {
      await page.close();
    }
  }

  async inspect(sessionUrl: string, timeoutSeconds: number): Promise<MusicSession> {
    const page = await this.newPage();
    try {
      await this.open(page, this.sessionUrl(sessionUrl));
      return await this.poll(page, timeoutSeconds);
    } finally {
      await page.close();
    }
  }

  async download(input: { sessionUrl: string; title?: string; destinationDir: string; fileName: string }): Promise<string> {
    const page = await this.newPage();
    try {
      await this.open(page, this.sessionUrl(input.sessionUrl));
      const state = await this.poll(page, 30);
      if (state.status !== "complete") throw new Error(`No finished song in this session yet (status: ${state.status}).`);
      const title = input.title ?? state.songs.at(-1)!;
      if (!state.songs.includes(title)) throw new Error(`Song "${title}" not found. Songs here: ${state.songs.join(", ")}.`);
      await page.getByRole("button", { name: `More options for ${title}`, exact: true }).first().click();
      await page.getByRole("menuitem", { name: "Download", exact: true }).click();
      await page.waitForTimeout(900);
      // The format submenu ignores Playwright's synthetic click; a real mouse move and click works.
      const box = await page.getByRole("menuitem", { name: "MP3", exact: true }).boundingBox();
      if (!box) throw new Error("Flow Music did not show an MP3 download option.");
      const pending = page.waitForEvent("download", { timeout: 60_000 });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const download = await pending;
      await mkdir(input.destinationDir, { recursive: true });
      const target = path.join(input.destinationDir, input.fileName.replace(/(\.mp3)?$/i, ".mp3"));
      await download.saveAs(target);
      return target;
    } finally {
      await page.close();
    }
  }

  async credits(): Promise<string> {
    const page = await this.newPage();
    try {
      await this.open(page, MUSIC_URL);
      await page.getByRole("button", { name: "Settings menu" }).click();
      await page.waitForTimeout(800);
      return (await page.evaluate(() => document.body.innerText.match(/[\d,]+ credits/)?.[0] ?? "unknown"));
    } finally {
      await page.close();
    }
  }

  private sessionUrl(value: string): string {
    const match = value.match(SESSION_URL);
    if (!match) throw new Error("Expected a https://www.flowmusic.app/session/<id> URL.");
    return match[0];
  }

  private async open(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Signed-out visitors get the marketing page without the account menu.
    await page.getByRole("button", { name: "Settings menu" }).waitFor({ state: "visible", timeout: 30_000 })
      .catch(() => { throw new Error("Flow Music is signed out. Clauber must sign in through the viewer (see the google-flow skill)."); });
  }

  private async poll(page: Page, timeoutSeconds: number): Promise<MusicSession> {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    for (;;) {
      const state = await page.evaluate(() => ({
        text: document.body.innerText.replace(/\s+/g, " "),
        songs: [...document.querySelectorAll("main button[aria-label^='More options for ']")].map((b) => b.getAttribute("aria-label")!),
      }));
      const songs = [...new Set(state.songs.map((label) => label.match(SONG_BUTTON)![1]))];
      const generating = /\d+% Generating|Creating "/.test(state.text);
      const status = songs.length > 0 && !generating ? "complete" : generating ? "generating" : "empty";
      if (status === "complete" || Date.now() >= deadline) {
        return { sessionUrl: page.url().match(SESSION_URL)?.[0] ?? page.url(), status, songs, producerText: state.text.slice(-700) };
      }
      await page.waitForTimeout(3_000);
    }
  }
}
