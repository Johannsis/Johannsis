import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }

  return value;
}

const GITHUB_TOKEN = getRequiredEnvVar("GITHUB_TOKEN");
const USER_NAME = getRequiredEnvVar("USER_NAME");

const HEADERS = {
  authorization: `token ${GITHUB_TOKEN}`,
  "content-type": "application/json",
};

type QueryCountKey =
  | "user_getter"
  | "follower_getter"
  | "graph_repos_stars"
  | "recursive_loc"
  | "graph_commits"
  | "loc_query";

const QUERY_COUNT: Record<QueryCountKey, number> = {
  follower_getter: 0,
  graph_commits: 0,
  graph_repos_stars: 0,
  loc_query: 0,
  recursive_loc: 0,
  user_getter: 0,
};

let OWNER_ID = "";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function formatPlural(unit: number): string {
  return unit !== 1 ? "s" : "";
}

function dailyReadme(birthday: Date): string {
  const today = new Date();
  let years = today.getFullYear() - birthday.getFullYear();
  let months = today.getMonth() - birthday.getMonth();
  let days = today.getDate() - birthday.getDate();

  if (days < 0) {
    months -= 1;
    const previousMonth = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
    days += previousMonth;
  }

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  return `${years} year${formatPlural(years)}, ${months} month${formatPlural(months)}, ${days} day${formatPlural(days)}${months === 0 && days === 0 ? " 🎂" : ""}`;
}

async function postGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<{ status: number; text: string; json?: T }> {
  const response = await fetch("https://api.github.com/graphql", {
    body: JSON.stringify({ query, variables }),
    headers: HEADERS,
    method: "POST",
  });

  const text = await response.text();
  let json: T | undefined;
  try {
    json = JSON.parse(text) as T;
  } catch {
    json = undefined;
  }

  return { json, status: response.status, text };
}

async function simpleRequest<T>(
  funcName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const request = await postGraphQL<T>(query, variables);
  if (request.status === 200 && request.json !== undefined) {
    return request.json;
  }

  throw new Error(
    `${funcName} has failed with a ${request.status}: ${request.text} ${JSON.stringify(QUERY_COUNT)}`,
  );
}

function queryCount(functId: QueryCountKey): void {
  QUERY_COUNT[functId] += 1;
}

async function _graphCommits(startDate: string, endDate: string): Promise<number> {
  queryCount("graph_commits");
  const query = `
    query($start_date: DateTime!, $end_date: DateTime!, $login: String!) {
        user(login: $login) {
            contributionsCollection(from: $start_date, to: $end_date) {
                contributionCalendar {
                    totalContributions
                }
            }
        }
    }`;

  const variables = {
    end_date: endDate,
    login: USER_NAME,
    start_date: startDate,
  };
  const data = await simpleRequest<{
    data: {
      user: {
        contributionsCollection: {
          contributionCalendar: { totalContributions: number };
        };
      };
    };
  }>("graphCommits", query, variables);

  return Number(data.data.user.contributionsCollection.contributionCalendar.totalContributions);
}

type RepoEdge = {
  node: {
    nameWithOwner: string;
    stargazers: { totalCount: number };
    defaultBranchRef?: {
      target: {
        history: {
          totalCount: number;
        };
      };
    } | null;
  };
};

async function graphReposStars(
  countType: "repos" | "stars",
  ownerAffiliation: string[],
  cursor: string | null = null,
): Promise<number> {
  queryCount("graph_repos_stars");
  const query = `
    query ($owner_affiliation: [RepositoryAffiliation], $login: String!, $cursor: String) {
        user(login: $login) {
            repositories(first: 100, after: $cursor, ownerAffiliations: $owner_affiliation) {
                totalCount
                edges {
                    node {
                        ... on Repository {
                            nameWithOwner
                            stargazers {
                                totalCount
                            }
                        }
                    }
                }
                pageInfo {
                    endCursor
                    hasNextPage
                }
            }
        }
    }`;

  const variables = {
    cursor,
    login: USER_NAME,
    owner_affiliation: ownerAffiliation,
  };
  const data = await simpleRequest<{
    data: {
      user: {
        repositories: {
          totalCount: number;
          edges: RepoEdge[];
        };
      };
    };
  }>("graphReposStars", query, variables);

  if (countType === "repos") {
    return data.data.user.repositories.totalCount;
  }

  return starsCounter(data.data.user.repositories.edges);
}

type CommitHistoryEdge = {
  node: {
    author?: { user?: { id: string } | null } | null;
    deletions: number;
    additions: number;
  };
};

type CommitHistory = {
  totalCount: number;
  edges: CommitHistoryEdge[];
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
};

async function recursiveLoc(
  owner: string,
  repoName: string,
  data: string[],
  cacheComment: string[],
  additionTotal = 0,
  deletionTotal = 0,
  myCommits = 0,
  cursor: string | null = null,
): Promise<[number, number, number]> {
  queryCount("recursive_loc");
  const query = `
    query ($repo_name: String!, $owner: String!, $cursor: String) {
        repository(name: $repo_name, owner: $owner) {
            defaultBranchRef {
                target {
                    ... on Commit {
                        history(first: 100, after: $cursor) {
                            totalCount
                            edges {
                                node {
                                    ... on Commit {
                                        committedDate
                                    }
                                    author {
                                        user {
                                            id
                                        }
                                    }
                                    deletions
                                    additions
                                }
                            }
                            pageInfo {
                                endCursor
                                hasNextPage
                            }
                        }
                    }
                }
            }
        }
    }`;

  const variables = { cursor, owner, repo_name: repoName };
  const request = await postGraphQL<{
    data?: {
      repository?: {
        defaultBranchRef?: {
          target: {
            history: CommitHistory;
          };
        } | null;
      } | null;
    };
  }>(query, variables);

  if (request.status === 200 && request.json?.data?.repository) {
    const defaultBranchRef = request.json.data.repository.defaultBranchRef;
    if (defaultBranchRef !== null && defaultBranchRef !== undefined) {
      return locCounterOneRepo(
        owner,
        repoName,
        data,
        cacheComment,
        defaultBranchRef.target.history,
        additionTotal,
        deletionTotal,
        myCommits,
      );
    }

    return [0, 0, 0];
  }

  await forceCloseFile(data, cacheComment);

  if (request.status === 403) {
    throw new Error(
      "Too many requests in a short amount of time!\nYou've hit the non-documented anti-abuse limit!",
    );
  }

  throw new Error(
    `recursiveLoc() has failed with a ${request.status}: ${request.text} ${JSON.stringify(QUERY_COUNT)}`,
  );
}

async function locCounterOneRepo(
  owner: string,
  repoName: string,
  data: string[],
  cacheComment: string[],
  history: CommitHistory,
  additionTotal: number,
  deletionTotal: number,
  myCommits: number,
): Promise<[number, number, number]> {
  for (const node of history.edges) {
    if (node.node.author?.user?.id === OWNER_ID) {
      myCommits += 1;
      additionTotal += node.node.additions;
      deletionTotal += node.node.deletions;
    }
  }

  if (history.edges.length === 0 || !history.pageInfo.hasNextPage) {
    return [additionTotal, deletionTotal, myCommits];
  }

  return recursiveLoc(
    owner,
    repoName,
    data,
    cacheComment,
    additionTotal,
    deletionTotal,
    myCommits,
    history.pageInfo.endCursor,
  );
}

async function locQuery(
  ownerAffiliation: string[],
  commentSize = 0,
  forceCache = false,
  cursor: string | null = null,
  edges: RepoEdge[] = [],
): Promise<[number, number, number, boolean]> {
  queryCount("loc_query");
  const query = `
    query ($owner_affiliation: [RepositoryAffiliation], $login: String!, $cursor: String) {
        user(login: $login) {
            repositories(first: 60, after: $cursor, ownerAffiliations: $owner_affiliation) {
            edges {
                node {
                    ... on Repository {
                        nameWithOwner
                        defaultBranchRef {
                            target {
                                ... on Commit {
                                    history {
                                        totalCount
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                pageInfo {
                    endCursor
                    hasNextPage
                }
            }
        }
    }`;

  const variables = {
    cursor,
    login: USER_NAME,
    owner_affiliation: ownerAffiliation,
  };
  const data = await simpleRequest<{
    data: {
      user: {
        repositories: {
          edges: RepoEdge[];
          pageInfo: {
            endCursor: string | null;
            hasNextPage: boolean;
          };
        };
      };
    };
  }>("locQuery", query, variables);

  const repositories = data.data.user.repositories;
  const nextEdges = [...edges, ...repositories.edges];

  if (repositories.pageInfo.hasNextPage) {
    return locQuery(
      ownerAffiliation,
      commentSize,
      forceCache,
      repositories.pageInfo.endCursor,
      nextEdges,
    );
  }

  return cacheBuilder(nextEdges, commentSize, forceCache);
}

function normalizeLines(fileContents: string): string[] {
  if (fileContents.length === 0) {
    return [];
  }

  return fileContents
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line, index, arr) => !(index === arr.length - 1 && line === ""));
}

async function readLines(fileName: string): Promise<string[]> {
  const raw = await fs.readFile(fileName, "utf8");
  return normalizeLines(raw);
}

async function writeLines(fileName: string, lines: string[]): Promise<void> {
  const payload = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  await fs.writeFile(fileName, payload, "utf8");
}

async function cacheBuilder(
  edges: RepoEdge[],
  commentSize: number,
  forceCache: boolean,
  locAdd = 0,
  locDel = 0,
): Promise<[number, number, number, boolean]> {
  let cached = true;
  await fs.mkdir("cache", { recursive: true });
  const fileName = `cache/${sha256(USER_NAME)}.txt`;

  let data: string[];
  try {
    data = await readLines(fileName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    data = [];
    if (commentSize > 0) {
      for (let index = 0; index < commentSize; index += 1) {
        data.push("This line is a comment block. Write whatever you want here.");
      }
    }
    await writeLines(fileName, data);
  }

  if (data.length - commentSize !== edges.length || forceCache) {
    cached = false;
    await flushCache(edges, fileName, commentSize);
    data = await readLines(fileName);
  }

  const cacheComment = data.slice(0, commentSize);
  const body = data.slice(commentSize);

  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    const storedLine = body[index] ?? "";
    const [repoHash, commitCountRaw] = storedLine.trim().split(/\s+/);
    const expectedHash = sha256(edge.node.nameWithOwner);

    if (repoHash !== expectedHash) {
      continue;
    }

    const totalCount = edge.node.defaultBranchRef?.target.history.totalCount;
    if (typeof totalCount !== "number") {
      body[index] = `${repoHash} 0 0 0 0`;
      continue;
    }

    if (Number.parseInt(commitCountRaw, 10) !== totalCount) {
      const [owner, repoName] = edge.node.nameWithOwner.split("/");
      const [additions, deletions, myCommits] = await recursiveLoc(
        owner,
        repoName,
        body,
        cacheComment,
      );
      body[index] = `${repoHash} ${totalCount} ${myCommits} ${additions} ${deletions}`;
    }
  }

  await writeLines(fileName, [...cacheComment, ...body]);

  for (const line of body) {
    const loc = line.trim().split(/\s+/);
    if (loc.length >= 5) {
      locAdd += Number.parseInt(loc[3], 10);
      locDel += Number.parseInt(loc[4], 10);
    }
  }

  return [locAdd, locDel, locAdd - locDel, cached];
}

async function flushCache(edges: RepoEdge[], fileName: string, commentSize: number): Promise<void> {
  let data: string[] = [];

  if (commentSize > 0) {
    try {
      data = (await readLines(fileName)).slice(0, commentSize);
    } catch {
      data = [];
    }
  }

  for (const node of edges) {
    data.push(`${sha256(node.node.nameWithOwner)} 0 0 0 0`);
  }

  await writeLines(fileName, data);
}

async function addArchive(): Promise<[number, number, number, number, number]> {
  const oldData = await readLines("cache/repository_archive.txt");
  const data = oldData.slice(7, oldData.length - 3);

  let addedLoc = 0;
  let deletedLoc = 0;
  let addedCommits = 0;
  const contributedRepos = data.length;

  for (const line of data) {
    const [, , myCommits, ...loc] = line.trim().split(/\s+/);
    addedLoc += Number.parseInt(loc[0], 10);
    deletedLoc += Number.parseInt(loc[1], 10);
    if (/^\d+$/.test(myCommits)) {
      addedCommits += Number.parseInt(myCommits, 10);
    }
  }

  const lastToken = oldData[oldData.length - 1]?.trim().split(/\s+/)[4] ?? "0";
  addedCommits += Number.parseInt(lastToken.slice(0, -1), 10);

  return [addedLoc, deletedLoc, addedLoc - deletedLoc, addedCommits, contributedRepos];
}

async function forceCloseFile(data: string[], cacheComment: string[]): Promise<void> {
  const fileName = `cache/${sha256(USER_NAME)}.txt`;
  await writeLines(fileName, [...cacheComment, ...data]);
  console.log(
    "There was an error while writing to the cache file. The file,",
    fileName,
    "has had the partial data saved and closed.",
  );
}

function starsCounter(data: RepoEdge[]): number {
  let totalStars = 0;
  for (const node of data) {
    totalStars += node.node.stargazers.totalCount;
  }
  return totalStars;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAndReplace(svg: string, elementId: string, newText: string): string {
  const pattern = new RegExp(
    `(<[^>]*\\bid=["']${escapeRegExp(elementId)}["'][^>]*>)([\\s\\S]*?)(</[^>]+>)`,
  );

  return svg.replace(
    pattern,
    (_full, startTag, _oldText, endTag) => `${startTag}${newText}${endTag}`,
  );
}

function justifyFormat(
  svg: string,
  elementId: string,
  newText: string | number,
  length = 0,
): string {
  const normalizedText =
    typeof newText === "number" ? newText.toLocaleString("en-US") : String(newText);
  let result = findAndReplace(svg, elementId, normalizedText);

  const justLen = Math.max(0, length - normalizedText.length);
  let dotString: string;

  if (justLen <= 2) {
    const dotMap: Record<number, string> = { 0: "", 1: " ", 2: ". " };
    dotString = dotMap[justLen];
  } else {
    dotString = ` ${".".repeat(justLen)} `;
  }

  result = findAndReplace(result, `${elementId}_dots`, dotString);
  return result;
}

async function svgOverwrite(
  fileName: string,
  _ageData: string,
  commitData: number,
  starData: number,
  repoData: number,
  contribData: number,
  followerData: number,
  locData: [string, string, string],
): Promise<void> {
  let svg = await fs.readFile(fileName, "utf8");

  svg = justifyFormat(svg, "commit_data", commitData, 22);
  svg = justifyFormat(svg, "star_data", starData, 14);
  svg = justifyFormat(svg, "repo_data", repoData, 6);
  svg = justifyFormat(svg, "contrib_data", contribData);
  svg = justifyFormat(svg, "follower_data", followerData, 10);
  svg = justifyFormat(svg, "loc_data", locData[2], 9);
  svg = justifyFormat(svg, "loc_add", locData[0]);
  svg = justifyFormat(svg, "loc_del", locData[1], 7);

  await fs.writeFile(fileName, svg, "utf8");
}

async function commitCounter(commentSize: number): Promise<number> {
  let totalCommits = 0;
  const fileName = `cache/${sha256(USER_NAME)}.txt`;
  const data = await readLines(fileName);
  const body = data.slice(commentSize);

  for (const line of body) {
    totalCommits += Number.parseInt(line.trim().split(/\s+/)[2], 10);
  }

  return totalCommits;
}

async function userGetter(username: string): Promise<[string, string]> {
  queryCount("user_getter");
  const query = `
    query($login: String!){
        user(login: $login) {
            id
            createdAt
        }
    }`;

  const variables = { login: username };
  const data = await simpleRequest<{
    data: {
      user: {
        id: string;
        createdAt: string;
      };
    };
  }>("userGetter", query, variables);

  return [data.data.user.id, data.data.user.createdAt];
}

async function followerGetter(username: string): Promise<number> {
  queryCount("follower_getter");
  const query = `
    query($login: String!){
        user(login: $login) {
            followers {
                totalCount
            }
        }
    }`;

  const data = await simpleRequest<{
    data: {
      user: {
        followers: {
          totalCount: number;
        };
      };
    };
  }>("followerGetter", query, { login: username });

  return Number(data.data.user.followers.totalCount);
}

async function perfCounter<TArgs extends unknown[], T>(
  funct: (...args: TArgs) => Promise<T> | T,
  ...args: TArgs
): Promise<[T, number]> {
  const start = performance.now();
  const functReturn = await funct(...args);
  const duration = (performance.now() - start) / 1000;
  return [functReturn, duration];
}

function formatter(
  queryType: string,
  difference: number,
  functReturn: number | string | boolean = false,
  whitespace = 0,
): number | string | boolean {
  const left = `   ${queryType}:`.padEnd(23, " ");
  const right =
    difference > 1
      ? `${difference.toFixed(4)} s `.padStart(12, " ")
      : `${(difference * 1000).toFixed(4)} ms`.padStart(12, " ");

  console.log(`${left}${right}`);

  if (whitespace > 0 && typeof functReturn === "number") {
    return functReturn.toLocaleString("en-US").padEnd(whitespace, " ");
  }

  return functReturn;
}

async function main(): Promise<void> {
  console.log("Calculation times:");

  const [userData, userTime] = await perfCounter(userGetter, USER_NAME);
  OWNER_ID = userData[0];
  formatter("account data", userTime);

  const [ageData, ageTime] = await perfCounter(dailyReadme, new Date(2002, 6, 5));
  formatter("age calculation", ageTime);

  const [locResult, locTime] = await perfCounter(
    locQuery,
    ["OWNER", "COLLABORATOR", "ORGANIZATION_MEMBER"],
    7,
  );
  formatter(locResult[3] ? "LOC (cached)" : "LOC (no cache)", locTime);

  let [locAdd, locDel, locTotal] = locResult;

  let [commitData, commitTime] = await perfCounter(commitCounter, 7);
  const [starData, starTime] = await perfCounter(graphReposStars, "stars", ["OWNER"]);
  const [repoData, repoTime] = await perfCounter(graphReposStars, "repos", ["OWNER"]);
  let [contribData, contribTime] = await perfCounter(graphReposStars, "repos", [
    "OWNER",
    "COLLABORATOR",
    "ORGANIZATION_MEMBER",
  ]);
  const [followerData] = await perfCounter(followerGetter, USER_NAME);

  if (OWNER_ID === "MDQ6VXNlcjU3MzMxMTM0") {
    const archivedData = await addArchive();
    locAdd += archivedData[0];
    locDel += archivedData[1];
    locTotal += archivedData[2];
    contribData += archivedData[4];
    commitData += archivedData[3];
  }

  const locData: [string, string, string] = [
    locAdd.toLocaleString("en-US"),
    locDel.toLocaleString("en-US"),
    locTotal.toLocaleString("en-US"),
  ];

  await svgOverwrite(
    "dark_mode.svg",
    String(ageData),
    Number(commitData),
    Number(starData),
    Number(repoData),
    Number(contribData),
    Number(followerData),
    locData,
  );

  await svgOverwrite(
    "light_mode.svg",
    String(ageData),
    Number(commitData),
    Number(starData),
    Number(repoData),
    Number(contribData),
    Number(followerData),
    locData,
  );

  console.log(
    "\u001b[F\u001b[F\u001b[F\u001b[F\u001b[F\u001b[F\u001b[F\u001b[F",
    "Total function time:".padEnd(21, " "),
    (userTime + ageTime + locTime + commitTime + starTime + repoTime + contribTime)
      .toFixed(4)
      .padStart(11, " "),
    " s \u001b[E\u001b[E\u001b[E\u001b[E\u001b[E\u001b[E\u001b[E\u001b[E",
    sep(),
  );

  console.log(
    "Total GitHub GraphQL API calls:",
    String(Object.values(QUERY_COUNT).reduce((sum, value) => sum + value, 0)).padStart(3, " "),
  );
  for (const [functName, count] of Object.entries(QUERY_COUNT)) {
    console.log(`   ${functName}:`.padEnd(28, " "), String(count).padStart(6, " "));
  }
}

function sep(): string {
  return "";
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
