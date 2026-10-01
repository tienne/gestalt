import { withFileLock } from '../core/file-lock.js';
import { gestaltPath } from '../core/home.js';
import { isPlainObject, readJsonOrQuarantine, writeJsonAtomic } from '../core/json-file.js';
import { log } from '../core/log.js';
import type { UserProfile } from '../core/types.js';

const PROFILE_FILENAME = 'profile.json';

function getProfilePath(): string {
  return gestaltPath(PROFILE_FILENAME);
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

  /**
   * 프로필을 읽는다. 읽기 자체가 실패하면 빈 프로필을 돌려준다.
   *
   * 고쳐 쓰는 경로는 `load()`를 직접 불러, 못 읽은 채로 빈 프로필을 덮어쓰지 않는다.
   * 잠금 없이 읽으므로 깨진 파일을 옮기지 않는다. 옮기는 건 잠금을 쥔 `update()`만 한다.
   */
  read(): UserProfile {
    try {
      return this.load({ quarantine: false });
    } catch (e) {
      log(`${this.profilePath}를 읽지 못했어요:`, e);
      return createEmptyProfile();
    }
  }

  private load(options: { quarantine: boolean }): UserProfile {
    const raw = readJsonOrQuarantine(this.profilePath, isPlainObject, options);
    if (raw === undefined) return createEmptyProfile();
    const parsed = raw as Partial<UserProfile>;
    return {
      ...createEmptyProfile(),
      ...parsed,
      crossRepoPatterns: Array.isArray(parsed.crossRepoPatterns) ? parsed.crossRepoPatterns : [],
      personalPreferences: isPlainObject(parsed.personalPreferences)
        ? parsed.personalPreferences
        : {},
    };
  }

  /**
   * 잠금을 쥔 채 읽고 고쳐 쓴다.
   *
   * 프로필은 `~/.gestalt` 아래 하나라 모든 워크트리와 세션이 같은 파일을 쓴다.
   */
  private update(mutate: (profile: UserProfile) => UserProfile | void): UserProfile {
    return withFileLock(
      `${this.profilePath}.lock`,
      ({ stillMine }) => {
        const current = this.load({ quarantine: true });
        const profile = mutate(current) ?? current;
        if (!stillMine()) {
          throw new Error('프로필 잠금을 뺏겨서 안 썼어요. 다시 불러주세요');
        }
        profile.updatedAt = new Date().toISOString();
        // userId와 개인 설정이 들어 있어 본인만 읽게 둔다
        writeJsonAtomic(this.profilePath, profile, { mode: 0o600 });
        return profile;
      },
      { busyMessage: '프로필 파일이 잠겨 있어서 못 고쳤어요' },
    );
  }

  setPreference(key: string, value: unknown): UserProfile {
    return this.update((profile) => {
      profile.personalPreferences[key] = value;
    });
  }

  addCrossRepoPattern(pattern: string): UserProfile {
    return this.update((profile) => {
      if (!profile.crossRepoPatterns.includes(pattern)) {
        profile.crossRepoPatterns.push(pattern);
      }
    });
  }

  setPreferredModel(model: string): UserProfile {
    return this.update((profile) => {
      profile.preferredModel = model;
    });
  }

  setUserId(userId: string): UserProfile {
    return this.update((profile) => {
      profile.userId = userId;
    });
  }

  merge(partial: Partial<UserProfile>): UserProfile {
    return this.update((profile) => ({
      ...profile,
      ...partial,
      crossRepoPatterns: [
        ...new Set([...profile.crossRepoPatterns, ...(partial.crossRepoPatterns ?? [])]),
      ],
      personalPreferences: {
        ...profile.personalPreferences,
        ...(partial.personalPreferences ?? {}),
      },
    }));
  }
}
