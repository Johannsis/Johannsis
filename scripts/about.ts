import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function getRequiredEnv(name: "GH_TOKEN" | "USER_NAME"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
}

const GH_TOKEN = getRequiredEnv("GH_TOKEN");
const USER_NAME = getRequiredEnv("USER_NAME");

const API_BASE = "https://api.github.com";
const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${GH_TOKEN}`,
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
    throw new Error(`GitHub REST request failed (${res.status}) for ${url}: ${await res.text()}`);
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
      throw new Error(`GitHub REST request failed (${res.status}) for ${url}: ${await res.text()}`);
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

  const lastMatch = (res.headers.get("link") ?? "").match(/<([^>]+)>;\s*rel="last"/);
  if (!lastMatch) {
    return firstPage.length;
  }

  const lastUrl = new URL(lastMatch[1]);
  const pageParam = Number.parseInt(lastUrl.searchParams.get("page") ?? "1", 10);
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

async function getLocForRepo(repo: Repo): Promise<{ add: number; del: number }> {
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
      throw new Error(`Failed contributor stats (${res.status}) for ${repo.full_name}: ${await res.text()}`);
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

function createStatsSvg(theme: "dark" | "light", asciiLines: string[], data: CardData): string {
  const isDark = theme === "dark";
  const bg = isDark ? "#0d1117" : "#ffffff";
  const border = isDark ? "#30363d" : "#d0d7de";
  const title = isDark ? "#79c0ff" : "#0969da";
  const text = isDark ? "#c9d1d9" : "#1f2328";
  const muted = isDark ? "#8b949e" : "#57606a";

  const lineHeight = 16;
  const asciiWidth = 600;
  const cardPadding = 24;
  const tableX = asciiWidth + cardPadding * 2;
  const tableY = 64;
  const rows = buildStatRows(data);
  const tableLineHeight = 34;
  const maxLabelLen = Math.max(...rows.map(([label]) => label.length));

  const asciiTspans = asciiLines
    .map(
      (line, index) =>
        `<tspan x="${cardPadding}" y="${tableY + index * lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("\n      ");

  const rowText = rows
    .map(([label, value], index) => {
      const dotCount = Math.max(2, maxLabelLen - label.length + 4);
      const dots = ".".repeat(dotCount);
      const y = tableY + 24 + index * tableLineHeight;
      return `
      <text x="${tableX}" y="${y}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="19" fill="${muted}">${escapeXml(label)} ${dots}</text>
      <text x="1230" y="${y}" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="19" fill="${text}">${escapeXml(value)}</text>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1250" height="820" viewBox="0 0 1250 820" role="img" aria-label="GitHub profile stats card">
  <rect x="10" y="10" width="1230" height="800" rx="16" fill="${bg}" stroke="${border}" />
  <line x1="640" y1="36" x2="640" y2="784" stroke="${border}" />
  <text x="24" y="40" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="700" fill="${title}">ASCII Portrait</text>
  <text x="${tableX}" y="40" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="700" fill="${title}">GitHub Metrics</text>
  <text x="24" y="64" xml:space="preserve" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="${text}">
      ${asciiTspans}
  </text>
  ${rowText}
</svg>
`;
}

async function writeStatsSvgs(data: CardData): Promise<void> {
  const asciiPath = path.join(process.cwd(), "assets", "asci_image.txt");
  const asciiRaw = await readFile(asciiPath, "utf8");
  const asciiLines = asciiRaw.replace(/\r/g, "").split("\n");

  const scriptsDir = path.join(process.cwd(), "scripts");
  const darkSvg = createStatsSvg("dark", asciiLines, data);
  const lightSvg = createStatsSvg("light", asciiLines, data);

  await writeFile(path.join(scriptsDir, "dark_mode.svg"), darkSvg, "utf8");
  await writeFile(path.join(scriptsDir, "light_mode.svg"), lightSvg, "utf8");
}

async function main(): Promise<void> {
  await mkdir(path.join(process.cwd(), "cache"), { recursive: true });

  const user = await getUser();
  const ageData = dailyReadme(new Date(2002, 6, 5));

  const ownedRepos = await getOwnedRepos();
  const repoData = ownedRepos.length;
  const starData = ownedRepos.reduce((sum, repo) => sum + repo.stargazers_count, 0);

  const commitCounts = await Promise.all(ownedRepos.map((repo) => getCommitCountForRepo(repo)));
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
