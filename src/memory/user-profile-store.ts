import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { UserProfile } from '../core/types.js';

const PROFILE_DIR = '.gestalt';
const PROFILE_FILENAME = 'profile.json';

function getProfilePath(): string {
  return join(homedir(), PROFILE_DIR, PROFILE_FILENAME);
}

function createEmptyProfile(): UserProfile {
  const now = new Date().toISOString();
  return {
    crossRepoPatterns: [],
    personalPreferences: {},
    createdAt: now,
    updatedAt: now,
  };
}

export class UserProfileStore {
  private profilePath: string;

  constructor(profilePath?: string) {
    this.profilePath = profilePath ?? getProfilePath();
  }

  read(): UserProfile {
    if (!existsSync(this.profilePath)) {
      return createEmptyProfile();
    }
    try {
      const raw = readFileSync(this.profilePath, 'utf-8');
      return JSON.parse(raw) as UserProfile;
    } catch {
      return createEmptyProfile();
    }
  }

  private write(profile: UserProfile): void {
    const dir = dirname(this.profilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    profile.updatedAt = new Date().toISOString();
    writeFileSync(this.profilePath, JSON.stringify(profile, null, 2), 'utf-8');
  }

  setPreference(key: string, value: unknown): UserProfile {
    const profile = this.read();
    profile.personalPreferences[key] = value;
    this.write(profile);
    return profile;
  }

  addCrossRepoPattern(pattern: string): UserProfile {
    const profile = this.read();
    if (!profile.crossRepoPatterns.includes(pattern)) {
      profile.crossRepoPatterns.push(pattern);
    }
    this.write(profile);
    return profile;
  }

  setPreferredModel(model: string): UserProfile {
    const profile = this.read();
    profile.preferredModel = model;
    this.write(profile);
    return profile;
  }

  setUserId(userId: string): UserProfile {
    const profile = this.read();
    profile.userId = userId;
    this.write(profile);
    return profile;
  }

  merge(partial: Partial<UserProfile>): UserProfile {
    const profile = this.read();
    const merged: UserProfile = {
      ...profile,
      ...partial,
      crossRepoPatterns: [
        ...new Set([
          ...profile.crossRepoPatterns,
          ...(partial.crossRepoPatterns ?? []),
        ]),
      ],
      personalPreferences: {
        ...profile.personalPreferences,
        ...(partial.personalPreferences ?? {}),
      },
    };
    this.write(merged);
    return merged;
  }
}
