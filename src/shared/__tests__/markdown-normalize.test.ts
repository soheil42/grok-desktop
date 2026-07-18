/**
 * Complete regression suite for the markdown parser/normalizer.
 * Fixtures mirror real Grok agent responses from desktop sessions
 * (Persian RTL reports, handbook TOC, status tables, streaming joins).
 */
import { describe, expect, it } from "vitest";
import {
  joinAgentTextChunks,
  normalizeMarkdownForRender,
  repairCollapsedMarkdownBlocks,
  segmentMarkdown,
  type MdSegment,
} from "../markdown-normalize.js";

function tablesOf(segs: MdSegment[]) {
  return segs.filter((s): s is Extract<MdSegment, { type: "table" }> => s.type === "table");
}

function markdownOf(segs: MdSegment[]) {
  return segs
    .filter((s): s is Extract<MdSegment, { type: "markdown" }> => s.type === "markdown")
    .map((s) => s.text)
    .join("\n");
}

// ─── Production fixtures (from ~/.grok session updates.jsonl) ───────────────

/** Exact handbook TOC from AriaVPN support session */
const FIXTURE_HANDBOOK_TOC = `محتوا:

| بخش | چیست |
|-----|------|
| بیو و جایگزین‌ها | آماده کپی |
| نقش پشتیبان vs ربات | مرز مسئولیت |
| لحن و ممنوعیت‌ها | بر اساس سبک واقعی چت‌ها |
| فلو triage | الگوریتم روزانه |
| **پیام‌های آماده A→N** | از پاسخ‌های واقعی اکسپورت: پرداخت، اتصال، هواپیما+آپدیت ساب |
| چک‌لیست اطلاعات لازم | اتصال / پرداخت / حجم |
| ارجاع به مدیر | چه وقت‌ها |
| **رفتار در افت فروش** | هر لید = فرصت؛ فروش نرم بعد از حل مشکل |
| آنبوردینگ ۲ ساعته پشتیبان جدید | روز اول + سناریو تمرینی |
| امنیت | ولت/رمز/ساب |

پیام‌های آماده بر پایه الگوهای واقعی شماست.`;

/** Export profile table from support review */
const FIXTURE_EXPORT_PROFILE = `## این اکسپورت چیست؟

| مورد | مقدار |
|------|--------|
| اکانت | **AriaVPN Support** — \`@peyman9\` |
| شماره | \`+1 534 794 2115\` |
| بیو | «لطفا صبور باشید 🙏 آدرس ربات : @AriaVpnRobot» |
| بازه زمانی | **۲ مارس تا ۱۶ جولای ۲۰۲۶** (~۴٫۵ ماه) |
| چت‌ها | **۱٬۱۶۸** فعال + **۲۲۹** left |
| کل پیام‌ها | **~۳۲٬۰۰۰** |

این فایل فقط خلاصه پروفایل است.`;

/** Ticket taxonomy table (broken UI screenshot) */
const FIXTURE_TAXONOMY = `۳. کاربرها برای چه می‌آیند؟ (تاکسونومی تیکت)

بر اساس پیام‌های کاربر (تقریبی؛ overlap دارد):

| موضوع | % چت‌ها (تقریبی) | معنی کسب‌وکار |
| --- | --- | --- |
| قیمت / خرید / پلن | ۴۳٪ | هنوز مسیر خرید داخل ربات کامل شفاف نیست |
| مشکل/سؤال پرداخت | ۲۵٪ | بزرگ‌ترین اصطکاک تبدیل |
| حجم تمام‌شده | ۲۴٪ | تمدید و upsell فرصت بزرگ است |
| وصل نمی‌شود / خطا | ۲۰٪ | پایداری + آموزش اتصال |
| تست رایگان | ۱۹٪ | قیف تست زنده است |
| نصب/کلاینت | ۱۸٪ | onboarding ناقص در ربات/پین |
| کندی/پینگ | ۱۸٪ | کیفیت ادراک‌شده |
| کریپتو/ولت | ۱۳٪ | پرداخت جایگزین پرتکرار |
| تمدید | ۱۱٪ |  |
| آپدیت ساب | ۱۰٪ | تأیید یافته ریپورت |
| گیم/تانل | ۹٪ | سگمنت واضح ولی کوچک‌تر |

پیام اول کاربر
~۹۰٪ با «سلام» شروع می‌شود.`;

/** Server status table after terminal fix */
const FIXTURE_SERVER_STATUS = `چک کردم — **الان اوکی است و سرور بالا است.**

| مورد | وضعیت |
|------|--------|
| ترمینال | کار می‌کند |
| Python | 3.9.6 |
| سرور | در حال اجرا |
| صفحه اصلی | \`200\` |
| CSS / JS | \`200\` |

آدرس:

**http://127.0.0.1:4173**

برای اجرای بعدی هم اسکریپت \`website/serve.py\` گذاشتم:

\`\`\`bash
python3 website/serve.py
\`\`\``;

/** Report comparison table (channel review) */
const FIXTURE_REPORT_COMPARE = `نکته‌های کلیدی:

| یافته ریپورت | چرا مهم است |
|---|---|
| پشتیبانی تک‌نفره \`@Peyman9\` = گلوگاه | دقیقاً همین اکانت اکسپورت شده |
| بیوی ضعیف | در اکسپورت هم همان بیو دیده می‌شود |
| اصطکاک پرداخت (کارت/ترونادو/کارمزد) | پرتکرارترین تم پشتیبانی |
| اسپم «آپدیت ساب» + قطعی | بخش بزرگی از تیکت‌های اتصال |
| نبود FAQ/پین | کاربر مستقیم می‌آید پی‌وی |`;

/** Response speed metrics */
const FIXTURE_SPEED = `### سرعت پاسخ (نقطه قوت واقعی)

| معیار | مقدار |
|------|--------|
| میانه پاسخ | **~۱٫۸ دقیقه** |
| زیر ۵ دقیقه | **~۵۸٪** |
| زیر ۳۰ دقیقه | **~۷۲٪** |
| زیر ۲ ساعت | **~۸۳٪** |
| دم بلند p90 | **~۵ ساعت** |

وقتی آنلاین هستی، پاسخ‌دهی **عالی** است.`;

/** English architecture tables from design docs */
const FIXTURE_ENGLISH_MODES = `| Mode | Command | Best for desktop |
|------|---------|------------------|
| **Interactive TUI** | \`grok\` | Don’t wrap this for UI |
| **Headless** | \`grok -p "..."\` | Simple jobs, automations |
| **Agent (ACP)** | \`grok agent stdio\` | **Primary path** |`;

// ─── joinAgentTextChunks ────────────────────────────────────────────────────

describe("joinAgentTextChunks", () => {
  it("concatenates normal stream tokens without extra whitespace", () => {
    expect(joinAgentTextChunks("hel", "lo")).toBe("hello");
    expect(joinAgentTextChunks("چک ", "کردم")).toBe("چک کردم");
  });

  it("does not break open code fences mid-stream", () => {
    expect(joinAgentTextChunks("```bash\n", "echo hi\n")).toBe("```bash\necho hi\n");
    expect(joinAgentTextChunks("```bash\necho hi\n", "echo bye\n")).toBe(
      "```bash\necho hi\necho bye\n",
    );
  });

  it("repairs a missing separator after a completed fence", () => {
    const a = "run this:\n\n```bash\necho hi\n```";
    const b = "یادآوری مربوط به تلاش ناموفق قبلی است";
    expect(joinAgentTextChunks(a, b)).toBe(`${a}\n\n${b}`);
  });

  it("repairs a missing newline before a complete table row", () => {
    expect(joinAgentTextChunks("محتوا:", "| بخش | چیست |")).toBe(
      "محتوا:\n| بخش | چیست |",
    );
  });

  it("repairs a missing blank line before a complete heading", () => {
    expect(joinAgentTextChunks("done.", "## بعدی")).toBe("done.\n\n## بعدی");
  });

  it("reconstructs identical source for every possible two-chunk split", () => {
    const source = FIXTURE_SERVER_STATUS;
    for (let i = 0; i <= source.length; i++) {
      expect(joinAgentTextChunks(source.slice(0, i), source.slice(i))).toBe(source);
    }
  });

  it("preserves streaming of table rows line by line", () => {
    let acc = "| a | b |\n";
    acc = joinAgentTextChunks(acc, "|---|---|\n");
    acc = joinAgentTextChunks(acc, "| 1 | 2 |\n");
    const segs = segmentMarkdown(acc);
    expect(tablesOf(segs)).toHaveLength(1);
    expect(tablesOf(segs)[0].rows).toEqual([["1", "2"]]);
  });

  it("reconstructs whitespace-trimmed semantic blocks from the reported failure", () => {
    const chunks = [
      "# Database structure",
      "There are **two layers**:",
      "1. **What actually runs today** — TypeORM entities",
      "2. **Target design** — full OTA schema",
      "Below is mainly **what’s implemented now**.",
      "---",
      "## Global rules (every table)",
      "| Rule | Detail |",
      "|---|---|",
      "| **IDs** | Internal `BIGSERIAL id` |",
      "| **Money** | Integer Rial |",
    ];
    const joined = chunks.reduce(joinAgentTextChunks, "");
    const segs = segmentMarkdown(joined);
    expect(joined).toContain("# Database structure\n\nThere are");
    expect(joined).toContain("implemented now**.\n\n---\n\n## Global rules");
    expect(tablesOf(segs)[0]).toMatchObject({
      headers: ["Rule", "Detail"],
      rows: [
        ["**IDs**", "Internal `BIGSERIAL id`"],
        ["**Money**", "Integer Rial"],
      ],
    });
  });
});

// ─── normalizeMarkdownForRender ─────────────────────────────────────────────

describe("normalizeMarkdownForRender", () => {
  it("repairs the exact live ACP heading and table collapse shape", () => {
    const broken = [
      "Everything below is what actually exists.",
      "---## 1. Status machines",
      "| Concept | Values | |---|---| | **Order** | pending → paid | | **Reservation** | held → confirmed |",
      "---## 2. Catalog - sellable product### `hotels`",
      "| Column | Type | Notes | |---|---|---| | `id` | BIGSERIAL | Internal only |",
    ].join("\n");

    const repaired = repairCollapsedMarkdownBlocks(broken);
    expect(repaired).toContain("---\n\n## 1. Status machines");
    expect(repaired).toContain("| Concept | Values |\n|---|---|\n| **Order**");
    expect(repaired).toContain("sellable product\n\n### `hotels`");

    const tables = tablesOf(segmentMarkdown(broken));
    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({
      headers: ["Concept", "Values"],
      rows: [
        ["**Order**", "pending → paid"],
        ["**Reservation**", "held → confirmed"],
      ],
    });
  });

  it("does not repair markdown-looking tokens inside fenced code", () => {
    const code = "```ts\nconst value = left || right; // ---## literal\n```";
    expect(repairCollapsedMarkdownBlocks(code)).toBe(code);
  });

  it("leaves dangling fences unchanged for CommonMark to render", () => {
    const src = "code:\n```bash\necho hi";
    const out = normalizeMarkdownForRender(src);
    expect(out).toBe(src);
  });

  it("leaves dangling emphasis unchanged", () => {
    const src = "این **متن باز";
    expect(normalizeMarkdownForRender(src)).toBe(src);
  });

  it("inserts blank line before a table after prose (not between table rows)", () => {
    const src = "Status:\n| a | b |\n|---|---|\n| 1 | 2 |";
    const out = normalizeMarkdownForRender(src);
    expect(out).toContain("Status:\n\n| a | b |");
    // Must NOT put blank line between header and separator
    expect(out).toMatch(/\| a \| b \|\n\|---\|---\|/);
  });

  it("normalizes exotic fullwidth pipes to ASCII", () => {
    const src = "｜ a ｜ b ｜\n｜---｜---｜\n｜ 1 ｜ 2 ｜";
    const out = normalizeMarkdownForRender(src);
    expect(out).toContain("| a | b |");
    expect(out).not.toContain("｜");
  });

  it("strips bidi control marks", () => {
    const src = "|\u200f a | b |\n|---|---|\n| 1 | 2 |";
    const out = normalizeMarkdownForRender(src);
    expect(out).not.toMatch(/[\u200e\u200f\u202a-\u202e]/);
  });

  it("does not insert blank lines between body rows", () => {
    const src = `| a | b |
|---|---|
| 1 | 2 |
| 3 | 4 |`;
    const out = normalizeMarkdownForRender(src);
    expect(out).toMatch(/\| 1 \| 2 \|\n\| 3 \| 4 \|/);
  });
});

// ─── segmentMarkdown — core table extraction ────────────────────────────────

describe("segmentMarkdown — basic tables", () => {
  it("extracts a simple 2-column English table", () => {
    const segs = segmentMarkdown(`| a | b |
|---|---|
| 1 | 2 |`);
    expect(tablesOf(segs)).toHaveLength(1);
    const t = tablesOf(segs)[0];
    expect(t.headers).toEqual(["a", "b"]);
    expect(t.rows).toEqual([["1", "2"]]);
  });

  it("handles separator without spaces |---|---|", () => {
    const segs = segmentMarkdown(`| a | b |
|---|---|
| 1 | 2 |`);
    expect(tablesOf(segs)[0].rows[0]).toEqual(["1", "2"]);
  });

  it("handles separator with spaces | --- | --- |", () => {
    const segs = segmentMarkdown(`| a | b |
| --- | --- |
| 1 | 2 |`);
    expect(tablesOf(segs)[0].rows[0]).toEqual(["1", "2"]);
  });

  it("handles mixed separator |-----|------| (handbook style)", () => {
    const segs = segmentMarkdown(`| بخش | چیست |
|-----|------|
| بیو | کپی |`);
    const t = tablesOf(segs)[0];
    expect(t.headers).toEqual(["بخش", "چیست"]);
    expect(t.rows).toEqual([["بیو", "کپی"]]);
  });

  it("handles alignment colons", () => {
    const segs = segmentMarkdown(`| left | center | right |
|:-----|:------:|------:|
| a | b | c |`);
    const t = tablesOf(segs)[0];
    expect(t.aligns).toEqual(["left", "center", "right"]);
  });

  it("pads short body rows to header width", () => {
    const segs = segmentMarkdown(`| a | b | c |
|---|---|---|
| 1 | 2 |`);
    expect(tablesOf(segs)[0].rows[0]).toEqual(["1", "2", ""]);
  });

  it("trims extra body cells to header width", () => {
    const segs = segmentMarkdown(`| a | b |
|---|---|
| 1 | 2 | 3 | 4 |`);
    expect(tablesOf(segs)[0].rows[0]).toEqual(["1", "2"]);
  });

  it("preserves prose before and after tables", () => {
    const segs = segmentMarkdown(`Intro text.

| a | b |
|---|---|
| 1 | 2 |

Outro text.`);
    expect(markdownOf(segs)).toContain("Intro text");
    expect(markdownOf(segs)).toContain("Outro text");
    expect(tablesOf(segs)).toHaveLength(1);
  });

  it("extracts multiple tables in one message", () => {
    const segs = segmentMarkdown(`First:

| a | b |
|---|---|
| 1 | 2 |

Second:

| x | y |
|---|---|
| 9 | 8 |`);
    expect(tablesOf(segs)).toHaveLength(2);
    expect(tablesOf(segs)[0].rows[0]).toEqual(["1", "2"]);
    expect(tablesOf(segs)[1].rows[0]).toEqual(["9", "8"]);
  });

  it("does not treat HR --- as a table", () => {
    const segs = segmentMarkdown(`Before

---

After`);
    expect(tablesOf(segs)).toHaveLength(0);
    expect(markdownOf(segs)).toContain("---");
  });

  it("does not treat prose with a single pipe as a table", () => {
    const segs = segmentMarkdown(`Use path/to/file | for something`);
    expect(tablesOf(segs)).toHaveLength(0);
  });
});

// ─── Production response fixtures ───────────────────────────────────────────

describe("segmentMarkdown — production Grok responses", () => {
  it("parses AriaVPN handbook TOC table (10 body rows)", () => {
    const segs = segmentMarkdown(FIXTURE_HANDBOOK_TOC);
    const t = tablesOf(segs)[0];
    expect(t).toBeDefined();
    expect(t.headers).toEqual(["بخش", "چیست"]);
    expect(t.rows.length).toBe(10);
    expect(t.rows[0][0]).toContain("بیو");
    expect(t.rows[0][1]).toContain("آماده کپی");
    expect(t.rows[4][0]).toContain("پیام");
    expect(t.rows[9][0]).toBe("امنیت");
    expect(markdownOf(segs)).toContain("پیام‌های آماده بر پایه");
    // Separator must not leak into markdown as raw pipes
    expect(markdownOf(segs)).not.toMatch(/^\|-----/m);
  });

  it("parses export profile table with bold/code in cells", () => {
    const segs = segmentMarkdown(FIXTURE_EXPORT_PROFILE);
    const t = tablesOf(segs)[0];
    expect(t.headers).toEqual(["مورد", "مقدار"]);
    expect(t.rows.length).toBe(6);
    expect(t.rows[0][1]).toContain("AriaVPN Support");
    expect(t.rows[1][1]).toContain("+1 534");
    expect(markdownOf(segs)).toContain("خلاصه پروفایل");
  });

  it("parses ticket taxonomy 3-column table with Persian % digits", () => {
    const segs = segmentMarkdown(FIXTURE_TAXONOMY);
    const t = tablesOf(segs)[0];
    expect(t.headers).toEqual(["موضوع", "% چت‌ها (تقریبی)", "معنی کسب‌وکار"]);
    expect(t.rows.length).toBeGreaterThanOrEqual(11);
    expect(t.rows[0][0]).toContain("قیمت");
    expect(t.rows[0][1]).toBe("۴۳٪");
    expect(t.rows[1][1]).toBe("۲۵٪");
    // No raw table pipes left in surrounding markdown for body rows
    const md = markdownOf(segs);
    expect(md).toContain("پیام اول کاربر");
    expect(md).not.toMatch(/\| قیمت \/ خرید/);
  });

  it("parses server status table + keeps bash fence in markdown segment", () => {
    const segs = segmentMarkdown(FIXTURE_SERVER_STATUS);
    const t = tablesOf(segs)[0];
    expect(t.headers).toEqual(["مورد", "وضعیت"]);
    expect(t.rows.length).toBe(5);
    expect(t.rows[1]).toEqual(["Python", "3.9.6"]);
    expect(t.rows[3][1]).toContain("200");
    const md = markdownOf(segs);
    expect(md).toContain("```bash");
    expect(md).toContain("python3 website/serve.py");
    expect(md).toContain("http://127.0.0.1:4173");
  });

  it("parses report comparison table with short |---|---| separator", () => {
    const segs = segmentMarkdown(FIXTURE_REPORT_COMPARE);
    const t = tablesOf(segs)[0];
    expect(t.headers).toEqual(["یافته ریپورت", "چرا مهم است"]);
    expect(t.rows.length).toBe(5);
    expect(t.rows[0][0]).toContain("پشتیبانی");
  });

  it("parses response-speed metrics table", () => {
    const segs = segmentMarkdown(FIXTURE_SPEED);
    const t = tablesOf(segs)[0];
    expect(t.headers).toEqual(["معیار", "مقدار"]);
    expect(t.rows.length).toBe(5);
    expect(t.rows[0][1]).toContain("۱٫۸");
    expect(markdownOf(segs)).toContain("عالی");
  });

  it("parses English mode comparison table with bold + code", () => {
    const segs = segmentMarkdown(FIXTURE_ENGLISH_MODES);
    const t = tablesOf(segs)[0];
    expect(t.headers).toEqual(["Mode", "Command", "Best for desktop"]);
    expect(t.rows.length).toBe(3);
    expect(t.rows[2][1]).toContain("grok agent stdio");
  });
});

// ─── Streaming reconstruction ───────────────────────────────────────────────

describe("streaming reconstruction of full agent replies", () => {
  it("rebuilds handbook table from character-sized chunks", () => {
    let acc = "";
    for (const ch of FIXTURE_HANDBOOK_TOC) {
      acc = joinAgentTextChunks(acc, ch);
    }
    const t = tablesOf(segmentMarkdown(acc))[0];
    expect(t.rows.length).toBe(10);
    expect(t.headers).toEqual(["بخش", "چیست"]);
  });

  it("rebuilds taxonomy table from line-sized chunks", () => {
    let acc = "";
    for (const line of FIXTURE_TAXONOMY.split("\n")) {
      acc = joinAgentTextChunks(acc, (acc ? "\n" : "") + line);
    }
    // join with explicit newlines when splitting by line
    acc = FIXTURE_TAXONOMY.split("\n").reduce(
      (a, line, i) => (i === 0 ? line : joinAgentTextChunks(a, "\n" + line)),
      "",
    );
    const t = tablesOf(segmentMarkdown(acc))[0];
    expect(t.rows.length).toBeGreaterThanOrEqual(11);
    expect(t.rows[0][1]).toBe("۴۳٪");
  });

  it("repairs a missing separator between a fence and prose", () => {
    const turn1 =
      "سرور بالا است.\n\n```bash\npython3 website/serve.py\n```";
    const turn2 =
      "یادآوری: سرور روی **http://127.0.0.1:4173** است.";
    const joined = joinAgentTextChunks(turn1, turn2);
    expect(joined).toBe(`${turn1}\n\n${turn2}`);
    const segs = segmentMarkdown(joined);
    expect(markdownOf(segs)).toContain("python3 website/serve.py");
    expect(markdownOf(segs)).toContain("یادآوری");
  });

  it("incomplete fence remains source-faithful while streaming", () => {
    const partial = "Run:\n```bash\ncd website\npython3 -m http.server 4173";
    const segs = segmentMarkdown(partial);
    const md = markdownOf(segs);
    expect(md).toBe(partial);
  });
});

// ─── Invariants for every production fixture ────────────────────────────────

describe("invariants across all production fixtures", () => {
  const fixtures: Array<{ name: string; src: string; minRows: number }> = [
    { name: "handbook", src: FIXTURE_HANDBOOK_TOC, minRows: 10 },
    { name: "export-profile", src: FIXTURE_EXPORT_PROFILE, minRows: 6 },
    { name: "taxonomy", src: FIXTURE_TAXONOMY, minRows: 11 },
    { name: "server-status", src: FIXTURE_SERVER_STATUS, minRows: 5 },
    { name: "report-compare", src: FIXTURE_REPORT_COMPARE, minRows: 5 },
    { name: "speed", src: FIXTURE_SPEED, minRows: 5 },
    { name: "english-modes", src: FIXTURE_ENGLISH_MODES, minRows: 3 },
  ];

  for (const { name, src, minRows } of fixtures) {
    it(`${name}: extracts ≥1 table with enough rows and no pipe-leak of body`, () => {
      const segs = segmentMarkdown(src);
      const ts = tablesOf(segs);
      expect(ts.length).toBeGreaterThanOrEqual(1);
      const t = ts[0];
      expect(t.headers.length).toBeGreaterThanOrEqual(2);
      expect(t.rows.length).toBeGreaterThanOrEqual(minRows);
      // Every body row matches header width
      for (const row of t.rows) {
        expect(row.length).toBe(t.headers.length);
      }
      // Aligns array matches header width
      expect(t.aligns.length).toBe(t.headers.length);
      // Separator lines must not appear as leftover markdown table rows
      const md = markdownOf(segs);
      expect(md).not.toMatch(/^\|[\s:-]+\|\s*$/m);
    });
  }

  it("segmentMarkdown is pure / deterministic", () => {
    const a = segmentMarkdown(FIXTURE_HANDBOOK_TOC);
    const b = segmentMarkdown(FIXTURE_HANDBOOK_TOC);
    expect(a).toEqual(b);
  });

  it("empty / whitespace input does not throw", () => {
    expect(segmentMarkdown("")).toEqual([{ type: "markdown", text: "" }]);
    expect(segmentMarkdown("   \n  ")).toBeTruthy();
    expect(normalizeMarkdownForRender("")).toBe("");
    expect(joinAgentTextChunks("", "x")).toBe("x");
    expect(joinAgentTextChunks("x", "")).toBe("x");
  });
});
