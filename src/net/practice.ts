import type { Profile } from '../types';
import type { ProfilesSnapshot, ShotSample } from '../feedback/sample';
import type { RoomBackend } from './backend';
import { LocalBackend } from './local';

/**
 * Practice mode (open the game with ?practice): one phone, nobody else needed. The room lives on
 * this phone (LocalBackend: no network, no friends to wait for), the other "players" are targets
 * the phone enrolled from its rear camera (a friend, a TV, a photo), shots are range-test shots that
 * deal no damage, and every labelled shot is uploaded to the shared feedback log so the tracking can
 * be tuned from it (`npm run feedback:pull`).
 */
export const isPractice = (): boolean => typeof location !== 'undefined' && new URL(location.href).searchParams.has('practice');

export class PracticeBackend extends LocalBackend {
  /** Where labelled shots go: the Firebase backend when one is configured, else kept in memory (LocalBackend). */
  constructor(private readonly feedbackSink: Pick<RoomBackend, 'submitShotFeedback'> | null) {
    super();
  }

  override async submitShotFeedback(round: string, sample: ShotSample, profiles: ProfilesSnapshot | null): Promise<void> {
    if (this.feedbackSink) return this.feedbackSink.submitShotFeedback(round, sample, profiles);
    return super.submitShotFeedback(round, sample, profiles);
  }

  /**
   * A target with no phone: a player record that is enrolled and always counts as present (no
   * heartbeat timestamp), so the lobby never waits for it and a round never forfeits to it.
   */
  async addTarget(code: string, name: string, profile: Profile): Promise<string> {
    const id = `target-${Math.random().toString(36).slice(2, 10)}`;
    const joined = await this.joinRoom(code, { id, name });
    if (joined !== 'ok') throw new Error(joined === 'in-progress' ? 'Add targets before the round starts.' : 'The practice room is gone. Start again.');
    await this.updatePlayer(code, id, { seenAt: undefined });
    await this.setProfile(code, id, profile);
    return id;
  }

  async removeTarget(code: string, id: string): Promise<void> {
    await this.leaveRoom(code, id);
  }
}
