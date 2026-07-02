import { MemoryRecord } from '../memory/memoryTypes';

export interface PlumbingFixture {
    id: string;
    question: string;
    expectedMemoryKeywords: string[];
    expectedAnswerDifference: string;
}

export const memoryPlumbingFixtures: PlumbingFixture[] = [
    {
        id: "F1",
        question: "Why do we use LanceDB?",
        expectedMemoryKeywords: ["LanceDB", "vector search", "local", "daemon"],
        expectedAnswerDifference: "Answer changes after memory injection to mention vector search and local embedded database instead of generic PostgreSQL references."
    },
    {
        id: "F2",
        question: "Why is RepoGuide local-first?",
        expectedMemoryKeywords: ["privacy", "offline", "zero latency"],
        expectedAnswerDifference: "Answer must reference repository privacy and offline capability directly from memory."
    },
    {
        id: "F3",
        question: "How do I add a mentor?",
        expectedMemoryKeywords: ["BaseMentor", "MentorRegistry"],
        expectedAnswerDifference: "Developer guidance memory influences answer to explicitly mention the MentorRegistry."
    },
    {
        id: "F4",
        question: "How are conflicting memories resolved?",
        expectedMemoryKeywords: ["timestamp", "supersedes"],
        expectedAnswerDifference: "Memory retrieval influences explanation to correctly state the timestamp and supersedes logic."
    }
];
