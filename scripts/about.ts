import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BIRTH_YEAR = 1996;
const BIRTH_MONTH = 8;
const BIRTH_DAY = 15;

// Keep this to about 10 properties or less so the SVG layout does not hide text or overflow.
// biome-ignore assist/source/useSortedKeys: Do not sort these, they are in a deliberate order for display purposes.
const profileProperties: ProfilePropertyGroup = {
  Name: "Johannes Hoersch",
  Age: getAgeLabel(),
  Languages: "English, Spanish, Italian",
  IDE: "Zed, VSCode",
  OS: "Windows, macOS",
  Hobbies: "Gaming, Extreme Sports",
  Contact: {
    Email: "johanneshoersch@gmail.com",
    Mobile: "+1 (829) 791 7414",
  },
  Random: {
    "Favorite Character": "Kirby",
  },
};

// Keep the ascii-art.txt around 47 lines and 80 characters wide for best results.
async function writeStatsSvgs(data: CardData): Promise<void> {
  const asciiPath = path.join(process.cwd(), "assets", "ascii-art.txt");
  const asciiRaw = await readFile(asciiPath, "utf8");
  const asciiLines = asciiRaw.replace(/\r/g, "").split("\n");

  const assetsDir = path.join(process.cwd(), "assets");
  const darkSvg = createStatsSvg("dark", asciiLines, data);
  const lightSvg = createStatsSvg("light", asciiLines, data);

  await writeFile(path.join(assetsDir, "dark_mode.svg"), darkSvg, "utf8");
  await writeFile(path.join(assetsDir, "light_mode.svg"), lightSvg, "utf8");
}

type ProfilePropertyValue = string | ProfilePropertyGroup;

type ProfilePropertyGroup = {
  [key: string]: ProfilePropertyValue;
};

type ProfilePropertyRow =
  | {
      kind: "item";
      label: string;
      value: string;
    }
  | {
      kind: "section";
      label: string;
    };

const BIRTH_MONTH_INDEX = BIRTH_MONTH - 1;

function getAgeLabel(today: Date = new Date()): string {
  let age = today.getFullYear() - BIRTH_YEAR;
  const hasHadBirthdayThisYear =
    today.getMonth() > BIRTH_MONTH_INDEX ||
    (today.getMonth() === BIRTH_MONTH_INDEX && today.getDate() >= BIRTH_DAY);

  if (!hasHadBirthdayThisYear) {
    age -= 1;
  }

  const isBirthday =
    today.getMonth() === BIRTH_MONTH_INDEX && today.getDate() === BIRTH_DAY;

  return `${age}${isBirthday ? "🎂" : ""}`;
}

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

function buildDotGap(
  label: string,
  value: string,
  totalCharacters: number,
): string {
  const dots = Math.max(4, totalCharacters - label.length - value.length);
  return ".".repeat(dots);
}

function buildDashGap(
  label: string,
  startX: number,
  endX: number,
  fontSize: number,
): string {
  const totalCharacters = getMonospaceCharacterCapacity(startX, endX, fontSize);
  return "─".repeat(Math.max(4, totalCharacters - label.length));
}

function getMonospaceCharacterCapacity(
  startX: number,
  endX: number,
  fontSize: number,
): number {
  const monospaceCharWidth = fontSize * 0.6;
  return Math.floor((endX - startX) / monospaceCharWidth);
}

function buildAsciiTspans(
  asciiLines: string[],
  x: number,
  topY: number,
  bottomY: number,
): string {
  const lineHeight =
    asciiLines.length > 1 ? (bottomY - topY) / (asciiLines.length - 1) : 0;

  return asciiLines
    .map(
      (line, index) =>
        `<tspan x="${x}" y="${topY + index * lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("\n      ");
}

function buildAlignedRow({
  fontSize,
  label,
  labelColor,
  muted,
  rightColumnX,
  totalCharacters,
  value,
  valueColor,
  valueX,
  y,
}: {
  fontSize: number;
  label: string;
  labelColor: string;
  muted: string;
  rightColumnX: number;
  totalCharacters: number;
  value: string;
  valueColor: string;
  valueX: number;
  y: number;
}): string {
  const dotGap = buildDotGap(label, value, totalCharacters);

  return `<text x="${rightColumnX}" y="${y}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${fontSize}"><tspan fill="${muted}">· </tspan><tspan fill="${labelColor}">${escapeXml(label)}</tspan><tspan fill="${muted}"> ${dotGap} </tspan><tspan x="${valueX}" text-anchor="end" fill="${valueColor}">${escapeXml(value)}</tspan></text>`;
}

function buildSectionHeader({
  endX,
  fontSize,
  label,
  muted,
  text,
  x,
  y,
}: {
  endX: number;
  fontSize: number;
  label: string;
  muted: string;
  text: string;
  x: number;
  y: number;
}): string {
  const sectionLabel = `— ${label}`;
  const dashGap = buildDashGap(sectionLabel, x, endX, fontSize);

  return `<text x="${x}" y="${y}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${fontSize}"><tspan fill="${text}">${escapeXml(sectionLabel)}</tspan><tspan fill="${muted}"> ${dashGap}</tspan></text>`;
}

function buildProfilePropertyRows(
  properties: ProfilePropertyGroup,
): ProfilePropertyRow[] {
  const rows: ProfilePropertyRow[] = [];

  for (const [label, value] of Object.entries(properties)) {
    if (typeof value === "string") {
      rows.push({ kind: "item", label: `${label}:`, value });
      continue;
    }

    rows.push({ kind: "section", label });
    rows.push(...buildProfilePropertyRows(value));
  }

  return rows;
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

  const propertyRows = buildProfilePropertyRows(profileProperties);
  const asciiBlockX = 28;
  const asciiBlockTopY = 60;
  const asciiBlockBottomY = 1044;
  const dividerX = 710;
  const rightColumnX = 740;
  const propertyValueX = 1520;
  const statsDetailX = 768;
  const headerFontSize = 26;
  const rowFontSize = 26;
  const totalRowCharacters = getMonospaceCharacterCapacity(
    rightColumnX,
    propertyValueX,
    rowFontSize,
  );
  const propertyLineGap = 42;
  const propertyStartY = 102;
  const propertyEndY =
    propertyStartY + (propertyRows.length - 1) * propertyLineGap;
  const githubStatsHeaderY = Math.max(734, propertyEndY + propertyLineGap * 2);
  const githubStatsStartY = githubStatsHeaderY + propertyLineGap;
  const githubStatsLineGap = 42;
  const asciiTspans = buildAsciiTspans(
    asciiLines,
    asciiBlockX,
    asciiBlockTopY,
    asciiBlockBottomY,
  );

  const propertyText = propertyRows
    .map((row, index) => {
      const y = propertyStartY + index * propertyLineGap;

      if (row.kind === "section") {
        return buildSectionHeader({
          endX: propertyValueX,
          fontSize: rowFontSize,
          label: row.label,
          muted,
          text,
          x: rightColumnX,
          y,
        });
      }

      return buildAlignedRow({
        fontSize: rowFontSize,
        label: row.label,
        labelColor: accent,
        muted,
        rightColumnX,
        totalCharacters: totalRowCharacters,
        value: row.value,
        valueColor: value,
        valueX: propertyValueX,
        y,
      });
    })
    .join("\n  ");

  const githubStatsRows: Array<[string, string]> = [
    ["Repos:", data.repos.toLocaleString("en-US")],
    ["Contributed:", data.contribRepos.toLocaleString("en-US")],
    ["Stars:", data.stars.toLocaleString("en-US")],
    ["Commits:", data.commits.toLocaleString("en-US")],
    ["Followers:", data.followers.toLocaleString("en-US")],
    ["Lines of Code:", data.locTotal.toLocaleString("en-US")],
  ];

  const githubStatsText = githubStatsRows
    .map(([label, currentValue], index) => {
      const y = githubStatsStartY + index * githubStatsLineGap;
      if (label === "Lines of Code:") {
        const breakdownY = y + githubStatsLineGap;

        return `${buildAlignedRow({
          fontSize: rowFontSize,
          label,
          labelColor: accent,
          muted,
          rightColumnX,
          totalCharacters: totalRowCharacters,
          value: currentValue,
          valueColor: value,
          valueX: propertyValueX,
          y,
        })}
  <text x="${statsDetailX}" y="${breakdownY}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26"><tspan fill="${muted}">(</tspan><tspan fill="${green}">${escapeXml(`${data.locAdd.toLocaleString("en-US")}++`)}</tspan><tspan fill="${muted}">, </tspan><tspan fill="${red}">${escapeXml(`${data.locDel.toLocaleString("en-US")}--`)}</tspan><tspan fill="${muted}">)</tspan></text>`;
      }

      return buildAlignedRow({
        fontSize: rowFontSize,
        label,
        labelColor: accent,
        muted,
        rightColumnX,
        totalCharacters: totalRowCharacters,
        value: currentValue,
        valueColor: value,
        valueX: propertyValueX,
        y,
      });
    })
    .join("\n  ");

  const profileHeaderBar = buildDashGap(
    `${USER_NAME}@github`,
    rightColumnX,
    propertyValueX,
    headerFontSize,
  );
  const githubStatsBar = buildDashGap(
    "— GitHub Stats",
    rightColumnX,
    propertyValueX,
    headerFontSize,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1580" height="1080" viewBox="0 0 1580 1080" role="img" aria-label="GitHub profile stats card">
  <rect x="8" y="8" width="1564" height="1064" rx="12" fill="${bg}" stroke="${border}" />
  <line x1="${dividerX}" y1="22" x2="${dividerX}" y2="1058" stroke="${border}" />
  <text x="${rightColumnX}" y="60" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${headerFontSize}"><tspan fill="${text}">${escapeXml(`${USER_NAME}@github`)}</tspan><tspan fill="${muted}"> ${profileHeaderBar}</tspan></text>
  ${propertyText}
  <text x="${rightColumnX}" y="${githubStatsHeaderY}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${headerFontSize}"><tspan fill="${text}">— GitHub Stats ${githubStatsBar}</tspan></text>
  ${githubStatsText}
  <text x="28" y="96" xml:space="preserve" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" fill="${text}">
      ${asciiTspans}
  </text>
</svg>
`;
}

async function main(): Promise<void> {
  const user = await getUser();

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
