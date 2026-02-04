import { spawn } from 'child_process';
import { ReviewResult, ReviewResultSchema } from '../types/review.js';

export type CliRunnerOptions = {
  repoPath: string;
  prNumber: number;
  baseBranch: string;
  headBranch: string;
  timeout?: number;
};

export type CliRunnerResult = {
  success: boolean;
  result?: ReviewResult;
  error?: string;
  rawOutput?: string;
};

const DEFAULT_TIMEOUT = 25 * 60 * 1000; // 25 minutes

export async function runClaudeReview(options: CliRunnerOptions): Promise<CliRunnerResult> {
  const { repoPath, prNumber, baseBranch, headBranch, timeout = DEFAULT_TIMEOUT } = options;

  const prompt = buildReviewPrompt(prNumber, baseBranch, headBranch);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn(
      'claude',
      [
        '--print',
        '--dangerously-skip-permissions',
        '--model',
        'claude-sonnet-4-20250514',
        prompt,
      ],
      {
        cwd: repoPath,
        env: {
          ...process.env,
          ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    const timeoutHandle = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      resolve({
        success: false,
        error: `Review timed out after ${timeout / 1000} seconds`,
        rawOutput: stdout,
      });
    }, timeout);

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);

      if (killed) {
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          error: `Claude CLI exited with code ${code}: ${stderr}`,
          rawOutput: stdout,
        });
        return;
      }

      const parseResult = parseReviewOutput(stdout);
      resolve(parseResult);
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      resolve({
        success: false,
        error: `Failed to spawn Claude CLI: ${err.message}`,
      });
    });
  });
}

function buildReviewPrompt(prNumber: number, baseBranch: string, headBranch: string): string {
  return `Use the pr-review-wrapper skill to review the changes in this PR.

Context:
- PR number: #${prNumber}
- Base branch: ${baseBranch}
- Head branch: ${headBranch}

First, run "git diff ${baseBranch}...${headBranch}" to see the changes.
Then analyze the changes and output the structured JSON review result.

Remember:
- Output ONLY valid JSON matching the schema in the skill
- Filter out nitpicks
- Include hash for each finding
- Be thorough but focused on real issues`;
}

function parseReviewOutput(output: string): CliRunnerResult {
  const jsonMatch = output.match(/\{[\s\S]*"status"[\s\S]*"findings"[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      success: false,
      error: 'Could not find JSON in Claude output',
      rawOutput: output,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    const validated = ReviewResultSchema.parse(parsed);

    return {
      success: true,
      result: validated,
      rawOutput: output,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown parse error';
    return {
      success: false,
      error: `Failed to parse review JSON: ${errorMessage}`,
      rawOutput: output,
    };
  }
}

export async function checkClaudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}
