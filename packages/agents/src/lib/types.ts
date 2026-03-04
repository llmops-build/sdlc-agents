/** Parameters passed to the SDLC agent workflow */
export interface SdlcWorkflowParams {
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

/** Event sent when a human approves/rejects the PR */
export interface ApprovalEvent {
	action: 'approved' | 'rejected';
	prNumber: number;
	merged: boolean;
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
