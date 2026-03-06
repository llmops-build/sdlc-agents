/** Parameters passed to the SDLC agent workflow */
export interface SdlcWorkflowParams {
	instanceId: string;
	issueNumber: number;
	repoOwner: string;
	repoName: string;
	issueTitle: string;
	issueBody: string;
	installationId: number;
	labelTrigger: string;
}

/** Output from the planning step */
export interface PlanResult {
	plan: string;
	branchName: string;
	estimatedFiles: string[];
}

/** Output from the coding step */
export interface CodingResult {
	branchName: string;
	prNumber: number;
	prUrl: string;
	filesChanged: string[];
	commitSha: string;
}

/** Parameters passed to the revision workflow */
export interface RevisionWorkflowParams {
	instanceId: string;
	sessionId: string;
	issueNumber: number;
	prNumber: number;
	repoOwner: string;
	repoName: string;
	branchName: string;
	installationId: number;
	reviewBody: string;
	reviewComments: ReviewComment[];
	reviewId: number;
}

/** A single inline review comment */
export interface ReviewComment {
	path: string;
	line: number | null;
	body: string;
	diffHunk: string;
}

/** GitHub webhook payload for pull_request_review.submitted */
export interface PullRequestReviewPayload {
	action: 'submitted';
	review: {
		id: number;
		body: string | null;
		state: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
		user: { login: string };
	};
	pull_request: { number: number; head: { ref: string } };
	repository: { name: string; full_name: string; owner: { login: string } };
	installation?: { id: number };
}

/** GitHub webhook payload for issues.labeled */
export interface IssuesLabeledPayload {
	action: 'labeled';
	label: {
		name: string;
	};
	issue: {
		number: number;
		title: string;
		body: string | null;
		user: {
			login: string;
		};
	};
	repository: {
		name: string;
		full_name: string;
		owner: {
			login: string;
		};
		default_branch: string;
	};
	sender?: {
		login: string;
	};
	installation?: {
		id: number;
	};
}

/** GitHub webhook payload for pull_request.closed */
export interface PullRequestClosedPayload {
	action: 'closed';
	pull_request: {
		number: number;
		merged: boolean;
		head: {
			ref: string;
		};
	};
	repository: {
		name: string;
		full_name: string;
		owner: {
			login: string;
		};
	};
	installation?: {
		id: number;
	};
}
