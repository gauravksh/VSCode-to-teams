import { exec } from "child_process";
import { promisify } from "util";

const pexec = promisify(exec);

export interface CommitLine {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/**
 * Returns commit subjects in `cwd` since `sinceIso` (an ISO timestamp).
 */
export async function getCommitsSince(
  cwd: string,
  sinceIso: string,
): Promise<CommitLine[]> {
  // Use a unit-separator unlikely to appear in commit text.
  const SEP = "\x1f";
  const fmt = `%H${SEP}%an${SEP}%aI${SEP}%s`;
  try {
    const { stdout } = await pexec(
      `git log --no-merges --since="${sinceIso}" --pretty=format:"${fmt}"`,
      { cwd, maxBuffer: 10 * 1024 * 1024 },
    );
    if (!stdout.trim()) {
      return [];
    }
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [hash, author, date, ...rest] = line.split(SEP);
        return {
          hash: (hash || "").slice(0, 7),
          author: author || "",
          date: date || "",
          subject: (rest.join(SEP) || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((c) => c.subject);
  } catch (err: any) {
    // Not a git repo, or git not installed. Return empty.
    return [];
  }
}
