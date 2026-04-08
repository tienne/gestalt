import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InterviewSessionRepository } from '../../../src/interview/repository.js';
import { SessionManager } from '../../../src/interview/session.js';
import { EventStore } from '../../../src/events/store.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

describe('InterviewSessionRepository', () => {
  let store: EventStore;
  let repo: InterviewSessionRepository;
  let manager: SessionManager;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/interview-repo-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    repo = new InterviewSessionRepository(store);
    manager = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch { /* ignore */ }
  });

  it('returns null for non-existent session', () => {
    expect(repo.reconstruct('non-existent')).toBeNull();
  });

  it('reconstructs a basic session from events', () => {
    const session = manager.create('test topic', 'greenfield');
    const reconstructed = repo.reconstruct(session.sessionId);

    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.sessionId).toBe(session.sessionId);
    expect(reconstructed!.topic).toBe('test topic');
    expect(reconstructed!.status).toBe('in_progress');
    expect(reconstructed!.projectType).toBe('greenfield');
    expect(reconstructed!.rounds).toHaveLength(0);
  });

  it('reconstructs session with Q&A rounds', () => {
    const session = manager.create('auth system', 'brownfield');
    manager.addQuestion(session.sessionId, 'What auth method?', GestaltPrinciple.CLOSURE);
    manager.recordResponse(session.sessionId, 'JWT');
    manager.addQuestion(session.sessionId, 'Token expiry?', GestaltPrinciple.PROXIMITY);
    manager.recordResponse(session.sessionId, '24 hours');

    const reconstructed = repo.reconstruct(session.sessionId);

    expect(reconstructed!.rounds).toHaveLength(2);
    expect(reconstructed!.rounds[0]!.question).toBe('What auth method?');
    expect(reconstructed!.rounds[0]!.userResponse).toBe('JWT');
    expect(reconstructed!.rounds[0]!.gestaltFocus).toBe(GestaltPrinciple.CLOSURE);
    expect(reconstructed!.rounds[1]!.question).toBe('Token expiry?');
    expect(reconstructed!.rounds[1]!.userResponse).toBe('24 hours');
  });

  it('reconstructs ambiguity score', () => {
    const session = manager.create('test', 'greenfield');
    manager.updateResolutionScore(session.sessionId, {
      overall: 0.3,
      isReady: false,
      dimensions: [
        { name: 'goal', clarity: 0.8, weight: 1, gestaltPrinciple: GestaltPrinciple.FIGURE_GROUND },
      ],
    });

    const reconstructed = repo.reconstruct(session.sessionId);

    expect(reconstructed!.resolutionScore).not.toBeNull();
    expect(reconstructed!.resolutionScore!.overall).toBe(0.3);
    expect(reconstructed!.resolutionScore!.isReady).toBe(false);
    expect(reconstructed!.resolutionScore!.dimensions).toHaveLength(1);
  });

  it('reconstructs completed session', () => {
    const session = manager.create('test', 'greenfield');
    manager.addQuestion(session.sessionId, 'Q1', GestaltPrinciple.CLOSURE);
    manager.recordResponse(session.sessionId, 'A1');
    manager.complete(session.sessionId);

    const reconstructed = repo.reconstruct(session.sessionId);

    expect(reconstructed!.status).toBe('completed');
  });

  it('lists all session IDs', () => {
    manager.create('topic1', 'greenfield');
    manager.create('topic2', 'brownfield');
    manager.create('topic3', 'greenfield');

    const ids = repo.list();
    expect(ids).toHaveLength(3);
  });

  it('reconstructs all sessions', () => {
    manager.create('topic1', 'greenfield');
    manager.create('topic2', 'brownfield');

    const sessions = repo.reconstructAll();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.topic).sort()).toEqual(['topic1', 'topic2']);
  });

  it('reconstructs session from a fresh EventStore (simulates server restart)', () => {
    const session = manager.create('persistent topic', 'greenfield');
    manager.addQuestion(session.sessionId, 'Will this persist?', GestaltPrinciple.CONTINUITY);
    manager.recordResponse(session.sessionId, 'It should!');
    manager.updateResolutionScore(session.sessionId, {
      overall: 0.15,
      isReady: true,
      dimensions: [],
    });

    // Simulate server restart: close and reopen EventStore
    store.close();
    const newStore = new EventStore(dbPath);
    const newRepo = new InterviewSessionRepository(newStore);

    const reconstructed = newRepo.reconstruct(session.sessionId);

    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.topic).toBe('persistent topic');
    expect(reconstructed!.rounds).toHaveLength(1);
    expect(reconstructed!.rounds[0]!.userResponse).toBe('It should!');
    expect(reconstructed!.resolutionScore!.overall).toBe(0.15);
    expect(reconstructed!.resolutionScore!.isReady).toBe(true);

    newStore.close();
  });

  it('SessionManager.loadFromStore() restores sessions into memory', () => {
    const session = manager.create('restore test', 'greenfield');
    manager.addQuestion(session.sessionId, 'Q1', GestaltPrinciple.CLOSURE);
    manager.recordResponse(session.sessionId, 'A1');

    // Simulate restart
    store.close();
    const newStore = new EventStore(dbPath);
    const newManager = new SessionManager(newStore);
    newManager.loadFromStore();

    const restored = newManager.get(session.sessionId);
    expect(restored.topic).toBe('restore test');
    expect(restored.rounds).toHaveLength(1);
    expect(restored.rounds[0]!.userResponse).toBe('A1');

    newStore.close();
  });
});
