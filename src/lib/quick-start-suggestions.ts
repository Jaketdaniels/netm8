const QUICK_START_SUGGESTIONS = [
	"A task management API with user auth",
	"A real-time chat app with rooms",
	"A CLI tool for managing dotfiles",
	"An AI meeting notes app with action-item extraction",
	"A Kanban board with drag-and-drop and team roles",
	"A passwordless login starter with magic links",
	"A personal finance dashboard with budget alerts",
	"A lightweight CRM for freelancers",
	"A habit tracker with streak heatmaps",
	"A markdown knowledge base with full-text search",
	"A product roadmap portal with voting",
	"A support ticket system with SLA timers",
	"A bug triage dashboard synced to GitHub issues",
	"A release notes generator from commit history",
	"An internal wiki with versioned pages",
	"A project time tracker with invoice export",
	"A file upload API with signed URLs",
	"A URL shortener with analytics and QR codes",
	"A social link-in-bio builder",
	"An event RSVP app with waitlist automation",
	"A newsletter composer with audience segments",
	"A feature flag service with rollout controls",
	"A changelog site with RSS and email updates",
	"A deployment checklist app for engineering teams",
	"A standup bot with async daily updates",
	"A team availability planner with timezone overlap",
	"A recruiting pipeline tracker with scorecards",
	"An applicant interview scheduler",
	"A customer onboarding checklist portal",
	"A contract approval workflow with audit logs",
	"A document signing tracker with reminders",
	"A lightweight OKR tracking system",
	"A sales call prep dashboard from CRM notes",
	"A proposal generator with reusable templates",
	"A subscription billing sandbox dashboard",
	"A refund request portal with review queue",
	"A procurement request system for operations teams",
	"A shift scheduling app for retail staff",
	"A warehouse inventory scanner dashboard",
	"A restaurant reservation manager with SMS reminders",
	"A no-show prediction tool for appointments",
	"A telehealth booking portal with intake forms",
	"A patient medication reminder app",
	"A clinic waitlist optimizer",
	"A school assignment planner for students",
	"A classroom attendance tracker with QR check-in",
	"A parent-teacher conference scheduler",
	"A course platform with quizzes and progress tracking",
	"A coding challenge platform with leaderboards",
	"An API playground with saved requests and mock responses",
	"A webhook inspector with replay support",
	"A JSON schema builder and validator",
	"A CI status dashboard across multiple repositories",
	"A developer onboarding portal with checklists",
	"A cloud cost monitor with anomaly alerts",
	"A log search tool with saved filters",
	"A synthetic uptime monitor with incident timeline",
	"A postmortem template app with timeline builder",
	"A security questionnaire automation portal",
	"A vendor risk register with renewal reminders",
	"A policy acknowledgement tracker for employees",
	"A remote team coffee-chat matcher",
	"A mentorship matching platform",
	"An employee recognition wall with kudos points",
	"A lightweight LMS for internal training",
	"A survey builder with NPS reporting",
	"A user feedback board with duplicate detection",
	"A mobile app release readiness checklist",
	"A startup KPI dashboard for founders",
	"An investor update generator from metrics",
	"A SaaS trial conversion funnel dashboard",
	"A pricing experiment tracker",
	"A customer churn early-warning dashboard",
	"A cohort retention explorer",
	"A referral program manager with rewards ledger",
	"A marketplace listing manager",
	"A quote-to-cash workflow starter",
	"A procurement bidding portal",
	"A legal case tracker with court date reminders",
	"A nonprofit donor CRM with campaign tracking",
	"A volunteer shift coordination app",
	"A grant application pipeline manager",
	"A community forum with moderation queues",
	"An online petition platform with verification",
	"A local government service request portal",
	"A field inspection app with offline sync",
	"A construction punch-list tracker",
	"A real estate listing dashboard with lead routing",
	"A property maintenance request workflow",
	"A tenant portal with rent reminders",
	"A travel itinerary planner with collaborative editing",
	"A trip expense splitter with settlement tracking",
	"A content calendar with approval workflows",
	"A podcast production tracker",
	"A video review tool with timestamp comments",
	"A design handoff portal with spec checklists",
	"A QA test case manager with run history",
	"A launch countdown control room dashboard",
	"A disaster recovery drill tracker",
	"A personal AI second-brain workspace",
] as const;

const LAST_SELECTION_STORAGE_KEY = "netm8.quick-start.last-selection";
let currentSelection: string[] | null = null;

function sampleSuggestions(count: number): string[] {
	const pool = [...QUICK_START_SUGGESTIONS];
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, count);
}

function haveSameSelection(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sortedA = [...a].sort();
	const sortedB = [...b].sort();
	return sortedA.every((value, index) => value === sortedB[index]);
}

function readPreviousSelection(): string[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(LAST_SELECTION_STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function writePreviousSelection(selection: string[]) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(LAST_SELECTION_STORAGE_KEY, JSON.stringify(selection));
	} catch {
		// Ignore storage failures.
	}
}

export function getRotatingQuickStartSuggestions(count = 3): string[] {
	const safeCount = Math.max(1, Math.min(count, QUICK_START_SUGGESTIONS.length));
	if (currentSelection && currentSelection.length === safeCount) {
		return currentSelection;
	}
	const previous = readPreviousSelection();

	let next = sampleSuggestions(safeCount);
	for (let attempt = 0; attempt < 5; attempt++) {
		if (!haveSameSelection(next, previous)) break;
		next = sampleSuggestions(safeCount);
	}

	currentSelection = next;
	writePreviousSelection(next);
	return next;
}

export const QUICK_START_SUGGESTION_COUNT = QUICK_START_SUGGESTIONS.length;
