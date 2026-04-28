import { mkdir, writeFile } from "node:fs/promises";
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

async function getContributedReposCount(): Promise<number> {
  const repos = await githubGetAllPages<Repo>(
    `${API_BASE}/user/repos?per_page=100&affiliation=owner,collaborator,organization_member`,
  );

  const unique = new Set<string>();
  for (const repo of repos) {
    unique.add(repo.full_name);
  }
  return unique.size;
}

async function getCommitCountForRepo(repo: Repo): Promise<number> {
  const base = `${API_BASE}/repos/${repo.full_name}/commits?author=${encodeURIComponent(USER_NAME)}&per_page=100`;
  const res = await fetch(base, { headers });
  if (res.status === 409) {
    return 0;
  }
  if (!res.ok) {
    throw new Error(
      `Failed commit fetch (${res.status}) for ${repo.full_name}: ${await res.text()}`,
    );
  }

  const firstPage = (await res.json()) as unknown[];
  const next = nextLink(res.headers.get("link"));
  if (!next) {
    return firstPage.length;
  }

  const lastMatch = (res.headers.get("link") ?? "").match(
    /<([^>]+)>;\s*rel="last"/,
  );
  if (!lastMatch) {
    return firstPage.length;
  }

  const lastUrl = new URL(lastMatch[1]);
  const pageParam = Number.parseInt(
    lastUrl.searchParams.get("page") ?? "1",
    10,
  );
  if (!Number.isFinite(pageParam) || pageParam <= 1) {
    return firstPage.length;
  }

  const lastRes = await fetch(lastMatch[1], { headers });
  if (!lastRes.ok) {
    throw new Error(
      `Failed last commit page (${lastRes.status}) for ${repo.full_name}: ${await lastRes.text()}`,
    );
  }
  const lastPage = (await lastRes.json()) as unknown[];
  return (pageParam - 1) * 100 + lastPage.length;
}

async function getLocForRepo(
  repo: Repo,
): Promise<{ add: number; del: number }> {
  const endpoint = `${API_BASE}/repos/${repo.full_name}/stats/contributors`;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await fetch(endpoint, { headers });
    if (res.status === 202) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }
    if (res.status === 204 || res.status === 409) {
      return { add: 0, del: 0 };
    }
    if (!res.ok) {
      throw new Error(
        `Failed contributor stats (${res.status}) for ${repo.full_name}: ${await res.text()}`,
      );
    }

    const rows = (await res.json()) as Array<{
      author: { login: string } | null;
      weeks: Array<{ a: number; d: number }>;
    }>;
    const mine = rows.find((row) => row.author?.login === USER_NAME);
    if (!mine) {
      return { add: 0, del: 0 };
    }

    let add = 0;
    let del = 0;
    for (const week of mine.weeks) {
      add += week.a;
      del += week.d;
    }
    return { add, del };
  }

  return { add: 0, del: 0 };
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

function createStatsSvg(theme: "dark" | "light", data: CardData): string {
  const isDark = theme === "dark";
  const bg = isDark ? "#0d1117" : "#ffffff";
  const border = isDark ? "#30363d" : "#d0d7de";
  const text = isDark ? "#c9d1d9" : "#1f2328";
  const muted = isDark ? "#8b949e" : "#57606a";
  const accent = "#ffae57";
  const value = "#79c0ff";
  const green = "#3fb950";
  const red = "#f85149";

  const topBar = "─".repeat(56);
  const osName = process.platform === "darwin" ? "macOS" : process.platform;
  const rows = buildStatRows(data);
  const lineGap = 46;
  const firstY = 78;

  const statText = rows
    .map(([label, currentValue], index) => {
      const y = firstY + (index + 11) * lineGap;
      return `<text x="44" y="${y}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">${escapeXml(`${label}:`)}</tspan><tspan fill="${muted}"> ${escapeXml(dottedLabel("", 24 - label.length))} </tspan><tspan fill="${value}">${escapeXml(currentValue)}</tspan></text>`;
    })
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1060" viewBox="0 0 1280 1060" role="img" aria-label="GitHub profile stats card">
  <rect x="8" y="8" width="1264" height="1044" rx="12" fill="${bg}" stroke="${border}" />
  <text x="44" y="78" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${text}">${escapeXml(`${USER_NAME}@github`)}</tspan><tspan fill="${muted}"> ${topBar}</tspan></text>
  <text x="44" y="124" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">OS:</tspan><tspan fill="${muted}"> ${dottedLabel("", 26)} </tspan><tspan fill="${value}">${escapeXml(osName)}</tspan></text>
  <text x="44" y="170" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">Uptime:</tspan><tspan fill="${muted}"> ${dottedLabel("", 22)} </tspan><tspan fill="${value}">${escapeXml(data.age)}</tspan></text>
  <text x="44" y="216" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">Host:</tspan><tspan fill="${muted}"> ${dottedLabel("", 24)} </tspan><tspan fill="${value}">GitHub Profile README</tspan></text>
  <text x="44" y="262" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">API:</tspan><tspan fill="${muted}"> ${dottedLabel("", 25)} </tspan><tspan fill="${value}">GitHub REST API</tspan></text>
  <text x="44" y="334" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${text}">— GitHub Stats ${topBar}</tspan></text>
  <text x="44" y="380" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">Repos:</tspan><tspan fill="${muted}"> .... </tspan><tspan fill="${value}">${data.repos.toLocaleString("en-US")}</tspan><tspan fill="${muted}"> {Contributed: </tspan><tspan fill="${value}">${data.contribRepos.toLocaleString("en-US")}</tspan><tspan fill="${muted}">} | </tspan><tspan fill="${accent}">Stars:</tspan><tspan fill="${muted}"> ......... </tspan><tspan fill="${value}">${data.stars.toLocaleString("en-US")}</tspan></text>
  <text x="44" y="426" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">Commits:</tspan><tspan fill="${muted}"> ......... </tspan><tspan fill="${value}">${data.commits.toLocaleString("en-US")}</tspan><tspan fill="${muted}"> | </tspan><tspan fill="${accent}">Followers:</tspan><tspan fill="${muted}"> .... </tspan><tspan fill="${value}">${data.followers.toLocaleString("en-US")}</tspan></text>
  <text x="44" y="472" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${muted}">· </tspan><tspan fill="${accent}">Lines of Code on GitHub:</tspan><tspan fill="${muted}"> </tspan><tspan fill="${value}">${data.locTotal.toLocaleString("en-US")}</tspan><tspan fill="${muted}"> (</tspan><tspan fill="${green}">${data.locAdd.toLocaleString("en-US")}++</tspan><tspan fill="${muted}">, </tspan><tspan fill="${red}">${data.locDel.toLocaleString("en-US")}--</tspan><tspan fill="${muted}">)</tspan></text>
  <text x="44" y="548" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="33"><tspan fill="${text}">— Detail Table ${topBar}</tspan></text>
  ${statText}
</svg>
`;
}

async function writeStatsSvgs(data: CardData): Promise<void> {
  const scriptsDir = path.join(process.cwd(), "scripts");
  const darkSvg = createStatsSvg("dark", data);
  const lightSvg = createStatsSvg("light", data);

  await writeFile(path.join(scriptsDir, "dark_mode.svg"), darkSvg, "utf8");
  await writeFile(path.join(scriptsDir, "light_mode.svg"), lightSvg, "utf8");
}

async function main(): Promise<void> {
  await mkdir(path.join(process.cwd(), "cache"), { recursive: true });

  const user = await getUser();
  const ageData = dailyReadme(new Date(2002, 6, 5));

  const ownedRepos = await getOwnedRepos();
  const repoData = ownedRepos.length;
  const starData = ownedRepos.reduce(
    (sum, repo) => sum + repo.stargazers_count,
    0,
  );

  const commitCounts = await Promise.all(
    ownedRepos.map((repo) => getCommitCountForRepo(repo)),
  );
  const commitData = commitCounts.reduce((sum, n) => sum + n, 0);

  const locParts = await Promise.all(
    ownedRepos
      .filter((repo) => !repo.fork && !repo.archived)
      .map((repo) => getLocForRepo(repo)),
  );
  const locAdd = locParts.reduce((sum, part) => sum + part.add, 0);
  const locDel = locParts.reduce((sum, part) => sum + part.del, 0);
  const locTotal = locAdd - locDel;

  const contribData = await getContributedReposCount();
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

  const output = {
    age: ageData,
    commits: commitData,
    contributorsRepos: contribData,
    followers: followerData,
    loc: { add: locAdd, del: locDel, total: locTotal },
    repos: repoData,
    stars: starData,
    userId: user.id,
  };

  await writeFile(
    path.join(process.cwd(), "cache", `${USER_NAME.toLowerCase()}-about.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
