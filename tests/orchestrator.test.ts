import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  logReviewStart: vi.fn(),
  logReviewComplete: vi.fn(),
  logReviewError: vi.fn()
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.query
}));

vi.mock('../src/config/mcp.config', () => ({
  mcpServersConfig: {}
}));

vi.mock('../src/utils/rate-limiter', () => ({
  globalRateLimiter: {
    acquire: mocks.acquire,
    release: mocks.release
  }
}));

vi.mock('../src/utils/logger', () => ({
  logReviewStart: mocks.logReviewStart,
  logReviewComplete: mocks.logReviewComplete,
  logReviewError: mocks.logReviewError
}));

import { CodeReviewOrchestrator } from '../src/orchestrator';
import { ReviewError, ErrorCodes } from '../src/utils/error-handler';

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    pullRequest: { owner: 'octocat', repo: 'hello-world', number: 1 },
    fileReviews: [
      {
        file: 'src/app.ts',
        codeQuality: {
          file: 'src/app.ts',
          issues: [{
            line: 10,
            severity: 'critical',
            category: 'bug-risk',
            description: 'Possible null access',
            suggestion: 'Check the value before use'
          }],
          overallScore: 80,
          summary: 'One issue found'
        },
        testCoverage: {
          file: 'src/app.ts',
          hasTests: false,
          testFiles: [],
          untestedPaths: [{
            type: 'function',
            location: 'handleRequest',
            priority: 'high',
            reasoning: 'Important path is untested',
            suggestedTest: 'Test a valid request'
          }],
          coverageEstimate: 50,
          summary: 'Additional tests recommended'
        },
        refactorings: {
          file: 'src/app.ts',
          suggestions: [{
            type: 'extract-function',
            location: 'handleRequest',
            impact: 'low',
            description: 'Extract validation logic',
            before: 'Inline validation',
            after: 'A dedicated validation function',
            benefits: 'Improves readability'
          }],
          summary: 'One refactoring'
        }
      }
    ],
    summary: {
      totalFiles: 999,
      overallScore: 0,
      criticalIssues: 0,
      highPriorityTests: 0,
      refactoringOpportunities: 0
    },
    recommendations: [],
    metadata: {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      duration: 1,
      agentVersions: {}
    },
    ...overrides
  };
}

function mockSuccessfulQuery(report: unknown) {
  mocks.query.mockImplementation(async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      structured_output: report
    };
  });
}

describe('CodeReviewOrchestrator', () => {
  const originalGitHubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'test-token';
    mocks.acquire.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalGitHubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGitHubToken;
    }
  });

  describe('Configuration', () => {
    it('initializes with defaults when a model is supplied', () => {
      expect(() => new CodeReviewOrchestrator({
        model: 'test-model'
      })).not.toThrow();
    });

    it('rejects a missing model', () => {
      const originalModel = process.env.ANTHROPIC_MODEL;
      delete process.env.ANTHROPIC_MODEL;

      try {
        expect(() => new CodeReviewOrchestrator()).toThrow(
          expect.objectContaining({ code: ErrorCodes.INVALID_CONFIG })
        );
      } finally {
        if (originalModel === undefined) {
          delete process.env.ANTHROPIC_MODEL;
        } else {
          process.env.ANTHROPIC_MODEL = originalModel;
        }
      }
    });

    it('rejects invalid limits', () => {
      expect(() => new CodeReviewOrchestrator({
        model: 'test-model',
        maxTurns: 0
      })).toThrow(
        expect.objectContaining({ code: ErrorCodes.INVALID_CONFIG })
      );
    });
  });

  describe('reviewPullRequest', () => {
    it.each([
      ['', 'repo', 1],
      ['owner', '', 1],
      ['owner', 'repo', 0],
      ['owner', 'repo', 1.5]
    ])('rejects invalid input: %s/%s #%s', async (owner, repo, number) => {
      const orchestrator = new CodeReviewOrchestrator({
        model: 'test-model'
      });

      await expect(
        orchestrator.reviewPullRequest(owner, repo, number)
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCodes.INVALID_CONFIG })
      );

      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('rejects a missing GitHub token before calling the SDK', async () => {
      delete process.env.GITHUB_TOKEN;

      const orchestrator = new CodeReviewOrchestrator({
        model: 'test-model',
        maxRetries: 0
      });

      await expect(
        orchestrator.reviewPullRequest('octocat', 'hello-world', 1)
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCodes.MISSING_GITHUB_TOKEN })
      );

      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('validates the report and recalculates summary metrics', async () => {
      mockSuccessfulQuery(makeReport());

      const orchestrator = new CodeReviewOrchestrator({
        model: 'test-model',
        maxRetries: 0
      });

      const result = await orchestrator.reviewPullRequest(
        'octocat', 'hello-world', 1
      );

      expect(result.summary).toEqual({
        totalFiles: 1,
        overallScore: 80,
        criticalIssues: 1,
        highPriorityTests: 1,
        refactoringOpportunities: 1
      });

      expect(result.metadata.agentVersions.orchestrator).toBe('1.0.0');
      expect(mocks.acquire).toHaveBeenCalledWith(5000);
      expect(mocks.release).toHaveBeenCalledTimes(1);
      expect(mocks.logReviewComplete).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid structured output', async () => {
      mockSuccessfulQuery({ not: 'a review report' });

      const orchestrator = new CodeReviewOrchestrator({
        model: 'test-model',
        maxRetries: 0
      });

      await expect(
        orchestrator.reviewPullRequest('octocat', 'hello-world', 1)
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCodes.VALIDATION_FAILED })
      );

      expect(mocks.release).toHaveBeenCalledTimes(1);
    });

    it('rejects a report for a different pull request', async () => {
      mockSuccessfulQuery(makeReport({
        pullRequest: {
          owner: 'someone-else',
          repo: 'hello-world',
          number: 1
        }
      }));

      const orchestrator = new CodeReviewOrchestrator({
        model: 'test-model',
        maxRetries: 0
      });

      await expect(
        orchestrator.reviewPullRequest('octocat', 'hello-world', 1)
      ).rejects.toThrow(
        expect.objectContaining({ code: ErrorCodes.VALIDATION_FAILED })
      );
    });

    it('releases the rate limiter when the SDK fails', async () => {
      mocks.query.mockImplementation(async function* () {
        yield {
          type: 'result',
          subtype: 'error_during_execution'
        };
      });

      const orchestrator = new CodeReviewOrchestrator({
        model: 'test-model',
        maxRetries: 0
      });

      await expect(
        orchestrator.reviewPullRequest('octocat', 'hello-world', 1)
      ).rejects.toThrow(ReviewError);

      expect(mocks.release).toHaveBeenCalledTimes(1);
    });
  });
});
