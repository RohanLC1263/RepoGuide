# RepoGuide Vision Constitution

> This document defines the permanent vision, purpose, and guiding principles of RepoGuide.
>
> It is not a roadmap, implementation plan, or architecture document.
> It should change very rarely.
>
> Every future product decision, architectural decision, implementation, and feature proposal should be evaluated against this constitution.

---

# 1. Purpose

RepoGuide exists to build a persistent, evidence-backed understanding of software repositories that helps developers make better engineering decisions.

As software systems grow, understanding them becomes harder than writing code.

RepoGuide exists to solve that problem.

Its purpose is to understand an entire repository deeply enough that developers, and the AI systems assisting them, can make changes with confidence instead of guesswork.

Every feature, refactor, architectural change, or roadmap decision must answer one question:

> Does this bring RepoGuide closer to its vision?

If the answer is No, Maybe, or Not Yet, the work should be challenged before implementation.

---

# 2. Vision

RepoGuide is a privacy-first VS Code extension that develops a deep understanding of an entire software repository.

Its mission is to become the trusted source of repository intelligence that developers consult before making engineering decisions.

RepoGuide should understand a repository well enough to answer questions about:

- Architecture
- Dependencies
- Execution flow
- Repository structure
- Symbol relationships
- Module boundaries
- Data flow
- Runtime behavior, where observable
- Change impact
- Engineering decisions
- Historical intent
- Code evolution

using evidence rather than speculation.

As RepoGuide evolves, a developer should be able to ask virtually any question about their repository and receive:

- an evidence-backed answer,
- supporting references,
- known limitations,
- and explicit uncertainty whenever sufficient evidence does not exist.

RepoGuide should become the place developers consult before making a change, not after something breaks.

---

# 3. Product Identity

RepoGuide is a VS Code extension.

The VS Code experience is the primary product.

Everything else exists to strengthen that experience.

RepoGuide is not:

- another AI chatbot,
- another code generator,
- another autocomplete engine.

RepoGuide is a Repository Intelligence Platform delivered through a VS Code extension.

---

# 4. Repository Intelligence Engine

The Repository Intelligence Engine is the heart of RepoGuide.

Everything else is an interface to this engine.

Its responsibilities include:

- Repository indexing
- Structural understanding
- Symbol resolution
- Dependency analysis
- Repository search
- Evidence retrieval
- Execution path analysis
- Architectural understanding
- Change impact analysis
- Repository reasoning
- Engineering decision support

There must always be one canonical intelligence implementation.

Every interface must consume this engine rather than implementing its own repository understanding.

---

# 5. MCP Vision

MCP is a core feature of RepoGuide.

It is not a separate product.

Its purpose is to expose RepoGuide's Repository Intelligence Engine to external AI development agents.

Instead of forcing every AI assistant to repeatedly:

- inspect hundreds of files,
- reconstruct architecture,
- infer dependencies,
- rebuild repository context,

AI agents should simply query RepoGuide's accumulated repository intelligence.

This enables seamless development across Claude Code, ChatGPT, Codex, Gemini, Cursor, Windsurf, and future MCP-compatible development environments.

One of the primary benefits of MCP is preserving repository understanding across AI sessions.

When an agentic IDE reaches its context window, token limit, or a new conversation begins, developers should not have to rebuild repository understanding from scratch.

A new AI agent should immediately continue development by querying RepoGuide's accumulated intelligence.

RepoGuide becomes the persistent source of truth while AI agents become interchangeable clients.

MCP must never contain its own repository intelligence.

It must expose exactly the same intelligence engine used by the VS Code extension.

```text
                    Developer
                         |
                         v
              VS Code Extension
                         |
                         v
          Repository Intelligence Engine
                         ^
                         |
                    MCP Server
                         ^
                         |
      Claude - Codex - ChatGPT - Gemini - Cursor
```

---

# 6. Core Product Pillars

RepoGuide is built around six permanent pillars.

## 1. Repository Understanding

Understand repositories deeply and accurately.

## 2. Engineering Decision Support

Help developers make safer engineering decisions before code changes occur.

## 3. Evidence-first Answers

Every answer should be backed by observable evidence.

Never fabricate repository knowledge.

## 4. Deterministic Reasoning

Prefer deterministic reasoning wherever practical.

When determinism is impossible, clearly communicate uncertainty.

## 5. Privacy-first Local Execution

Repository understanding should happen locally.

Developer source code should remain under the developer's control.

## 6. AI Collaboration

Enable external AI systems to leverage RepoGuide's repository understanding through MCP rather than independently reconstructing repository knowledge.

---

# 7. Architectural Principles

The architecture must evolve without compromising the long-term vision.

The following principles are non-negotiable.

## One Canonical Implementation

Every capability should have one canonical implementation.

Duplicate engines should eventually be consolidated.

## Intelligence Before Presentation

Presentation layers should never implement repository intelligence.

All reasoning belongs inside the Repository Intelligence Engine.

## Reuse Before Rebuilding

Existing implementations should be evaluated before creating new ones.

Preserve valuable concepts even if implementations change.

## Evidence Over Opinion

Every engineering conclusion should be supported by evidence.

Evidence always outweighs intuition.

## Explicit Uncertainty

When RepoGuide cannot determine an answer confidently, it must explicitly communicate uncertainty.

Unknown is preferable to incorrect.

## Evolution Without Fragmentation

New capabilities should strengthen the existing platform rather than creating parallel architectures.

## Correctness Before Complexity

Correct answers are more valuable than sophisticated implementations.

## Long-Term Maintainability

Architectural simplicity is preferred over short-term convenience.

---

# 8. Product Philosophy

RepoGuide does not exist to generate code.

RepoGuide exists to help developers understand software systems.

Better understanding leads to better engineering decisions.

Better engineering decisions lead to higher quality software.

The goal is not to replace developers.

The goal is to make developers dramatically more effective.

---

# 9. Decision Filter

Before implementing any feature, ask:

- Does this move RepoGuide closer to its vision?
- Does this improve repository understanding?
- Does this help developers make better engineering decisions?
- Does this strengthen the canonical architecture?
- Does it reduce duplicate systems?
- Does it improve evidence quality?
- Does it improve developer trust?
- Can an existing implementation be reused?
- Can both the VS Code extension and MCP benefit from this capability?
- Will this still make sense two years from now?

If most answers are No, the work should be reconsidered.

---

# 10. What RepoGuide Will Not Become

RepoGuide will not become:

- a generic chatbot,
- a cloud-first coding assistant,
- an autocomplete engine,
- a collection of disconnected experiments,
- multiple competing architectures,
- a system built on duplicated intelligence.

Every subsystem must contribute to one coherent Repository Intelligence Platform.

---

# 11. Long-Term North Star

RepoGuide should become the most trusted local Repository Intelligence platform available inside VS Code.

Developers should rely on RepoGuide before making significant engineering decisions.

External AI development agents should rely on RepoGuide through MCP instead of attempting to understand repositories independently.

Whether a developer is working directly inside VS Code or through an AI agent, the repository should only need to be understood once.

RepoGuide should become that persistent understanding.

---

# 12. The Guiding Question

Every discussion, feature, pull request, architectural proposal, refactor, and roadmap decision should begin with one question:

> Does this decision bring RepoGuide closer to its vision?

If the answer is No, the work should not proceed.

If the answer is Maybe, investigate further before building.

If the answer is Yes, build it in a way that strengthens the canonical architecture rather than fragmenting it.
