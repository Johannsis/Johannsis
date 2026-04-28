import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function getRequiredEnv(name: "GITHUB_TOKEN" | "USER_NAME"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
}

const GITHUB_TOKEN = getRequiredEnv("GITHUB_TOKEN");
const USER_NAME = getRequiredEnv("USER_NAME");

const API_BASE = "https://api.github.com";
const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "User-Agent": `${USER_NAME}-about-script`,
  "X-GitHub-Api-Version": "2022-11-28",
};

type Repo = {
  archived: boolean;
  default_branch: string;
  fork: boolean;
  full_name: string;
  name: string;
  owner: {
    login: string;
  };
  stargazers_count: number;
};

type CommitSummary = {
  sha: string;
};

type CommitDetail = {
  stats?: {
    additions: number;
    deletions: number;
  };
};

function formatPlural(unit: number): string {
  return unit === 1 ? "" : "s";
}

function shiftMonth(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

function dailyReadme(birthday: Date): string {
  const now = new Date();
  let years = now.getFullYear() - birthday.getFullYear();

  const yearAnchor = new Date(birthday.getTime());
  yearAnchor.setFullYear(birthday.getFullYear() + years);
  if (yearAnchor > now) {
    years -= 1;
  }

  const afterYears = new Date(birthday.getTime());
  afterYears.setFullYear(birthday.getFullYear() + years);

  let months =
    (now.getFullYear() - afterYears.getFullYear()) * 12 +
    (now.getMonth() - afterYears.getMonth());

  let afterMonths = shiftMonth(afterYears, months);
  if (afterMonths > now) {
    months -= 1;
    afterMonths = shiftMonth(afterYears, months);
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor((now.getTime() - afterMonths.getTime()) / dayMs);

  return `${years} year${formatPlural(years)}, ${months} month${formatPlural(months)}, ${days} day${formatPlural(days)}${months === 0 && days === 0 ? " 🎂" : ""}`;
}

async function githubGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(
      `GitHub REST request failed (${res.status}) for ${url}: ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  const parts = linkHeader.split(",").map((part) => part.trim());
  for (const part of parts) {
    const match = part.match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match && match[2] === "next") {
      return match[1];
    }
  }
  return null;
}

async function githubGetAllPages<T>(initialUrl: string): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = initialUrl;

  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(
        `GitHub REST request failed (${res.status}) for ${url}: ${await res.text()}`,
      );
    }

    const page = (await res.json()) as T[];
    all.push(...page);
    url = nextLink(res.headers.get("link"));
  }

  return all;
}

async function getUser() {
  return githubGet<{
    created_at: string;
    followers: number;
    id: number;
    login: string;
  }>(`${API_BASE}/users/${encodeURIComponent(USER_NAME)}`);
}

async function getOwnedRepos(): Promise<Repo[]> {
  return githubGetAllPages<Repo>(
    `${API_BASE}/users/${encodeURIComponent(USER_NAME)}/repos?per_page=100&type=owner&sort=updated`,
  );
}

async function getAccessibleRepos(): Promise<Repo[]> {
  const repos = await githubGetAllPages<Repo>(
    `${API_BASE}/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated`,
  );

  const uniqueRepos = new Map<string, Repo>();
  for (const repo of repos) {
    uniqueRepos.set(repo.full_name, repo);
  }

  return [...uniqueRepos.values()];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function getRepoContributionStats(repo: Repo): Promise<{
  add: number;
  commits: number;
  del: number;
}> {
  const commitListUrl = `${API_BASE}/repos/${repo.full_name}/commits?author=${encodeURIComponent(USER_NAME)}&per_page=100`;

  let commitSummaries: CommitSummary[];
  try {
    commitSummaries = await githubGetAllPages<CommitSummary>(commitListUrl);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("(409)") ||
        error.message.includes("Git Repository is empty"))
    ) {
      return { add: 0, commits: 0, del: 0 };
    }
    throw error;
  }

  let add = 0;
  let del = 0;

  for (const commitBatch of chunk(commitSummaries, 10)) {
    const details = await Promise.all(
      commitBatch.map(({ sha }) =>
        githubGet<CommitDetail>(
          `${API_BASE}/repos/${repo.full_name}/commits/${sha}`,
        ),
      ),
    );

    for (const detail of details) {
      add += detail.stats?.additions ?? 0;
      del += detail.stats?.deletions ?? 0;
    }
  }

  return { add, commits: commitSummaries.length, del };
}

type CardData = {
  age: string;
  commits: number;
  contribRepos: number;
  followers: number;
  locAdd: number;
  locDel: number;
  locTotal: number;
  repos: number;
  stars: number;
};

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildStatRows(data: CardData): Array<[string, string]> {
  return [
    ["Age", data.age],
    ["Commits", data.commits.toLocaleString("en-US")],
    ["Stars", data.stars.toLocaleString("en-US")],
    ["Repositories", data.repos.toLocaleString("en-US")],
    ["Contributed to", data.contribRepos.toLocaleString("en-US")],
    ["Followers", data.followers.toLocaleString("en-US")],
    ["Lines of Code", data.locTotal.toLocaleString("en-US")],
    ["Added lines", data.locAdd.toLocaleString("en-US")],
    ["Deleted lines", data.locDel.toLocaleString("en-US")],
  ];
}

function dottedLabel(label: string, total = 30): string {
  return `${label} ${".".repeat(Math.max(4, total - label.length))}`;
}

function buildAsciiTspans(asciiLines: string[], x: number, y: number): string {
  return asciiLines
    .map(
      (line, index) =>
        `<tspan x="${x}" y="${y + index * 12}">${escapeXml(line)}</tspan>`,
    )
    .join("\n      ");
}

function createStatsSvg(
  theme: "dark" | "light",
  asciiLines: string[],
  data: CardData,
): string {
  const isDark = theme === "dark";
  const bg = isDark ? "#0d1117" : "#ffffff";
  const border = isDark ? "#30363d" : "#d0d7de";
  const text = isDark ? "#c9d1d9" : "#1f2328";
  const muted = isDark ? "#8b949e" : "#57606a";
  const accent = "#ffae57";
  const value = "#79c0ff";
  const green = "#3fb950";
  const red = "#f85149";

  const topBar = "─".repeat(42);
  const osName = process.platform === "darwin" ? "macOS" : process.platform;
  const rows = buildStatRows(data);
  const lineGap = 42;
  const asciiBlockX = 28;
  const asciiBlockY = 96;
  const detailSectionY = 594;
  const asciiTspans = buildAsciiTspans(asciiLines, asciiBlockX, asciiBlockY);

  const statText = rows
    .map(([label, currentValue], index) => {
      const y = detailSectionY + index * lineGap;
      return `<text x="640" y="${y}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">${escapeXml(`${label}:`)}</tspan><tspan fill="${muted}"> ${escapeXml(dottedLabel("", 24 - label.length))} </tspan><tspan fill="${value}">${escapeXml(currentValue)}</tspan></text>`;
    })
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1580" height="1080" viewBox="0 0 1580 1080" role="img" aria-label="GitHub profile stats card">
  <rect x="8" y="8" width="1564" height="1064" rx="12" fill="${bg}" stroke="${border}" />
  <line x1="610" y1="22" x2="610" y2="1058" stroke="${border}" />
  <text x="36" y="60" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${text}">${escapeXml(`${USER_NAME}@github`)}</tspan><tspan fill="${muted}"> ${topBar}</tspan></text>
  <text x="640" y="96" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">OS:</tspan><tspan fill="${muted}"> ${dottedLabel("", 26)} </tspan><tspan fill="${value}">${escapeXml(osName)}</tspan></text>
  <text x="640" y="138" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">Uptime:</tspan><tspan fill="${muted}"> ${dottedLabel("", 22)} </tspan><tspan fill="${value}">${escapeXml(data.age)}</tspan></text>
  <text x="640" y="180" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">Host:</tspan><tspan fill="${muted}"> ${dottedLabel("", 24)} </tspan><tspan fill="${value}">GitHub Profile README</tspan></text>
  <text x="640" y="222" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">API:</tspan><tspan fill="${muted}"> ${dottedLabel("", 25)} </tspan><tspan fill="${value}">GitHub REST API</tspan></text>
  <text x="640" y="280" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${text}">— GitHub Stats ${topBar}</tspan></text>
  <text x="640" y="322" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">Repos:</tspan><tspan fill="${muted}"> .... </tspan><tspan fill="${value}">${data.repos.toLocaleString("en-US")}</tspan><tspan fill="${muted}"> {Contributed: </tspan><tspan fill="${value}">${data.contribRepos.toLocaleString("en-US")}</tspan><tspan fill="${muted}">} | </tspan><tspan fill="${accent}">Stars:</tspan><tspan fill="${muted}"> ......... </tspan><tspan fill="${value}">${data.stars.toLocaleString("en-US")}</tspan></text>
  <text x="640" y="364" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">Commits:</tspan><tspan fill="${muted}"> ......... </tspan><tspan fill="${value}">${data.commits.toLocaleString("en-US")}</tspan><tspan fill="${muted}"> | </tspan><tspan fill="${accent}">Followers:</tspan><tspan fill="${muted}"> .... </tspan><tspan fill="${value}">${data.followers.toLocaleString("en-US")}</tspan></text>
  <text x="640" y="406" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">Lines of Code on GitHub:</tspan><tspan fill="${muted}"> </tspan><tspan fill="${value}">${data.locTotal.toLocaleString("en-US")}</tspan></text>
  <text x="668" y="442" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${muted}">(</tspan><tspan fill="${green}">${data.locAdd.toLocaleString("en-US")}++</tspan><tspan fill="${muted}">, </tspan><tspan fill="${red}">${data.locDel.toLocaleString("en-US")}--</tspan><tspan fill="${muted}">)</tspan></text>
  <text x="640" y="500" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${text}">— Detail Table ${topBar}</tspan></text>
  <text x="28" y="96" xml:space="preserve" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" fill="${text}">
      ${asciiTspans}
  </text>
  ${statText}
</svg>
`;
}

async function writeStatsSvgs(data: CardData): Promise<void> {
  const asciiPath = path.join(process.cwd(), "assets", "ascii_art.txt");
  const asciiRaw = await readFile(asciiPath, "utf8");
  const asciiLines = asciiRaw.replace(/\r/g, "").split("\n");

  const assetsDir = path.join(process.cwd(), "assets");
  const darkSvg = createStatsSvg("dark", asciiLines, data);
  const lightSvg = createStatsSvg("light", asciiLines, data);

  await writeFile(path.join(assetsDir, "dark_mode.svg"), darkSvg, "utf8");
  await writeFile(path.join(assetsDir, "light_mode.svg"), lightSvg, "utf8");
}

async function main(): Promise<void> {
  const user = await getUser();
  const ageData = dailyReadme(new Date(1996, 7, 15));

  const ownedRepos = await getOwnedRepos();
  const accessibleRepos = await getAccessibleRepos();
  const repoData = ownedRepos.length;
  const starData = ownedRepos.reduce(
    (sum, repo) => sum + repo.stargazers_count,
    0,
  );

  const repoStats = await Promise.all(
    accessibleRepos
      .filter((repo) => !repo.fork && !repo.archived)
      .map((repo) => getRepoContributionStats(repo)),
  );
  const commitData = repoStats.reduce((sum, repo) => sum + repo.commits, 0);
  const locAdd = repoStats.reduce((sum, repo) => sum + repo.add, 0);
  const locDel = repoStats.reduce((sum, repo) => sum + repo.del, 0);
  const locTotal = locAdd - locDel;

  const contribData = accessibleRepos.length;
  const followerData = user.followers;

  await writeStatsSvgs({
    age: ageData,
    commits: commitData,
    contribRepos: contribData,
    followers: followerData,
    locAdd,
    locDel,
    locTotal,
    repos: repoData,
    stars: starData,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
